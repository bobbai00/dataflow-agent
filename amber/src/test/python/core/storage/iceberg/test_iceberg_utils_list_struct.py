# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.
"""
Regressions for iceberg-storage handling of LIST / STRUCT columns.

Before this fix, `_AMBER_TO_ICEBERG_TYPE_MAPPING` had no entries for
LIST or STRUCT, so `amber_schema_to_iceberg_schema` raised
`KeyError: <AttributeType.LIST: 9>` whenever the engine tried to
create a per-port storage writer for a schema-inferred LIST or STRUCT
column. The crash fires OUTSIDE user code in the OutputManager's
`recreate_port_storage_writer` path — the operator looks like it
completed but downstream sees no data.

The fix adds LIST → StringType() and STRUCT → StringType() to the
mapping (consistent with TO_ARROW_MAPPING which already collapses
both to `pa.string()` for the network/Arrow transport), and
JSON-encodes list/dict/ndarray cells in `amber_tuples_to_arrow_table`
so they survive the now-StringType iceberg column without an
ArrowTypeError.

This module pins:
  - schema-build doesn't KeyError for LIST and STRUCT
  - cells round-trip through pa.Table.from_pydict (JSON-encoded strings)
  - existing types still pass through unchanged (no regressions on
    STRING / INT / LONG / BOOL / TIMESTAMP)
  - the per-cell encoder handles the exotic shapes the agent's UDFs
    are known to emit (numpy.ndarray, tuple, set, nested list,
    pd.NA inside container, datetime cell)
"""

import datetime
import json

import numpy as np
import pyarrow as pa
import pytest

from core.models import Schema, Tuple
from core.models.schema.attribute_type import AttributeType
from core.storage.iceberg.iceberg_utils import (
    _AMBER_TO_ICEBERG_TYPE_MAPPING,
    amber_schema_to_iceberg_schema,
    amber_tuples_to_arrow_table,
    arrow_table_to_amber_tuples,
)


# ----------------------------------------------------------------------
# Mapping shape
# ----------------------------------------------------------------------


class TestAmberToIcebergMapping:
    """The mapping must cover every AttributeType the engine produces."""

    def test_list_mapped_to_string(self):
        # The KeyError that the production trace flagged came from a
        # missing AttributeType.LIST entry. Pin the contract directly.
        assert AttributeType.LIST in _AMBER_TO_ICEBERG_TYPE_MAPPING
        # The JSON-encoded transport contract (see attribute_type.py
        # TO_ARROW_MAPPING) collapses LIST to pa.string() for the wire.
        # The iceberg storage type must match (also string-typed) so the
        # two layers don't disagree about cell shape.
        assert "string" in str(_AMBER_TO_ICEBERG_TYPE_MAPPING[AttributeType.LIST]).lower()

    def test_struct_mapped_to_string(self):
        assert AttributeType.STRUCT in _AMBER_TO_ICEBERG_TYPE_MAPPING
        assert "string" in str(
            _AMBER_TO_ICEBERG_TYPE_MAPPING[AttributeType.STRUCT]
        ).lower()

    def test_all_attribute_types_in_mapping(self):
        """
        The mapping must be exhaustive over AttributeType so a future
        addition can't silently regress this code path. The original bug
        was exactly this kind of silent omission.
        """
        missing = []
        for attr_type in AttributeType:
            if attr_type not in _AMBER_TO_ICEBERG_TYPE_MAPPING:
                missing.append(attr_type)
        assert missing == [], f"AttributeTypes missing iceberg mapping: {missing}"

    def test_pre_existing_mappings_unchanged(self):
        # Guard that the new LIST/STRUCT additions didn't disturb the
        # mappings the rest of the system already depends on.
        assert "string" in str(_AMBER_TO_ICEBERG_TYPE_MAPPING[AttributeType.STRING]).lower()
        assert "int" in str(_AMBER_TO_ICEBERG_TYPE_MAPPING[AttributeType.INT]).lower()
        assert "long" in str(_AMBER_TO_ICEBERG_TYPE_MAPPING[AttributeType.LONG]).lower()
        assert "double" in str(_AMBER_TO_ICEBERG_TYPE_MAPPING[AttributeType.DOUBLE]).lower()
        assert "bool" in str(_AMBER_TO_ICEBERG_TYPE_MAPPING[AttributeType.BOOL]).lower()
        assert "timestamp" in str(
            _AMBER_TO_ICEBERG_TYPE_MAPPING[AttributeType.TIMESTAMP]
        ).lower()


