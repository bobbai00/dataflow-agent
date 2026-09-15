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

"""Hand-computed shape contracts, including empty and scalar transport domains."""

import json
import sys
from pathlib import Path

import pandas as pd
import pytest

from test_native_v2_runtime import run, runtime, spec


def values(frame, column):
    return [runtime._scalar(value) for value in frame[column]]


def test_window_partition_nulls_ties_stability_and_original_row_order():
    frame = pd.DataFrame(
        {
            "g": ["b", "a", "a", None, "a", None, "a"],
            "t": pd.array([2, 2, 1, 1, 1, None, None], dtype="Int64"),
            "v": pd.array([99, 20, 10, 5, None, 6, 30], dtype="Int64"),
        },
        index=[8, 8, -2, 0, 0, 8, 2],
    )
    before = frame.copy(deep=True)
    result = run(
        "Window",
        frame,
        partitionBy=["g"],
        orderBy=[{"col": "t"}],
        columns=[
            {"fn": "lag", "col": "v", "as": "previous"},
            {"fn": "lead", "col": "v", "as": "next"},
            {"fn": "row_number", "as": "position"},
            {"fn": "rank", "as": "rank"},
            {"fn": "dense_rank", "as": "dense"},
        ],
    )
    assert values(result, "previous") == [None, None, None, None, 10, 5, 20]
    assert values(result, "next") == [None, 30, None, 6, 20, None, None]
    assert values(result, "position") == [1, 3, 1, 1, 2, 2, 4]
    assert values(result, "rank") == [1, 3, 1, 1, 1, 2, 4]
    assert values(result, "dense") == [1, 2, 1, 1, 1, 2, 3]
    pd.testing.assert_frame_equal(frame, before)
    pd.testing.assert_frame_equal(result[frame.columns], frame.reset_index(drop=True))
    measured = result.attrs["native_v2"]["operations"]["window"]
    assert measured["partitions"] == 3 and measured["tieRows"] == 1
    assert measured["outputs"]["previous"] == {"boundaryNulls": 3, "nullOutputs": 4}


def test_window_multiple_order_keys_descending_offsets_and_exact_integers():
    large = 9007199254740993
    frame = pd.DataFrame({"a": [1, 1, 1, 1], "b": [2, 2, 3, None], "v": pd.Series([large, None, 7, 9], dtype=object)})
    result = run(
        "Window",
        frame,
        orderBy=[{"col": "a"}, {"col": "b", "desc": True}],
        columns=[
            {"fn": "lead", "col": "v", "as": "next2", "offset": 2},
            {"fn": "lag", "col": "v", "as": "lagged"},
            {"fn": "row_number", "as": "rn"},
        ],
    )
    assert values(result, "rn") == [2, 3, 1, 4]
    assert values(result, "next2") == [9, None, None, None]
    assert values(result, "lagged") == [7, large, None, None]
    assert str(result["lagged"].dtype) == "Int64"


@pytest.mark.parametrize(
    "dtype,value",
    [
        ("string", "001"),
        ("boolean", False),
        ("Float64", 2.5),
        ("datetime64[ns, UTC]", pd.Timestamp("2025-01-01", tz="UTC")),
    ],
)
def test_window_preserves_shift_domain_and_empty_schema(dtype, value):
    frame = pd.DataFrame({"v": pd.Series([value, None], dtype=dtype), "t": [1, 2]})
    props = {"orderBy": [{"col": "t"}], "columns": [{"fn": "lag", "col": "v", "as": "prev"}]}
    result = run("Window", frame, **props)
    assert values(result, "prev") == [None, value]
    empty = run("Window", frame.iloc[:0], **props)
    assert str(empty["prev"].dtype) == dtype
    assert empty.attrs["native_v2"]["operations"]["window"]["partitions"] == 0


@pytest.mark.parametrize(
    "column,code",
    [
        ({"fn": "lag", "as": "v2"}, "WINDOW_ARGUMENT"),
        ({"fn": "lag", "col": "v", "as": "v2", "offset": 0}, "WINDOW_ARGUMENT"),
        ({"fn": "rank", "col": "v", "as": "v2"}, "WINDOW_ARGUMENT"),
        ({"fn": "row_number", "offset": 2, "as": "v2"}, "WINDOW_ARGUMENT"),
        ({"fn": "rolling_mean", "col": "v", "as": "v2"}, "WINDOW_ARGUMENT"),
        ({"fn": "lag", "col": "missing", "as": "v2"}, "MISSING_COLUMN"),
        ({"fn": "rank", "as": "v"}, "COLUMN_COLLISION"),
    ],
)
def test_window_actionable_errors(column, code):
    with pytest.raises(runtime.NativeError, match=code):
        run("Window", pd.DataFrame({"v": [1]}), orderBy=[{"col": "v"}], columns=[column])


