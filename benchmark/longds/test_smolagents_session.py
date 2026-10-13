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
"""The smolagents baseline: its sandboxed interpreter behaves as the library's
local one towards the agent and sees the session's data and nothing else; its
records have run_session.py's layout. No model calls."""
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from benchmark.longds.campaign import command
from benchmark.longds.smolagents_session import answer_text, make_interpreter_class, request_record
from benchmark.retrieval.metrics import current_price_schedule

try:
    from smolagents.local_python_executor import CodeOutput, PythonExecutor
except ImportError:  # pragma: no cover - the environment without smolagents
    PythonExecutor = None

TASK = "x/y/task1"
IMPORTS = ["numpy.*", "pandas.*", "os", "json", "posixpath", "genericpath"]


@unittest.skipIf(PythonExecutor is None or shutil.which("bwrap") is None, "needs smolagents and bubblewrap")
class SandboxedInterpreterTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.data = root / "data" / TASK / "data"
        self.data.mkdir(parents=True)
        (self.data / "events.csv").write_text("id,value\n1,3\n2,7\n")
        self.secret = root / "data" / TASK / "gold.json"
        self.secret.write_text('{"answer": 10}')
        interpreter = make_interpreter_class(PythonExecutor, CodeOutput)
        self.interpreter = interpreter(TASK, root / "scratch", IMPORTS, timeout=60, data_root=root / "data")

    def tearDown(self):
        self.interpreter.cleanup()
        self.temp.cleanup()

    def test_state_persists_and_the_requests_relative_paths_resolve(self):
        first = self.interpreter(f"import pandas as pd\nevents = pd.read_csv('data/longds/{TASK}/data/events.csv')\n"
                                 "print('loaded')\nlen(events)")
        self.assertEqual((first.output, first.logs.strip(), first.is_final_answer), ("2", "loaded", False))
        self.assertEqual(self.interpreter("total = int(events['value'].sum())\ntotal").output, "10")

    def test_a_failed_step_reports_the_library_error_and_keeps_what_was_printed(self):
        self.interpreter("kept = 5")
        with self.assertRaisesRegex(Exception, "The variable `missing` is not defined"):
            self.interpreter("print('before')\nmissing + 1")
        self.assertEqual(self.interpreter.state["_print_outputs"].strip(), "before")
        with self.assertRaisesRegex(Exception, "Import of requests is not allowed"):
            self.interpreter("import requests")
        self.assertEqual(self.interpreter("kept").output, "5")

    def test_a_final_answer_arrives_as_plain_values(self):
        result = self.interpreter("import numpy as np\nfinal_answer({'n': np.int64(2), 'mean': np.float64(5.0), "
                                  "'ids': np.array([1, 2])})")
        self.assertTrue(result.is_final_answer)
        self.assertEqual(result.output, {"n": 2, "mean": 5.0, "ids": [1, 2]})
        self.assertEqual(json.loads(answer_text(result.output)), result.output)
        self.assertEqual((answer_text("already text"), answer_text(None)), ("already text", ""))

    def test_only_the_session_data_is_visible_read_only_and_offline(self):
        seen = self.interpreter(f"import os\n[os.path.exists('{self.data}/events.csv'), os.path.exists('{self.secret}'), "
                                f"os.path.exists('{Path(__file__).resolve()}')]")
        self.assertEqual(seen.output, "[True, False, False]")
        with self.assertRaises(Exception):
            self.interpreter(f"open('data/longds/{TASK}/data/new.csv', 'w').write('x')")
        with self.assertRaisesRegex(Exception, "URLError|resolution|unreachable"):
            self.interpreter("import pandas as pd\npd.read_csv('https://example.com/x.csv')")


class RecordTest(unittest.TestCase):
    def test_a_request_record_has_run_session_layout_and_luna_cost(self):
        calls = [{"input": 1000, "cached": 800, "cache_creation": 0, "output": 100, "reasoning": 20},
                 {"input": 1200, "cached": 1000, "cache_creation": 0, "output": 50, "reasoning": 0}]
        record = request_record(3, "q", calls, current_price_schedule("gpt-5.6-luna"), output={"n": 3}, error=None,
                                out_of_steps=False, steps=2, failed=0, elapsed=4.2)
        self.assertEqual((record["completed"], record["answer"], record["end"]), (True, '{"n": 3}', "answer"))
        self.assertEqual((record["llm_calls"], record["usage"]["input_tokens"], record["max_input_tokens"]), (2, 2200, 1200))
        self.assertAlmostEqual(record["cost_usd"], (400 * 0.2 + 1800 * 0.02 + 150 * 1.2) / 1e6)
        failed = request_record(4, "q", [], current_price_schedule("gpt-5.6-luna"), output=None,
                                error="SessionLost: gone", out_of_steps=False, steps=0, failed=0, elapsed=1)
        self.assertEqual((failed["completed"], failed["answer"], failed["end"]), (False, "", "error"))

    def test_the_campaign_sends_the_smolagents_arm_to_its_own_runner(self):
        job = {"prepared": Path("P"), "out": Path("O"), "arm": "smolagents"}
        self.assertIn("benchmark.longds.smolagents_session", command(job, "gpt-5.6-luna", []))
        self.assertNotIn("--arm", command(job, "gpt-5.6-luna", []))
        self.assertIn("benchmark.longds.run_session", command({**job, "arm": "hybrid"}, "gpt-5.6-luna", []))
        oracle = command({**job, "arm": "smolagents-oracle"}, "gpt-5.6-luna", [])
        self.assertIn("benchmark.longds.smolagents_session", oracle)
        self.assertEqual(oracle[oracle.index("--select") + 1], "oracle")

    def test_the_oracle_selection_keeps_request_one_and_the_annotated_dependencies(self):
        from benchmark.longds.common import oracle_selection, selection_note
        gold = {"turns": [{"turn_id": 1, "depends_tasks": []}, {"turn_id": 2, "depends_tasks": [1]},
                          {"turn_id": 5, "depends_tasks": [3, 2]}, {"turn_id": 9, "depends_tasks": [7, 9, 12]}]}
        self.assertEqual([oracle_selection(gold, turn) for turn in (1, 2, 5, 9)], [None, [1], [1, 2, 3], [1, 7]])
        # Nothing left out, no note; otherwise the same sentence for both agents.
        self.assertEqual(selection_note([1], 2), "")
        self.assertEqual(selection_note(None, 1), "")
        self.assertEqual(selection_note([1, 7], 9), "\n\n(Context: of the earlier tasks, this conversation shows tasks 1, 7; "
                                                   "the others are left out of it, and what they computed still exists.)")


if __name__ == "__main__":
    unittest.main()
