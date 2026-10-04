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

from comparison_cost import cost_summary, script_turn_metrics, turn_behavior, paired_costs


def test_script_metrics_separate_turns_and_ignore_protocol_feedback(tmp_path):
    agent = tmp_path / 'agent'
    agent.mkdir()
    turns = [{'turn_id': n, 'prompt': [{'role': 'user', 'content': f'[Task {n}]'}]}
             for n in range(1, 5)]
    (agent / 'turns.json').write_text(json.dumps(turns))
    conversation = [
        {'role': 'system', 'content': '<python>instruction</python>'},
        {'role': 'user', 'content': '[Task 1]'},
        {'role': 'assistant', 'content': '<answer>{"error":"Unable to access data"}</answer>'},
        {'role': 'user', 'content': '[Task 2]'},
        {'role': 'assistant', 'content': '<python>print(3)</python>'},
        {'role': 'user', 'content': '<information>[stdout] 3</information>'},
        {'role': 'assistant', 'content': '<answer>3</answer>'},
        {'role': 'user', 'content': '[Task 3]'},
        {'role': 'assistant', 'content': '3'},
        {'role': 'user', 'content': '<information>No python code found. Try again.</information>'},
        {'role': 'assistant', 'content': '<answer>3</answer>'},
    ]
    (agent / 'traj.json').write_text(json.dumps({'conversation': conversation}))
    metrics = script_turn_metrics(tmp_path)
    assert metrics[1] == {'python_blocks': 0, 'execution_observations': 0}
    assert metrics[2] == {'python_blocks': 1, 'execution_observations': 1}
    assert metrics[3] == {'python_blocks': 0, 'execution_observations': 0}
    assert 4 not in metrics
    assert script_turn_metrics(tmp_path / 'missing') == {}


def test_no_code_correct_answers_and_wrong_values_are_not_nonanswers():
    metrics = {'python_blocks': 0, 'execution_observations': 0}
    assert turn_behavior({'score': 1, 'solution': '{"score":3}'}, metrics) == 'correct_without_code'
    assert turn_behavior({'score': 0, 'solution': '{"score":4}'}, metrics) == 'wrong_without_code'
    assert turn_behavior({'score': 0, 'solution': '{"error":"Unable to access data"}'}, metrics) == 'no_code_nonanswer'
    assert turn_behavior({'score': 0, 'solution': ''}, metrics) == 'no_code_nonanswer'
    assert turn_behavior({'score': 0, 'solution': '{"error":"Unable to access data"}'}, None) == 'unknown_trace'
    assert turn_behavior({'score': 0, 'solution': '{"error":"Unable to access data"}'},
                         {'python_blocks': 1, 'execution_observations': 1}) == 'code_attempted'
    assert turn_behavior({'score': None, 'solution': ''}, metrics) == 'unjudged'


def row(arm, turn, score, cost, behavior=None):
    return {'task': 'task', 'rep': 1, 'turn_id': turn, 'arm': arm, 'score': score,
            'stats': {'cost_usd': cost, 'llm_calls': 1}, 'uniform_cost_usd': cost,
            'script_behavior': behavior}


def test_cost_filters_use_identical_questions_and_preserve_failures():
    rows = [row('history', 1, 1, .1), row('dsgym', 1, 0, .01, 'no_code_nonanswer'),
            row('history', 2, 1, .2), row('dsgym', 2, 1, .02, 'code_attempted'),
            row('history', 3, 1, .3), row('dsgym', 3, 1, .03, 'correct_without_code')]
    result = paired_costs(rows, 'dsgym', 'history')
    assert result['all_paired']['dsgym']['turns'] == 3
    assert result['both_correct']['dsgym']['turns'] == 2
    assert result['both_correct']['history']['uniform_cost_usd'] == pytest.approx(.5)
    assert result['script_code_attempted']['history']['turns'] == 1
    assert result['excluding_script_no_code_nonanswers']['history']['turns'] == 2
    assert result['both_correct_consecutive_prefix']['history']['turns'] == 0
    assert result['all_paired']['dsgym']['uniform_cost_per_correct_answer'] == pytest.approx(.03)


def test_unknown_cost_is_not_reported_as_free_and_empty_success_ratio_is_undefined():
    summary = cost_summary([row('dsgym', 1, 1, None)])
    assert summary['unknown_uniform_cost_turns'] == 1
    assert summary['uniform_cost_per_correct_answer'] is None
    assert cost_summary([row('dsgym', 1, 0, .01)])['uniform_cost_per_correct_answer'] is None
    assert cost_summary([])['uniform_cost_per_correct_answer'] is None
    assert cost_summary([row('dsgym', 1, 1, .01), row('dsgym', 2, None, .02)])['uniform_cost_per_correct_answer'] is None


def test_consecutive_prefix_does_not_bridge_missing_or_incorrect_answers():
    rows = [row(arm, turn, score, .01, 'code_attempted')
            for arm in ['dsgym', 'history'] for turn, score in [(1, 1), (2, 1), (4, 1)]]
    result = paired_costs(rows, 'dsgym', 'history')
    assert result['both_correct']['dsgym']['turns'] == 3
    assert result['both_correct_consecutive_prefix']['dsgym']['turns'] == 2
    rows[0]['score'] = 0
    assert paired_costs(rows, 'dsgym', 'history')['both_correct_consecutive_prefix']['dsgym']['turns'] == 0


def test_unknown_traces_remain_in_overall_and_both_correct_costs():
    rows = [row('dsgym', 1, 1, .01, 'unknown_trace'), row('history', 1, 1, .02)]
    result = paired_costs(rows, 'dsgym', 'history')
    assert result['all_paired']['dsgym']['turns'] == 1
    assert result['both_correct']['dsgym']['turns'] == 1
    assert result['excluding_script_no_code_nonanswers']['dsgym']['turns'] == 0
