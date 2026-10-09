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

import unittest
from versions_run_report import paired_results


class PairedReportTest(unittest.TestCase):
    def test_cost_comparison_uses_only_questions_both_solvers_got_right(self):
        metrics = []
        for turn, native_score, python_score in [(1, 1, 1), (2, 1, 0), (3, 0, 1), (4, 1, None)]:
            for agent, score, cost in [('dataflow', native_score, .2), ('python', python_score, .3)]:
                metrics.append({'model': 'terra', 'context': 'catalog', 'task': 'case', 'turn_id': turn,
                                'agent': agent, 'judge': {'score': score}, 'stats': {'cost_usd': cost}})
        result = paired_results(metrics)[0]
        self.assertEqual(result['judged_pairs'], 3)
        self.assertEqual(result['both_correct'], 1)
        self.assertEqual(result['dataflow_only'], 1)
        self.assertEqual(result['python_only'], 1)
        self.assertAlmostEqual(result['dataflow_cost'], .2)
        self.assertAlmostEqual(result['python_cost'], .3)


if __name__ == '__main__':
    unittest.main()
