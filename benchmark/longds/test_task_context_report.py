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

from task_context_report import trace_diagnostics, aggregate_partial, context_summary, verify_study, judge_cost
from state_comparison import digest


def test_partial_reports_both_macro_and_micro_without_treating_missing_as_correct():
    rows = [{'components_total': 10, 'components_correct': 5, 'components_present': 8,
             'strict_component_score': .5, 'format_json': True},
            {'components_total': 2, 'components_correct': 2, 'components_present': 2,
             'strict_component_score': 1, 'format_json': True}]
    result = aggregate_partial(rows)
    assert result['macro_strict_component_score'] == .75
    assert result['micro_strict_component_score'] == 7 / 12
    assert result['component_presence'] == 10 / 12
    assert aggregate_partial([])['macro_strict_component_score'] is None


def test_trace_distinguishes_root_errors_upstream_blocks_and_unrelated_stops(tmp_path):
    folder = tmp_path / 't01'
    folder.mkdir()
    previous = [{'role': 'user', 'content': 'question'}]
    steps = [{'role': 'agent', 'inputMessages': previous, 'usage': {'inputTokens': 100, 'cachedInputTokens': 20}},
             {'role': 'agent', 'inputMessages': previous + [{'role': 'tool', 'content': 'receipt'}],
              'toolResults': [{'output': {'actions': [
                  {'status': 'error', 'action': {'type': 'execute'}, 'output': {'operators': [
                      {'id': 'a', 'state': 'failed'},
                      {'id': 'b', 'state': 'not run', 'cause': 'upstream `a` failed'},
                      {'id': 'c', 'state': 'not run', 'cause': 'the run stopped when `a` failed; they do not read from it'}]}},
                  {'status': 'skipped', 'action': {'type': 'edit'}},
                  {'status': 'ok', 'action': {'type': 'inspect', 'target': 'task', 'task_id': 1}},
              ]}}]}]
    (folder / 'react_steps.json.gz').write_bytes(gzip.compress(json.dumps({'steps': steps}).encode()))
    (folder / 'task-history.json').write_text(json.dumps({'tasks': [
        {'task_id': 1, 'dependencies': [], 'consulted_tasks': [], 'unresolved_references': 0},
        {'task_id': 2, 'dependencies': [{'task_id': 1, 'references': [{'kind': 'definition'}]}],
         'consulted_tasks': [1], 'unresolved_references': 0}]}))
    result = trace_diagnostics(tmp_path)
    counts = result['counts']
    assert counts['within_task_prefix_changes'] == 0
    assert counts['execute_failed_visits'] == 1
    assert counts['execute_upstream_blocked_visits'] == 1
    assert counts['execute_unrelated_stopped_visits'] == 1
    assert counts['skipped_actions'] == 1
    assert counts['inspect_task'] == 1
    assert counts['observed_task_edges'] == 1
    assert counts['recorded_task_consultations'] == 1
    assert result['mechanical_turns'][0]['turn_id'] == 1
    assert result['mechanical_turns'][0]['counts']['error_execute'] == 1
    assert 'semantic_cascade_errors' not in counts


def test_context_summary_reports_token_coverage_and_task_boundary_cache_separately():
    result = context_summary([
        {'first_call': True, 'dynamic_context_chars': 50, 'input_tokens': 100, 'cached_tokens': 20},
        {'first_call': False, 'dynamic_context_chars': 80, 'input_tokens': 200, 'cached_tokens': 180},
        {'first_call': False, 'dynamic_context_chars': 90, 'input_tokens': None, 'cached_tokens': None},
    ])
    assert result['first_calls']['cache_hit_rate'] == .2
    assert result['within_task_calls']['cache_hit_rate'] == .9
    assert result['within_task_calls']['unknown_token_calls'] == 1
    assert context_summary([])['all_calls']['mean_dynamic_context_chars'] is None


def test_report_rejects_changed_frozen_protocol_inputs(tmp_path):
    phase = tmp_path / 'longds'
    phase.mkdir()
    manifest = phase / 'manifest.json'
    manifest.write_text('{"jobs": []}')
    rubric = tmp_path / 'partial-rubrics.json'
    rubric.write_text('{}')
    study = {'manifests': {'longds': digest(manifest)}, 'partial_rubric_sha256': digest(rubric)}
    (tmp_path / 'protocol.json').write_text(json.dumps(study))
    assert verify_study(tmp_path) == study
    manifest.write_text('{"jobs": ["changed"]}')
    with pytest.raises(ValueError, match='manifest changed'):
        verify_study(tmp_path)
    manifest.write_text('{"jobs": []}')
    rubric.write_text('{"changed": true}')
    with pytest.raises(ValueError, match='rubric changed'):
        verify_study(tmp_path)


def test_judge_cost_counts_failed_and_recovered_usage_once_and_skips_intents(tmp_path):
    original = tmp_path / 'judge-cache'
    recovery = tmp_path / 'judge-recovery-cache'
    original.mkdir()
    recovery.mkdir()
    (original / 'first.json').write_text(json.dumps({'score': None, 'usage': [{'cost': .1}, {'cost': .2}]}))
    (recovery / 'fixed.json').write_text(json.dumps({'score': 1, 'usage': [{'cost': .3}]}))
    (recovery / 'fixed.started.json').write_text('{}')
    result = judge_cost(tmp_path)
    assert result['reported_cost_usd'] == pytest.approx(.6)
    assert result['calls'] == 3
    assert result['original_unjudged_verdicts'] == 1
    assert result['unique_recovery_verdicts'] == 1
    assert result['unjudged_recovery_verdicts'] == 0
