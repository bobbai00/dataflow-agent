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
from core.models.internal_marker import StartChannel
from proto.org.apache.texera.amber.engine.architecture.rpc import (
    EmptyReturn,
    EmptyRequest,
)


class StartChannelHandler(ControlHandler):
    async def start_channel(self, req: EmptyRequest) -> EmptyReturn:
        # Stamp current_input_port_id from the channel-id before flipping the
        # marker; same race fix as EndChannelHandler. produce_state_on_start
        # reads port_id off the marker context, and a stale port from the
        # previous data_element would route the wrong state.
        port_id = self.context.input_manager.get_port_id(
            self.context.current_input_channel_id
        )
        if port_id is not None:
            self.context.tuple_processing_manager.current_input_port_id = port_id
        self.context.tuple_processing_manager.current_internal_marker = StartChannel()
        return EmptyReturn()
