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
"""LongDS session tools on synthetic traces: no stack, model or judge calls."""
import gzip
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from benchmark.longds.behavior import session_behavior
from benchmark.longds.common import committed_calls, parse_delete, parse_set, save, statement_blocks
from benchmark.longds.judge import judge_run, verdict
from benchmark.longds.prepare import build_prompts, turn_ids
from benchmark.longds.report import run_summary
from benchmark.longds.run_session import request_record

RULES = '''def eligible_units(orders, *, min_orders=5):
    """Units with at least min_orders orders."""
    return orders

def unit_scores(units):
    return units
'''


def call_step(python, statements, edit_status="ok", usage=None):
    """An agent step with one dataflow call. A call with definitions or `set`
    and `delete` lines has an edit action, which succeeded or failed."""
    edits = bool(python) or any(line.startswith(("set ", "delete ")) for line in statements.splitlines())
    actions = [{"action": {"type": "edit"}, "status": edit_status}] if edits else []
    actions += [{"action": {"type": "retrieve"}, "status": "ok"}] if "show result" in statements else []
    return {"role": "agent", "isEnd": False, "content": "",
            "toolCalls": [{"toolName": "dataflow", "toolCallId": "c1", "input": {"python": python, "statements": statements}}],
            "toolResults": [{"toolCallId": "c1", "output": {"kind": "dataflow-actions", "status": "completed",
                                                            "actions": actions}}],
            "usage": usage or {"inputTokens": 1000, "outputTokens": 100, "cachedInputTokens": 800}}


def reply_step(text, **extra):
    return {"role": "agent", "isEnd": True, "content": text,
            "usage": {"inputTokens": 1200, "outputTokens": 50, "cachedInputTokens": 1000}, **extra}


class StatementTests(unittest.TestCase):
    def test_statements_split_at_commands_and_keep_multiline_settings(self):
        blocks = statement_blocks("# comment\nset a: scan(files='x.csv')\nset b: aggregate(a,\n    outputs={'n': count()})\n"
                                  "delete c\nshow result b")
        self.assertEqual(len(blocks), 4)
        self.assertEqual(parse_set(blocks[0]), {"id": "a", "op": "scan", "inputs": [], "settings": {"files": "x.csv"}})
        self.assertEqual(parse_set(blocks[1]), {"id": "b", "op": "aggregate", "inputs": ["a"],
                                                "settings": {"outputs": "{'n': count()}"}})
        self.assertEqual(parse_delete(blocks[2]), "c")
        self.assertIsNone(parse_set(blocks[3]))

    def test_a_call_is_applied_only_when_its_edits_succeeded(self):
        calls = committed_calls([call_step(RULES, "set a: scan(files='x.csv')"),
                                 call_step("", "set b: oops(", edit_status="error"),
                                 call_step("", "show result a")])
        self.assertEqual([c["applied"] for c in calls], [True, False, False])


class RecordTests(unittest.TestCase):
    def test_an_answer_with_usage_and_cost(self):
        steps = [{"role": "user", "content": "q", "isBegin": True, "isEnd": False},
                 call_step(RULES, "set a: scan(files='x.csv')\nshow result a"), reply_step('{"n": 3}')]
        record = request_record(1, "q", steps, "gpt-5.6-luna", 12.34, watchdog=False)
        self.assertTrue(record["completed"])
        self.assertEqual(record["answer"], '{"n": 3}')
        self.assertEqual(record["llm_calls"], 2)
        self.assertEqual(record["usage"]["input_tokens"], 2200)
        # Luna: $0.2/M fresh input, $0.02/M cached, $1.2/M output.
        self.assertAlmostEqual(record["cost_usd"], (400 * 0.2 + 1800 * 0.02 + 150 * 1.2) / 1e6)
        self.assertEqual(record["dataflow_calls"], 1)

    def test_a_failed_or_stopped_request_has_no_answer(self):
        failed = request_record(2, "q", [call_step("", "show result a"),
                                         reply_step("Error: the turn ended", endReason="error")],
                                "gpt-5.6-luna", 1.0, watchdog=False)
        self.assertEqual((failed["completed"], failed["answer"], failed["end"]), (False, "", "error"))
        stopped = request_record(3, "q", [reply_step('{"n": 3}')], "gpt-5.6-luna", 1.0, watchdog=True)
        self.assertEqual((stopped["completed"], stopped["end"]), (False, "watchdog"))


