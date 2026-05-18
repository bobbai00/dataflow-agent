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

import datetime
import pandas
import pyarrow
import pytest
import numpy as np
from copy import deepcopy

from core.models import Tuple, ArrowTableTupleProvider
from core.models.schema.schema import Schema


class TestTuple:
    @pytest.fixture
    def target_tuple(self):
        return Tuple({"x": 1, "y": "a"})

    def test_tuple_from_list(self, target_tuple):
        assert Tuple([("x", 1), ("y", "a")]) == target_tuple

    def test_tuple_from_dict(self, target_tuple):
        assert Tuple({"x": 1, "y": "a"}) == target_tuple

    def test_tuple_from_series(self, target_tuple):
        assert Tuple(pandas.Series({"x": 1, "y": "a"})) == target_tuple

    def test_tuple_as_key_value_pairs(self, target_tuple):
        assert target_tuple.as_key_value_pairs() == [("x", 1), ("y", "a")]

    def test_tuple_as_dict(self, target_tuple):
        assert target_tuple.as_dict() == {"x": 1, "y": "a"}

    def test_tuple_as_series(self, target_tuple):
        assert (target_tuple.as_series() == pandas.Series({"x": 1, "y": "a"})).all()

    def test_tuple_get_fields(self, target_tuple):
        assert target_tuple.get_fields() == (1, "a")

    def test_tuple_get_field_names(self, target_tuple):
        assert target_tuple.get_field_names() == ("x", "y")

    def test_tuple_get_item(self, target_tuple):
        assert target_tuple["x"] == 1
        assert target_tuple["y"] == "a"
        assert target_tuple[0] == 1
        assert target_tuple[1] == "a"

    def test_tuple_set_item(self, target_tuple):
        target_tuple["x"] = 3
        assert target_tuple["x"] == 3
        assert target_tuple["y"] == "a"
        assert target_tuple[0] == 3
        assert target_tuple[1] == "a"
        target_tuple["z"] = 1.1
        assert target_tuple[2] == 1.1
        assert target_tuple["z"] == 1.1

    def test_tuple_str(self, target_tuple):
        assert str(target_tuple) == "Tuple['x': 1, 'y': 'a']"

    def test_tuple_repr(self, target_tuple):
        assert repr(target_tuple) == "Tuple['x': 1, 'y': 'a']"

    def test_tuple_eq(self, target_tuple):
        assert target_tuple == target_tuple
        assert not Tuple({"x": 2, "y": "a"}) == target_tuple

    def test_tuple_ne(self, target_tuple):
        assert not target_tuple != target_tuple
        assert Tuple({"x": 1, "y": "b"}) != target_tuple

    def test_reject_empty_tuplelike(self):
        with pytest.raises(AssertionError):
            Tuple([])
        with pytest.raises(AssertionError):
            Tuple({})
        with pytest.raises(AssertionError):
            Tuple(pandas.Series(dtype=pandas.StringDtype()))

    def test_reject_invalid_tuplelike(self):
        with pytest.raises(TypeError):
            Tuple(1)
        with pytest.raises(TypeError):
            Tuple([1])
        with pytest.raises(TypeError):
            Tuple([None])

    def test_tuple_lazy_get_from_arrow(self):
        def field_accessor(field_name):
            return chr(96 + int(field_name))

        chr_tuple = Tuple({"1": "a", "3": "c"})
        tuple_ = Tuple({"1": field_accessor, "3": field_accessor})
        assert tuple_ == Tuple({"1": "a", "3": "c"})
        tuple_ = Tuple({"1": field_accessor, "3": field_accessor})
        assert deepcopy(tuple_) == chr_tuple

    def test_retrieve_tuple_from_empty_arrow_table(self):
        arrow_schema = pyarrow.schema([])
        arrow_table = arrow_schema.empty_table()
        tuple_provider = ArrowTableTupleProvider(arrow_table)
        tuples = [
            Tuple({name: field_accessor for name in arrow_table.column_names})
            for field_accessor in tuple_provider
        ]
        assert tuples == []

    def test_finalize_tuple(self):
        tuple_ = Tuple(
            {"name": "texera", "age": 21, "scores": [85, 94, 100], "height": np.nan}
        )
        schema = Schema(
            raw_schema={
                "name": "STRING",
                "age": "INTEGER",
                "scores": "BINARY",
                "height": "DOUBLE",
            }
        )
        tuple_.finalize(schema)
        assert isinstance(tuple_["scores"], bytes)
        assert tuple_["height"] is None

    def test_hash(self):
        schema = Schema(
            raw_schema={
                "col-int": "INTEGER",
                "col-string": "STRING",
                "col-bool": "BOOLEAN",
                "col-long": "LONG",
                "col-double": "DOUBLE",
                "col-timestamp": "TIMESTAMP",
                "col-binary": "BINARY",
            }
        )

        tuple_ = Tuple(
            {
                "col-int": 922323,
                "col-string": "string-attr",
                "col-bool": True,
                "col-long": 1123213213213,
                "col-double": 214214.9969346,
                "col-timestamp": datetime.datetime.fromtimestamp(100000000),
                "col-binary": b"hello",
            },
            schema,
        )
        assert hash(tuple_) == -1335416166  # calculated with Java

        tuple2 = Tuple(
            {
                "col-int": 0,
                "col-string": "",
                "col-bool": False,
                "col-long": 0,
                "col-double": 0.0,
                "col-timestamp": datetime.datetime.fromtimestamp(0),
                "col-binary": b"",
            },
            schema,
        )

        assert hash(tuple2) == -1409761483  # calculated with Java

        tuple3 = Tuple(
            {
                "col-int": None,
                "col-string": None,
                "col-bool": None,
                "col-long": None,
                "col-double": None,
                "col-timestamp": None,
                "col-binary": None,
            },
            schema,
        )

        assert hash(tuple3) == 1742810335  # calculated with Java

        tuple4 = Tuple(
            {
                "col-int": -3245763,
                "col-string": "\n\r\napple",
                "col-bool": True,
                "col-long": -8965536434247,
                "col-double": 1 / 3,
                "col-timestamp": datetime.datetime.fromtimestamp(-1990),
                "col-binary": None,
            },
            schema,
        )
        assert hash(tuple4) == -592643630  # calculated with Java

        tuple5 = Tuple(
            {
                "col-int": 0x7FFFFFFF,
                "col-string": "",
                "col-bool": True,
                "col-long": 0x7FFFFFFFFFFFFFFF,
                "col-double": 7 / 17,
                "col-timestamp": datetime.datetime.fromtimestamp(1234567890),
                "col-binary": b"o" * 4097,
            },
            schema,
        )
        assert hash(tuple5) == -2099556631  # calculated with Java

    def test_tuple_with_large_binary(self):
        """Test tuple with largebinary field."""
        from core.models.type.large_binary import largebinary

        schema = Schema(
            raw_schema={
                "regular_field": "STRING",
                "large_binary_field": "LARGE_BINARY",
            }
        )

        large_binary = largebinary("s3://test-bucket/path/to/object")
        tuple_ = Tuple(
            {
                "regular_field": "test string",
                "large_binary_field": large_binary,
            },
            schema=schema,
        )

        assert tuple_["regular_field"] == "test string"
        assert tuple_["large_binary_field"] == large_binary
        assert isinstance(tuple_["large_binary_field"], largebinary)
        assert tuple_["large_binary_field"].uri == "s3://test-bucket/path/to/object"

    def test_tuple_from_arrow_with_large_binary(self):
        """Test creating tuple from Arrow table with LARGE_BINARY metadata."""
        import pyarrow as pa
        from core.models.type.large_binary import largebinary

        # Create Arrow schema with LARGE_BINARY metadata
        arrow_schema = pa.schema(
            [
                pa.field("regular_field", pa.string()),
                pa.field(
                    "large_binary_field",
                    pa.string(),
                    metadata={b"texera_type": b"LARGE_BINARY"},
                ),
            ]
        )

        # Create Arrow table with URI string for large_binary_field
        arrow_table = pa.Table.from_pydict(
            {
                "regular_field": ["test"],
                "large_binary_field": ["s3://test-bucket/path/to/object"],
            },
            schema=arrow_schema,
        )

        # Create tuple from Arrow table
        tuple_provider = ArrowTableTupleProvider(arrow_table)
        tuples = [
            Tuple({name: field_accessor for name in arrow_table.column_names})
            for field_accessor in tuple_provider
        ]

        assert len(tuples) == 1
        tuple_ = tuples[0]
        assert tuple_["regular_field"] == "test"
        assert isinstance(tuple_["large_binary_field"], largebinary)
        assert tuple_["large_binary_field"].uri == "s3://test-bucket/path/to/object"

    def test_tuple_with_null_large_binary(self):
        """Test tuple with null largebinary field."""
        import pyarrow as pa

        # Create Arrow schema with LARGE_BINARY metadata
        arrow_schema = pa.schema(
            [
                pa.field(
                    "large_binary_field",
                    pa.string(),
                    metadata={b"texera_type": b"LARGE_BINARY"},
                ),
            ]
        )

        # Create Arrow table with null value
        arrow_table = pa.Table.from_pydict(
            {
                "large_binary_field": [None],
            },
            schema=arrow_schema,
        )

        # Create tuple from Arrow table
        tuple_provider = ArrowTableTupleProvider(arrow_table)
        tuples = [
            Tuple({name: field_accessor for name in arrow_table.column_names})
            for field_accessor in tuple_provider
        ]

        assert len(tuples) == 1
        tuple_ = tuples[0]
        assert tuple_["large_binary_field"] is None


