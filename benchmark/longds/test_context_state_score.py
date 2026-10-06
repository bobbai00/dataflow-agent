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
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from context_state_score import structural_metrics, judge_record, judge_cost


class StructuralMetricTest(unittest.TestCase):
    def test_boundary_cache_is_measured_from_the_first_call_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            for name, cached in [('001-response.json', 0), ('002-response.json', 5500)]:
                (directory / name).write_text(json.dumps({'usage': {'prompt_tokens': 6000,
                    'prompt_tokens_details': {'cached_tokens': cached}}}))
            metrics = structural_metrics({'scripts': []}, directory, 'python')
            self.assertEqual(metrics['first_call_usage'], {'input_tokens': 6000, 'cached_tokens': 0})

    def test_transport_failure_with_no_usage_has_unknown_cost(self):
        protocol = {'judge': {'rates_usd_per_million': {'input': 1, 'output': 2, 'cached': .1}}}
        result = {'score': None, 'error_detail': 'judge call failed: timeout', 'usage': []}
        self.assertIsNone(judge_cost(result, 'deepseek/deepseek-v4-pro', protocol))

    def test_openrouter_reported_cost_takes_precedence_over_token_estimate(self):
        result = {'score': 1, 'usage': [{'cost': .123, 'prompt_tokens': 100, 'completion_tokens': 10}]}
        self.assertAlmostEqual(judge_cost(result, 'deepseek/deepseek-v4-pro', {}), .123)

    def test_invalid_tool_arguments_are_counted_without_stopping_scoring(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with gzip.open(directory / 'react_steps.json.gz', 'wt') as stream:
                json.dump({'steps': []}, stream)
            metrics = structural_metrics({'native_actions': ['not JSON', {'actions': []}]}, directory, 'dataflow')
            self.assertEqual(metrics['malformed_tool_calls'], 1)

    def test_transport_failure_can_be_judged_again(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            directory = folder / 't01'
            directory.mkdir()
            record = {'turn_id': 1, 'answer': '{"value":1}'}
            (directory / 'record.json').write_text(json.dumps(record))
            gold = {'turns': [{'context': '', 'question': 'q', 'answer': {'value': 1}}]}
            protocol = {'judge': {'model': 'gpt-5.2'}}
            responses = [dict(score=None, error_detail='judge call failed: timeout', usage=[]),
                         dict(score=1, usage=[])]
            with patch('context_state_score.judge_client', return_value=object()), \
                 patch('context_state_score.judge_one', side_effect=responses) as judge:
                self.assertIsNone(judge_record(folder, directory, record, gold, protocol, 'prompt')['score'])
                self.assertEqual(judge_record(folder, directory, record, gold, protocol, 'prompt')['score'], 1)
                self.assertEqual(judge.call_count, 2)

    def test_engine_outcomes_count_real_nested_receipts_not_requested_ids(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            trace = {'steps': [{'toolResults': [{'isError': False, 'output': {'actions': [{
                'action': {'type': 'execute'}, 'status': 'ok', 'output': {'operators': [
                    {'id': 'old@1', 'status': 'ok', 'state': 'cached'},
                    {'id': 'consumer', 'status': 'ok', 'state': 'executed'},
                    {'id': 'failed', 'status': 'error', 'state': 'failed'}]}}, {
                'action': {'type': 'execute'}, 'status': 'error', 'output': 'Unknown target'}]}}]}]}
            with gzip.open(directory / 'react_steps.json.gz', 'wt') as stream:
                json.dump(trace, stream)
            metrics = structural_metrics({'native_actions': []}, directory, 'dataflow')
            self.assertEqual(metrics['operator_outcomes'], {'executed': 1, 'cached': 1})


if __name__ == '__main__':
    unittest.main()
