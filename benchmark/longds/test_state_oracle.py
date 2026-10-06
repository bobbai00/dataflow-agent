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
import pandas as pd
from state_oracle import (compare_state_table, dependency_agreement, classify_update,
                          annotated_closure, script_answer_references, native_answer_references)


class StateOracleTest(unittest.TestCase):
    def test_native_saved_handle_traverses_the_historical_graph_not_todays_rule(self):
        snapshot = {'workflow': {'operators': [
            {'operatorID': 'answer', 'nativeOp': {'revision': 'a'}},
            {'operatorID': 'saved', 'savedResult': {'operatorId': 'score', 'taskId': 1},
             'nativeOp': {'revision': 'h'}}], 'links': [
                {'source': {'operatorID': 'saved'}, 'target': {'operatorID': 'answer'}}]}}
        tasks = [{'task_id': 1, 'operators': [
                    {'operator_id': 'score', 'change': 'created', 'revision': 'old', 'inputs': ['raw']},
                    {'operator_id': 'raw', 'change': 'created', 'revision': 'r', 'inputs': []}]},
                 {'task_id': 2, 'operators': [
                    {'operator_id': 'score', 'change': 'updated', 'revision': 'new', 'inputs': ['other']}]},
                 {'task_id': 3, 'operators': [{'operator_id': 'answer', 'change': 'created', 'revision': 'a'}],
                  'output_roots': {'basis': 'answer', 'roots': [{'operator_id': 'answer'}]}}]
        refs = native_answer_references({'snapshot': snapshot, 'history': {'tasks': tasks}}, 3)
        self.assertEqual({r['task_id'] for r in refs}, {1})
        self.assertEqual({r['operator_id'] for r in refs}, {'score', 'raw'})

    def test_table_state_is_keyed_and_numeric_tolerant(self):
        a = pd.DataFrame({'country': ['A', 'B'], 'score': [1., 2.]})
        b = pd.DataFrame({'country': ['B', 'A'], 'score': [2., 1. + 1e-10], 'extra': [0, 0]})
        out = compare_state_table(a, b, ['country'], ['score'])
        self.assertTrue(out['match'])

    def test_wrong_values_and_duplicates_do_not_pass(self):
        a = pd.DataFrame({'k': ['a'], 'v': [1]})
        for b in (pd.DataFrame({'k': ['a'], 'v': [2]}), pd.DataFrame({'k': ['a','a'], 'v': [1,1]})):
            self.assertFalse(compare_state_table(a, b, ['k'], ['v'])['match'])

    def test_missing_observation_is_unknown(self):
        a = pd.DataFrame({'k': ['a'], 'v': [1]})
        self.assertIsNone(compare_state_table(a, None, ['k'], ['v'])['match'])

    def test_missing_key_is_wrong_with_partial_value_credit(self):
        expected = pd.DataFrame({'k': ['a', 'b'], 'v': [1, 2]})
        actual = pd.DataFrame({'k': ['a'], 'v': [1]})
        out = compare_state_table(expected, actual, ['k'], ['v'])
        self.assertFalse(out['match'])
        self.assertEqual(out['key_recall'], .5)
        self.assertEqual(out['value_score'], .5)

    def test_consultation_is_not_computational_lineage(self):
        refs = [{'task_id': 2, 'kind': 'compute'}, {'task_id': 4, 'kind': 'read'},
                {'task_id': 8, 'kind': 'consultation'}, {'task_id': None, 'kind': 'read'}]
        out = dependency_agreement(refs, [2,4])
        self.assertEqual(out['precision'], 1)
        self.assertEqual(out['recall'], 1)
        self.assertEqual(out['unresolved'], 1)
        self.assertEqual(out['coverage'], 2/3)

    def test_unknown_answer_lineage_is_not_zero_recall(self):
        out = dependency_agreement([{'task_id': None, 'kind': 'definition'}], [1, 2])
        self.assertIsNone(out['precision'])
        self.assertIsNone(out['recall'])
        self.assertEqual(out['coverage'], 0)

    def test_changed_rule_old_output_is_stale(self):
        self.assertEqual(classify_update(True, False, True), 'stale')
        self.assertEqual(classify_update(True, True, False), 'updated')
        self.assertEqual(classify_update(True, None, None), 'unknown')
        self.assertEqual(classify_update(False, True, True), 'unchanged')

    def test_dependency_closure_validates_annotation_edges(self):
        turns = [{'turn_id': 1, 'depends_tasks': []}, {'turn_id': 2, 'depends_tasks': [1]},
                 {'turn_id': 3, 'depends_tasks': [2]}]
        self.assertEqual(annotated_closure(turns, 3), [1, 2])
        with self.assertRaises(ValueError):
            annotated_closure([{'turn_id': 1, 'depends_tasks': [2]}], 1)

    def test_script_lineage_follows_answer_roots_and_excludes_exploration(self):
        from script_catalog import ScriptCatalog
        cat = ScriptCatalog({})
        a = cat.execute(1, 'x = 1')
        b = cat.execute(2, 'unrelated = 9')
        c = cat.execute(3, 'answer_value = x + 1')
        current = {'turn_id': 3, 'scripts': [c], 'source_bindings': {'answer_value': cat.bindings['answer_value']}}
        refs = script_answer_references([{'scripts': [a]}, {'scripts': [b]}, current], current)
        self.assertEqual({r['task_id'] for r in refs}, {1})

    def test_native_lineage_uses_answer_graph_without_unrelated_operators(self):
        snapshot = {'workflow': {'operators': [
            {'operatorID': n, 'nativeOp': {'revision': 'r'}} for n in ['raw', 'score', 'unrelated']],
            'links': [{'source': {'operatorID': 'raw'}, 'target': {'operatorID': 'score'}}]}}
        tasks = [
            {'task_id': 1, 'operators': [{'operator_id': 'raw', 'revision': 'r', 'change': 'created'}]},
            {'task_id': 2, 'operators': [{'operator_id': 'unrelated', 'revision': 'r', 'change': 'created'}]},
            {'task_id': 3, 'operators': [{'operator_id': 'score', 'revision': 'r', 'change': 'created'}],
             'output_roots': {'basis': 'answer', 'roots': [{'operator_id': 'score'}]}}]
        refs = native_answer_references({'snapshot': snapshot, 'history': {'tasks': tasks}}, 3)
        self.assertEqual({r['task_id'] for r in refs}, {1})


if __name__ == '__main__':
    unittest.main()
