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
import gzip

import pytest

from scope_verification_report import attempt_path, paired_cases, validate_settings, descriptive_metrics, interrupted_spend, scope_metrics, judge_spend


def test_interruption_replacement_needs_registration_for_both_conditions(tmp_path):
    job = {'task': 'sports/test/task1', 'arm': 'before', 'rep': 1}
    original = tmp_path / 'longds-before/runs/before-r1/sports__test__task1'
    assert attempt_path(tmp_path, 'longds', job) == original
    registration = {'recovery': [{'arm': 'before', 'original': str(original), 'recovery_phase': 'recovery-before'}]}
    (tmp_path / 'interrupt-recovery-20261004.json').write_text(json.dumps(registration))
    with pytest.raises(ValueError, match='Both conditions'):
        attempt_path(tmp_path, 'longds', job, recovered=True)


def test_recovery_view_preserves_original_artifacts_and_selects_only_registered_job(tmp_path):
    task = 'sports/test/task1'
    registrations = [{'arm': arm, 'original': str(tmp_path / f'longds-{arm}/runs/{arm}-r1/sports__test__task1'),
                      'recovery_phase': f'recovery-{arm}'} for arm in ['before', 'after']]
    (tmp_path / 'interrupt-recovery-20261004.json').write_text(json.dumps({'recovery': registrations}))
    for arm in ['before', 'after']:
        job = {'task': task, 'arm': arm, 'rep': 1}
        assert attempt_path(tmp_path, 'longds', job, recovered=True) == tmp_path / f'recovery-{arm}/runs/{arm}-r1/sports__test__task1'
        job['rep'] = 2
        assert attempt_path(tmp_path, 'longds', job, recovered=True) == tmp_path / f'longds-{arm}/runs/{arm}-r2/sports__test__task1'


def test_setting_drift_cannot_be_hidden_by_matching_model_and_inputs():
    job = {'task': 'fixture', 'rep': 1, 'settings': {'stateHistory': True}}
    validate_settings({'jobs': [job]}, {'jobs': [dict(job)]})
    with pytest.raises(ValueError, match='settings'):
        validate_settings({'jobs': [job]}, {'jobs': [{**job, 'settings': {'stateHistory': False}}]})


def test_case_selection_retains_unknown_costs_and_requires_both_judgments():
    rows = [{'task': 'fixture', 'rep': 1, 'turn_id': 1, 'arm': arm, 'score': score,
             'stats': {'cost_usd': None}, 'question': 'Calculate', 'state_type': []}
            for arm, score in [('before', 0), ('after', 1)]]
    case = paired_cases(rows)[0]
    assert case['category'] == 'after_only' and case['costs']['after'] is None
    rows[1]['score'] = None
    assert paired_cases(rows) == []


def test_latency_retains_unknowns_and_does_not_filter_on_judge_success():
    rows = [
        {'arm': 'before', 'task': 'a', 'rep': 1, 'turn_id': 1, 'score': 0,
         'solution': 'wrong', 'success': True, 'stats': {'elapsed_seconds': 10}},
        {'arm': 'after', 'task': 'a', 'rep': 1, 'turn_id': 1, 'score': None,
         'solution': '', 'success': False, 'stats': {'elapsed_seconds': 20}},
        {'arm': 'before', 'task': 'b', 'rep': 1, 'turn_id': 1, 'score': 1,
         'solution': 'correct', 'success': True, 'stats': {'elapsed_seconds': None}},
    ]
    result = descriptive_metrics(rows, 'longds')
    assert result['arms']['before']['latency']['known'] == 1
    assert result['arms']['before']['latency']['unknown'] == 1
    assert result['arms']['after']['empty_answers'] == 1
    assert result['arms']['after']['runtime_failures'] == 1
    assert result['paired_latency']['pairs'] == 1
    assert result['paired_latency']['after_minus_before_seconds']['median'] == 10