def test_split_is_literal_padded_bounded_and_null_safe():
    frame = pd.DataFrame({"label": ["a.*b.*c.*d", "a", None, "", ".*b"], "id": [1, 2, 3, 4, 5]}, index=[9, 9, 9, -1, 0])
    result = run("Split", frame, column="label", into=["a", "b", "rest"], separator=".*", keepSource=False)
    assert list(result.columns) == ["id", "a", "b", "rest"]
    assert values(result, "a") == ["a", "a", None, "", ""]
    assert values(result, "b") == ["b", None, None, None, "b"]
    assert values(result, "rest") == ["c.*d", None, None, None, None]
    assert all(str(result[name].dtype) == "string" for name in ["a", "b", "rest"])
    assert result.attrs["native_v2"]["operations"]["columnDependencies"] == {
        name: ["label"] for name in ["a", "b", "rest"]
    }
    empty = run("Split", frame.iloc[:0], column="label", into=["x", "y"], separator=":")
    assert empty.empty and list(empty.columns) == ["label", "id", "x", "y"]


@pytest.mark.parametrize(
    "frame,properties,code",
    [
        (pd.DataFrame({"x": [1]}), {"column": "x", "into": ["a", "b"], "separator": ":"}, "SPLIT_TYPE"),
        (
            pd.DataFrame({"x": ["a:b"]}),
            {"column": "x", "into": ["x", "b"], "separator": ":", "keepSource": False},
            "COLUMN_COLLISION",
        ),
        (pd.DataFrame({"x": ["a:b"]}), {"column": "x", "into": ["a", "a"], "separator": ":"}, "COLUMN_COLLISION"),
        (pd.DataFrame({"x": ["a:b"]}), {"column": "x", "into": ["a", "b"], "separator": ""}, "SPLIT_ARGUMENT"),
    ],
)
def test_split_does_not_coerce_or_overwrite(frame, properties, code):
    with pytest.raises(runtime.NativeError, match=code):
        run("Split", frame, **properties)


def test_explode_json_order_empty_policy_private_parent_mapping_and_exact_int64():
    large = 9007199254740993
    frame = pd.DataFrame({"tags": [f"[1, null, {large}]", "[]", None, "[2]"], "id": [5, 6, 7, 8]}, index=[9, 9, -1, 2])
    result = run("Explode", frame, column="tags", encoding="json")
    assert values(result, "tags") == [1, None, large, 2]
    assert values(result, "id") == [5, 5, 5, 8]
    assert list(result.columns) == ["tags", "id"] and str(result["tags"].dtype) == "Int64"
    ops = result.attrs["native_v2"]["operations"]
    assert ops["explode"] == {"emptyParents": 2, "arrayElements": 4, "nullElements": 1, "maxElements": 3}
    assert ops["rowMapping"]["sample"] == [
        {"inputPosition": 0, "elementPosition": 0},
        {"inputPosition": 0, "elementPosition": 1},
        {"inputPosition": 0, "elementPosition": 2},
        {"inputPosition": 3, "elementPosition": 0},
    ]
    kept = run("Explode", frame, column="tags", encoding="json", empty="null_row")
    assert values(kept, "id") == [5, 5, 5, 6, 7, 8]
    assert values(kept, "tags") == [1, None, large, None, None, 2]


@pytest.mark.parametrize(
    "serialized,expected,dtype",
    [
        ('["001", "NULL", null, ""]', ["001", "NULL", None, ""], "string"),
        ("[true, false, null]", [True, False, None], "boolean"),
        ("[1.5, null, 2.0]", [1.5, None, 2.0], "Float64"),
        ("[null]", [None], "string"),
    ],
)
def test_explode_scalar_domains(serialized, expected, dtype):
    output = run("Explode", pd.DataFrame({"x": [serialized]}), column="x", encoding="json")
    assert values(output, "x") == expected and str(output["x"].dtype) == dtype


def test_explode_empty_output_and_parent_metadata_are_bounded():
    frame = pd.DataFrame({"x": ["[]", None], "id": pd.Series([1, 2], dtype="Int64")})
    result = run("Explode", frame, column="x", encoding="json")
    assert result.empty and list(result.columns) == ["x", "id"] and str(result["x"].dtype) == "string"
    wide = run("Explode", pd.DataFrame({"x": [json.dumps(list(range(40)))]}), column="x", encoding="json")
    mapping = wide.attrs["native_v2"]["operations"]["rowMapping"]
    assert len(mapping["sample"]) <= 16 and mapping["complete"] is False


