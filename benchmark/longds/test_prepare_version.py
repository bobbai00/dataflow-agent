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

from prepare import resolve_task_selection, prepare_one


class VersionPreparationTest(unittest.TestCase):
    def test_v11_does_not_fall_back_to_legacy(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'task/longds').mkdir(parents=True)
            (root / 'task/longds/task_list.json').write_text('[]')
            with self.assertRaises(FileNotFoundError):
                resolve_task_selection(root, 'v1.1', 'lite')

    def test_versioned_preparation_keeps_private_fields_out(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tasks = root / 'task/longds_v1.1'
            source = tasks / 'business/example/task1'
            source.mkdir(parents=True)
            entry = {'task_domain': 'business', 'dataset_name': 'example', 'task_id': 'task1'}
            (tasks / 'task_list_lite.json').write_text(json.dumps([entry]))
            (source / 'task.json').write_text(json.dumps([
                {'turn_id': 1, 'context': 'scope', 'question': 'count', 'answer': {'n': 2}, 'code': 'SECRET_REFERENCE'}]))
            (source / 'metadata.json').write_text(json.dumps([
                {'turn': 1, 'state_type': ['Initial'], 'depends_tasks': [], 'depends_span': []}]))
            data = root / 'data/business/example/task1/data'
            data.mkdir(parents=True)
            (data / 'input.csv').write_text('x\n1\n2\n')
            selected, listed = resolve_task_selection(root, 'v1.1', 'lite')
            self.assertEqual(selected, tasks)
            self.assertEqual(listed, [entry])
            manifest = prepare_one(entry, None, task_root=selected, output_root=root / 'prepared',
                                   data_root=root / 'data', version='v1.1', split='lite')
            self.assertEqual(manifest['longds_version'], 'v1.1')
            self.assertEqual(manifest['split'], 'lite')
            public = json.dumps(manifest)
            for field in ('SECRET_REFERENCE', 'state_type', 'depends_tasks', '"answer"'):
                self.assertNotIn(field, public)

    def test_path_components_are_validated(self):
        with self.assertRaises(ValueError):
            resolve_task_selection(Path('/tmp'), '../private', 'lite')


if __name__ == '__main__':
    unittest.main()