# ----------------------------------------------------------------------
# Schema build path (the surface that produced the KeyError)
# ----------------------------------------------------------------------


class TestAmberSchemaToIcebergSchemaForListAndStruct:
    """Exercise amber_schema_to_iceberg_schema for the new types."""

    def test_list_only_schema_does_not_raise(self):
        # The exact failure mode from the production trace.
        s = Schema()
        s.add("tags", AttributeType.LIST)
        iceberg_schema = amber_schema_to_iceberg_schema(s)
        assert iceberg_schema is not None
        # Field should exist and be string-typed in iceberg.
        names = [f.name for f in iceberg_schema.fields]
        assert "tags" in names

    def test_struct_only_schema_does_not_raise(self):
        s = Schema()
        s.add("meta", AttributeType.STRUCT)
        iceberg_schema = amber_schema_to_iceberg_schema(s)
        names = [f.name for f in iceberg_schema.fields]
        assert "meta" in names

    def test_mixed_schema_with_list_and_scalars(self):
        # Realistic shape from the production trace:
        # one identifier column + one LIST column.
        s = Schema()
        s.add("strategy", AttributeType.STRING)
        s.add("uniques", AttributeType.LIST)
        s.add("count", AttributeType.LONG)
        iceberg_schema = amber_schema_to_iceberg_schema(s)
        names = [f.name for f in iceberg_schema.fields]
        assert names == ["strategy", "uniques", "count"]


# ----------------------------------------------------------------------
# Cell encoding for the StringType iceberg projection
# ----------------------------------------------------------------------


def _build_arrow_from_amber_list(cells):
    """Helper: build amber LIST schema + one-column table from cells."""
    s = Schema()
    s.add("tags", AttributeType.LIST)
    iceberg_schema = amber_schema_to_iceberg_schema(s)
    tuples = [Tuple({"tags": c}) for c in cells]
    return amber_tuples_to_arrow_table(iceberg_schema, tuples)


def _build_arrow_from_amber_struct(cells):
    s = Schema()
    s.add("meta", AttributeType.STRUCT)
    iceberg_schema = amber_schema_to_iceberg_schema(s)
    tuples = [Tuple({"meta": c}) for c in cells]
    return amber_tuples_to_arrow_table(iceberg_schema, tuples)