@pytest.mark.parametrize(
    "serialized,code",
    [
        ("bad", "EXPLODE_JSON"),
        ("{}", "EXPLODE_TYPE"),
        ("null", "EXPLODE_TYPE"),
        ("[{}]", "EXPLODE_TYPE"),
        ("[[1]]", "EXPLODE_TYPE"),
        ("[1, true]", "EXPLODE_TYPE"),
        ('[1, "2"]', "EXPLODE_TYPE"),
        ("[1, 2.0]", "EXPLODE_TYPE"),
        ("[NaN]", "EXPLODE_JSON"),
        ("[Infinity]", "EXPLODE_JSON"),
        ("[1e999]", "EXPLODE_TYPE"),
        ("[9223372036854775808]", "EXPLODE_TYPE"),
        (42, "EXPLODE_TYPE"),
    ],
)
def test_explode_rejects_non_json_mixed_and_untransportable_elements(serialized, code):
    with pytest.raises(runtime.NativeError, match=code) as error:
        run("Explode", pd.DataFrame({"x": [serialized]}), column="x", encoding="json")
    assert error.value.diagnostic["field"] == "column"
    assert "row 0" in error.value.diagnostic["message"]


def test_explode_type_is_consistent_across_parent_rows():
    with pytest.raises(runtime.NativeError, match="EXPLODE_TYPE"):
        run("Explode", pd.DataFrame({"x": ['["a"]', "[true]"]}), column="x", encoding="json")


def test_unpivot_order_null_cells_types_and_zero_key_columns():
    large = 9007199254740993
    frame = pd.DataFrame(
        {"id": ["b", "a"], "y1": pd.Series([large, None], dtype=object), "y2": pd.Series([7, 9], dtype="Int64")}
    )
    result = run("Unpivot", frame, columns=["y2", "y1"], nameColumn="year", valueColumn="amount")
    assert values(result, "id") == ["b", "b", "a", "a"]
    assert values(result, "year") == ["y2", "y1", "y2", "y1"]
    assert values(result, "amount") == [7, large, 9, None] and str(result["amount"].dtype) == "Int64"
    empty = run("Unpivot", frame.iloc[:0], columns=["y2", "y1"])
    assert empty.empty and list(empty.columns) == ["id", "variable", "value"]
    no_keys = run("Unpivot", frame[["y2", "y1"]], columns=["y1", "y2"])
    assert len(no_keys) == 4 and list(no_keys.columns) == ["variable", "value"]


@pytest.mark.parametrize(
    "properties,code",
    [
        ({"columns": ["a", "b"]}, "UNPIVOT_TYPE"),
        ({"columns": ["a"], "nameColumn": "id"}, "COLUMN_COLLISION"),
        ({"columns": ["a"], "nameColumn": "same", "valueColumn": "same"}, "COLUMN_COLLISION"),
        ({"columns": ["a", "a"]}, "COLUMN_COLLISION"),
        ({"columns": ["missing"]}, "MISSING_COLUMN"),
    ],
)
def test_unpivot_rejects_incompatible_domains_and_collisions(properties, code):
    with pytest.raises(runtime.NativeError, match=code):
        run("Unpivot", pd.DataFrame({"id": [1], "a": [2], "b": ["2"]}), **properties)


def test_pivot_unique_keys_null_index_first_seen_order_and_dynamic_schema():
    large = 9007199254740993
    frame = pd.DataFrame(
        {
            "id": ["b", None, "b", "a"],
            "year": ["y2", "y1", "y1", "y3"],
            "amount": pd.Series([large, 3, None, 4], dtype="Int64"),
        }
    )
    result = run("Pivot", frame, index=["id"], columns="year", values="amount")
    assert list(result.columns) == ["id", "y2", "y1", "y3"]
    assert values(result, "id") == ["b", None, "a"]
    assert values(result, "y2") == [large, None, None]
    assert values(result, "y1") == [None, 3, None]
    assert values(result, "y3") == [None, None, 4]
    assert all(str(result[c].dtype) == "Int64" for c in ["y1", "y2", "y3"])
    assert result.attrs["native_v2"]["operations"]["pivot"]["missingCells"] == 5
    empty = run("Pivot", frame.iloc[:0], index=["id"], columns="year", values="amount")
    assert empty.empty and list(empty.columns) == ["id"]
    revised = run("Pivot", frame.iloc[-1:], index=["id"], columns="year", values="amount")
    assert list(revised.columns) == ["id", "y3"]
    no_keys = run("Pivot", frame.iloc[:2], index=[], columns="year", values="amount")
    assert len(no_keys) == 1 and list(no_keys.columns) == ["y2", "y1"]


