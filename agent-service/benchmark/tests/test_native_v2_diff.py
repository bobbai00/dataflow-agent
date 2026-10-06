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

import pandas as pd
import pytest
from test_native_v2_runtime import runtime, spec


def compare(left, right, **properties):
    definition = spec("Diff", **properties)
    definition["inputs"] = ["old", "current"]
    return runtime.execute_native(definition, [left, right])


def test_diff_has_explicit_identity_and_preserves_both_inputs():
    left = pd.DataFrame({"market": ["a", "b", "c"], "score": [1.0, 2.0, None]})
    right = pd.DataFrame({"market": ["a", "c", "d"], "score": [3.0, None, 4.0]})
    original_left, original_right = left.copy(deep=True), right.copy(deep=True)
    result = compare(left, right, key=["market"], columns=["score"])
    indexed = result.set_index("market")
    assert indexed.loc["a", "status"] == "changed"
    assert indexed.loc["a", "score_delta"] == 2.0
    assert indexed.loc["a", "score_abs_delta"] == 2.0
    assert indexed.loc["b", "status"] == "removed"
    assert indexed.loc["d", "status"] == "added"
    assert "c" not in indexed.index
    assert pd.isna(indexed.loc["b", "score_delta"])
    assert result.attrs["native_v2"]["operations"]["diff"] == {
        "keys": 4, "added": 1, "removed": 1, "changed": 1, "same": 1,
    }
    pd.testing.assert_frame_equal(left, original_left)
    pd.testing.assert_frame_equal(right, original_right)


def test_diff_null_equality_boolean_and_text_changes_have_no_numeric_delta():
    left = pd.DataFrame({"id": [1, 2], "value": [None, "old"], "flag": [False, True]})
    right = pd.DataFrame({"id": [1, 2], "value": [None, "new"], "flag": [False, False]})
    result = compare(left, right, key=["id"], columns=["value", "flag"], include_same=True).set_index("id")
    assert list(result["status"]) == ["same", "changed"]
    assert result["value_delta"].isna().all()
    assert result["flag_delta"].isna().all()


@pytest.mark.parametrize("key", [None, [], ["missing"]])
def test_diff_does_not_infer_entity_keys_from_unique_scores(key):
    frame = pd.DataFrame({"score": [1, 2]})
    with pytest.raises(runtime.NativeError):
        compare(frame, frame, key=key, columns=["score"])


def test_diff_rejects_duplicate_and_missing_entity_keys():
    for values in [[1, 1], [1, None]]:
        frame = pd.DataFrame({"id": values, "score": [1.0, 2.0]})
        with pytest.raises(runtime.NativeError, match="DIFF_KEYS"):
            compare(frame, frame, key=["id"], columns=["score"])


def test_diff_empty_tables_keep_the_output_schema():
    frame = pd.DataFrame({"id": pd.Series(dtype="string"), "score": pd.Series(dtype="Float64")})
    result = compare(frame, frame, key=["id"], columns=["score"])
    assert result.empty
    assert list(result.columns) == ["id", "status", "score_left", "score_right", "score_delta", "score_abs_delta"]


def test_diff_outer_alignment_preserves_int64_values_and_exact_deltas():
    left = pd.DataFrame({"id": ["a", "removed"], "score": [2**60 + 1, 2**60 + 2]})
    right = pd.DataFrame({"id": ["a", "added"], "score": [2**60 + 3, 2**60 + 4]})
    result = compare(left, right, key=["id"], columns=["score"]).set_index("id")
    assert result.loc["a", "score_left"] == 2**60 + 1
    assert result.loc["a", "score_right"] == 2**60 + 3
    assert result.loc["a", "score_delta"] == 2
    assert result.loc["removed", "score_left"] == 2**60 + 2


def test_diff_integer_delta_overflow_is_explicit_instead_of_wrapping():
    left = pd.DataFrame({"id": ["a"], "score": [-2**63]})
    right = pd.DataFrame({"id": ["a"], "score": [2**63 - 1]})
    with pytest.raises(runtime.NativeError, match="DIFF_ARGUMENT"):
        compare(left, right, key=["id"], columns=["score"])