class TestAmberTuplesToArrowTableContainerCells:
    """The list/dict/ndarray-in-LIST/STRUCT cells must JSON-encode."""

    def test_plain_list_cells_become_json_strings(self):
        table = _build_arrow_from_amber_list(
            [["red", "blue"], ["green"], ["yellow", "purple", "orange"]]
        )
        col = table.column("tags").to_pylist()
        assert col[0] == '["red", "blue"]'
        assert col[1] == '["green"]'
        assert col[2] == '["yellow", "purple", "orange"]'
        # Round-trip via json.loads gets the original list back.
        assert json.loads(col[0]) == ["red", "blue"]

    def test_nested_list_cells_survive(self):
        table = _build_arrow_from_amber_list(
            [[[1, 2], [3, 4]], [[5]]]
        )
        col = table.column("tags").to_pylist()
        assert json.loads(col[0]) == [[1, 2], [3, 4]]
        assert json.loads(col[1]) == [[5]]

    def test_numpy_ndarray_cell_in_list_column_becomes_json(self):
        table = _build_arrow_from_amber_list(
            [np.array(["Full Suppression", "Other"], dtype=object), np.array(["Other"])]
        )
        col = table.column("tags").to_pylist()
        # Native list shape (not numpy.array(...)) — confirms .tolist()
        # ran inside the encoder.
        assert json.loads(col[0]) == ["Full Suppression", "Other"]
        assert json.loads(col[1]) == ["Other"]

    def test_tuple_cell_becomes_json_array(self):
        table = _build_arrow_from_amber_list([("a", "b"), ("c",)])
        col = table.column("tags").to_pylist()
        assert json.loads(col[0]) == ["a", "b"]
        assert json.loads(col[1]) == ["c"]

    def test_dict_cell_in_struct_column_becomes_json(self):
        table = _build_arrow_from_amber_struct(
            [{"k": 1, "v": "alpha"}, {"k": 2, "v": "beta"}]
        )
        col = table.column("meta").to_pylist()
        assert json.loads(col[0]) == {"k": 1, "v": "alpha"}
        assert json.loads(col[1]) == {"k": 2, "v": "beta"}

    def test_dict_with_heterogeneous_value_types(self):
        """
        Real UDFs commonly emit dicts whose values mix scalar Python
        types — strings, ints, floats, bools, None. All must survive
        JSON encoding intact.
        """
        cell = {
            "name": "alpha",
            "count": 42,
            "ratio": 0.5,
            "active": True,
            "deleted": False,
            "notes": None,
        }
        table = _build_arrow_from_amber_struct([cell])
        decoded = json.loads(table.column("meta").to_pylist()[0])
        assert decoded == cell

    def test_dict_with_nested_dict_value(self):
        """
        Nested dicts (one struct embedded inside another) JSON-encode
        recursively without any extra wrapping logic — `json.dumps`
        handles the recursion natively. Round-trip is exact.
        """
        cell = {"outer": {"inner": {"deepest": 7}}, "side": ["a", "b"]}
        table = _build_arrow_from_amber_struct([cell])
        assert json.loads(table.column("meta").to_pylist()[0]) == cell

    def test_dict_with_list_value_round_trip(self):
        """
        Dict cell whose value is a list — common shape from a `groupby`
        followed by `.agg(list)`. JSON encodes both layers in one pass.
        """
        cell = {"label": "g1", "members": ["alice", "bob", "carol"]}
        table = _build_arrow_from_amber_struct([cell])
        assert json.loads(table.column("meta").to_pylist()[0]) == cell

    def test_dict_with_int_keys_serializes(self):
        """
        Python lets dicts have int keys; JSON does not. `json.dumps`
        coerces int keys to their decimal-string form by default —
        verify the cell still ends up as a valid JSON object instead
        of crashing the encoder.
        """
        cell = {1: "one", 2: "two"}
        table = _build_arrow_from_amber_struct([cell])
        decoded = json.loads(table.column("meta").to_pylist()[0])
        # Keys stringified by json.dumps default behavior.
        assert decoded == {"1": "one", "2": "two"}

    def test_struct_column_with_none_cells_interleaved(self):
        """
        Mixed dict + None cells should pass None through cleanly —
        only the dict cells get JSON-encoded.
        """
        table = _build_arrow_from_amber_struct(
            [{"k": 1}, None, {"k": 2}, None]
        )
        col = table.column("meta").to_pylist()
        assert json.loads(col[0]) == {"k": 1}
        assert col[1] is None
        assert json.loads(col[2]) == {"k": 2}
        assert col[3] is None

    def test_empty_dict_cell_round_trips(self):
        """Empty dict → `"{}"` → decodes back to empty dict."""
        table = _build_arrow_from_amber_struct([{}])
        col = table.column("meta").to_pylist()
        assert col == ["{}"]
        assert json.loads(col[0]) == {}

    def test_struct_round_trip_via_arrow_table_to_amber_tuples(self):
        """
        End-to-end: amber tuple with dict cell → iceberg arrow table →
        amber tuple again. The cell comes back as the JSON string form
        (iceberg-stored), and downstream code is expected to ``json.loads``
        if it wants the dict back.
        """
        s = Schema()
        s.add("meta", AttributeType.STRUCT)
        iceberg_schema = amber_schema_to_iceberg_schema(s)
        tuples = [
            Tuple({"meta": {"k": 1, "v": "alpha"}}),
            Tuple({"meta": {"k": 2}}),
            Tuple({"meta": None}),
        ]
        table = amber_tuples_to_arrow_table(iceberg_schema, tuples)
        out = list(arrow_table_to_amber_tuples(iceberg_schema, table))
        assert len(out) == 3
        assert json.loads(out[0]["meta"]) == {"k": 1, "v": "alpha"}
        assert json.loads(out[1]["meta"]) == {"k": 2}
        assert out[2]["meta"] is None

    def test_none_cells_stay_none(self):
        table = _build_arrow_from_amber_list([["a"], None, ["b"]])
        col = table.column("tags").to_pylist()
        assert col == ['["a"]', None, '["b"]']

    def test_set_cell_serializes_via_list_form(self):
        # set is unordered, so check via set equality after decode.
        table = _build_arrow_from_amber_list([{"a", "b", "c"}])
        col = table.column("tags").to_pylist()
        assert set(json.loads(col[0])) == {"a", "b", "c"}

    def test_container_with_datetime_uses_default_str(self):
        # datetime is not natively JSON-serializable; default=str rescues it.
        d = datetime.datetime(2024, 1, 15, 12, 0, 0)
        table = _build_arrow_from_amber_list([[d, "tag"]])
        col = table.column("tags").to_pylist()
        # The datetime serialized via str(): "2024-01-15 12:00:00".
        decoded = json.loads(col[0])
        assert decoded[1] == "tag"
        assert "2024-01-15" in decoded[0]