class BehaviorTests(unittest.TestCase):
    def test_reuse_of_rules_and_tables_across_requests(self):
        requests = [
            [call_step(RULES, "set orders: scan(files='data/orders.csv')\n"
                              "set units: eligible_units(orders, min_orders=5)\nset scores: unit_scores(units)")],
            # A rule changed for everything after it, and a rescan.
            [call_step("", "set units: eligible_units(orders, min_orders=10)\n"
                           "set orders2: scan(files='data/orders.csv')")],
            # An alternative beside the current version, and a new table on an earlier one.
            [call_step("", "set units7: eligible_units(orders, min_orders=7)\nset top: limit(scores, n=3)")],
            # A redefinition, and nothing reused.
            [call_step(RULES.replace("return orders", "return orders.head()"), "set extra: scan(files='data/other.csv')")],
        ]
        behavior = session_behavior(requests, {2: ["Update"], 3: ["Counterfactual"], 4: ["Rollback"]})
        self.assertEqual(behavior["settings changes"], 1)
        self.assertEqual(behavior["alternatives"], 1)
        self.assertEqual(behavior["earlier functions called"], 2)
        self.assertEqual(behavior["earlier tables read"], 2)
        self.assertEqual(behavior["rescans"], 1)
        self.assertEqual(behavior["functions redefined"], 1)
        self.assertEqual(behavior["new functions per request"], 0.5)
        self.assertEqual(behavior["share of new functions with settings"], 0.5)
        self.assertEqual(behavior["revisits reusing"], 0.67)

    def test_rejected_edits_do_not_count(self):
        behavior = session_behavior([[call_step(RULES, "set units: eligible_units(orders, min_orders=5)")],
                                     [call_step("", "set units: eligible_units(orders, min_orders=9)", "error")]])
        self.assertEqual(behavior["settings changes"], 0)


class PrepareTests(unittest.TestCase):
    def test_the_first_request_names_the_files_and_later_ones_their_turn(self):
        prompts = build_prompts(["data/longds/a/b/task1/data/x.csv"],
                                [{"turn_id": 1, "context": "C1", "question": "Q1"},
                                 {"turn_id": 2, "context": "C2", "question": "Q2"}])
        self.assertIn(" - data/longds/a/b/task1/data/x.csv\n", prompts[0]["prompt"])
        self.assertTrue(prompts[0]["prompt"].endswith("[Task 1]\nC1\nQuestion: Q1"))
        self.assertEqual(prompts[1]["prompt"], "[Task 2]\nC2\nQuestion: Q2")

    def test_dependencies_are_turn_numbers_whatever_their_spelling(self):
        self.assertEqual(turn_ids(["task_3", "task_1", 2, True]), [1, 2, 3])


class FakeClient:
    """Answers every judge request with the given text and counts calls."""

    def __init__(self, text):
        self.calls = 0
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))
        self.text = text

    def create(self, **_):
        self.calls += 1
        return SimpleNamespace(usage=None, choices=[SimpleNamespace(message=SimpleNamespace(content=self.text))])


TEMPLATE = "Q: {question}\nGold: {ground_truth}\nAnswer: {solution}"
TURN = {"turn_id": 1, "context": "C", "question": "Q", "answer": {"n": 3}, "state_type": ["Initial"]}


class JudgeTests(unittest.TestCase):
    def test_scores_parse_and_empty_answers_cost_nothing(self):
        client = FakeClient("<reasoning>same</reasoning><score>1</score>")
        self.assertEqual(verdict(client, TEMPLATE, TURN, '{"n": 3}')["score"], 1)
        self.assertEqual(verdict(client, TEMPLATE, TURN, "")["score"], 0)
        self.assertEqual(client.calls, 1)
        self.assertIsNone(verdict(FakeClient("no tag"), TEMPLATE, TURN, '{"n": 3}', retries=1)["score"])

    def test_a_run_is_judged_once_then_read_from_the_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            run = make_run(root)
            client = FakeClient("<score>1</score>")
            judge_run(run, client, TEMPLATE, root / "cache", workers=1)
            (run / "t01" / "judge.json").unlink()
            judge_run(run, client, TEMPLATE, root / "cache", workers=1)
            self.assertEqual(client.calls, 1)
            summary = run_summary(run)
            self.assertEqual((summary["correct"], summary["by_label"]), (1, {"Initial": "1/1"}))
            self.assertEqual(summary["behavior"]["new functions per request"], 2.0)


def make_run(root):
    """A one-request run folder as run_session.py writes it."""
    save(root / "prepared" / "gold.json", {"turns": [TURN]})
    run = root / "runs" / "s__catalog__r1"
    save(run / "protocol.json", {"prepared": str(root / "prepared"), "arm": "catalog", "model": "gpt-5.6-luna"})
    steps = [call_step(RULES, "set a: scan(files='x.csv')"), reply_step('{"n": 3}')]
    record = request_record(1, "q", steps, "gpt-5.6-luna", 1.0, watchdog=False)
    save(run / "records.json", [record])
    save(run / "t01" / "record.json", record)
    with gzip.open(run / "t01" / "steps.json.gz", "wt") as stream:
        json.dump(steps, stream)
    return run


if __name__ == "__main__":
    unittest.main()
