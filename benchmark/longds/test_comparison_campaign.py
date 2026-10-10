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
import subprocess
import sys

import pytest

from comparison_campaign import completed_artifacts, process_matches, validate_input_policy, reuse_control


def test_full_input_policy_drift_is_rejected_before_launch():
    protocol = {'full_input_policy': {'budget_tokens': 64000, 'scale': .92}, 'max_model_calls_per_turn': 40}
    env = {'MODEL_INPUT_TOKEN_BUDGET': '64000', 'MODEL_INPUT_TOKEN_SCALE': '.92', 'MODEL_MAX_CALLS_PER_TURN': '40'}
    validate_input_policy(protocol, env)
    for field, value in [('MODEL_INPUT_TOKEN_BUDGET', '0'), ('MODEL_INPUT_TOKEN_SCALE', '1'),
                         ('MODEL_MAX_CALLS_PER_TURN', '0')]:
        with pytest.raises(ValueError, match='policy'):
            validate_input_policy(protocol, {**env, field: value})
    validate_input_policy({}, {})


def test_reuse_keeps_the_predeclared_control_including_its_wrong_answers(tmp_path):
    source = tmp_path / 'bounded/runs/history-r1/task'
    source.mkdir(parents=True)
    identity = {'task': 'task', 'arm': 'history', 'rep': 1, 'turns_total': 2}
    source.joinpath('job.json').write_text(json.dumps({**identity, 'settings': {'stateLedger': False}}))
    source.joinpath('results_eval.json').write_text(json.dumps([
        {'turn_id': 1, 'judge': {'score': 0}}, {'turn_id': 2, 'judge': {'score': 1}}]))
    job = {**identity, 'reuse_from': str(source), 'settings': {'stateLedger': False}}
    destination = tmp_path / 'ledger/runs/history-r1/task'
    before = source.joinpath('results_eval.json').read_bytes()
    reuse_control(job, destination)
    assert destination.is_symlink() and destination.resolve() == source.resolve()
    assert completed_artifacts(destination, 2)
    assert source.joinpath('results_eval.json').read_bytes() == before
    with pytest.raises(ValueError, match='settings'):
        reuse_control({**job, 'settings': {'stateLedger': True}}, tmp_path / 'bad')
    with pytest.raises(ValueError, match='incomplete'):
        reuse_control({**job, 'turns_total': 3}, tmp_path / 'missing')
    for field, value in [('task', 'another-task'), ('rep', 2), ('arm', 'baseline')]:
        with pytest.raises(ValueError, match='identity'):
            reuse_control({**job, field: value}, tmp_path / field)


def test_recovery_uses_completeness_and_preserves_incorrect_answers(tmp_path):
    source = tmp_path / 'results_eval.json'
    assert not completed_artifacts(tmp_path, 2)
    rows = [{'turn_id': 1, 'judge': {'score': 0}}, {'turn_id': 2, 'judge': {'score': 1}}]
    source.write_text(json.dumps(rows))
    assert completed_artifacts(tmp_path, 2)
    rows[1]['judge']['score'] = None
    source.write_text(json.dumps(rows))
    assert not completed_artifacts(tmp_path, 2)
    rows[1] = rows[0]
    source.write_text(json.dumps(rows))
    assert not completed_artifacts(tmp_path, 2)


def test_pid_reuse_does_not_adopt_an_unrelated_process(tmp_path):
    proc = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(10)'])
    try:
        assert not process_matches(proc.pid, tmp_path)
    finally:
        proc.terminate()
        proc.wait()
