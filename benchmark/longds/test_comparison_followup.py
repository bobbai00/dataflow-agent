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
import pytest
import comparison_followup as followup
from comparison_followup import phase_complete


def test_followup_distinguishes_running_failed_and_unjudged_conditions(tmp_path, monkeypatch):
    assert not phase_complete(tmp_path)
    path = tmp_path / 'progress.json'
    monkeypatch.setattr(followup, 'existing_controller', lambda folder: 123)
    path.write_text(json.dumps({'status': 'running', 'controller_pid': 123}))
    assert not phase_complete(tmp_path)
    path.write_text(json.dumps({'status': 'completed_with_failures'}))
    with pytest.raises(ValueError, match='failures'):
        phase_complete(tmp_path)
    job = {'task': 'task', 'rep': 1, 'arm': 'history', 'turns_total': 1}
    path.write_text(json.dumps({'status': 'complete', 'completed': [job]}))
    (tmp_path / 'manifest.json').write_text(json.dumps({'jobs': [job]}))
    folder = tmp_path / 'runs/history-r1/task'
    folder.mkdir(parents=True)
    result = folder / 'results_eval.json'
    result.write_text(json.dumps([{'turn_id': 1, 'judge': {'score': None}}]))
    with pytest.raises(ValueError, match='incomplete'):
        phase_complete(tmp_path)
    result.write_text(json.dumps([{'turn_id': 1, 'judge': {'score': 0}}]))
    assert phase_complete(tmp_path)


def test_dead_context_controller_cannot_leave_followup_waiting_forever(tmp_path, monkeypatch):
    path = tmp_path / 'progress.json'
    path.write_text(json.dumps({'status': 'running', 'controller_pid': 123}))
    monkeypatch.setattr(followup, 'existing_controller', lambda folder: None)
    with pytest.raises(ValueError, match='controller'):
        phase_complete(tmp_path)