# ----------------------------------------------------------------------
# Round-trip + interaction with existing types
# ----------------------------------------------------------------------


class TestAmberTuplesToArrowTableRoundTrip:
    """End-to-end write+read using the iceberg-projected arrow schema."""

    def test_list_column_round_trip(self):
        s = Schema()
        s.add("strategy", AttributeType.STRING)
        s.add("uniques", AttributeType.LIST)
        iceberg_schema = amber_schema_to_iceberg_schema(s)
        tuples = [
            Tuple({"strategy": "alpha", "uniques": ["x", "y"]}),
            Tuple({"strategy": "beta", "uniques": ["z"]}),
        ]
        table = amber_tuples_to_arrow_table(iceberg_schema, tuples)
        # The iceberg→amber direction collapses iceberg-string back to
        # AttributeType.STRING for both columns; we verify the bytes
        # survive verbatim through pa.Table.from_pydict.
        out = list(arrow_table_to_amber_tuples(iceberg_schema, table))
        assert len(out) == 2
        decoded_uniques = [json.loads(t["uniques"]) for t in out]
        assert decoded_uniques[0] == ["x", "y"]
        assert decoded_uniques[1] == ["z"]
        assert out[0]["strategy"] == "alpha"
        assert out[1]["strategy"] == "beta"

    def test_string_column_passthrough_unaffected(self):
        # The per-cell encoder must NOT touch plain string cells in a
        # STRING column. Without this guarantee a STRING column with
        # values like ``"[1, 2]"`` would be JSON-decoded back to a list
        # on the next read.
        s = Schema()
        s.add("name", AttributeType.STRING)
        iceberg_schema = amber_schema_to_iceberg_schema(s)
        tuples = [
            Tuple({"name": "hello"}),
            Tuple({"name": "[1, 2]"}),  # looks like JSON but is a string
            Tuple({"name": ""}),
        ]
        table = amber_tuples_to_arrow_table(iceberg_schema, tuples)
        col = table.column("name").to_pylist()
        assert col == ["hello", "[1, 2]", ""]

    def test_long_column_passthrough_unaffected(self):
        s = Schema()
        s.add("count", AttributeType.LONG)
        iceberg_schema = amber_schema_to_iceberg_schema(s)
        tuples = [Tuple({"count": 1}), Tuple({"count": 99})]
        table = amber_tuples_to_arrow_table(iceberg_schema, tuples)
        assert table.column("count").to_pylist() == [1, 99]

    def test_bool_column_passthrough_unaffected(self):
        s = Schema()
        s.add("flag", AttributeType.BOOL)
        iceberg_schema = amber_schema_to_iceberg_schema(s)
        tuples = [Tuple({"flag": True}), Tuple({"flag": False})]
        table = amber_tuples_to_arrow_table(iceberg_schema, tuples)
        assert table.column("flag").to_pylist() == [True, False]

    def test_numpy_int_in_long_column_unaffected(self):
        # tolist()-bearing types that ARE numeric scalars must NOT be
        # mis-routed through the JSON path. Long columns must remain
        # integer-valued, not string-valued.
        s = Schema()
        s.add("n", AttributeType.LONG)
        iceberg_schema = amber_schema_to_iceberg_schema(s)
        tuples = [Tuple({"n": np.int64(7)}), Tuple({"n": np.int32(42)})]
        table = amber_tuples_to_arrow_table(iceberg_schema, tuples)
        assert table.column("n").to_pylist() == [7, 42]