def test_official_partial_metrics_are_separate_by_answer_type_and_unknown_preserved():
    rows = [
        {'arm': 'after', 'solution': 'partial', 'judge': {'answer_type': 'list_exact',
         'evaluation': {'f1': 0.5, 'precision': 0}}},
        {'arm': 'after', 'solution': 'wrong', 'judge': {'answer_type': 'numeric_exact',
         'evaluation': {'success': 0}}},
        {'arm': 'after', 'solution': 'missing', 'judge': {'answer_type': 'list_exact',
         'evaluation': {}}},
    ]
    result = descriptive_metrics(rows, 'krama')['arms']['after']['official_metrics']
    assert result['list_exact']['metric'] == 'f1'
    assert result['list_exact']['known'] == result['list_exact']['unknown'] == 1
    assert result['list_exact']['mean'] == 0.5
    assert result['numeric_exact']['mean'] == 0
    assert 'official_metrics' not in descriptive_metrics(rows, 'longds')['arms']['after']


def test_interrupted_spend_preserves_unknown_calls_instead_of_dropping_replaced_attempt(tmp_path):
    folder = tmp_path / 'original'
    folder.mkdir()
    (folder / 'results_with_ground_truth.json').write_text(json.dumps([
        {'turn_id': 1, 'stats': {'cost_usd': 0.1}},
        {'turn_id': 2, 'stats': {'cost_usd': None}},
    ]))
    (folder / 't03').mkdir()
    (folder / 't03/prompt.txt').write_text('An interrupted request')
    (tmp_path / 'interrupt-recovery-20261004.json').write_text(json.dumps({
        'recovery': [{'arm': 'before', 'original': str(folder)}]}))
    result = interrupted_spend(tmp_path)['before']
    assert result['saved_turns'] == 2
    assert result['known_saved_cost_usd'] == 0.1
    assert result['saved_turns_with_unknown_cost'] == 1
    assert result['started_questions_without_receipts'] == 1
    assert result['unrecorded_question_ids'] == [3]


def test_representation_metrics_separate_opaque_processes_from_selection_facts(tmp_path):
    turn = tmp_path / 't01'
    turn.mkdir()
    steps = [{'role': 'agent', 'toolCalls': [{'input': {'actions': [{'type': 'edit',
        'changes': 'create operator calc: process(fn=calc)\n    def calc(df):\n        return df\ncreate operator eligible: filter(lambda row: True)'}]}}],
        'toolResults': [{'output': {'actions': [{'output': {'operator_blocks': [
            {'scope': ['process calc: internal selection unknown.']},
            {'scope': ['filter eligible: input calc (3 rows); output 2 rows.']},
        ]}}]}}]}]
    (turn / 'react_steps.json.gz').write_bytes(gzip.compress(json.dumps({'steps': steps}).encode()))
    result = scope_metrics(tmp_path)
    assert result['model_calls'] == result['definition_attempt_process'] == 1
    assert result['definition_attempt_filter'] == 1
    assert result['scope_facts_process'] == result['scope_facts_filter'] == 1
    assert result['scope_blocks'] == 2


def test_judge_spend_counts_unique_receipts_and_retains_unknown_interrupted_cost(tmp_path):
    cache = tmp_path / 'judge-cache'
    cache.mkdir()
    (cache / 'shared.json').write_text(json.dumps({'score': 1, 'usage': [{'cost': 0.01}, {'cost': 0.02}]}))
    (cache / 'unknown.json').write_text(json.dumps({'score': None, 'usage': [{}]}))
    (cache / 'pending.lock').touch()
    recovery = tmp_path / 'judge-recovery-cache'
    recovery.mkdir()
    (recovery / 'saved.started.json').write_text('{}')
    (recovery / 'saved.json').write_text(json.dumps({'score': 0, 'usage': [{'cost': 0.04}]}))
    (recovery / 'interrupted.started.json').write_text('{}')
    result = judge_spend(tmp_path)
    assert result['unique_verdict_receipts'] == 3
    assert result['recorded_calls'] == 4
    assert result['known_provider_cost_usd'] == pytest.approx(0.07)
    assert result['calls_with_unknown_cost'] == 1
    assert result['pending_or_interrupted_requests'] == 2


def test_judge_provider_exception_keeps_missing_usage_unknown(tmp_path):
    cache = tmp_path / 'judge-cache'
    cache.mkdir()
    (cache / 'failed.json').write_text(json.dumps({'score': None, 'usage': [],
        'error_detail': 'judge call failed: no response receipt'}))
    result = judge_spend(tmp_path)
    assert result['failed_calls_without_usage_receipts'] == 1
