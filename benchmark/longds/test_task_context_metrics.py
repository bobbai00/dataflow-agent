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

from task_context_metrics import component_rubric, score_components
from task_context_verification import settings, COHORT


def test_only_context_policy_differs_between_matched_arms():
    for benchmark in ['longds', 'krama']:
        trajectory = settings(benchmark, 'trajectory')
        dependencies = settings(benchmark, 'dependencies')
        assert {k for k in trajectory if trajectory[k] != dependencies[k]} == {'taskContext'}
        assert trajectory['stateHistory'] and dependencies['stateHistory']
        assert not trajectory['stateLedger'] and not trajectory['dataEvidence']
        assert trajectory['multiTask'] == (benchmark == 'longds')
    assert len(COHORT) == 2
    with pytest.raises(ValueError):
        settings('unsupported', 'dependencies')
    with pytest.raises(ValueError):
        settings('longds', 'invented')


def test_missing_fields_have_zero_credit_and_are_counted_in_the_denominator():
    rubric = component_rubric({'count': 3, 'mean': 1.234, 'winner': 'A'})
    result = score_components('{"count": 3, "mean": 2}', rubric)
    assert result['components_total'] == 3
    assert result['components_present'] == 2
    assert result['components_correct'] == 1
    assert result['strict_component_score'] == pytest.approx(1 / 3)


def test_ranked_arrays_keep_order_and_paths_escape_json_pointer_characters():
    rubric = component_rubric({'a/b~c': [{'name': 'A'}, {'name': 'B'}]})
    assert rubric[0]['path'] == '/a~1b~0c/0/name'
    assert score_components('{"a/b~c": [{"name": "B"}, {"name": "A"}]}', rubric)['components_correct'] == 0


def test_numeric_rules_keep_counts_exact_and_allow_only_last_decimal_rounding():
    rubric = component_rubric({'count': 3, 'value': 1.2, 'precise': 1.2345})
    assert score_components('{"count": 3.01, "value": 1.2004, "precise": 1.23454}', rubric)['components_correct'] == 2
    assert score_components('{"count": true, "value": 1.201, "precise": 1.2346}', rubric)['components_correct'] == 0


def test_invalid_json_and_missing_null_are_distinct_from_valid_null():
    rubric = component_rubric({'missing': None, 'label': 'New York'})
    assert score_components('no answer', rubric)['format_json'] is False
    assert score_components('{}', rubric)['components_correct'] == 0
    assert score_components('```json\n{"missing": null, "label": " new   york "}\n```', rubric)['components_correct'] == 2


def test_alternate_field_names_do_not_receive_semantic_credit():
    rubric = component_rubric({'required_name': 3})
    result = score_components('{"synonym": 3}', rubric)
    assert result['components_present'] == 0
    assert result['strict_component_score'] == 0
    assert component_rubric('unstructured reference') == []
