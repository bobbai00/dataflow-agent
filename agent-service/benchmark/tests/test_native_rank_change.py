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
"""rank_change: which items entered, left or stayed in a top n between two versions."""
import pandas as pd
import pytest
from test_native_v2_runtime import runtime, spec


def ranks(before, after, **properties):
    definition = spec("RankChange", **properties)
    definition["inputs"] = ["before", "after"]
    return runtime.execute_native(definition, [before, after])


BEFORE = pd.DataFrame({"store": ["a", "b", "c", "d", "e"], "score": [5.0, 4.0, 3.0, 2.0, 1.0]})
AFTER = pd.DataFrame({"store": ["a", "b", "c", "d", "e"], "score": [5.0, 1.5, 3.5, 4.5, 1.0]})


def test_items_that_entered_left_or_stayed_carry_ranks_and_values_from_both_sides():
    result = ranks(BEFORE, AFTER, key=["store"], by=[{"col": "score", "desc": True}], n=3)
    assert list(result["store"]) == ["a", "d", "c", "b"]
    assert list(result["status"]) == ["stayed", "entered", "stayed", "left"]
    rows = result.set_index("store")
    assert (rows.loc["d", "rank_before"], rows.loc["d", "rank_after"]) == (4, 2)
    assert rows.loc["b", "score_after"] == 1.5 and rows.loc["b", "score_change"] == -2.5
    assert result.attrs["native_v2"]["operations"]["rankChange"] == {"n": 3, "entered": 1, "left": 1, "stayed": 2}


def test_an_item_missing_from_one_table_has_no_rank_or_value_there():
    after = AFTER[AFTER["store"] != "b"]
    rows = ranks(BEFORE, after, key=["store"], by=[{"col": "score", "desc": True}], n=2).set_index("store")
    assert rows.loc["b", "status"] == "left"
    assert pd.isna(rows.loc["b", "rank_after"]) and pd.isna(rows.loc["b", "score_after"])


def test_ties_are_broken_by_the_key_and_extra_columns_are_reported():
    before = pd.DataFrame({"store": ["b", "a", "c"], "score": [1.0, 1.0, 0.0], "region": ["n", "s", "n"]})
    after = before.assign(region=["n", "s", "s"])
    result = ranks(before, after, key=["store"], by=[{"col": "score", "desc": True}], n=1, columns=["region"])
    assert list(result["store"]) == ["a"]
    assert result.loc[0, "region_before"] == "s" and result["region_change"].isna().all()


def test_keys_must_identify_items_and_stay_apart_from_ranked_columns():
    duplicated = pd.DataFrame({"store": ["a", "a"], "score": [1.0, 2.0]})
    with pytest.raises(runtime.NativeError, match="RANK_KEYS"):
        ranks(duplicated, duplicated, key=["store"], by=[{"col": "score"}], n=1)
    with pytest.raises(runtime.NativeError, match="RANK_ARGUMENT"):
        runtime.validate_native({**spec("RankChange", key=["store"], by=[{"col": "store"}], n=1), "inputs": ["x", "y"]})
    with pytest.raises(runtime.NativeError, match="RANK_ARGUMENT"):
        runtime.validate_native({**spec("RankChange", key=["store"], by=[{"col": "score"}], n=0), "inputs": ["x", "y"]})