class TestTupleKeyNormalization:
    """
    Regression coverage for the `pd.read_excel(header=None)` failure mode
    captured in the archeology trace `new-new-trace.json`.

    When the user's UDF returns a DataFrame whose columns are a RangeIndex
    of ints (which `pd.read_*(header=None)` always produces), the Tuple's
    `_field_data` was keyed by int while `get_field_names()` stringified
    on read. Downstream code — schema inference, `cast_to_schema`,
    `validate_schema` — used the stringified names to look back into
    `_field_data`, hitting `KeyError: '0'` because `_field_data[0]` and
    `_field_data["0"]` are different keys.

    The fix normalizes keys to str at construction. These tests pin
    down the invariant so future Tuple constructor changes don't
    regress it.
    """

    def test_int_keyed_dict_normalized_to_str(self):
        t = Tuple({0: "Region", 1: "Site", 11: "K"})
        assert t.get_field_names() == ("0", "1", "11")
        # __getitem__ now finds the underlying value by str key.
        assert t["0"] == "Region"
        assert t["1"] == "Site"
        assert t["11"] == "K"
        # Positional access by int still works (treated as index, not key).
        assert t[0] == "Region"
        assert t[2] == "K"

    def test_pandas_series_with_int_index_normalized(self):
        # Mirrors what `Table(df).as_tuples()` builds when the source
        # DataFrame has integer column labels — `pandas.Series.to_dict()`
        # of such a series produces int-keyed dicts.
        series = pandas.Series(["Region", "Site", "Layer"], index=[0, 1, 2])
        t = Tuple(series)
        assert t.get_field_names() == ("0", "1", "2")
        assert t["0"] == "Region"

    def test_dataframe_with_header_none_round_trips_through_finalize(self):
        # End-to-end: a 3x4 DataFrame with header=None-style int columns,
        # finalize against a schema inferred via str column names.
        # Pre-fix this would raise KeyError on the very first
        # finalize() because cast_to_schema reads str keys but
        # _field_data was int-keyed.
        from core.models.schema.schema import Schema
        from core.models.schema.attribute_type import AttributeType

        df = pandas.DataFrame(
            [["Region", "Site", "Layer", "K"]]
            + [["ODP 967", "D", "1", "10665.81"]] * 2,
            columns=[0, 1, 2, 3],  # int RangeIndex (header=None shape)
        )
        schema = Schema()
        for c in df.columns:
            schema.add(str(c), AttributeType.STRING)

        # Build tuples the same way `Table(df).as_tuples()` does.
        for raw in df.itertuples(index=False, name=None):
            t = Tuple(dict(zip(df.columns, raw)))
            t.finalize(schema)  # → cast_to_schema, validate_schema
            # Round-trip lookup works on every field.
            for col in df.columns:
                assert t[str(col)] == raw[col]

    def test_string_keyed_dict_is_not_unnecessarily_recopied(self):
        # If all keys are already strings, normalization should be a no-op.
        # We can't assert "same OrderedDict instance" (the implementation
        # might still copy for other reasons), but we can assert the
        # observable contract: keys remain identical strings.
        original = {"col_a": 1, "col_b": 2}
        t = Tuple(original)
        assert list(t.get_field_names()) == ["col_a", "col_b"]
        assert t["col_a"] == 1
        assert t["col_b"] == 2


