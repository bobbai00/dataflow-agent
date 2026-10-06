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
from unittest.mock import patch
from versions_reference_study import classify, apply_edit, compact_capture


class ReferenceStudyTest(unittest.TestCase):
    def test_hidden_handle_renaming_does_not_change_the_semantic_definition(self):
        def capture(handle, revision):
            return {'snapshot': {'workflow': {'operators': [
                {'operatorID': handle, 'savedResult': {'operatorId': 'source', 'taskId': 1}},
                {'operatorID': 'scores', 'nativeOp': {'type': 'Process', 'inputs': [handle],
                                                     'properties': {'fn': 'score'}, 'revision': revision}}]}}}
        old = compact_capture(capture('_saved_first', 'r1'))['scores']
        replayed = compact_capture(capture('_saved_second', 'r2'))['scores']
        self.assertEqual(old['definition'], replayed['definition'])

    def test_immutable_materialization_is_hashed_once_across_task_captures(self):
        capture = {'snapshot': {'workflow': {'operators': [{'operatorID': 'scores'}]},
                                'results': {'scores': {'state': 'Completed', 'resultVersion': {'id': 'v1'}}}},
                   'observerTables': {'scores': {'complete': True, 'rows': [{'score': 1}]}}}
        cache = {}
        with patch('versions_reference_study.rows_digest', return_value='digest') as hashing:
            self.assertEqual(compact_capture(capture, cache)['scores']['value_hash'], 'digest')
            self.assertEqual(compact_capture(capture, cache)['scores']['value_hash'], 'digest')
            self.assertEqual(hashing.call_count, 1)
            capture['snapshot']['results']['scores']['resultVersion']['id'] = 'v2'
            compact_capture(capture, cache)
            self.assertEqual(hashing.call_count, 2)

    def table(self, value, version='v1'):
        return {'present': True, 'available': True, 'value_hash': value,
                'result_version': version, 'definition': 'rule1', 'inputs': []}

    def test_a_later_same_turn_update_does_not_make_an_earlier_read_discriminating(self):
        state = {'scores': self.table('same')}
        ref = classify(('read', 'scores', 1), 2, {'scores': self.table('same')}, state)
        apply_edit(state, {'changes': [{'operation': 'update_operator', 'operator_id': 'scores'}],
                           'invalidated_results': ['scores']})
        self.assertEqual(ref['verdict'], 'same_as_current')
        self.assertEqual(classify(('read', 'scores', 1), 2, {'scores': self.table('same')}, state)['verdict'], 'current_result_unknown')

    def test_unsaved_results_are_not_filled_from_an_earlier_task(self):
        self.assertEqual(classify(('read', 'scores', 2), 3, {}, {})['verdict'], 'historical_result_unavailable')

    def test_different_execution_ids_do_not_prove_different_values(self):
        result = classify(('read', 'scores', 1), 2, {'scores': self.table('same', 'v1')}, {'scores': self.table('same', 'v2')})
        self.assertEqual(result['verdict'], 'same_as_current')

    def test_missing_observer_data_is_not_a_deleted_operator(self):
        current = {'scores': {'present': True, 'available': False}}
        self.assertEqual(classify(('edge', 'scores', 1), 3, {'scores': self.table('same')}, current)['verdict'], 'current_result_unknown')
        self.assertEqual(classify(('edge', 'scores', 1), 3, {'scores': self.table('same')}, {})['verdict'], 'operator_absent_now')

    def test_definition_differences_are_separate_from_table_differences(self):
        saved = self.table('same')
        current = {**saved, 'definition': 'rule2'}
        self.assertEqual(classify(('read_definition', 'scores', 1), 2, {'scores': saved}, {'scores': current})['verdict'], 'definition_differs')
        self.assertEqual(classify(('read', 'scores', 1), 2, {'scores': saved}, {'scores': current})['verdict'], 'same_as_current')
