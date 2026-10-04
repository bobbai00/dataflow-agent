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
import hashlib
import json
from pathlib import Path

import pytest
import comparison_ledger as ledger
import state_comparison


def ledger_fixture(tmp_path, monkeypatch, budget=64000):
    root = tmp_path / 'root'
    source = root / 'benchmark/longds/comparison_ledger.py'
    source.parent.mkdir(parents=True)
    source.write_text('frozen ledger source')
    runtime = root / 'agent-service/src/runtime.py'
    runtime.parent.mkdir(parents=True)
    runtime.write_text('frozen runtime')
    sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
    monkeypatch.setattr(ledger, 'ROOT', root)
    monkeypatch.setattr(ledger, '__file__', str(source))
    monkeypatch.setattr(ledger, 'digest', sha)
    monkeypatch.setattr(state_comparison, 'ROOT', root)
    monkeypatch.setattr(state_comparison, 'digest', sha)
    output = tmp_path / 'output'
    bounded = output / 'bounded'
    bounded.mkdir(parents=True)
    settings = {'stateHistory': True, 'stateLedger': False, 'retrievalViews': ['sample_stats', 'full']}
    jobs = [{'phase': 'bounded', 'task': task, 'arm': arm, 'rep': rep, 'turns_total': 8,
             'settings': settings if arm == 'history' else None}
            for task in ['task/a', 'task/b'] for rep in [1, 2, 3] for arm in ['history', 'dsgym']]
    protocol = {'jobs': jobs, 'source_hashes': {'agent-service/src/runtime.py': sha(runtime)},
                'full_input_policy': {'budget_tokens': budget, 'scale': .92},
                'input_files': {'data/fixture.csv': {'sha256': 'input'}},
                'prompt_hashes': {'task/a': 'prompt-a', 'task/b': 'prompt-b'}}
    (bounded / 'manifest.json').write_text(json.dumps(protocol))
    return output, protocol, runtime


def test_ledger_predeclares_every_control_before_results_exist(tmp_path, monkeypatch):
    output, bounded, _ = ledger_fixture(tmp_path, monkeypatch)
    ledger.freeze(output)
    result = json.loads((output / 'ledger/manifest.json').read_text())
    assert not (output / 'bounded/runs').exists()
    controls = [job for job in result['jobs'] if 'reuse_from' in job]
    added = [job for job in result['jobs'] if 'reuse_from' not in job]
    assert len(controls) == len(added) == result['new_solver_jobs'] == 6
    assert result['new_solver_turns'] == 48
    for control in controls:
        match = next(job for job in added if (job['task'], job['rep']) == (control['task'], control['rep']))
        assert match['arm'] == 'ledger'
        assert match['settings'] == {**control['settings'], 'stateLedger': True}
        assert control['reuse_from'].endswith(f"bounded/runs/history-r{control['rep']}/{control['task'].replace('/', '__')}")
    assert result['input_files'] == bounded['input_files']
    assert result['prompt_hashes'] == bounded['prompt_hashes']
    assert (output / 'ledger/source/agent-service/src/runtime.py').read_text() == 'frozen runtime'
    with pytest.raises(FileExistsError):
        ledger.freeze(output)


def test_ledger_refuses_source_drift_before_creating_a_phase(tmp_path, monkeypatch):
    output, _, runtime = ledger_fixture(tmp_path, monkeypatch)
    runtime.write_text('changed runtime')
    with pytest.raises(RuntimeError, match='Frozen source changed'):
        ledger.freeze(output)
    assert not (output / 'ledger').exists()


def test_ledger_refuses_a_different_context_policy(tmp_path, monkeypatch):
    output, _, _ = ledger_fixture(tmp_path, monkeypatch, budget=0)
    with pytest.raises(ValueError, match='64k'):
        ledger.freeze(output)
    assert not (output / 'ledger').exists()
