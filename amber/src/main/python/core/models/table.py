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

import pandas
import pyarrow as pa
from pampy import match
from typing import Dict, Iterator, List, Optional, Tuple as TypingTuple, TypeVar

from core.models import Tuple, TupleLike
from core.models.schema.schema import Schema
from core.models.schema.attribute_type import AttributeType

TableLike = TypeVar("TableLike", pandas.DataFrame, List[TupleLike])


def deduplicate_columns(
    columns: List[str],
) -> TypingTuple[List[str], Optional[Dict[str, str]]]:
    """
    Rename duplicate column names so every name in the returned list is
    unique, following pandas' own convention: `col`, `col.1`, `col.2`, …

    Required by `Table.as_tuples`: it builds each row's Tuple via
    `dict(zip(columns, row))`, which silently drops every duplicate's value
    when two columns share a name. Deduping the column-name list before
    the zip preserves all cells.

    Returns `(columns, None)` when no renames were needed, so callers can
    cheaply detect the no-op case and skip emitting a console hint.
    """
    seen_counts: Dict[str, int] = {}
    all_names = set(columns)
    new_columns: List[str] = []
    rename_map: Dict[str, str] = {}
    for col in columns:
        if col not in seen_counts:
            seen_counts[col] = 0
            new_columns.append(col)
        else:
            seen_counts[col] += 1
            suffix = seen_counts[col]
            new_name = f"{col}.{suffix}"
            # Edge case: original columns already contain "col.N" — bump
            # the suffix past it so we don't collide.
            while new_name in all_names or new_name in rename_map.values():
                suffix += 1
                new_name = f"{col}.{suffix}"
            seen_counts[col] = suffix
            rename_map[f"{col}@{suffix}"] = new_name
            new_columns.append(new_name)
    if not rename_map:
        return columns, None
    return new_columns, rename_map


class Table(pandas.DataFrame):
    @staticmethod
    def from_table(table):
        return table

    @staticmethod
    def from_data_frame(df):
        return df

    @staticmethod
    def from_tuple_likes(tuple_likes: Iterator[TupleLike], schema: Optional[Schema] = None):
        # TODO: currently only validate all Tuples have the same fields.
        #  should validate types as well
        column_names = tuple(schema.get_attr_names()) if schema is not None else None
        records = []
        for tuple_like in tuple_likes:
            tuple_ = Tuple(tuple_like)
            field_names = tuple_.get_field_names()

            if column_names is not None:
                assert field_names == column_names
            else:
                column_names = field_names

            records.append(tuple_.get_fields())

        if schema is None:
            return pandas.DataFrame.from_records(records, columns=column_names)
        # Keep the engine's declared domains, even when no tuple arrives. Build
        # nullable columns directly: DataFrame.from_records first promotes
        # integer/null pairs to float and can irreversibly round large IDs.
        nullable_types = {
            AttributeType.INT: "Int32",
            AttributeType.LONG: "Int64",
            AttributeType.DOUBLE: "Float64",
            AttributeType.BOOL: "boolean",
        }
        columns = {}
        for index, name in enumerate(column_names):
            attr_type = schema.get_attr_type(name)
            dtype = nullable_types.get(attr_type, object)
            if attr_type == AttributeType.TIMESTAMP:
                # Preserve timezone-aware values; an empty timestamp column
                # still needs an explicit dtype for downstream inference.
                dtype = None if records else "datetime64[ns]"
            columns[name] = pandas.Series([row[index] for row in records], dtype=dtype)
        return pandas.DataFrame(columns, index=range(len(records)))

    def __init__(self, table_like, schema: Optional[Schema] = None):
        df: pandas.DataFrame

        if isinstance(table_like, Table):
            df = self.from_table(table_like)
        elif isinstance(table_like, pandas.DataFrame):
            df = self.from_data_frame(table_like)
        elif isinstance(table_like, list):
            # only supports List[TupleLike]
            df = self.from_tuple_likes(table_like, schema=schema)
        else:
            raise TypeError(f"unsupported tablelike type {type(table_like)}")
        super().__init__(df)

    def as_tuples(self) -> Iterator[Tuple]:
        """
        Convert rows of the table into Tuples, in row-index order.

        Column labels are stringified first (a DataFrame produced via
        `pd.read_excel(header=None)` carries an int RangeIndex; the engine's
        Schema/Tuple layer is str-keyed throughout), then deduplicated so
        that two columns sharing a name don't silently collapse to a single
        Tuple field via `dict(zip(...))`.
        """
        str_columns = [str(col) for col in self.columns]
        deduped_columns, _ = deduplicate_columns(str_columns)
        for raw_tuple in self.itertuples(index=False, name=None):
            yield Tuple(dict(zip(deduped_columns, raw_tuple)))

    def __eq__(self, other: "Table") -> bool:
        if isinstance(other, Table):
            return all(a == b for a, b in zip(self.as_tuples(), other.as_tuples()))
        else:
            return super().__eq__(other).all()


