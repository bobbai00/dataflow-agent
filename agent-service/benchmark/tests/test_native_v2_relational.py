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

import pandas as pd
import pytest

from test_native_v2_runtime import runtime, spec


def execute(kind, *frames, **properties):
    definition = spec(kind, **properties)
    definition["inputs"] = [f"source_{i}" for i in range(len(frames))]
    return runtime.execute_native(definition, list(frames))


def rows(frame):
    return json.loads(frame.to_json(orient="records", date_format="iso"))


def test_aggregate_null_groups_first_seen_order_counts_and_denominators():
    frame = pd.DataFrame({"g": ["b", None, "b", "a", None], "v": pd.Series([None, 4, 2, None, 6], dtype="Int64")})
    result = execute(
        "Aggregate",
        frame,
        groupBy=["g"],
        aggregations=[
            {"fn": "count", "as": "rows"},
            {"fn": "count", "col": "v", "as": "present"},
            {"fn": "sum", "col": "v", "as": "sum"},
            {"fn": "mean", "col": "v", "as": "mean"},
            {"fn": "first", "col": "v", "as": "first"},
        ],
    )
    assert rows(result) == [
        {"g": "b", "rows": 2, "present": 1, "sum": 2, "mean": 2, "first": None},
        {"g": None, "rows": 2, "present": 2, "sum": 10, "mean": 5, "first": 4},
        {"g": "a", "rows": 1, "present": 0, "sum": None, "mean": None, "first": None},
    ]
    assert str(result["sum"].dtype) == "Int64"
    assert result.attrs["native_v2"]["operations"]["aggregateNonNull"]["mean"]["total"] == 3


def test_aggregate_mean_is_pandas_groupby_mean():
    # prepbench-hard-137: both groups average 22.7 / 3. pandas' groupby mean keeps them tied for the sort's
    # tie-break; Series.mean on the nullable column put the second one a bit higher.
    frame = pd.DataFrame({"g": ["a"] * 3 + ["b"] * 3, "v": pd.Series([7.6, 7.6, 7.5, 7.7, 7.6, 7.4], dtype="Float64")})
    assert pd.Series([7.6, 7.6, 7.5], dtype="Float64").mean() != pd.Series([7.7, 7.6, 7.4], dtype="Float64").mean()
    result = execute("Aggregate", frame, groupBy=["g"], aggregations=[{"fn": "mean", "col": "v", "as": "mean"}])
    expected = frame.astype({"v": "float64"}).groupby("g")["v"].mean()
    assert list(result["mean"]) == [expected["a"], expected["b"]]
    assert result["mean"][0] == result["mean"][1]


def test_aggregate_reductions_all_null_and_empty_schemas():
    aggregations = [
        {"fn": fn, "col": "v", "as": fn}
        for fn in ["count", "count_distinct", "sum", "mean", "min", "max", "median", "stddev", "first"]
    ]
    frame = pd.DataFrame({"g": pd.Series(dtype="string"), "v": pd.Series(dtype="Float64")})
    expected = {item["fn"]: 0 if item["fn"] in ("count", "count_distinct") else None for item in aggregations}
    assert rows(execute("Aggregate", frame, aggregations=aggregations)) == [expected]
    all_null = pd.DataFrame({"v": pd.Series([None, None], dtype="Float64")})
    assert rows(execute("Aggregate", all_null, aggregations=aggregations)) == [expected]
    grouped = execute("Aggregate", frame, groupBy=["g"], aggregations=aggregations)
    assert grouped.empty and list(grouped.columns) == ["g", *expected]
    assert str(grouped["count"].dtype) == "Int64"
    assert str(grouped["stddev"].dtype) == "Float64"


def test_aggregate_stddev_is_sample_and_first_includes_null():
    result = execute(
        "Aggregate",
        pd.DataFrame({"v": [None, 2.0, 4.0, 4.0]}),
        aggregations=[
            {"fn": "stddev", "col": "v", "as": "std"},
            {"fn": "median", "col": "v", "as": "med"},
            {"fn": "count_distinct", "col": "v", "as": "distinct"},
            {"fn": "first", "col": "v", "as": "first"},
        ],
    )
    assert result["std"][0] == pytest.approx((4 / 3) ** 0.5)
    assert rows(result)[0] | {"std": None} == {"std": None, "med": 4, "distinct": 2, "first": None}
    singleton = execute("Aggregate", pd.DataFrame({"v": [2]}), aggregations=[{"fn": "stddev", "col": "v", "as": "v"}])
    assert rows(singleton) == [{"v": None}]


