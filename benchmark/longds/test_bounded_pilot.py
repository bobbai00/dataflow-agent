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

from bounded_pilot import score_rubric

RUBRIC = {"key_fields": ["country"], "value_fields": ["difference"],
          "ordered": True, "decimals": 4, "tables": ["sensitivity"]}
GOLD = {"sensitivity": [{"country": "A", "difference": 2.5},
                        {"country": "B", "difference": 1.5}]}


def test_components_distinguish_selection_values_and_order():
    actual = {"sensitivity": [{"country": "B", "difference": 1.5},
                              {"country": "A", "difference": 99}]}
    result = score_rubric(GOLD, actual, RUBRIC)
    table = result["tables"]["sensitivity"]
    assert table["identity_f1"] == 1
    assert table["value_accuracy"] == .5
    assert table["order_accuracy"] == 0
    assert result["partial_score"] == .5


def test_unrecognized_shape_is_unscored_and_recognized_empty_table_is_wrong():
    assert score_rubric(GOLD, {"unsupported_alias": []}, RUBRIC)["partial_score"] is None
    assert score_rubric(GOLD, {"sensitivity": "bad"}, RUBRIC)["partial_score"] is None
    assert score_rubric(GOLD, {"sensitivity": []}, RUBRIC)["partial_score"] == 0


def test_missing_group_is_not_dropped_from_the_denominator():
    rubric = {**RUBRIC, "tables": ["group_a", "group_b"]}
    gold = {"group_a": GOLD["sensitivity"], "group_b": GOLD["sensitivity"]}
    result = score_rubric(gold, {"group_a": GOLD["sensitivity"]}, rubric)
    assert result["partial_score"] == .5
    assert result["tables"]["group_b"]["missing_answer"]