def test_pivot_duplicate_pairs_fail_instead_of_aggregating_with_bounded_witness():
    frame = pd.DataFrame({"id": [None, None], "k": ["x", "x"], "v": [2, 2]})
    with pytest.raises(runtime.NativeError, match="PIVOT_DUPLICATE") as error:
        run("Pivot", frame, index=["id"], columns="k", values="v")
    message = error.value.diagnostic["message"]
    assert "rows 0 and 1" in message and "Aggregate" in message
    assert error.value.diagnostic["field"] == "index/columns"


@pytest.mark.parametrize(
    "keys,code", [([None], "PIVOT_NULL_KEY"), (["id"], "COLUMN_COLLISION"), ([""], "COLUMN_COLLISION")]
)
def test_pivot_rejects_unusable_dynamic_names(keys, code):
    with pytest.raises(runtime.NativeError, match=code):
        run("Pivot", pd.DataFrame({"id": [1], "k": keys, "v": [2]}), index=["id"], columns="k", values="v")


def test_shape_parameter_errors_are_preflight_not_worker_execution():
    cases = [
        ("Window", {"orderBy": [{"col": "x"}], "columns": [{"fn": "rank", "as": "r", "offset": 1}]}, "WINDOW_ARGUMENT"),
        ("Split", {"column": "x", "into": ["a", "b"], "separator": ""}, "SPLIT_ARGUMENT"),
        ("Explode", {"column": "x", "encoding": "python"}, "EXPLODE_ARGUMENT"),
        ("Pivot", {"index": ["x"], "columns": "x", "values": "v"}, "PIVOT_ARGUMENT"),
    ]
    for kind, properties, code in cases:
        with pytest.raises(runtime.NativeError, match=code) as error:
            runtime.validate_native(spec(kind, **properties))
        assert error.value.diagnostic["stage"] == "validate"


@pytest.mark.parametrize("empty", [False, True])
def test_all_shapes_round_trip_engine_schema_tuples_and_arrow(empty):
    # Local codec test; no JVM/service is launched and this is not called E2E.
    sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "amber/src/main/python"))
    import pyarrow as pa
    from core.models.table import Table
    from core.runnables.data_processor import DataProcessor

    large = 9007199254740993
    frame = pd.DataFrame(
        {
            "label": ["A:Alpha"],
            "tags": ["[1,2]"],
            "y1": pd.Series([large], dtype="Int64"),
            "y2": pd.Series([7], dtype="Int64"),
            "__row_index__": ["user_value"],
            "__is_visualization__": [True],
        }
    )
    if empty:
        frame = frame.iloc[:0]
    chain = [
        ("Split", {"column": "label", "into": ["entity", "description"], "separator": ":"}),
        ("Explode", {"column": "tags", "encoding": "json"}),
        ("Unpivot", {"columns": ["y1", "y2"]}),
        (
            "Window",
            {
                "partitionBy": ["entity", "tags"],
                "orderBy": [{"col": "variable"}],
                "columns": [{"fn": "lag", "col": "value", "as": "previous"}],
            },
        ),
        ("Pivot", {"index": ["entity", "tags"], "columns": "variable", "values": "previous"}),
    ]
    processor = DataProcessor.__new__(DataProcessor)
    for kind, properties in chain:
        output = run(kind, frame, **properties)
        schema = processor._infer_schema_from_dataframe(output)
        tuples = list(Table(output).as_tuples())
        # Model the scalar normalization at the worker/Arrow boundary without
        # changing labels, injecting internal columns or float-coercing int64.
        records = [
            {name: runtime._scalar(value) for name, value in zip(schema.get_attr_names(), row.get_fields())}
            for row in tuples
        ]
        arrow = pa.Table.from_pylist(records, schema=schema.as_arrow_schema())
        sink = pa.BufferOutputStream()
        with pa.ipc.new_stream(sink, arrow.schema) as writer:
            writer.write_table(arrow)
        restored = pa.ipc.open_stream(sink.getvalue()).read_all()
        frame = Table.from_tuple_likes(iter(restored.to_pylist()), schema=schema)
        assert list(frame.columns) == list(output.columns)
        assert len(frame) == len(output)
        for column in output.columns:
            assert values(frame, column) == values(output, column)
        if kind == "Window" and not empty:
            assert values(frame, "previous") == [None, large, None, large]
        if kind == "Pivot":
            assert list(frame.columns) == (["entity", "tags"] if empty else ["entity", "tags", "y1", "y2"])