@pytest.mark.parametrize(
    "properties,code",
    [
        ({"aggregations": [{"fn": "mean", "col": "g", "as": "v"}]}, "AGGREGATE_TYPE"),
        ({"aggregations": [{"fn": "sum", "as": "v"}]}, "AGGREGATE_ARGUMENT"),
        ({"aggregations": [{"fn": "sum", "col": "missing", "as": "v"}]}, "MISSING_COLUMN"),
        ({"groupBy": ["g"], "aggregations": [{"fn": "count", "as": "g"}]}, "COLUMN_COLLISION"),
        ({"aggregations": [{"fn": "count", "as": "x"}, {"fn": "count", "as": "x"}]}, "COLUMN_COLLISION"),
    ],
)
def test_aggregate_contract_errors(properties, code):
    with pytest.raises(runtime.NativeError, match=code):
        execute("Aggregate", pd.DataFrame({"g": ["a"]}), **properties)


def test_integer_sum_cannot_silently_overflow():
    with pytest.raises(runtime.NativeError, match="AGGREGATE_RANGE"):
        execute("Aggregate", pd.DataFrame({"v": [2**62, 2**62]}), aggregations=[{"fn": "sum", "col": "v", "as": "sum"}])


def join_frames():
    left = pd.DataFrame({"id": pd.Series([1, 1, 2, None, None], dtype="Int64"), "v": ["a", "b", "c", "d", "e"]})
    right = pd.DataFrame({"id": pd.Series([1, 1, 3, None], dtype="Int64"), "v": ["x", "y", "z", "n"]})
    return left, right


@pytest.mark.parametrize("kind,expected", [("inner", 4), ("left", 7), ("right", 6), ("full", 9)])
def test_join_default_null_keys_never_match_and_same_name_keys_coalesce(kind, expected):
    result = execute("Join", *join_frames(), on="id", type=kind)
    assert len(result) == expected
    assert list(result.columns) == ["id", "v", "v_right"]
    assert str(result["id"].dtype) == "Int64"
    facts = result.attrs["native_v2"]["operations"]["join"]
    assert facts["matchedOutputRows"] == 4
    assert facts["left"]["matchedRows"] == 2 and facts["left"]["unmatchedRows"] == 3
    assert facts["left"]["matchedKeys"] == 1 and facts["left"]["distinctKeys"] == 2
    if kind == "full":
        assert 3 in result["id"].dropna().tolist()
        assert result["id"].isna().sum() == 3


def test_join_null_matching_is_explicit_and_cardinality_is_enforced():
    left, right = join_frames()
    assert len(execute("Join", left, right, on="id", type="full", nullsEqual=True)) == 8
    with pytest.raises(runtime.NativeError, match="JOIN_CARDINALITY"):
        execute("Join", left, right, on="id", validate="many_to_one")
    only_null = pd.DataFrame({"id": pd.Series([None, None], dtype="Int64")})
    assert len(execute("Join", only_null, only_null, on="id", validate="one_to_one")) == 0
    with pytest.raises(runtime.NativeError, match="JOIN_CARDINALITY"):
        execute("Join", only_null, only_null, on="id", nullsEqual=True, validate="one_to_one")


def test_composite_join_and_distinct_self_join_port_roles():
    left = pd.DataFrame({"a": [1, 1], "b": [2, 3], "v": [10, 20]})
    right = pd.DataFrame({"x": [1, 1], "y": [3, 4], "v": [30, 40]})
    result = execute("Join", left, right, on=[["a", "x"], ["b", "y"]], validate="one_to_one")
    assert rows(result) == [{"a": 1, "b": 3, "v": 20, "x": 1, "y": 3, "v_right": 30}]
    definition = spec("Join", on=["a", "b"])
    definition["inputs"] = ["source", "source"]
    same = runtime.execute_native(definition, [left, left])
    assert len(same) == 2 and same.attrs["native_v2"]["inputRows"] == [2, 2]


