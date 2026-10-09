# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.

"""The sandboxed smolagents interpreter: it behaves as the library's local one
towards the agent, and sees the session's data and nothing else."""
import json
from pathlib import Path
import tempfile
import unittest

from baseline_pilot import benchmark_text
from smolagents_session import IMPORTS, SandboxedInterpreter, answer_text


class SandboxedInterpreterTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.data = root / "session" / "data"
        self.data.mkdir(parents=True)
        (self.data / "events.csv").write_text("id,value\n1,3\n2,7\n")
        self.secret = root / "session" / "gold.json"
        self.secret.write_text('{"answer": 10}')
        self.interpreter = SandboxedInterpreter({"data_dir": str(self.data)}, root / "scratch", IMPORTS, timeout=60)

    def tearDown(self):
        self.interpreter.cleanup()
        self.temp.cleanup()

    def test_state_persists_and_the_agent_sees_the_text_of_each_output(self):
        first = self.interpreter(f"import pandas as pd\nevents = pd.read_csv('{self.data}/events.csv')\nprint('loaded')\nlen(events)")
        self.assertEqual((first.output, first.logs.strip(), first.is_final_answer), ("2", "loaded", False))
        second = self.interpreter("total = int(events['value'].sum())\ntotal")
        self.assertEqual(second.output, "10")

    def test_a_failed_step_reports_the_library_error_and_keeps_what_was_printed(self):
        self.interpreter("kept = 5")
        with self.assertRaisesRegex(Exception, "The variable `missing` is not defined"):
            self.interpreter("print('before')\nmissing + 1")
        self.assertEqual(self.interpreter.state["_print_outputs"].strip(), "before")
        with self.assertRaisesRegex(Exception, "Import of requests is not allowed"):
            self.interpreter("import requests")
        self.assertEqual(self.interpreter("kept").output, "5")

    def test_a_final_answer_arrives_as_plain_values(self):
        result = self.interpreter("import numpy as np\nfinal_answer({'n': np.int64(2), 'mean': np.float64(5.0), 'ids': np.array([1, 2])})")
        self.assertTrue(result.is_final_answer)
        self.assertEqual(result.output, {"n": 2, "mean": 5.0, "ids": [1, 2]})
        self.assertEqual(json.loads(answer_text(result.output)), result.output)
        self.assertEqual(answer_text("already text"), "already text")
        self.assertEqual(answer_text(None), "")

    def test_only_the_session_data_is_visible_and_it_is_read_only(self):
        seen = self.interpreter(
            f"import os\n[os.path.exists('{self.data}/events.csv'), os.path.exists('{self.secret}'), "
            f"os.path.exists('{Path(__file__).resolve()}')]")
        self.assertEqual(seen.output, "[True, False, False]")
        with self.assertRaises(Exception):
            self.interpreter(f"open('{self.data}/new.csv', 'w').write('x')")
        with self.assertRaisesRegex(Exception, "URLError|resolution|unreachable"):
            self.interpreter("import pandas as pd\npd.read_csv('https://example.com/x.csv')")


class TaskTextTest(unittest.TestCase):
    def test_only_the_first_request_says_where_the_data_is(self):
        manifest = {"data_dir": "data/longds/x/y/task1/data"}
        first = benchmark_text(manifest, {"turn_id": 1, "context": "Clean the rows.", "question": "How many remain?"})
        later = benchmark_text(manifest, {"turn_id": 2, "context": "Now drop duplicates.", "question": "How many remain?"})
        self.assertEqual(first, "The data for these requests is in `data/longds/x/y/task1/data`.\n\nClean the rows.\nQuestion: How many remain?")
        self.assertEqual(later, "Now drop duplicates.\nQuestion: How many remain?")


if __name__ == "__main__":
    unittest.main()
