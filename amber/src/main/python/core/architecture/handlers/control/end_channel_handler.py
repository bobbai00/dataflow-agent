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

from core.architecture.handlers.control.control_handler_base import ControlHandler
from core.models.internal_marker import EndChannel
from proto.org.apache.texera.amber.engine.architecture.rpc import (
    EmptyReturn,
    EmptyRequest,
)


class EndChannelHandler(ControlHandler):
    async def end_channel(self, req: EmptyRequest) -> EmptyReturn:
        # Resolve the port that this EndChannel belongs to from the channel id
        # and stamp it onto current_input_port_id BEFORE flipping the marker.
        # The data_processor thread reads the marker and then queries
        # current_input_port_id; if a downstream port's DataElement was
        # processed in the same input-queue drain (sequential-dependencies
        # workflows with N>=3 inputs do this routinely), current_input_port_id
        # would otherwise reflect the last data tuple's port — not the port
        # whose channel just emitted EndChannel — and on_finish() fires for
        # the wrong port. See tests/03-three-input-merge.
        port_id = self.context.input_manager.get_port_id(
            self.context.current_input_channel_id
        )
        if port_id is not None:
            self.context.tuple_processing_manager.current_input_port_id = port_id
        self.context.input_manager.complete_current_port(
            self.context.current_input_channel_id
        )
        self.context.tuple_processing_manager.current_internal_marker = EndChannel()
        return EmptyReturn()