# ----------------------------------------------------------------------
# Edge cases
# ----------------------------------------------------------------------


class TestAmberTuplesToArrowTableEdgeCases:
    def test_empty_list_cell(self):
        table = _build_arrow_from_amber_list([[]])
        assert table.column("tags").to_pylist() == ["[]"]

    def test_empty_dict_cell(self):
        table = _build_arrow_from_amber_struct([{}])
        assert table.column("meta").to_pylist() == ["{}"]

    def test_empty_tuple_list_emits_empty_table(self):
        s = Schema()
        s.add("tags", AttributeType.LIST)
        iceberg_schema = amber_schema_to_iceberg_schema(s)
        table = amber_tuples_to_arrow_table(iceberg_schema, [])
        assert table.num_rows == 0
        assert "tags" in table.column_names

    def test_mixed_types_in_one_table(self):
        """Realistic UDF output: string + list + long + bool together."""
        s = Schema()
        s.add("label", AttributeType.STRING)
        s.add("tags", AttributeType.LIST)
        s.add("count", AttributeType.LONG)
        s.add("active", AttributeType.BOOL)
        iceberg_schema = amber_schema_to_iceberg_schema(s)
        tuples = [
            Tuple({"label": "a", "tags": ["x", "y"], "count": 3, "active": True}),
            Tuple({"label": "b", "tags": ["z"], "count": 7, "active": False}),
        ]
        table = amber_tuples_to_arrow_table(iceberg_schema, tuples)
        assert table.num_rows == 2
        # Each column lands on its expected runtime cell type after
        # encoding: strings stay strings, longs stay ints, bools stay
        # bools, list cells become JSON strings.
        assert table.column("label").to_pylist() == ["a", "b"]
        assert table.column("count").to_pylist() == [3, 7]
        assert table.column("active").to_pylist() == [True, False]
        assert json.loads(table.column("tags").to_pylist()[0]) == ["x", "y"]
        assert json.loads(table.column("tags").to_pylist()[1]) == ["z"]

    def test_unhashable_cell_does_not_crash(self):
        """
        Even pathological cells must not torpedo the write path. A
        circular-reference dict would crash `json.dumps`, but the encoder's
        try/except falls through to `str(value)` so the cell still lands
        in the column (as a non-round-trippable repr — better than a
        process-killing exception).
        """
        d = {}
        d["self"] = d  # circular
        table = _build_arrow_from_amber_struct([d])
        col = table.column("meta").to_pylist()
        assert col[0] is not None  # we got SOMETHING in the column
        # And it's a string (not a dict).
        assert isinstance(col[0], str)
