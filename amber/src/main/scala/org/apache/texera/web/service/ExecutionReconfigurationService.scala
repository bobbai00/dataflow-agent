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

package org.apache.texera.web.service

import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.amber.engine.architecture.controller.Workflow
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.{
  UpdateExecutorRequest,
  WorkflowReconfigureRequest
}
import org.apache.texera.amber.engine.common.client.AmberClient
import org.apache.texera.web.SubscriptionManager
import org.apache.texera.web.model.websocket.event.TexeraWebSocketEvent
import org.apache.texera.web.model.websocket.request.ModifyLogicRequest
import org.apache.texera.web.model.websocket.response.{
  ModifyLogicCompletedEvent,
  ModifyLogicResponse
}
import org.apache.texera.web.storage.ExecutionStateStore

import java.util.UUID
import scala.util.{Failure, Success}

class ExecutionReconfigurationService(
    client: AmberClient,
    stateStore: ExecutionStateStore,
    workflow: Workflow
) extends SubscriptionManager
    with LazyLogging {

  // monitors notification from the engine that a reconfiguration on a worker is completed
  //  client.registerCallback[UpdateExecutorCompleted]((evt: UpdateExecutorCompleted) => {
  //    stateStore.reconfigurationStore.updateState(old => {
  //      old.copy(completedReconfigurations = old.completedReconfigurations + evt.id)
  //    })
  //  })

  // monitors the reconfiguration state (completed workers) change,
  // notifies the frontend when all workers of an operator complete reconfiguration.
  // (Legacy path — kept for compatibility with the old UpdateExecutorCompleted
  //  callback. Currently nothing populates `completedReconfigurations`.)
  addSubscription(
    stateStore.reconfigurationStore.registerDiffHandler((oldState, newState) => {
      if (
        oldState.completedReconfigurations != newState.completedReconfigurations
        && oldState.currentReconfigId == newState.currentReconfigId
      ) {
        val diff = newState.completedReconfigurations -- oldState.completedReconfigurations
        val newlyCompletedOps = diff
          .map(workerId => workflow.physicalPlan.getPhysicalOpByWorkerId(workerId).id)
          .map(opId => opId.logicalOpId.id)
        if (newlyCompletedOps.nonEmpty) {
          List(ModifyLogicCompletedEvent(newlyCompletedOps.toList))
        } else {
          List()
        }
      } else {
        List()
      }
    })
  )

  // New-style completion path: `completedReconfigOpIds` is populated after the
  // engine's `reconfigureWorkflow` Future succeeds. We diff and emit one
  // ModifyLogicCompletedEvent for the newly-completed logical op IDs.
  addSubscription(
    stateStore.reconfigurationStore.registerDiffHandler((oldState, newState) => {
      val diff = newState.completedReconfigOpIds -- oldState.completedReconfigOpIds
      if (diff.nonEmpty) {
        List(ModifyLogicCompletedEvent(diff.toList))
      } else {
        List()
      }
    })
  )

  // handles reconfigure workflow logic from frontend
  // validate the modify logic request and notifies the frontend
  // reconfigurations can only come when the workflow is paused,
  // they are not actually performed until the workflow is resumed
  def modifyOperatorLogic(modifyLogicRequest: ModifyLogicRequest): TexeraWebSocketEvent = {
    val newOp = modifyLogicRequest.operator
    val opId = newOp.operatorIdentifier
    val currentOp = workflow.logicalPlan.getOperator(opId)
    val reconfiguredPhysicalOp =
      currentOp.runtimeReconfiguration(
        workflow.context.workflowId,
        workflow.context.executionId,
        currentOp,
        newOp
      )
    reconfiguredPhysicalOp match {
      case Failure(exception) => ModifyLogicResponse(opId.id, isValid = false, exception.getMessage)
      case Success(op) => {
        stateStore.reconfigurationStore.updateState(old =>
          old.copy(unscheduledReconfigurations = old.unscheduledReconfigurations :+ op)
        )
        ModifyLogicResponse(opId.id, isValid = true, "")
      }
    }
  }

  // actually performs all reconfiguration requests the user made during pause
  // sends ModifyLogic messages to operators and workers,
  // see the Fries reconfiguration paper for the algorithm.
  // Note: StateTransferFunc is currently not threaded through to the engine —
  // the new UpdateExecutorRequest only carries (targetOpId, newOpExecInitInfo).
  def performReconfigurationOnResume(): Unit = {
    val reconfigurations = stateStore.reconfigurationStore.getState.unscheduledReconfigurations
    if (reconfigurations.isEmpty) {
      return
    }

    val reconfigurationId = UUID.randomUUID().toString
    val updateExecutorRequests = reconfigurations.map {
      case (op, _) => UpdateExecutorRequest(op.id, op.opExecInitInfo)
    }
    val reconfiguredLogicalOpIds = reconfigurations.map { case (op, _) => op.id.logicalOpId.id }.toSet

    val future = client.controllerInterface.reconfigureWorkflow(
      WorkflowReconfigureRequest(
        reconfiguration = updateExecutorRequests,
        reconfigurationId = reconfigurationId
      ),
      ()
    )

    // When the engine confirms all workers have applied the new logic, surface
    // a ModifyLogicCompletedEvent to the frontend by diffing completedReconfigOpIds.
    future.onSuccess { _ =>
      stateStore.reconfigurationStore.updateState(old =>
        old.copy(completedReconfigOpIds = old.completedReconfigOpIds ++ reconfiguredLogicalOpIds)
      )
    }
    future.onFailure { err =>
      // Surface failure as a no-op for now; the frontend's modify-logic UI doesn't
      // currently render a per-reconfiguration failure event. Logging is enough
      // until a richer error event exists.
      logger.warn(s"Reconfiguration $reconfigurationId failed: ${err.getMessage}")
    }

    // clear all un-scheduled reconfigurations, start a new reconfiguration ID
    stateStore.reconfigurationStore.updateState(_ =>
      org.apache.texera.web.storage
        .ExecutionReconfigurationStore(currentReconfigId = Some(reconfigurationId))
    )
  }
}
