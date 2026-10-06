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
from context_state_pilot import validate_case, SpendGuard, native_settings


class PilotContractTest(unittest.TestCase):
    def test_missing_prefix_or_evaluator_fields_are_rejected(self):
        manifest = {'domain': 'd', 'dataset_name': 'x', 'task_id': 't',
                    'longds_version': 'v1.1', 'split': 'lite', 'files': ['data/x.csv'],
                    'turns': [{'turn_id': 1, 'context': '', 'question': 'q'}]}
        self.assertEqual(validate_case(manifest, {'d/x/t'}, 1), 'd/x/t')
        with self.assertRaises(ValueError):
            validate_case(manifest, set(), 1)
        with self.assertRaises(ValueError):
            validate_case(manifest, {'d/x/t'}, 2)
        manifest['turns'][0]['answer'] = 'evaluator only'
        with self.assertRaises(ValueError):
            validate_case(manifest, {'d/x/t'}, 1)

    def test_context_ablation_changes_only_context_policy(self):
        catalog, trajectory = native_settings('catalog'), native_settings('trajectory')
        self.assertEqual({k: v for k, v in catalog.items() if k != 'taskContext'},
                         {k: v for k, v in trajectory.items() if k != 'taskContext'})
        self.assertEqual(catalog['contextWindowTokens'], 0)
        self.assertFalse(catalog['catalogStatistics'])
        self.assertEqual(catalog['catalogRecords'], 0)

    def test_unknown_cost_stops_future_dispatch(self):
        guard = SpendGuard(1)
        guard.add(.5)
        guard.check()
        with self.assertRaises(RuntimeError):
            guard.add(None)
        with self.assertRaises(RuntimeError):
            guard.check()


if __name__ == '__main__':
    unittest.main()
