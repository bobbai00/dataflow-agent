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

"""A yielded DataFrame that leaves whole must carry the batches and stored
rows the per-row path builds from it, value for value; any frame the
per-row cast would bridge or reject keeps the per-row path."""
import datetime
from unittest.mock import MagicMock

import numpy
import pandas
import pyarrow as pa
import pytest

from core.architecture.packaging.output_manager import OutputManager
from core.models import Schema, Table
from core.models.table import frame_to_arrow
from core.storage.iceberg.iceberg_table_writer import IcebergTableWriter
from core.storage.iceberg.iceberg_utils import (
    amber_schema_to_iceberg_schema,
    amber_tuples_to_arrow_table,
    arrow_to_stored_table,
)
from proto.org.apache.texera.amber.core import (
    ActorVirtualIdentity,
    ChannelIdentity,
    PhysicalLink,
    PortIdentity,
)
from proto.org.apache.texera.amber.engine.architecture.sendsemantics import (
    OneToOnePartitioning,
    Partitioning,
    RoundRobinPartitioning,
)

SCHEMA = Schema(
    raw_schema={"id": "LONG", "n": "INTEGER", "x": "DOUBLE", "ok": "BOOLEAN", "name": "STRING", "at": "TIMESTAMP", "none": "STRING"}
)


def frame():
    return pandas.DataFrame(
        {
            "id": pandas.array([9007199254740993, None, 3], dtype="Int64"),
            "n": numpy.array([1, 2, 7], dtype="int64"),
            "x": [1.5, float("nan"), None],
            "ok": pandas.array([True, None, False], dtype="boolean"),
            "name": ["a", None, float("nan")],
            "at": pandas.Series(
                [datetime.datetime(2020, 1, 1), None, datetime.datetime(2021, 6, 30, 12, 0, 0, 123456)],
                dtype="datetime64[ns]",
                index=[5, 3, 9],
            ),
            "none": [None, None, None],
        },
        index=[5, 3, 9],  # the index is not a column
    )


def per_row(df, schema):
    """The per-row path: as_tuples, finalize, one Arrow column per field."""
    tuples = list(Table(df).as_tuples())
    for t in tuples:
        t.finalize(schema)
    names = schema.get_attr_names()
    return tuples, pa.Table.from_pydict(
        {name: [t.get_serialized_field(name) for t in tuples] for name in names}, schema=schema.as_arrow_schema()
    )


def test_a_whole_frame_is_the_per_row_output():
    tuples, expected = per_row(frame(), SCHEMA)
    actual = frame_to_arrow(frame(), SCHEMA)
    assert actual.equals(expected), (actual.to_pydict(), expected.to_pydict())
    iceberg = amber_schema_to_iceberg_schema(SCHEMA)
    stored = arrow_to_stored_table(iceberg, actual)
    assert stored.equals(amber_tuples_to_arrow_table(iceberg, tuples), check_metadata=True)


def test_labels_are_read_as_the_tuple_path_reads_them():
    df = pandas.DataFrame([["a", "b", 1]], columns=["q", "q", 0])
    schema = Schema(raw_schema={"q": "STRING", "q.1": "STRING", "0": "LONG"})
    _, expected = per_row(df, schema)
    assert frame_to_arrow(df, schema).equals(expected)


@pytest.mark.parametrize(
    "column, attr",
    [
        (["a", 5], "STRING"),  # the per-row cast writes str(5)
        ([b"a", "b"], "STRING"),  # and str(b"a")
        ([1.0, 2.0], "LONG"),  # a float column bridged to LONG
        ([1, 2], "DOUBLE"),
        (pandas.to_datetime(["2020-01-01"] * 2).tz_localize("UTC"), "TIMESTAMP"),
        (["true", "false"], "BOOLEAN"),
    ],
)
def test_columns_the_per_row_cast_bridges_keep_the_per_row_path(column, attr):
    assert frame_to_arrow(pandas.DataFrame({"c": column}), Schema(raw_schema={"c": attr})) is None


def test_values_that_do_not_fit_raise_so_the_per_row_path_reports_them():
    with pytest.raises(pa.ArrowInvalid):
        frame_to_arrow(pandas.DataFrame({"c": numpy.array([2**40], dtype="int64")}), Schema(raw_schema={"c": "INTEGER"}))


