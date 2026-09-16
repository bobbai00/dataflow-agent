# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.
"""Architecture-neutral state checks must not conceal missing or wrong work."""
import json
from pathlib import Path
import runpy
import tempfile
import unittest

score = runpy.run_path(str(Path(__file__).with_name('task-study.py')))['score']


class MetricsTest(unittest.TestCase):
    def run_case(self, gold, answers, checks, calls=2):
        with tempfile.TemporaryDirectory() as tmp:
            case, run = Path(tmp) / 'case', Path(tmp) / 'run'
            case.mkdir(); run.mkdir()
            (case / 'gold.json').write_text(json.dumps(gold))
            (case / 'checks.json').write_text(json.dumps(checks))
            for i, answer in enumerate(answers, 1):
                directory = run / f't{i:02}'; directory.mkdir()
                (directory / 'answer.json').write_text(json.dumps({'answer': answer}))
                (directory / 'stats.json').write_text(json.dumps({'cost_usd': .1 if calls else 0, 'llm_calls': calls}))
            return score(case, run)

    def test_missing_work_counts_as_failure_and_cost_is_incomplete(self):
        result = self.run_case([{'total': 3}, {'total': 4}], [{'total': 3}], [{}, {}])
        self.assertEqual(result['passed'], 1)
        self.assertEqual(result['requirements'], {'passed': 1, 'total': 2})
        self.assertFalse(result['cost_complete'])
        self.assertEqual(result['cost_usd'], .1)
        self.assertFalse(result['session_passed'])

    def test_preservation_requires_correct_reference_not_merely_same_answer(self):
        result = self.run_case([{'current': 10, 'baseline': 5}], [{'current': 10, 'baseline': 4}],
                               [{'fields': {'current': 'update', 'baseline': 'preservation'}, 'correction': True}])
        self.assertEqual(result['state_checks']['update'], {'passed': 1, 'total': 1})
        self.assertEqual(result['state_checks']['preservation'], {'passed': 0, 'total': 1})
        self.assertEqual(result['correction_cost_usd'], .1)
        self.assertEqual(result['task_averaged_requirement_score'], .5)

    def test_shape_failure_is_kept_separate_without_forgiving_wrong_values(self):
        result = self.run_case([{'x': 1}], [{'x': 1, 'extra': 2}], [{}])
        self.assertEqual(result['passed'], 0)
        self.assertEqual(result['content_passed'], 1)
        self.assertEqual(result['extra_field_only_failures'], 1)
        result = self.run_case([{'x': 1}], [{'x': 2, 'extra': 2}], [{}])
        self.assertEqual(result['content_passed'], 0)

    def test_nonfinite_numbers_and_boolean_do_not_pass(self):
        for answer in [{'x': 'nan'}, {'x': True}, {'x': float('inf')}]:
            self.assertEqual(self.run_case([{'x': 1}], [answer], [{}])['passed'], 0)

    def test_timeout_with_zero_usage_is_not_reported_as_complete_cost(self):
        result = self.run_case([{'x': 1}], ['Error: The operation timed out.'], [{}], calls=0)
        self.assertEqual(result['passed'], 0)
        self.assertEqual(result['cost_usd'], 0)
        self.assertFalse(result['cost_complete'])


if __name__ == '__main__':
    unittest.main()