class TestTupleNumpyCoercion:
    """
    Caught by the runtime-schema e2e: when a pandas DataFrame (especially
    one with an extension dtype like Int64 / Float64) is row-exploded via
    `itertuples`, the resulting field values are numpy scalars
    (`numpy.int64`, `numpy.float64`). `numpy.int64` is NOT a subclass of
    Python `int`, so the post-cast `validate_schema` step would reject
    them with `Unmatched type for field …`.

    `cast_to_schema` must run `coerce_value_to_type` to normalize numpy
    scalars to native Python types before validation.
    """

    def test_numpy_int64_normalizes_to_python_int_for_LONG(self):
        from core.models.schema.attribute_type import AttributeType

        schema = Schema()
        schema.add("n", AttributeType.LONG)

        t = Tuple({"n": np.int64(42)})
        # Pre-finalize: still a numpy scalar.
        assert isinstance(t["n"], np.int64)

        t.finalize(schema)  # cast_to_schema → validate_schema

        # After finalize: plain Python int and value preserved.
        assert type(t["n"]) is int
        assert t["n"] == 42

    def test_numpy_float64_passes_validation_for_DOUBLE(self):
        # Unlike numpy.int64, numpy.float64 IS a subclass of Python float,
        # so validate_schema accepts it directly and coerce_value_to_type's
        # fast-path leaves it alone. No transformation expected; this test
        # just guards that finalize() doesn't error on a numpy float arriving
        # at a DOUBLE column.
        from core.models.schema.attribute_type import AttributeType

        schema = Schema()
        schema.add("x", AttributeType.DOUBLE)

        t = Tuple({"x": np.float64(3.5)})
        t.finalize(schema)  # must not raise

        assert isinstance(t["x"], float)  # numpy.float64 is-a float
        assert t["x"] == 3.5

    def test_numpy_bool_normalizes_to_python_bool_for_BOOL(self):
        from core.models.schema.attribute_type import AttributeType

        schema = Schema()
        schema.add("flag", AttributeType.BOOL)

        # numpy bool_ is also not Python bool on every platform.
        t = Tuple({"flag": np.bool_(True)})
        t.finalize(schema)
        assert type(t["flag"]) is bool
        assert t["flag"] is True

    def test_pandas_nullable_int64_NA_becomes_None(self):
        from core.models.schema.attribute_type import AttributeType

        schema = Schema()
        schema.add("n", AttributeType.LONG)

        # pd.NA fires `checknull` true, so cast_to_schema rewrites it to None
        # *before* the int-coercion branch. Validate the contract end-to-end.
        t = Tuple({"n": pandas.NA})
        t.finalize(schema)
        assert t["n"] is None

    def test_numpy_int64_with_NaN_partner_field(self):
        # End-to-end shape: simulate a row coming out of a DataFrame that
        # holds both an Int64 value and a float NaN cell — both branches of
        # cast_to_schema (coerce + checknull) must fire correctly in the
        # same finalize() call.
        from core.models.schema.attribute_type import AttributeType

        schema = Schema()
        schema.add("n", AttributeType.LONG)
        schema.add("missing", AttributeType.LONG)

        t = Tuple({"n": np.int64(5), "missing": float("nan")})
        t.finalize(schema)
        assert type(t["n"]) is int
        assert t["n"] == 5
        assert t["missing"] is None

    def test_string_value_for_LONG_target_coerces_via_int_cast(self):
        # Mirrors a real agent failure case where one operator returns "42"
        # (object dtype, str) but the downstream LONG schema accepts only
        # int. coerce_value_to_type must run `int(value)` so the engine
        # bridges the small mismatch instead of failing the workflow.
        from core.models.schema.attribute_type import AttributeType

        schema = Schema()
        schema.add("n", AttributeType.LONG)

        t = Tuple({"n": "42"})
        t.finalize(schema)
        assert type(t["n"]) is int
        assert t["n"] == 42
