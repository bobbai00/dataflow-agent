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

from comparison_hidden_fixture import REFRESHED_UNIT, TARGETS, fixture_data
from state_comparison import build_prompts


def test_later_queries_cover_unreported_rows_and_keep_source_versions_distinct():
    manifest, gold, original, updated = fixture_data()
    assert len(original)==18000 and len(updated)==18001
    assert len({r['unit'] for r in original})==6000
    for tid in [1,2]:
        assert not set(TARGETS) & {r['unit'] for r in gold['turns'][tid-1]['answer']['scores']}
    assert gold['turns'][5]['answer']['current_minus_historical']==10000
    original_sum=sum(r['amount'] for r in original if r['unit']==REFRESHED_UNIT and r['status']=='delivered')
    assert gold['turns'][5]['answer']['historical_score']==original_sum
    assert gold['turns'][6]['answer']['scores'][0]['score']==2*(original_sum+10000)
    assert gold['turns'][7]['answer']['scores'][0]['score']==original_sum+10000
    prompts=json.dumps(build_prompts(manifest))
    assert 'ground_truth' not in prompts and 'Rollback' not in prompts
    assert REFRESHED_UNIT in prompts
