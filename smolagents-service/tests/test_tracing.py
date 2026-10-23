# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements. See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import tempfile
import unittest
from pathlib import Path

from smolagents_service.config import Config
from smolagents_service.sessions import ChatSession
from smolagents_service.store import Store
from smolagents_service.ui import run_agent

from tests.helpers import ScriptedModel

EPSILON = 0.005  # seconds of clock jitter allowed when comparing nested intervals


def answer(text):
    return lambda task: f"Thought: answer.\n<code>\nfinal_answer({text!r})\n</code>"


class TracingTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.folder.name) / "data" / "traces.db")
        self.user = {"id": self.store.create_user("alice", "correct horse"), "username": "alice"}
        self.sessions = []

    def tearDown(self):
        for session in self.sessions:
            session.close()
        self.store.close()
        self.folder.cleanup()

    def session(self, script, latency=0.05, max_steps=6) -> ChatSession:
        config = Config(data_dir=Path(self.folder.name) / "data", max_steps=max_steps,
                        model_factory=lambda: ScriptedModel(script, latency=latency))
        files = config.user_dir(self.user["id"]) / "files"
        files.mkdir(parents=True, exist_ok=True)
        self.csv = files / "numbers.csv"
        self.csv.write_text("x\n1\n2\n3\n")
        session = ChatSession(self.store, config, self.user)
        self.sessions.append(session)
        return session

    def ask(self, session, task):
        history = []
        for history in run_agent(session, task, []):
            pass
        return history

    def test_a_run_is_traced_step_by_step(self):
        from tests.helpers import SUM_AND_CHART

        session = self.session(SUM_AND_CHART, latency=0.2)
        history = self.ask(session, f"Sum x in this file: ['{self.csv}']")
        self.assertIn("6", " ".join(str(m.content) for m in history))
        self.assertTrue(any(isinstance(m.content, dict) for m in history), "the chart is in the chat")

        [summary] = self.store.list_runs(self.user["id"])
        self.assertEqual((summary["status"], summary["final_answer"], summary["turn"]), ("ok", "6", 1))
        self.assertEqual((summary["steps"], summary["llm_calls"]), (2, 2))
        run = self.store.get_run(self.user["id"], summary["id"], context=True)

        for step in run["steps"]:
            calls = [c for c in run["llm_calls"] if c["step_number"] == step["step_number"]]
            execs = [p for p in run["python_execs"] if p["step_number"] == step["step_number"]]
            self.assertEqual((len(calls), len(execs)), (1, 1))
            call, execution = calls[0], execs[0]
            # Nested in time: step ⊇ model call, then code execution; the run contains every step.
            self.assertLessEqual(run["started_at"], step["started_at"] + EPSILON)
            self.assertLessEqual(step["started_at"], call["started_at"] + EPSILON)
            self.assertLess(call["started_at"], call["first_token_at"])
            self.assertLessEqual(call["first_token_at"], call["ended_at"])
            self.assertLessEqual(call["ended_at"], execution["started_at"] + EPSILON)
            self.assertLessEqual(execution["ended_at"], step["ended_at"] + EPSILON)
            self.assertLessEqual(step["ended_at"], run["ended_at"] + EPSILON)
            self.assertGreaterEqual(step["seconds"] + EPSILON, step["llm_seconds"] + step["python_seconds"])
            self.assertGreaterEqual(step["llm_seconds"], 0.2 - EPSILON)  # the scripted model's latency
            self.assertLessEqual(execution["worker_seconds"], execution["ended_at"] - execution["started_at"])
            self.assertGreater(call["input_tokens"], 0)
            self.assertEqual((step["input_tokens"], step["output_tokens"]),
                             (call["input_tokens"], call["output_tokens"]))

        first, second = run["steps"]
        self.assertEqual((first["figures"], second["is_final_answer"]), (1, 1))
        [figure] = run["artifacts"]
        self.assertTrue(Path(figure["path"]).is_file())
        # Step 2's model call saw step 1's chart and its printed output.
        context = self.store.step_context(self.user["id"], summary["id"], 2)
        parts = [part for message in context for part in (message["content"] or [])]
        self.assertTrue(any(part.get("type") == "image" for part in parts))
        self.assertTrue(any("(3, 1)" in part.get("text", "") for part in parts))

    def test_each_part_of_a_run_is_shown_once(self):
        session = self.session([
            lambda task: ("Thought: Add them up.\n<code>\nsubtotal = 19 + 23  # distinctive-line\n"
                          "print(subtotal)\n</code>"),
            lambda task: "Thought: Report it.\n<code>\nfinal_answer('the total is 42, distinctive-answer')\n</code>",
        ])
        history = self.ask(session, "Add 19 and 23.")
        shown = [message.content if isinstance(message.content, str) else "" for message in history]
        everything = "\n".join(shown)
        self.assertEqual(everything.count("distinctive-line"), 1, "the code is shown once, in its Python block")
        self.assertEqual(everything.count("distinctive-answer"), 1, "the answer is shown once")
        self.assertNotIn("final_answer(", everything)  # a step that only answers shows no code
        self.assertEqual(everything.count("Add them up."), 1)
        titles = [message.metadata.get("title", "") for message in history]
        self.assertEqual(sum(title.startswith("🐍 Ran Python · step 1") for title in titles), 1)
        self.assertFalse(any(title.startswith("✍️") for title in titles), "no streaming box is left behind")
        self.assertIn("✓ 2 steps", shown[-1])

    def test_the_users_own_code_joins_the_conversation(self):
        session = self.session([lambda task: "<code>\nfinal_answer(total * 2)\n</code>"])
        reply, _ = session.run_python(
            "import pandas as pd\ntotal = int(pd.read_csv('numbers.csv')['x'].sum())\nprint('total', total)", "sum.py")
        self.assertEqual(reply["output"].strip(), "total 6")
        self.ask(session, "Double it.")
        script, asked = sorted(self.store.list_runs(self.user["id"]), key=lambda r: r["turn"])
        self.assertEqual((script["kind"], script["status"], script["task"]), ("script", "ok", "Ran sum.py"))
        self.assertEqual((asked["kind"], asked["final_answer"]), ("agent", "12"))
        context = str(self.store.step_context(self.user["id"], asked["id"], 1))
        self.assertIn("The user ran their own code, sum.py", context)
        self.assertIn("total 6", context)
        self.assertIn("total (int)", context)
        pids = {p["worker_pid"] for run in (script, asked)
                for p in self.store.get_run(self.user["id"], run["id"])["python_execs"]}
        self.assertEqual(pids, {session.executor.process.pid}, "one Python process for the whole chat")

    def test_memory_and_turns_carry_over(self):
        session = self.session([
            lambda task: "<code>\nkept = 7\nfinal_answer('stored')\n</code>",
            lambda task: "<code>\nfinal_answer(kept * 6)\n</code>",
        ])
        self.ask(session, "Remember seven.")
        self.ask(session, "Multiply it by six.")
        runs = sorted(self.store.list_runs(self.user["id"]), key=lambda r: r["turn"])
        self.assertEqual([(r["turn"], r["final_answer"]) for r in runs], [(1, "stored"), (2, "42")])
        context = self.store.step_context(self.user["id"], runs[1]["id"], 1)
        self.assertIn("Remember seven.", str(context))

    def test_a_chat_comes_back_with_its_variables(self):
        """A session on an earlier chat runs the chat's code again: code that failed too, since what it assigned
        before failing stayed, but nothing from before a lost worker, since the worker lost it the first time."""
        session = self.session([answer("unused")])
        for code in ("a = 1", "b = 2\n1 / 0", "import os\nos._exit(3)", "c = 3", "d = c + 1\nundefined_name"):
            session.run_python(code, "cell")
        here = "[name for name in 'abcd' if name in globals()]"
        self.assertEqual(session.run_python(here, "check")[0]["value"], "['c', 'd']")
        restored = ChatSession(self.store, session.config, self.user, session.chat_id)
        self.sessions.append(restored)
        self.assertTrue(restored.ready.wait(60))
        self.assertEqual((restored.restored["runs"], restored.restored["replayed"]), (6, 3))
        self.assertEqual(restored.run_python(here, "check")[0]["value"], "['c', 'd']")
        self.assertEqual([r["turn"] for r in self.store.runs_of_chat(self.user["id"], session.chat_id)][-2:], [6, 7])

    def test_failures_are_recorded(self):
        session = self.session([
            lambda task: "<code>\n1 / 0\n</code>",
            lambda task: "I will not write code this time.",
            answer("recovered"),
        ])
        self.ask(session, "Divide.")
        [summary] = self.store.list_runs(self.user["id"])
        self.assertEqual((summary["status"], summary["final_answer"]), ("ok", "recovered"))
        steps = self.store.get_run(self.user["id"], summary["id"])["steps"]
        self.assertIn("division by zero", steps[0]["error"])
        self.assertIn("code parsing", steps[1]["error"])
        self.assertIsNone(steps[2]["error"])

    def test_running_out_of_steps(self):
        session = self.session([lambda task: "<code>\nprint('again')\n</code>"], max_steps=2)
        self.ask(session, "Loop forever.")
        [summary] = self.store.list_runs(self.user["id"])
        self.assertEqual(summary["status"], "max_steps")
        self.assertEqual(summary["llm_calls"], 3)  # two steps, then the forced final answer
        self.assertEqual(summary["steps"], 3)


if __name__ == "__main__":
    unittest.main()
