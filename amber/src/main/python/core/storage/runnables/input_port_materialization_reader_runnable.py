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

import time
import typing
from loguru import logger
from pyarrow import Table
from typing import Callable, Optional, Union

from core.architecture.sendsemantics.broad_cast_partitioner import (
    BroadcastPartitioner,
)
from core.architecture.sendsemantics.hash_based_shuffle_partitioner import (
    HashBasedShufflePartitioner,
)
from core.architecture.sendsemantics.one_to_one_partitioner import OneToOnePartitioner
from core.architecture.sendsemantics.partitioner import Partitioner
from core.architecture.sendsemantics.range_based_shuffle_partitioner import (
    RangeBasedShufflePartitioner,
)
from core.architecture.sendsemantics.round_robin_partitioner import (
    RoundRobinPartitioner,
)
from core.models import (
    Tuple,
    InternalQueue,
    DataFrame,
    DataPayload,
    State,
    StateFrame,
    Schema,
)
from core.models.internal_queue import DataElement, ECMElement, InputPortReadError
from core.storage.document_factory import DocumentFactory
from core.storage.iceberg.iceberg_document import IcebergDocument
from core.storage.iceberg.iceberg_utils import (
    arrow_table_to_amber_frame,
    columnar_readable,
)
from core.storage.vfs_uri_factory import VFSURIFactory
from core.util import Stoppable, get_one_of
from core.util.runnable import Runnable
from core.util.virtual_identity import get_from_actor_id_for_input_port_storage
from proto.org.apache.texera.amber.core import (
    ActorVirtualIdentity,
    ChannelIdentity,
    PortIdentity,
    EmbeddedControlMessageIdentity,
)
from proto.org.apache.texera.amber.engine.architecture.rpc import (
    ControlInvocation,
    EmptyRequest,
    EmbeddedControlMessageType,
    EmbeddedControlMessage,
    AsyncRpcContext,
    ControlRequest,
)
from proto.org.apache.texera.amber.engine.architecture.sendsemantics import (
    HashBasedShufflePartitioning,
    OneToOnePartitioning,
    Partitioning,
    RoundRobinPartitioning,
    RangeBasedShufflePartitioning,
    BroadcastPartitioning,
)