def test_labels_that_do_not_name_the_port_fields_keep_the_per_row_path():
    assert frame_to_arrow(pandas.DataFrame({"a": [1]}), Schema(raw_schema={"b": "LONG"})) is None
    assert frame_to_arrow(pandas.DataFrame({"a": [1], "b": [2]}), Schema(raw_schema={"a": "LONG"})) is None


def worker(name):
    return ActorVirtualIdentity(name=name)


def channel(source, target):
    return ChannelIdentity(worker(source), worker(target), is_control=False)


def manager(partitioning):
    output = OutputManager("me")
    output.add_output_port(PortIdentity(0, False), SCHEMA)
    output.add_partitioning(PhysicalLink(), partitioning)
    return output


def test_one_receiver_gets_slices_of_the_batch_size():
    output = manager(Partitioning(one_to_one_partitioning=OneToOnePartitioning(batch_size=2, channels=[channel("me", "down")])))
    assert output.accepts_arrow()
    table = frame_to_arrow(frame(), SCHEMA)
    batches = list(output.arrow_to_batches(table))
    assert [(to.name, b.frame.num_rows) for to, b in batches] == [("down", 2), ("down", 1)]
    assert pa.concat_tables([b.frame for _, b in batches]).equals(table)


def test_rows_split_across_receivers_or_waiting_in_a_batch_keep_the_per_row_path():
    split = manager(
        Partitioning(round_robin_partitioning=RoundRobinPartitioning(batch_size=2, channels=[channel("me", "a"), channel("me", "b")]))
    )
    assert not split.accepts_arrow()
    waiting = manager(Partitioning(one_to_one_partitioning=OneToOnePartitioning(batch_size=2, channels=[channel("me", "down")])))
    tuples, _ = per_row(frame(), SCHEMA)
    list(waiting.tuple_to_batch(tuples[0]))
    assert not waiting.accepts_arrow()


def writer_with(buffer_size, commit_bytes):
    iceberg = amber_schema_to_iceberg_schema(SCHEMA)
    writer = IcebergTableWriter.__new__(IcebergTableWriter)
    writer.table_schema = iceberg
    writer.serde = amber_tuples_to_arrow_table
    writer.buffer = []
    writer.buffer_size = buffer_size
    writer.commit_bytes = commit_bytes
    writer.pending = []
    writer.pending_bytes = 0
    writer.table = MagicMock()
    return writer, iceberg


def committed(writer):
    return [call.args[0] for call in writer.table.append.call_args_list]


def test_the_writer_commits_buffered_and_arrow_rows_together_in_order():
    writer, iceberg = writer_with(buffer_size=2, commit_bytes=1 << 30)
    tuples, _ = per_row(frame(), SCHEMA)
    writer.put_one(tuples[0])
    writer.put_arrow(frame_to_arrow(frame(), SCHEMA))
    assert committed(writer) == []  # nothing reaches the catalog before the cap or close
    writer.close()
    files = committed(writer)
    assert [f.num_rows for f in files] == [4]
    expected = pa.concat_tables([amber_tuples_to_arrow_table(iceberg, tuples[:1]), amber_tuples_to_arrow_table(iceberg, tuples)])
    assert files[0].equals(expected, check_metadata=True)


def test_many_buffers_become_one_commit_and_a_tiny_cap_commits_each_one():
    tuples, _ = per_row(frame(), SCHEMA)
    batched, _ = writer_with(buffer_size=1, commit_bytes=1 << 30)
    for item in tuples * 4:
        batched.put_one(item)
    batched.close()
    assert [f.num_rows for f in committed(batched)] == [len(tuples) * 4]
    eager, iceberg = writer_with(buffer_size=2, commit_bytes=1)
    eager.put_one(tuples[0])
    eager.put_arrow(frame_to_arrow(frame(), SCHEMA))
    eager.close()
    files = committed(eager)
    assert [f.num_rows for f in files] == [1, 2, 1]
    assert pa.concat_tables(files[1:]).equals(amber_tuples_to_arrow_table(iceberg, tuples), check_metadata=True)
