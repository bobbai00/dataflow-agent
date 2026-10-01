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

from pathlib import Path

from input_snapshot import snapshot_inputs


def test_snapshot_excludes_outputs_left_inside_source_directory(tmp_path):
    source = tmp_path / 'data' / 'task'
    source.mkdir(parents=True)
    (source / 'input.csv').write_text('x\n3\n7\n')
    (source / 'old_answer.csv').write_text('answer\n1234567\n')
    manifest = {'data_dir': 'data/task', 'files': ['data/task/input.csv'],
                'turns': [{'turn_id': 1, 'question': 'Count the rows.'}]}
    target = tmp_path / 'clean' / 'task'
    prepared = snapshot_inputs(manifest, tmp_path, target)
    assert prepared['data_dir'] == 'clean/task'
    assert prepared['files'] == ['clean/task/input.csv']
    assert (target / 'input.csv').read_bytes() == (source / 'input.csv').read_bytes()
    assert not (target / 'old_answer.csv').exists()
    assert (source / 'old_answer.csv').exists()
    assert prepared['turns'] == manifest['turns']
    assert manifest['data_dir'] == 'data/task'
