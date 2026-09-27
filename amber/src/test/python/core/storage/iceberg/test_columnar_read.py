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

"""A materialized input port read as whole Arrow batches must carry the
payload the per-row read builds from the same data file, value for value."""
import datetime
import io
from unittest.mock import MagicMock

import pyarrow as pa
import pyarrow.parquet as pq

from core.models import DataFrame, Schema, Tuple
from core.models.internal_queue import DataElement
from core.storage.iceberg.iceberg_document import IcebergDocument
from core.storage.iceberg.iceberg_utils import (
    amber_schema_to_iceberg_schema,
    amber_tuples_to_arrow_table,
    arrow_table_to_amber_frame,
    arrow_table_to_amber_tuples,
    columnar_readable,
)
from core.storage.runnables.input_port_materialization_reader_runnable import (
    InputPortMaterializationReaderRunnable,
)
from proto.org.apache.texera.amber.core import ActorVirtualIdentity, ChannelIdentity
from proto.org.apache.texera.amber.engine.architecture.sendsemantics import (
    OneToOnePartitioning,
    RoundRobinPartitioning,
)

AMBER = Schema(
    raw_schema={"id": "LONG", "n": "INTEGER", "x": "DOUBLE", "ok": "BOOLEAN", "name": "STRING", "at": "TIMESTAMP"}
)
ICEBERG = amber_schema_to_iceberg_schema(AMBER)
# The schema the reader types the port with, as DocumentFactory.open_document builds it.
PORT = Schema(ICEBERG.as_arrow())
ROWS = [
    {"id": 9007199254740993, "n": 1, "x": 1.5, "ok": True, "name": "a", "at": datetime.datetime(2020, 1, 1)},
    {"id": None, "n": None, "x": float("nan"), "ok": None, "name": None, "at": None},
    {"id": 3, "n": 7, "x": None, "ok": False, "name": "", "at": datetime.datetime(2021, 6, 30, 12, 0, 0, 123456)},
]


def data_file(rows):
    """A data file as the reader gets it back: the writer's serde, through Parquet."""
    buffer = io.BytesIO()
    pq.write_table(amber_tuples_to_arrow_table(ICEBERG, [Tuple(r, schema=AMBER) for r in rows]), buffer)
    return pq.read_table(io.BytesIO(buffer.getvalue()))


def per_row(file_table):
    """The per-row read: a Tuple per row, cast to the port schema, one Arrow column per field."""
    tuples = list(arrow_table_to_amber_tuples(ICEBERG, file_table))
    for t in tuples:
        t.cast_to_schema(PORT)
    return pa.Table.from_pydict(
        {name: [t[name] for t in tuples] for name in PORT.get_attr_names()}, schema=PORT.as_arrow_schema()
    )


def test_the_columnar_read_is_the_per_row_read():
    file_table = data_file(ROWS)
    assert columnar_readable(PORT)
    expected = per_row(file_table)
    actual = arrow_table_to_amber_frame(PORT, file_table)
    assert actual.equals(expected), (actual.to_pydict(), expected.to_pydict())
    assert actual.column("x").to_pylist() == [1.5, None, None]  # NaN is null, as the per-row cast reads it


def test_binary_columns_keep_the_per_row_read():
    assert not columnar_readable(Schema(raw_schema={"blob": "BINARY", "n": "LONG"}))


def reader(partitioning, file_table):
    me = ActorVirtualIdentity(name="me")
    instance = InputPortMaterializationReaderRunnable.__new__(InputPortMaterializationReaderRunnable)
    instance.worker_actor_id = me
    instance.tuple_schema = PORT
    instance.the_partitioning = partitioning
    instance._stopped = False
    instance.channel_id = ChannelIdentity(me, me, is_control=False)
    instance.queue = MagicMock()
    instance.materialization = MagicMock(spec=IcebergDocument)
    instance.materialization.get_arrow_tables.return_value = iter([file_table])
    return instance


def emitted(instance):
    return [
        call.args[0].payload.frame
        for call in instance.queue.put.call_args_list
        if isinstance(call.args[0], DataElement) and isinstance(call.args[0].payload, DataFrame)
    ]


def channel(to):
    return ChannelIdentity(ActorVirtualIdentity(name="upstream"), ActorVirtualIdentity(name=to), is_control=False)


def test_a_single_receiver_gets_the_rows_as_batches_of_the_partitioning_size():
    file_table = data_file(ROWS)
    instance = reader(OneToOnePartitioning(batch_size=2, channels=[channel("me")]), file_table)
    assert instance.reads_columnar()
    instance.emit_columnar()
    batches = emitted(instance)
    assert [b.num_rows for b in batches] == [2, 1]
    assert pa.concat_tables(batches).equals(per_row(file_table))


def test_rows_split_across_workers_keep_the_per_row_read():
    instance = reader(RoundRobinPartitioning(batch_size=2, channels=[channel("me"), channel("other")]), data_file(ROWS))
    assert not instance.reads_columnar()