class InputPortMaterializationReaderRunnable(Runnable, Stoppable):
    # Opening the stored input needs the result catalog, which can refuse
    # connections for a while when many workers start at once (Postgres:
    # "too many clients already"). Attempts and the first backoff in seconds,
    # doubled per retry: about 15 s in all.
    OPEN_ATTEMPTS = 5
    OPEN_BACKOFF_SECONDS = 1.0

    def __init__(
        self,
        uri: str,
        queue: InternalQueue,
        worker_actor_id: ActorVirtualIdentity,
        partitioning: Partitioning,
        port_id: PortIdentity,
        on_schema: Optional[Callable[[Schema], None]] = None,
    ):
        """
        Args:
            uri (str): The URI of the materialized document.
            queue: An instance of IQueue where messages are enqueued.
            worker_actor_id (ActorVirtualIdentity): The target worker actor's identity.
            partitioning: The partitioning information for this virtual reader worker
        """
        self.uri = uri
        self.queue = queue
        self.worker_actor_id = worker_actor_id
        from_actor_id = get_from_actor_id_for_input_port_storage(self.uri, self.worker_actor_id, port_id)
        self.channel_id = ChannelIdentity(from_actor_id, self.worker_actor_id, is_control=False)
        self._stopped = False
        self._finished = False
        self.materialization = None
        self.state_document = None
        self.tuple_schema = None
        self.on_schema = on_schema
        self._partitioning_to_partitioner: dict[
            type(Partitioning), type(Partitioner)
        ] = {
            OneToOnePartitioning: OneToOnePartitioner,
            RoundRobinPartitioning: RoundRobinPartitioner,
            HashBasedShufflePartitioning: HashBasedShufflePartitioner,
            RangeBasedShufflePartitioning: RangeBasedShufflePartitioner,
            BroadcastPartitioning: BroadcastPartitioner,
        }
        the_partitioning: Partitioning = get_one_of(partitioning)
        self.the_partitioning = the_partitioning
        partitioner = self._partitioning_to_partitioner[type(the_partitioning)]
        self.partitioner: Partitioner = (
            partitioner(the_partitioning)
            if partitioner != OneToOnePartitioner
            else partitioner(the_partitioning, from_actor_id.name)
        )

    def finished(self) -> bool:
        """
        :return: Whether this reader thread has finished its logic.
        """
        return self._finished

    def open(self) -> None:
        """Open the stored rows and states this reader replays, retrying a
        failure before giving up. The worker's start request calls this before
        the reader's thread runs, so a store that cannot be read fails that
        request, and with it the execution. A failure inside the thread only
        reached the log: the operator then waited for input that never came
        until the execution timed out."""
        if self.materialization is not None:
            return
        backoff = self.OPEN_BACKOFF_SECONDS
        for attempt in range(1, self.OPEN_ATTEMPTS + 1):
            try:
                materialization, tuple_schema = DocumentFactory.open_document(
                    VFSURIFactory.result_uri(self.uri)
                )
                self.state_document, _ = DocumentFactory.open_document(
                    VFSURIFactory.state_uri(self.uri)
                )
                self.materialization, self.tuple_schema = materialization, tuple_schema
                return
            except Exception as err:
                if attempt == self.OPEN_ATTEMPTS:
                    raise RuntimeError(
                        f"Could not open the stored input {self.uri} after "
                        f"{attempt} attempts: {err}"
                    ) from err
                logger.warning(
                    f"Opening the stored input {self.uri} failed (attempt "
                    f"{attempt} of {self.OPEN_ATTEMPTS}): {err}; retrying in "
                    f"{backoff:.1f} s"
                )
                time.sleep(backoff)
                backoff *= 2

    def tuple_to_batch_with_filter(self, tuple_: Tuple) -> typing.Iterator[DataFrame]:
        """
        Let the partitioner produce batches to each (hypothetical) downstream
        worker but only selects the worker that this thread is running on
        as the input. This mimics the iterator logic of that in output
        manager.
        """
        for receiver, tuples in self.partitioner.add_tuple_to_batch(tuple_):
            if receiver == self.worker_actor_id:
                yield self.tuples_to_data_frame(tuples)

    def run(self) -> None:
        """
        Main execution logic that reads tuples from the materialized storage and
        enqueues them in batches. It first emits a StartChannel ECM and, when finished,
        emits an EndChannel ECM. Use the same partitioner implementation as that in
        output manager, where a tuple is batched by the partitioner and only
        selected as the input of this worker according to the partitioner.

        States and tuples are persisted to separate tables, so the original
        interleaving is lost and replay has to pick an order: we replay states
        first because downstream operators typically need their state set up
        before they process the incoming tuples. Every state is broadcast to
        every downstream worker -- no partitioner filtering, unlike the tuple
        loop. State is shared context (e.g. config / counters), not per-key
        data, so each worker needs the full set.
        """
        try:
            self.open()  # already open when the worker's start request opened it
            # The materialized table is authoritative for dynamic outputs.
            # Publish its schema even when no tuple/batch will be emitted.
            if self.on_schema is not None:
                self.on_schema(self.tuple_schema)
            self.emit_ecm("StartChannel", EmbeddedControlMessageType.NO_ALIGNMENT)

            for state_row in self.state_document.get():
                self.emit_payload(
                    StateFrame(
                        State.from_tuple(state_row),
                        loop_counter=state_row[State.LOOP_COUNTER],
                        loop_start_id=state_row[State.LOOP_START_ID],
                    )
                )

            if self.reads_columnar():
                self.emit_columnar()
            else:
                storage_iterator = self.materialization.get()
                # Iterate and process tuples.
                for tup in storage_iterator:
                    if self._stopped:
                        break
                    # Each tuple is sent to the partitioner and converted to
                    # a batch-based iterator.
                    tup.cast_to_schema(self.tuple_schema)
                    for data_frame in self.tuple_to_batch_with_filter(tup):
                        self.emit_payload(data_frame)
            self.emit_ecm("EndChannel", EmbeddedControlMessageType.PORT_ALIGNMENT)
            self._finished = True
        except Exception as err:
            logger.exception(err)
            # A detached reader cannot fail the worker by raising here. Wake
            # its main loop on a control channel, including when a data channel
            # is disabled for alignment, so the error reaches the coordinator.
            self.queue.put(
                InputPortReadError(
                    tag=ChannelIdentity(self.channel_id.from_worker_id, self.worker_actor_id, True),
                    exception=err,
                )
            )

    def reads_columnar(self) -> bool:
        """Whether the stored rows can go to this worker as whole Arrow
        batches: every row is routed here (a single receiver, whatever the
        partitioning) and every column is a plain type."""
        if not isinstance(self.materialization, IcebergDocument):
            return False
        receivers = {c.to_worker_id.name for c in self.the_partitioning.channels}
        return receivers == {self.worker_actor_id.name} and columnar_readable(
            self.tuple_schema
        )

    def emit_columnar(self) -> None:
        """Emit the stored rows in order, in batches of the partitioning's
        size, each the Arrow table the per-row path builds from them, without
        a Tuple, a cast and a cell copy per row (19 s for a 24,000-row,
        296-column table)."""
        batch_size = max(1, self.the_partitioning.batch_size)
        for file_table in self.materialization.get_arrow_tables():
            frame = arrow_table_to_amber_frame(self.tuple_schema, file_table)
            for offset in range(0, frame.num_rows, batch_size):
                if self._stopped:
                    return
                self.emit_payload(DataFrame(frame=frame.slice(offset, batch_size)))

    def stop(self):
        """Sets the stop flag so the run loop may terminate."""
        self._stopped = True

    def emit_ecm(self, method_name: str, alignment: EmbeddedControlMessageType) -> None:
        """
        Emit an ECM (StartChannel or EndChannel), and
        flush the remaining data batches if any. This mimics the
        iterator logic of that in output manager.
        """
        ecm = EmbeddedControlMessage(
            EmbeddedControlMessageIdentity(method_name),
            alignment,
            [],
            {
                self.worker_actor_id.name: ControlInvocation(
                    method_name,
                    ControlRequest(empty_request=EmptyRequest()),
                    AsyncRpcContext(ActorVirtualIdentity(), ActorVirtualIdentity()),
                    -1,
                )
            },
        )

        for payload in self.partitioner.flush(self.worker_actor_id, ecm):
            final_payload = (
                payload
                if isinstance(payload, EmbeddedControlMessage)
                else self.tuples_to_data_frame(payload)
            )
            self.emit_payload(final_payload)

    def emit_payload(self, payload: Union[DataPayload, EmbeddedControlMessage]) -> None:
        """
        Put the payload to the DP internal queue.
        """
        queue_element = (
            ECMElement(tag=self.channel_id, payload=payload)
            if isinstance(payload, EmbeddedControlMessage)
            else DataElement(tag=self.channel_id, payload=payload)
        )
        self.queue.put(queue_element)

    def tuples_to_data_frame(self, tuples: typing.List[Tuple]) -> DataFrame:
        """
        Converts a list of tuples to a DataFrame using pyarrow.Table.from_pydict
        :param tuples:
        :return:
        """
        return DataFrame(
            frame=Table.from_pydict(
                {
                    name: [t[name] for t in tuples]
                    for name in self.tuple_schema.get_attr_names()
                },
                schema=self.tuple_schema.as_arrow_schema(),
            )
        )
