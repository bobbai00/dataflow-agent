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
import shutil
import context_state_pilot
from context_state_pilot import validate_case, SpendGuard, native_settings, attempt_spend, solver_signature, visible_tables


class PilotContractTest(unittest.TestCase):
    def test_an_unchanged_observer_table_is_stored_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            earlier, current = Path(temporary) / 't01/observer', Path(temporary) / 't02/observer'
            earlier.mkdir(parents=True); current.mkdir(parents=True)
            (earlier / 'same.pkl').write_bytes(b'table bytes')
            (current / 'same.pkl').write_bytes(b'table bytes')
            (earlier / 'changed.pkl').write_bytes(b'old rows')
            (current / 'changed.pkl').write_bytes(b'new rows')
            context_state_pilot.share_unchanged_tables(current, earlier)
            self.assertTrue((current / 'same.pkl').samefile(earlier / 'same.pkl'))
            self.assertFalse((current / 'changed.pkl').samefile(earlier / 'changed.pkl'))
            self.assertEqual((current / 'changed.pkl').read_bytes(), b'new rows')
            self.assertEqual(sorted(p.name for p in current.iterdir()), ['changed.pkl', 'same.pkl'])

    def test_resume_preserves_an_answer_saved_before_the_observer_failed(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            first = {'turn_id': 1, 'completed': True}
            (run / 'records.json').write_text(json.dumps([first]))
            for number, completed in [(2, True), (3, False)]:
                directory = run / f't{number:02d}'
                directory.mkdir()
                (directory / 'record.json').write_text(json.dumps({'turn_id': number, 'completed': completed}))
            self.assertEqual([r['turn_id'] for r in context_state_pilot.completed_prefix(run)], [1, 2])

    def test_resume_shares_immutable_tables_without_sharing_mutable_records(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, target = root / 'source', root / 'target'
            (source / 'observer').mkdir(parents=True)
            (source / 'observer/table.pkl').write_bytes(b'immutable table')
            (source / 'record.json').write_text('{}')
            shutil.copytree(source, target, copy_function=context_state_pilot.copy_checkpoint_file)
            self.assertEqual((source / 'observer/table.pkl').stat().st_ino,
                             (target / 'observer/table.pkl').stat().st_ino)
            (target / 'record.json').write_text('{"reused_from":"source"}')
            self.assertEqual((source / 'record.json').read_text(), '{}')

    def test_replay_compares_visible_tables_not_internal_materialization_ids(self):
        capture = {'snapshot': {'workflow': {'operators': [
            {'operatorID': '_saved_handle', 'savedResult': {'taskId': 1}},
            {'operatorID': '_saved_user_table'}]}},
            'observerTables': {'_saved_handle': {'rows': []}, '_saved_user_table': {'rows': [1]}}}
        self.assertEqual(list(visible_tables(capture)), ['_saved_user_table'])

    def test_resume_budget_includes_archives_but_not_reused_prefixes(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            for name, record in [('old.failed-test', {'stats': {'cost_usd': .7}}),
                                 ('new', {'stats': {'cost_usd': .7}, 'reused_from': 'old/t01'}),
                                 ('other', {'stats': {'cost_usd': .4}})]:
                run = folder / 'runs' / name
                run.mkdir(parents=True)
                (run / 'records.json').write_text(json.dumps([record]))
            total = attempt_spend(folder)
            self.assertAlmostEqual(total['known_cost_usd'], 1.1)
            guard = SpendGuard(1, initial=total['known_cost_usd'])
            with self.assertRaises(RuntimeError):
                guard.check()

    def test_arm_spending_includes_only_its_current_and_archived_attempts(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            for name, cost in [('native', .1), ('native.failed-old', .2), ('python', .4)]:
                run = folder / 'runs' / name
                run.mkdir(parents=True)
                (run / 'records.json').write_text(json.dumps([{'stats': {'cost_usd': cost}}]))
            self.assertAlmostEqual(attempt_spend(folder, {'native'})['known_cost_usd'], .3)

    def test_solver_prompt_and_loop_changes_are_not_resume_exempt(self):
        source = 'SHARED = "one"\ndef solve():\n return 1\nclass Kernel:\n def __init__(self):\n  self.root="old"\n'
        wiring = source.replace('self.root="old"', 'self.root="new"')
        self.assertEqual(solver_signature(source, 'catalog_pilot.py'), solver_signature(wiring, 'catalog_pilot.py'))
        self.assertNotEqual(solver_signature(source, 'catalog_pilot.py'), solver_signature(source.replace('"one"', '"two"'), 'catalog_pilot.py'))
        self.assertNotEqual(solver_signature(source, 'catalog_pilot.py'), solver_signature(source.replace('return 1', 'return 2'), 'catalog_pilot.py'))

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
