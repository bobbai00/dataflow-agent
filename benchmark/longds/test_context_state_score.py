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

import gzip
import json
from pathlib import Path
import tempfile
import unittest
from context_state_score import structural_metrics


class StructuralMetricTest(unittest.TestCase):
    def test_engine_outcomes_count_real_nested_receipts_not_requested_ids(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            trace = {'steps': [{'toolResults': [{'isError': False, 'output': {'actions': [{
                'action': {'type': 'execute'}, 'status': 'ok', 'output': {'operators': [
                    {'id': 'old@1', 'status': 'ok', 'state': 'cached'},
                    {'id': 'consumer', 'status': 'ok', 'state': 'executed'},
                    {'id': 'failed', 'status': 'error', 'state': 'failed'}]}}, {
                'action': {'type': 'execute'}, 'status': 'error', 'output': 'Unknown target'}]}}]}]}
            with gzip.open(directory / 'react_steps.json.gz', 'wt') as stream:
                json.dump(trace, stream)
            metrics = structural_metrics({'native_actions': []}, directory, 'dataflow')
            self.assertEqual(metrics['operator_outcomes'], {'executed': 1, 'cached': 1})


if __name__ == '__main__':
    unittest.main()