def test_join_empty_cross_missing_keys_mismatched_types_and_suffix_collision():
    left, right = join_frames()
    empty = execute("Join", left.iloc[:0], right, on="id", type="right")
    assert len(empty) == len(right) and str(empty["id"].dtype) == "Int64"
    assert len(execute("Join", left, right, type="cross")) == 20
    for properties, code in [
        ({}, "JOIN_KEYS"),
        ({"type": "cross", "on": "id"}, "JOIN_KEYS"),
        ({"on": "missing"}, "MISSING_COLUMN"),
        ({"on": "id", "rightSuffix": ""}, "JOIN_ARGUMENT"),
        ({"on": "id", "type": "outer"}, "JOIN_ARGUMENT"),
    ]:
        with pytest.raises(runtime.NativeError, match=code):
            execute("Join", left, right, **properties)
    with pytest.raises(runtime.NativeError, match="JOIN_TYPE"):
        execute("Join", left, right.astype({"id": "string"}), on="id")
    # A right column whose suffixed name is also taken gets the suffix again;
    # the rename is recorded instead of failing the join.
    renamed = execute("Join", left.assign(v_right=1), right, on="id")
    assert "v_right_right" in renamed.columns and "v_right" in renamed.columns
    assert renamed.attrs["native_v2"]["operations"]["join"]["renamedRight"] == {"v": "v_right_right"}


def test_semi_and_anti_joins_keep_left_rows_once_without_right_columns():
    left = pd.DataFrame({"id": pd.Series([1, 2, 3, None], dtype="Int64"), "v": ["a", "b", "c", "d"]})
    right = pd.DataFrame({"id": pd.Series([2, 2, 3, 9], dtype="Int64"), "w": ["x", "y", "z", "q"]})
    semi = execute("Join", left, right, on="id", type="semi")
    assert rows(semi) == [{"id": 2, "v": "b"}, {"id": 3, "v": "c"}]
    assert list(semi.columns) == ["id", "v"]
    anti = execute("Join", left, right, on="id", type="anti")
    assert rows(anti) == [{"id": 1, "v": "a"}, {"id": None, "v": "d"}]
    facts = semi.attrs["native_v2"]["operations"]["join"]
    assert facts["type"] == "semi" and facts["matchedOutputRows"] == 2
    assert facts["left"]["matchedRows"] == 2 and facts["left"]["unmatchedRows"] == 2
    with pytest.raises(runtime.NativeError, match="JOIN_KEYS"):
        execute("Join", left, right, type="semi")


def test_bool_columns_sum_and_average_as_zero_one():
    frame = pd.DataFrame({"g": ["a", "a", "b"], "flag": pd.Series([True, False, None], dtype="boolean")})
    result = execute(
        "Aggregate",
        frame,
        groupBy=["g"],
        aggregations=[{"fn": "sum", "col": "flag", "as": "n_true"}, {"fn": "mean", "col": "flag", "as": "share"}],
    )
    assert rows(result) == [{"g": "a", "n_true": 1, "share": 0.5}, {"g": "b", "n_true": None, "share": None}]
    assert str(result["n_true"].dtype) == "Int64"
    assert result.attrs["native_v2"]["operations"]["boolAsInt"] == ["flag"]
    with pytest.raises(runtime.NativeError, match="AGGREGATE_TYPE"):
        execute("Aggregate", pd.DataFrame({"s": ["x"]}), aggregations=[{"fn": "sum", "col": "s", "as": "t"}])


