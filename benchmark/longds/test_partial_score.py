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

from partial_score import compare_table, compare_scalars
from audit_after_repairs import apply_groups, scalar, table


def test_partial_values_do_not_turn_a_nearly_correct_table_into_zero():
    expected = [{"id": "a", "score": 1}, {"id": "b", "score": 2}]
    actual = [{"id": "a", "score": 1}, {"id": "b", "score": 3}]
    result = compare_table(expected, actual, ["id"], ["score"], ordered=True)
    assert result["identity_f1"] == 1
    assert result["value_accuracy"] == .5
    assert result["order_accuracy"] == 1
    assert result["partial_score"] == pytest.approx(5 / 6)
    assert not result["exact"]


def test_missing_rows_count_against_both_identity_and_values():
    expected = [{"id": "a", "score": 1}, {"id": "b", "score": 2}]
    result = compare_table(expected, expected[:1], ["id"], ["score"])
    assert result["identity_recall"] == .5
    assert result["value_accuracy"] == .5
    assert result["missing_keys"] == [["b"]]


def test_extra_and_duplicate_rows_are_penalized():
    expected = [{"id": "a", "score": 1}]
    result = compare_table(expected, expected * 2 + [{"id": "x", "score": 8}], ["id"], ["score"])
    assert result["identity_precision"] == pytest.approx(1 / 3)
    assert result["duplicate_keys"] == [["a"]]
    assert not result["exact"]


def test_requested_order_is_scored_independently_of_set_membership():
    expected = [{"id": "a"}, {"id": "b"}]
    result = compare_table(expected, list(reversed(expected)), ["id"], [], ordered=True)
    assert result["identity_f1"] == 1
    assert result["order_accuracy"] == 0
    assert result["partial_score"] == .5


def test_missing_answer_is_not_an_explicit_empty_answer():
    assert compare_table([], [], ["id"], [])["exact"]
    assert compare_table([], None, ["id"], [])["partial_score"] == 0


def test_numeric_precision_boolean_and_missing_zero_are_distinct():
    result = compare_scalars({"rounded": 7.0312, "flag": False, "zero": 0},
                             {"rounded": 7.03125, "flag": 0}, decimals=4)
    assert result["matched"] == 1
    assert result["total"] == 3
    assert not result["exact"]


def test_reported_extra_values_are_audited_without_changing_requested_score():
    expected = [{"id": "a", "wanted": 1, "extra": 2}]
    actual = [{"id": "a", "wanted": 1, "extra": 3}]
    result = compare_table(expected, actual, ["id"], ["wanted"], extra_fields=["extra"])
    assert result["partial_score"] == 1
    assert result["reported_extra_values"]["matched"] == 0
    assert result["reported_extra_values"]["total"] == 1


def test_duplicate_reference_keys_fail_instead_of_hiding_rubric_errors():
    with pytest.raises(ValueError, match="reference"):
        compare_table([{"id": "a"}, {"id": "a"}], [], ["id"], [])


def test_explicit_complements_and_sign_conversions_preserve_equivalent_answers():
    reference = {"valid": 9, "drop": 2}
    answer = {"total": 10, "missing": 1, "change": -2}
    result = apply_groups(reference, answer, [
        scalar("valid", {"difference": ["total", "missing"]}),
        scalar("drop", {"negate": "change"}),
    ], 3)
    assert result["exact_requested_contract"]
    assert result["partial_score"] == 1


def test_unsupported_prose_does_not_silently_become_an_empty_table():
    with pytest.raises(ValueError, match="Unsupported table shape"):
        apply_groups({"rows": []}, "No rows", [table("rows", "$", {"id": "id"})], 3)


def test_missing_scalar_answer_is_not_null_or_false_credit():
    result = apply_groups({"changed": False}, {}, [scalar("changed", "different")], 3)
    assert result["partial_score"] == 0
    assert result["groups"][0]["facts"][0]["missing"]
