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

import os

import pyarrow as pa
from pyiceberg.catalog import Catalog
from pyiceberg.schema import Schema
from pyiceberg.table import Table
from tenacity import retry, stop_after_attempt, wait_random_exponential
from typing import List, TypeVar, Callable, Iterable

from core.storage.model.buffered_item_writer import BufferedItemWriter
from core.storage.storage_config import StorageConfig

# Rows are serialized per buffer (``buffer_size`` rows) but committed to the
# catalog together. A commit per buffer made large results quadratic: every
# commit refreshes and rewrites table metadata that grows with the number of
# snapshots, so an 8.6 M-row scan (2,100 buffers) spent about 200 s in commits
# (pyiceberg, 300 commits of 4,096 rows: 27.5 s; one commit of the same rows:
# 0.5 s). Pending Arrow data is committed once it reaches COMMIT_BYTES and at
# close. The cap stays far below pyiceberg's 512 MB target file size, so each
# commit writes one data file and the files keep the rows' order.
COMMIT_BYTES = int(os.environ.get("TEXERA_ICEBERG_COMMIT_BYTES", 64 * 1024 * 1024))

# Define a type variable for the data type T
T = TypeVar("T")


class IcebergTableWriter(BufferedItemWriter[T]):
    """
    IcebergTableWriter writes data to the given Iceberg table in an append-only way.
    - Each time the buffer is flushed, a new data file is created using pyarrow
    - Iceberg data files are immutable once created. So each flush will create a
    distinct file.

    **Thread Safety**: This writer is NOT thread-safe, so only one thread should call
    this writer.

    :param writer_identifier: A unique identifier used to prefix the created files.
    :param catalog: The Iceberg catalog to manage table metadata.
    :param table_namespace: The namespace of the Iceberg table.
    :param table_name: The name of the Iceberg table.
    :param table_schema: The schema of the Iceberg table.
    """

    def __init__(
        self,
        writer_identifier: str,
        catalog: Catalog,
        table_namespace: str,
        table_name: str,
        table_schema: pa.Schema,
        serde: Callable[[Schema, Iterable[T]], pa.Table],
    ):
        self.writer_identifier = writer_identifier
        self.catalog = catalog
        self.table_namespace = table_namespace
        self.table_name = table_name
        self.table_schema = table_schema
        self.serde = serde
        self.buffer_size = StorageConfig.ICEBERG_TABLE_COMMIT_BATCH_SIZE

        # Internal state
        self.buffer: List[T] = []
        # Serialized buffers waiting for the next catalog commit.
        self.commit_bytes = COMMIT_BYTES
        self.pending: List[pa.Table] = []
        self.pending_bytes = 0

        # Load the Iceberg table
        self.table: Table = self.catalog.load_table(
            f"{self.table_namespace}.{self.table_name}"
        )

    @property
    def buffer_size(self) -> int:
        return self._buffer_size

    def open(self) -> None:
        """Open the writer and clear the buffer."""
        self.buffer.clear()

    def put_one(self, item: T) -> None:
        """Add a single item to the buffer."""
        self.buffer.append(item)
        if len(self.buffer) >= self.buffer_size:
            self._flush_buffer()

    def remove_one(self, item: T) -> None:
        """Remove a single item from the buffer."""
        self.buffer.remove(item)

    def _flush_buffer(self) -> None:
        """
        Flush the current buffer to a new Iceberg data file. The buffer is first
        converted to a pyarrow table, and then appended to the iceberg table as a
        parquet file. Note in the case of concurrent writers, as iceberg uses
        optimistic concurrency control, we use a random exponential backoff mechanism
        when commit failure happens because currently pyiceberg does not natively
        support retry.
        """
        if not self.buffer:
            return
        self._stage(self.serde(self.table_schema, self.buffer))
        self.buffer.clear()

    def _stage(self, table: pa.Table) -> None:
        """Queue serialized rows for the next commit; commit once enough are pending."""
        if table.num_rows == 0:
            return
        self.pending.append(table)
        self.pending_bytes += table.nbytes
        if self.pending_bytes >= self.commit_bytes:
            self._commit_pending()

    def _commit_pending(self) -> None:
        """Commit the queued rows as one data file in one snapshot."""
        if not self.pending:
            return
        rows = (
            self.pending[0]
            if len(self.pending) == 1
            else pa.concat_tables(self.pending)
        )
        self.pending = []
        self.pending_bytes = 0
        self._append(rows)

    def _append(self, pa_df: pa.Table) -> None:
        """Append one data file, retrying commit conflicts (see _flush_buffer)."""

        @retry(
            wait=wait_random_exponential(0.001, 10),
            stop=stop_after_attempt(10),
            reraise=True,
        )
        def append_with_retry():
            self.table.refresh()
            self.table.append(pa_df)

        append_with_retry()

    def put_arrow(self, table: pa.Table) -> None:
        """Append rows already in Arrow, in the port's plain schema, after the
        buffered items: the data files the serde writes for the same rows,
        one per ``buffer_size`` rows, without one item per row."""
        from core.storage.iceberg.iceberg_utils import arrow_to_stored_table

        self._flush_buffer()
        # Cast the whole table, then slice. A cast of a slice keeps its whole
        # column's data buffer (string to large_string shares it), and writing
        # such slices held about 0.2 GB more per commit of an 8.6 M-row table.
        stored = arrow_to_stored_table(self.table_schema, table)
        # Slices of about one commit each, so a commit's file stays near the cap.
        per_commit = max(
            self.buffer_size,
            stored.num_rows * self.commit_bytes // max(stored.nbytes, 1),
        )
        for offset in range(0, stored.num_rows, per_commit):
            self._stage(stored.slice(offset, per_commit))

    def close(self) -> None:
        """Close the writer: flush the buffer and commit everything pending."""
        self._flush_buffer()
        self._commit_pending()

    @buffer_size.setter
    def buffer_size(self, value):
        self._buffer_size = value
