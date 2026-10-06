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
import json
from pathlib import Path
import tempfile
from catalog_pilot import task_index, Kernel, assemble_messages


class ContextContractTest(unittest.TestCase):
    def test_catalog_preserves_the_full_answer_for_context_parity(self):
        answer = json.dumps({'rows': ['complete_answer'] * 200})
        task = {'turn_id': 1, 'completed': True, 'context': '', 'question': 'First',
                'answer': answer, 'sources': [], 'scripts': []}
        self.assertIn('Answer: ' + answer, task_index([task]))

    def test_trajectory_reuses_only_each_tasks_own_frames_and_boundary(self):
        task = {'turn_id': 1, 'completed': True, 'context': '', 'question': 'First',
                'answer': '{}', 'sources': [], 'scripts': [],
                'trajectory_messages': [{'role': 'user', 'content': 'First'},
                    {'role': 'assistant', 'content': 'PRIVATE_THOUGHT'},
                    {'role': 'tool', 'tool_call_id': 'c1', 'content': 'computed output'}]}
        catalog = assemble_messages('system', 'files', 'Second', [task], 'catalog')
        trajectory = assemble_messages('system', 'files', 'Second', [task], 'trajectory')
        self.assertNotIn('PRIVATE_THOUGHT', json.dumps(catalog))
        self.assertEqual(trajectory[2:-1], task['trajectory_messages'])
        self.assertEqual(catalog[-1], trajectory[-1])
        self.assertEqual(task['trajectory_messages'][0]['content'], 'First')

    def test_prior_task_keeps_its_complete_request_but_not_code(self):
        task = {'turn_id': 1, 'completed': True, 'context': 'Keep four decimals and rank all eligible markets.',
                'question': 'Build the working tables.', 'answer': '{"count":2}', 'sources': ['table'],
                'scripts': [{'script_id': 't1_s1', 'success': True, 'writes': ['table'],
                             'references': [], 'source': 'private old ReAct code'}]}
        rendered = task_index([task])
        self.assertIn(task['context'], rendered)
        self.assertIn(task['question'], rendered)
        self.assertNotIn('private old ReAct code', rendered)
        self.assertNotIn('Task 2', rendered)

    def test_task_catalog_has_saved_statistics_without_code_or_sample_records(self):
        task = {'turn_id': 1, 'completed': True, 'context': '', 'question': 'Build tables.',
                'answer': '{}', 'sources': ['table'], 'scripts': [{
                    'script_id': 't1_s1', 'success': True, 'writes': ['table'], 'references': [],
                    'source': 'PRIVATE_SCRIPT', 'output': 'PRIVATE_SAMPLE',
                    'written_bindings': {'table': {'summary': '100 rows × 2 columns; stats full; amount:float64(null=0/100)'}}}]}
        rendered = task_index([task])
        self.assertIn('table: 100 rows × 2 columns', rendered)
        self.assertNotIn('PRIVATE_SCRIPT', rendered)
        self.assertNotIn('PRIVATE_SAMPLE', rendered)

    def test_observer_export_does_not_parse_large_kernel_stdout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'kernel/kernel-1/pilot-observer/observer'
            source.mkdir(parents=True)
            (source / 'bindings.json').write_text(json.dumps({'table': {'version': 'v'}}))
            kernel = Kernel.__new__(Kernel)
            kernel.output = root
            kernel.execute = lambda code: 'unrelated kernel output\n'
            bindings = kernel.capture(root / 'observer')
            self.assertEqual(bindings['table']['version'], 'v')
            self.assertFalse(source.exists())


if __name__ == '__main__':
    unittest.main()