def columnar_supported(table: pa.Table) -> bool:
    """Whether ``arrow_batches_to_frame`` reproduces the Tuple path for every
    column of ``table``: integers, floats, booleans, text and timestamps.
    Binary columns (pickled objects, large-binary references) and fields with
    metadata keep the Tuple path, whose field accessor decodes them."""
    for field in table.schema:
        kind = field.type
        if field.metadata:
            return False
        if not (
            pa.types.is_integer(kind)
            or pa.types.is_floating(kind)
            or pa.types.is_boolean(kind)
            or pa.types.is_string(kind)
            or pa.types.is_large_string(kind)
            or pa.types.is_timestamp(kind)
        ):
            return False
    return True


def arrow_batches_to_frame(batches: List[pa.Table], schema: Optional[Schema]) -> Optional[pandas.DataFrame]:
    """The DataFrame that ``Table(tuples, schema)`` builds from the same rows,
    converted column by column from Arrow instead of through one Tuple per
    row. INT, LONG, DOUBLE and BOOL become nullable Int32, Int64, Float64 and
    boolean (a NaN is missing, as the Tuple path reads it); TIMESTAMP keeps
    its zone at nanosecond resolution, and an all-null one holds None; other
    types stay Python objects. None when the Tuple path must run instead: no
    schema, no rows, or a column the conversion does not cover."""
    import numpy

    if schema is None or not batches:
        return None
    table = pa.concat_tables(batches) if len(batches) > 1 else batches[0]
    rows = table.num_rows
    names = list(schema.get_attr_names())
    if rows == 0 or not columnar_supported(table) or set(names) != set(table.column_names):
        return None
    nullable = {AttributeType.INT: "Int32", AttributeType.LONG: "Int64", AttributeType.BOOL: "boolean"}
    columns = {}
    for name in names:
        column = table.column(name)
        attr_type = schema.get_attr_type(name)
        if attr_type == AttributeType.DOUBLE:
            values = column.to_numpy(zero_copy_only=False).astype("float64")
            columns[name] = pandas.Series(pandas.array(values, dtype="Float64"))
        elif attr_type in nullable:
            columns[name] = pandas.Series(pandas.array(column.to_pylist(), dtype=nullable[attr_type]))
        elif attr_type == AttributeType.TIMESTAMP:
            if column.null_count == rows:
                columns[name] = pandas.Series([None] * rows, dtype=object)
            else:
                series = column.to_pandas()
                zone = getattr(series.dtype, "tz", None)
                columns[name] = series.astype(f"datetime64[ns, {zone}]" if zone is not None else "datetime64[ns]")
        else:
            series = column.to_pandas()
            columns[name] = series.astype(object) if series.dtype != object else series
    return pandas.DataFrame(columns, index=range(rows))


def table_to_ipc_bytes(table: Table) -> bytes:
    """Serialize ``table`` as an Apache Arrow IPC stream.

    Used by the loop operators to round-trip a Table through a state dict
    (and through iceberg storage) without resorting to ``pickle.dumps``,
    which would expose ``pickle.loads`` as a remote-code-execution surface
    on the receiving side. Arrow IPC is a length-prefixed, schema-typed
    format that carries data only -- no executable payload.
    """
    arrow_table = pa.Table.from_pandas(table, preserve_index=False)
    sink = pa.BufferOutputStream()
    with pa.ipc.new_stream(sink, arrow_table.schema) as writer:
        writer.write_table(arrow_table)
    return sink.getvalue().to_pybytes()


def table_from_ipc_bytes(buf: bytes) -> Table:
    """Inverse of :func:`table_to_ipc_bytes`.

    Reconstruct a Table from an Apache Arrow IPC stream buffer. Raises if
    ``buf`` is not a well-formed Arrow IPC stream, so malformed input
    surfaces as a parse error rather than executing anything.
    """
    with pa.ipc.open_stream(pa.py_buffer(buf)) as reader:
        arrow_table = reader.read_all()
    return Table(arrow_table.to_pandas())


def all_output_to_tuple(output) -> Iterator[Tuple]:
    """
    Convert all kinds of types into Tuples.
    :param output:
    :return:
    """
    yield from match(
        output,
        None,
        iter([None]),
        Table,
        lambda x: x.as_tuples(),
        pandas.DataFrame,
        lambda x: Table(x).as_tuples(),
        List[TupleLike],
        lambda x: (Tuple(t) for t in x),
        TupleLike,
        lambda x: iter([Tuple(x)]),
        Tuple,
        lambda x: iter([x]),
    )
