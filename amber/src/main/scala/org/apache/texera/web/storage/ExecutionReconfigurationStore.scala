/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

package org.apache.texera.web.storage

import org.apache.texera.amber.core.virtualidentity.ActorVirtualIdentity
import org.apache.texera.amber.core.workflow.PhysicalOp
import org.apache.texera.amber.operator.StateTransferFunc

case class ExecutionReconfigurationStore(
    currentReconfigId: Option[String] = None,
    unscheduledReconfigurations: List[(PhysicalOp, Option[StateTransferFunc])] = List(),
    completedReconfigurations: Set[ActorVirtualIdentity] = Set(),
    // Logical op IDs whose reconfiguration has been confirmed-applied by the engine.
    // Populated after `controllerInterface.reconfigureWorkflow(...)` resolves. The
    // ws diff handler reads this to emit ModifyLogicCompletedEvent. Exists alongside
    // `completedReconfigurations` (which keys by worker id) because the new
    // ReconfigurationHandler doesn't surface per-worker completion events; we only
    // know "all workers of these ops are done" when the Future succeeds.
    completedReconfigOpIds: Set[String] = Set.empty
)
