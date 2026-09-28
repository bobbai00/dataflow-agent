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

"""A table operator's input converted from whole Arrow batches must be the
DataFrame the Tuple path builds from the same rows, dtype for dtype."""
import datetime

import pandas
import pyarrow as pa

from core.models import Table, Tuple
from core.models.operator import TableOperator
from core.models.schema.schema import Schema
from core.models.table import arrow_batches_to_frame, columnar_supported
from core.models.tuple import ArrowTableTupleProvider

UTC = datetime.timezone.utc
SCHEMA = Schema(
    raw_schema={"id": "LONG", "n": "INTEGER", "x": "DOUBLE", "ok": "BOOLEAN", "name": "STRING", "at": "TIMESTAMP", "none_at": "TIMESTAMP"}
)


def batch(rows):
    return pa.table(
        {
            "id": pa.array([r[0] for r in rows], pa.int64()),
            "n": pa.array([r[1] for r in rows], pa.int32()),
            "x": pa.array([r[2] for r in rows], pa.float64()),
            "ok": pa.array([r[3] for r in rows], pa.bool_()),
            "name": pa.array([r[4] for r in rows], pa.string()),
            "at": pa.array([r[5] for r in rows], pa.timestamp("us", tz="UTC")),
            "none_at": pa.array([None for _ in rows], pa.timestamp("us", tz="UTC")),
        }
    )


ROWS = [
    (9007199254740993, 1, 1.5, True, "a", datetime.datetime(2020, 1, 1, tzinfo=UTC)),
    (None, None, float("nan"), None, None, None),
    (3, 7, None, False, "", datetime.datetime(2021, 6, 30, 12, tzinfo=UTC)),
]


def tuple_path(batches, schema):
    rows = []
    for b in batches:
        rows.extend(Tuple({name: acc for name in b.column_names}, schema=schema) for acc in ArrowTableTupleProvider(b))
    return Table(rows, schema=schema)


def test_columnar_conversion_matches_the_tuple_path():
    batches = [batch(ROWS[:2]), batch(ROWS[2:])]
    expected = tuple_path(batches, SCHEMA)
    actual = arrow_batches_to_frame(batches, SCHEMA)
    pandas.testing.assert_frame_equal(pandas.DataFrame(actual), pandas.DataFrame(expected))
    assert actual["x"].isna().tolist() == [False, True, True]  # NaN is missing, as in the Tuple path
    assert str(actual["at"].dtype) == "datetime64[ns, UTC]"
    assert actual["none_at"].tolist() == [None, None, None]


def test_unsupported_columns_and_empty_input_keep_the_tuple_path():
    assert not columnar_supported(pa.table({"blob": pa.array([b"x"], pa.binary())}))
    assert columnar_supported(batch(ROWS))
    assert arrow_batches_to_frame([batch([])], SCHEMA) is None
    assert arrow_batches_to_frame([batch(ROWS)], None) is None


class Collect(TableOperator):
    def process_table(self, table, port):
        yield table


def test_a_table_operator_buffers_batches_and_yields_the_same_table():
    batches = [batch(ROWS[:1]), batch(ROWS[1:])]
    columnar = Collect()
    columnar._set_input_schema(0, SCHEMA)
    for b in batches:
        columnar._buffer_arrow(0, b)
    rows = Collect()
    rows._set_input_schema(0, SCHEMA)
    for t in tuple_path(batches, SCHEMA).as_tuples():
        list(rows.process_tuple(t, 0))
    (got,) = [t for t in columnar.on_finish(0) if t is not None]
    (want,) = [t for t in rows.on_finish(0) if t is not None]
    pandas.testing.assert_frame_equal(pandas.DataFrame(got), pandas.DataFrame(want))


def test_a_table_operator_drops_its_buffered_input_once_the_table_is_built():
    # The operator runs with the Table only, not beside a second copy of its
    # input; a later port input starts from an empty buffer.
    held = []

    class Hold(TableOperator):
        def process_table(self, table, port):
            held.append(self._buffered_table(port))
            yield table

    operator = Hold()
    operator._set_input_schema(0, SCHEMA)
    operator._buffer_arrow(0, batch(ROWS))
    (got,) = [t for t in operator.on_finish(0) if t is not None]
    assert len(got) == len(ROWS)
    assert len(held) == 1 and len(held[0]) == 0
