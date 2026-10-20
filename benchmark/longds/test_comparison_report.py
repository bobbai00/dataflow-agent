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
import gzip
import json

import pytest

from comparison_report import bootstrap_delta, build_report, native_metrics


def test_uncertainty_resamples_sessions_instead_of_independent_turns():
    rows = [{'task': task, 'rep': 1, 'turn_id': tid, 'arm': arm, 'score': score}
            for task, count, scores in [('large', 50, [1, 0]), ('small', 1, [0, 1])]
            for tid in range(1, count+1) for arm, score in zip(['history', 'baseline'], scores)]
    delta = bootstrap_delta(rows, 'history', 'baseline', draws=100)
    assert delta['estimate'] == 0
    assert delta['sessions'] == 2
    assert bootstrap_delta(rows[:100], 'history', 'baseline')['interval'] is None


def test_metrics_count_successful_history_receipts_and_append_only_prefixes(tmp_path):
    first = [{'role': 'user', 'content': 'task'}]
    second = first + [{'role': 'assistant', 'content': 'inspect'}]
    steps = [{'role': 'agent', 'inputMessages': first}, {'role': 'agent', 'inputMessages': second,
        'toolResults': [{'output': {'actions': [
            {'status': 'error', 'action': {'type': 'edit', 'changes': 'fork operator a from task 1 as old'}},
            {'status': 'ok', 'action': {'type': 'edit', 'changes': 'fork operator a from task 1 as old'}},
            {'status': 'ok', 'action': {'type': 'edit', 'changes': 'update operator eligible from task 1'}},
            {'status': 'ok', 'action': {'type': 'inspect', 'target': 'state', 'task_id': 1}},
            {'status': 'ok', 'action': {'type': 'inspect', 'target': 'state', 'task_id': None}},
            {'status': 'ok', 'action': {'type': 'retrieve', 'view': 'sample_stats'},
             'output': {'text': 'rows', 'evidence': ['data.column.a.counts']}},
        ]}}]}]
    folder = tmp_path / 't02'
    folder.mkdir()
    (folder / 'react_steps.json.gz').write_bytes(gzip.compress(json.dumps({'steps': steps}).encode()))
    metrics = native_metrics(tmp_path)
    assert metrics['fork_operator'] == 1
    assert metrics['restore_operator'] == 1
    assert metrics['historical_inspect'] == 1
    assert metrics['version_listing'] == 1
    assert metrics['statistics_displayed'] == 1
    assert metrics['prefix_checks'] == 1 and metrics['prefix_changes'] == 0


def test_missing_results_never_become_an_accuracy_or_a_free_correct_turn(tmp_path):
    (tmp_path / 'manifest.json').write_text(json.dumps({'jobs': [
        {'task': 'task', 'arm': 'history', 'rep': 1, 'turns_total': 2},
        {'task': 'task', 'arm': 'baseline', 'rep': 1, 'turns_total': 2},
    ]}))
    for arm in ['history', 'baseline']:
        folder = tmp_path / 'runs' / f'{arm}-r1' / 'task'
        folder.mkdir(parents=True)
        rows = [{'turn_id': 1, 'judge': {'score': 1}, 'stats': {'cost_usd': None}, 'depends_tasks': []}]
        (folder / 'results_eval.json').write_text(json.dumps(rows))
    report = build_report(tmp_path)
    assert report['summary']['history']['accuracy'] is None
    assert report['summary']['history']['missing_turns'] == 1
    assert report['pairs']['baseline__history']['both_correct_unknown_cost_turns'] == {'baseline': 1, 'history': 1}


def test_completed_turns_waiting_for_judgment_remain_visible(tmp_path):
    job = {'task': 'task', 'arm': 'dsgym', 'rep': 1, 'turns_total': 2}
    (tmp_path / 'manifest.json').write_text(json.dumps({'jobs': [job]}))
    folder = tmp_path / 'runs/dsgym-r1/task'
    folder.mkdir(parents=True)
    (folder / 'results_with_ground_truth.json').write_text(json.dumps([
        {'turn_id': 1, 'stats': {'cost_usd': .01}, 'depends_tasks': []}]))
    stats = build_report(tmp_path)['summary']['dsgym']
    assert stats['observed_turns'] == 1 and stats['unjudged_turns'] == 1
    assert stats['missing_turns'] == 1 and stats['accuracy'] is None
    assert stats['cost_usd'] == pytest.approx(.01)