def test_union_strict_align_null_columns_and_port_order():
    left = pd.DataFrame({"a": pd.Series([1, None], dtype="Int64"), "b": ["x", "y"]})
    right = pd.DataFrame({"b": ["z"], "a": pd.Series([3], dtype="Int64")})
    result = execute("Union", left, right)
    assert rows(result) == [{"a": 1, "b": "x"}, {"a": None, "b": "y"}, {"a": 3, "b": "z"}]
    assert str(result["a"].dtype) == "Int64"
    aligned = execute("Union", left, pd.DataFrame({"c": [True]}), schema="align")
    assert list(aligned.columns) == ["a", "b", "c"] and len(aligned) == 3
    assert rows(aligned)[2] == {"a": None, "b": None, "c": True}
    assert aligned.attrs["native_v2"]["operations"]["alignedMissingColumns"] == [["c"], ["a", "b"]]
    with pytest.raises(runtime.NativeError, match="UNION_SCHEMA") as union_error:
        execute("Union", left, pd.DataFrame({"a": [2], "z": [0]}))
    union_message = json.loads(str(union_error.value).split("NATIVE_ERROR_V2:", 1)[1])["message"]
    assert "input 2 lacks ['b']; input 2 adds ['z']" in union_message
    assert 'schema="align"' in union_message
    with pytest.raises(runtime.NativeError, match="UNION_TYPE"):
        execute("Union", left, right.astype({"a": "string"}))
    # Whole numbers beside fractions are one numeric column, as in pandas.
    widened = execute("Union", left, pd.DataFrame({"a": [2.5], "b": ["w"]}))
    assert str(widened["a"].dtype) == "Float64"
    assert rows(widened) == [{"a": 1.0, "b": "x"}, {"a": None, "b": "y"}, {"a": 2.5, "b": "w"}]
    assert widened.attrs["native_v2"]["operations"]["widened"] == {"a": ["float64", "int64"]}
    assert "widened" not in result.attrs["native_v2"]["operations"]
    with pytest.raises(runtime.NativeError, match="UNION_TYPE"):
        execute("Union", pd.DataFrame({"a": [2**53 + 1], "b": ["x"]}), pd.DataFrame({"a": [2.5], "b": ["w"]}))
    with pytest.raises(runtime.NativeError, match="UNION_TYPE"):
        execute("Union", pd.DataFrame({"a": [True], "b": ["x"]}), pd.DataFrame({"a": [2.5], "b": ["w"]}))


def test_distinct_sort_limit_stable_order_and_empty_schema():
    frame = pd.DataFrame(
        {"k": pd.array([1, None, 1, None, 2], dtype="Int64"), "v": [2, 2, 1, 2, 2]}, index=[8, 8, -1, 7, 7]
    )
    assert rows(execute("Distinct", frame, columns=["k"], keep="last")) == [
        {"k": 1, "v": 1},
        {"k": None, "v": 2},
        {"k": 2, "v": 2},
    ]
    assert len(execute("Distinct", frame)) == 4
    sorted_frame = execute("Sort", frame, by=[{"col": "v"}], nulls="first")
    assert rows(sorted_frame) == [rows(frame)[i] for i in [2, 0, 1, 3, 4]]
    assert rows(execute("Limit", sorted_frame, n=2, offset=1)) == rows(sorted_frame)[1:3]
    empty = execute("Limit", frame, n=1, offset=100)
    assert empty.empty and empty.dtypes.equals(frame.dtypes)
    with pytest.raises(runtime.NativeError, match="MISSING_COLUMN"):
        execute("Sort", frame, by=[{"col": "missing"}])


def test_multiple_sort_keys_and_null_placement_are_stable():
    frame = pd.DataFrame({"a": [1, None, 1, 1, None], "b": [2, 1, 2, 3, 4], "order": list(range(5))})
    result = execute("Sort", frame, by=[{"col": "a"}, {"col": "b", "desc": True}], nulls="first")
    assert result["order"].tolist() == [4, 1, 3, 0, 2]


def test_float_infinity_cannot_silently_become_a_null_in_json_transport():
    with pytest.raises(runtime.NativeError, match="INPUT_VALUE_TYPE"):
        execute("Union", pd.DataFrame({"x": [float("inf")]}), pd.DataFrame({"x": [1.0]}))
    with pytest.raises(runtime.NativeError, match="OUTPUT_VALUE_TYPE"):
        execute("Map", pd.DataFrame({"x": [1.0]}), func="def apply(row):\n    return {**row, 'y': float('inf')}")


def test_join_and_union_do_not_round_nullable_object_integers():
    large = 9007199254740993
    left = pd.DataFrame({"id": pd.Series([large, None], dtype=object)})
    right = pd.DataFrame({"id": [large]})
    for result in (execute("Join", left, right, on="id"), execute("Union", left, right)):
        assert result["id"].iloc[0] == large


def test_cross_join_cannot_silently_ignore_a_key_cardinality_constraint():
    with pytest.raises(runtime.NativeError, match="JOIN_KEYS"):
        execute("Join", pd.DataFrame({"a": [1, 2]}), pd.DataFrame({"b": [3, 4]}), type="cross", validate="one_to_one")
