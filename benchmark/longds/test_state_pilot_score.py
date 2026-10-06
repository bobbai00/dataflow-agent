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

import json
from pathlib import Path
import tempfile
import unittest
import pandas as pd
from state_pilot_score import answer_components, actual_tables, branch_preservation, state_anchor


class PilotScoreTest(unittest.TestCase):
    def test_explicit_datetime_adapter_aligns_engine_json_to_python_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'oracle.parquet'
            pd.DataFrame({'id': ['A'], 'time': pd.to_datetime(['2025-04-23 13:01:02'])}).to_parquet(path)
            oracle = {'turns': [{'frames': [{'name': 'working', 'file': str(path), 'digest': 'd'}]}]}
            tables = {'main': {'records': [{'id': 'A', 'timestamp': '2025-04-23T13:01:02'}],
                              'complete': True, 'rows': 1, 'version': 'v'}}
            spec = {'oracle_turn': 1, 'oracle_name': 'working', 'actual_name': 'main',
                    'rename': {'timestamp': 'time'}, 'keys': ['id'], 'columns': ['time'],
                    'types': {'time': 'datetime'}}
            self.assertTrue(state_anchor(oracle, tables, spec)['match'])

    def test_unrecognized_answer_is_not_silently_scored_as_wrong(self):
        score = answer_components({'overlap_count': 4}, '{"different_shape":4}')
        self.assertIsNone(score['partial_score'])
        self.assertTrue(score['json_valid'])
        self.assertFalse(score['reference_exact'])

    def test_answer_components_separate_identity_value_and_order(self):
        expected = {'rows': [{'country':'A', 'score':1.0}, {'country':'B', 'score':2.0}]}
        actual = '{"rows":[{"country":"B","score":2.0},{"country":"A","score":1.0}]}'
        score = answer_components(expected, actual)['components']['rows']
        self.assertEqual(score['identity_f1'], 1)
        self.assertEqual(score['value_accuracy'], 1)
        self.assertEqual(score['order_accuracy'], 0)

    def test_moved_observer_bundle_uses_local_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            observer = directory / 'observer'
            observer.mkdir()
            pd.DataFrame({'key': ['A'], 'value': [1]}).to_pickle(observer / 'table.pkl')
            (observer / 'bindings.json').write_text(json.dumps({'table': {
                'file': '/old/export/table.pkl', 'rows': 1, 'version': 'v1'}}))
            tables, _ = actual_tables(directory, 'ordinary')
            self.assertEqual(Path(tables['table']['file']), observer / 'table.pkl')

    def test_branch_values_ignore_native_materialization_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            # Native execution can change result IDs without changing values.
            seed = {'snapshot': {'workflow': {'operators': [
                {'operatorID': 'main', 'nativeOp': {'revision': 'r1'}}]},
                'results': {'main': {'sampleRecords': [{'value': 1}],
                                    'truncated': False, 'totalRowCount': 1,
                                    'resultVersion': 'execution-before'}}}}
            after = {'snapshot': {'workflow': seed['snapshot']['workflow'],
                'results': {'main': {'sampleRecords': [{'value': 1}],
                                    'truncated': False, 'totalRowCount': 1,
                                    'resultVersion': 'execution-after'}}}}
            import gzip
            for name, capture in [('seed-observer', seed), ('observer', after)]:
                folder = directory / name
                folder.mkdir()
                with gzip.open(folder / 'capture.json.gz', 'wt') as stream:
                    json.dump(capture, stream)
            tables, capture = actual_tables(directory, 'dataflow')
            result = branch_preservation(directory, directory, 'dataflow', tables, capture)
            self.assertEqual(result['definitions']['changed'], [])
            self.assertEqual(result['values']['changed'], [])
            self.assertEqual(result['values']['preserved'], ['main'])

    def test_incomplete_observation_does_not_certify_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'oracle.parquet'
            pd.DataFrame({'key': ['A', 'B'], 'value': [1, 2]}).to_parquet(path)
            oracle = {'turns': [{'frames': [{'name': 'working', 'file': str(path), 'digest': 'd'}]}]}
            tables = {'main': {'records': [{'key': 'A', 'value': 1}],
                              'complete': False, 'rows': 2, 'version': 'v'}}
            result = state_anchor(oracle, tables, {'oracle_turn': 1,
                'oracle_name': 'working', 'actual_name': 'main',
                'keys': ['key'], 'columns': ['value']})
            self.assertIsNone(result['match'])
            self.assertEqual(result['coverage'], 0)
            self.assertEqual(result['reason'], 'incomplete_observation')

    def test_explicit_adapter_selects_rank_over_unrelated_old_rank(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'oracle.parquet'
            pd.DataFrame({'country': ['A'], 'current_rank': [1]}).to_parquet(path)
            oracle = {'turns': [{'frames': [{'name': 'working', 'file': str(path), 'digest': 'd'}]}]}
            # Historical report columns coexist with today's rank in real tables.
            tables = {'main': {'records': [{'market': 'A', 'current_rank': 9,
                                           'new_rank': 1}],
                              'complete': True, 'rows': 1, 'version': 'v'}}
            result = state_anchor(oracle, tables, {'oracle_turn': 1,
                'oracle_name': 'working', 'actual_name': 'main',
                'rename': {'market': 'country', 'new_rank': 'current_rank'},
                'keys': ['country'], 'columns': ['current_rank']})
            self.assertTrue(result['match'])

    def test_answer_adapter_keeps_optional_details_separate(self):
        expected = {'leaders': [{'country': 'Hong Kong', 'movement': 1, 'recovery': .6476}]}
        adapter = {'leaders': {'path': ['result', 'rows'], 'keys': ['country'],
            'rename': {'market': 'country', 'score': 'recovery', 'rank_move': 'movement'},
            'value_maps': {'country': {'hongkong': 'Hong Kong'}},
            'value_fields': [], 'extra_fields': ['movement', 'recovery'], 'ordered': True}}
        score = answer_components(expected,
            '{"result":{"rows":[{"market":"hongkong","score":0.6476,"rank_move":0}]}}',
            adapter)['components']['leaders']
        self.assertEqual(score['identity_f1'], 1)
        self.assertEqual(score['partial_score'], 1)
        self.assertEqual(score['reported_extra_values']['matched'], 1)
        self.assertEqual(score['reported_extra_values']['total'], 2)


if __name__ == '__main__':
    unittest.main()
