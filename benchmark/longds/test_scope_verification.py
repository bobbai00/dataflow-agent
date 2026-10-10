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
import pytest

from scope_verification import compare_sources, settings, canonical_score


def test_control_and_treatment_keep_runtime_and_evidence_settings_matched():
    for benchmark in ['longds', 'krama']:
        s = settings(benchmark)
        assert s['stateLedger'] is False
        assert s['dataEvidence'] is False and s['flowEvidence'] is False
        assert s['retrievalViews'] == ['sample', 'full']
        assert s['contextWindowTokens'] == 0
        assert s['stateHistory'] == s['multiTask'] == (benchmark == 'longds')


def test_unrelated_runtime_difference_refuses_the_paid_comparison(tmp_path):
    before, after = tmp_path / 'before', tmp_path / 'after'
    for root in [before, after]:
        p = root / 'agent-service/src/agent/native/python/runtime.py'
        p.parent.mkdir(parents=True)
        p.write_text('same corrected runtime')
    assert compare_sources(before, after)['differences'] == []
    (after / 'agent-service/src/agent/native/python/runtime.py').write_text('another engine')
    with pytest.raises(ValueError, match='Unrelated runtime'):
        compare_sources(before, after)


def test_approved_observation_change_is_recorded_without_hiding_the_sources(tmp_path):
    before, after = tmp_path / 'before', tmp_path / 'after'
    rel = 'agent-service/src/agent/native/observation-format.ts'
    for root, body in [(before, 'old observation'), (after, 'new scope observation')]:
        p = root / rel
        p.parent.mkdir(parents=True)
        p.write_text(body)
    result = compare_sources(before, after)
    assert result['differences'] == [rel]
    assert result['before'][rel] != result['after'][rel]


def test_official_partial_scores_and_unknowns_are_not_promoted_to_full_success():
    assert canonical_score('numeric_exact', {'success': 1}) == 1
    assert canonical_score('numeric_approximate', {'rae_score': .95}) == 0
    assert canonical_score('list_exact', {'f1': .5}) == 0
    assert canonical_score('list_exact', {'f1': 1}) == 1
    assert canonical_score('numeric_exact', {'success': None}) is None
    assert canonical_score('numeric_exact', {}) is None
