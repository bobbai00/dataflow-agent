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

import pytest
import comparison_adjudicate as recovery


def write_results(folder):
    path = folder / 'results_eval.json'
    rows = [{'turn_id': tid, 'context': 'context', 'question': 'question', 'solution': 'answer',
             'ground_truth': 'reference', 'judge': {'score': score, 'raw_responses': ['original']}}
            for tid, score in [(1, 0), (2, None), (3, 1)]]
    path.write_text(json.dumps(rows))
    return path, rows


def overlay(path, verdict):
    return {'results_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'recoveries': [{'turn_id': 2, 'verdict': verdict}]}


def test_recovery_preserves_original_artifacts_and_existing_scores(tmp_path):
    path, rows = write_results(tmp_path)
    before = path.read_bytes()
    (tmp_path / 'judge-recovery.json').write_text(json.dumps(overlay(path, {'score': 1})))
    result = recovery.resolved_rows(tmp_path)
    assert [row['judge']['score'] for row in result] == [0, 1, 1]
    assert result[1]['judge_original'] == rows[1]['judge']
    assert result[1]['judge_recovered']
    assert result[0] == rows[0] and result[2] == rows[2]
    assert path.read_bytes() == before


def test_stale_duplicate_or_existing_score_overlays_are_rejected(tmp_path):
    path, _ = write_results(tmp_path)
    data = overlay(path, {'score': 0})
    destination = tmp_path / 'judge-recovery.json'
    for mutation in ['hash', 'duplicate', 'scored']:
        invalid = json.loads(json.dumps(data))
        if mutation == 'hash':
            invalid['results_sha256'] = 'stale'
        elif mutation == 'duplicate':
            invalid['recoveries'] *= 2
        else:
            invalid['recoveries'][0]['turn_id'] = 1
        destination.write_text(json.dumps(invalid))
        with pytest.raises(ValueError):
            recovery.resolved_rows(tmp_path)


def test_only_unjudged_answers_get_one_recovery_attempt(tmp_path, monkeypatch):
    path, _ = write_results(tmp_path)
    calls = []
    def judge(client, model, prompt, row, **kwargs):
        calls.append((row['turn_id'], kwargs))
        return {'score': None, 'error_detail': 'still unparseable', 'raw_responses': ['new response']}
    monkeypatch.setattr(recovery, 'judge_one', judge)
    recovery.recover_folder(tmp_path, tmp_path / 'cache', object(), 'same-judge', 'same-prompt')
    recovery.recover_folder(tmp_path, tmp_path / 'cache', object(), 'same-judge', 'same-prompt')
    assert calls == [(2, {'retries': 1, 'max_tokens': 16000})]
    assert recovery.resolved_rows(tmp_path)[1]['judge']['score'] is None
    assert json.loads(path.read_text())[1]['judge']['raw_responses'] == ['original']


def test_failed_serialization_never_advertises_a_partial_receipt(tmp_path):
    target = tmp_path / 'receipt.json'
    with pytest.raises(TypeError):
        recovery.write_once(target, {'status': 'started', 'invalid': object()})
    assert not target.exists()
    recovery.write_once(target, {'status': 'complete'})
    before = target.read_bytes()
    with pytest.raises(FileExistsError):
        recovery.write_once(target, {'status': 'replacement'})
    assert target.read_bytes() == before
