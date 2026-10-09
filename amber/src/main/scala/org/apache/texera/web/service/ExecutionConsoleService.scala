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

import com.google.protobuf.timestamp.Timestamp
import com.twitter.util.{Await, Duration}
import com.typesafe.scalalogging.LazyLogging
import org.apache.texera.common.config.ApplicationConfig
import org.apache.texera.amber.core.storage.model.BufferedItemWriter
import org.apache.texera.amber.core.storage.result.ResultSchema
import org.apache.texera.amber.core.storage.{DocumentFactory, VFSURIFactory}
import org.apache.texera.amber.core.tuple.Tuple
import org.apache.texera.amber.core.virtualidentity.{ActorVirtualIdentity, OperatorIdentity}
import org.apache.texera.amber.core.workflow.WorkflowContext
import org.apache.texera.amber.engine.architecture.coordinator.ExecutionStateUpdate
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.ConsoleMessageType.COMMAND
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.{
  ConsoleMessage,
  ConsoleMessageType,
  EvaluatePythonExpressionRequest,
  DebugCommandRequest => AmberDebugCommandRequest
}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState.{
  COMPLETED,
  FAILED,
  KILLED
}
import org.apache.texera.amber.engine.common.client.AmberClient
import org.apache.texera.amber.engine.common.executionruntimestate.{
  EvaluatedValueList,
  ExecutionConsoleStore,
  OperatorConsole
}
import org.apache.texera.amber.util.VirtualIdentityUtils
import org.apache.texera.web.model.websocket.event.TexeraWebSocketEvent
import org.apache.texera.web.model.websocket.event.python.ConsoleUpdateEvent
import org.apache.texera.web.model.websocket.request.RetryRequest
import org.apache.texera.web.model.websocket.request.python.{
  DebugCommandRequest,
  PythonExpressionEvaluateRequest
}
import org.apache.texera.web.model.websocket.response.python.PythonExpressionEvaluateResponse
import org.apache.texera.web.resource.dashboard.user.workflow.WorkflowExecutionsResource
import org.apache.texera.web.storage.ExecutionStateStore
import org.apache.texera.web.{SubscriptionManager, WebsocketInput}

import java.time.Instant
import java.util.concurrent.{ExecutorService, Executors, TimeUnit}
import scala.collection.mutable

/**
  * Utility object for processing console messages
  * This is extracted to allow for easier testing and reuse
  */
object ConsoleMessageProcessor {

  /**
    * Processes a console message for display, performing truncation if needed.
    *
    * @param consoleMessage The original console message to process
    * @param displayLength The maximum display length for the message title
    * @return The truncated console message
    */
  def processConsoleMessage(
      consoleMessage: ConsoleMessage,
      displayLength: Int
  ): ConsoleMessage = {
    // ERROR titles carry the user-relative line number, code line, and
    // exception cause; downstream consumers (SyncExecutionResource → agent
    // service) need the full text. Don't truncate.
    if (consoleMessage.msgType == ConsoleMessageType.ERROR) {
      return consoleMessage
    }
    // Truncate message title if it exceeds the display length
    val title = consoleMessage.title
    if (title.getBytes.length > displayLength) {
      val truncateIndicator = "..."
      val truncatedTitle = title
        .take(displayLength - truncateIndicator.length) + truncateIndicator
      consoleMessage.copy(title = truncatedTitle)
    } else {
      consoleMessage
    }
  }

  /**
    * Updates the console store by adding a console message to an operator's console.
    *
    * @param consoleStore The console store to update
    * @param opId The operator ID
    * @param processedMessage The processed console message
    * @param bufferSize The maximum number of messages to keep in the buffer
    * @return The updated console store
    */
  def addMessageToOperatorConsole(
      consoleStore: ExecutionConsoleStore,
      opId: String,
      processedMessage: ConsoleMessage,
      bufferSize: Int
  ): ExecutionConsoleStore = {
    val opInfo = consoleStore.operatorConsole.getOrElse(opId, OperatorConsole())

    val updatedOpInfo = if (opInfo.consoleMessages.size < bufferSize) {
      opInfo.addConsoleMessages(processedMessage)
    } else {
      opInfo.withConsoleMessages(opInfo.consoleMessages.tail :+ processedMessage)
    }

    consoleStore.addOperatorConsole(opId -> updatedOpInfo)
  }
}

class ExecutionConsoleService(
    client: AmberClient,
    stateStore: ExecutionStateStore,
    wsInput: WebsocketInput,
    workflowContext: WorkflowContext
) extends SubscriptionManager
    with LazyLogging {

  registerCallbackOnPythonConsoleMessage()

  val bufferSize: Int = ApplicationConfig.operatorConsoleBufferSize
  val consoleMessageDisplayLength: Int = ApplicationConfig.consoleMessageDisplayLength

  private val consoleMessageOpIdToWriterMap: mutable.Map[String, BufferedItemWriter[Tuple]] =
    mutable.Map()

  private val consoleWriterThread: ExecutorService = Executors.newSingleThreadExecutor()

  private def getOrCreateWriter(opId: OperatorIdentity): BufferedItemWriter[Tuple] = {
    consoleMessageOpIdToWriterMap.getOrElseUpdate(
      opId.id, {
        val uri = VFSURIFactory
          .createConsoleMessagesURI(workflowContext.workflowId, workflowContext.executionId, opId)
        val writer = DocumentFactory
          .createDocument(uri, ResultSchema.consoleMessagesSchema)
          .writer("console_messages")
          .asInstanceOf[BufferedItemWriter[Tuple]]
        WorkflowExecutionsResource.insertOperatorExecutions(
          workflowContext.executionId.id,
          opId.id,
          uri
        )
        writer.open()
        writer
      }
    )
  }

  addSubscription(
    stateStore.consoleStore.registerDiffHandler((oldState, newState) => {
      val output = new mutable.ArrayBuffer[TexeraWebSocketEvent]()
      // For each operator, check if it has new python console message or breakpoint events
      newState.operatorConsole
        .foreach {
          case (opId, info) =>
            val oldConsole = oldState.operatorConsole.getOrElse(opId, new OperatorConsole())
            val diff = info.consoleMessages.diff(oldConsole.consoleMessages)
            output.append(ConsoleUpdateEvent(opId, diff))

            info.evaluateExprResults.keys
              .filterNot(oldConsole.evaluateExprResults.contains)
              .foreach { key =>
                output.append(
                  PythonExpressionEvaluateResponse(key, info.evaluateExprResults(key).values)
                )
              }
        }
      output
    })
  )

  protected def registerCallbackOnPythonConsoleMessage(): Unit = {
    addSubscription(
      client
        .registerCallback[ConsoleMessage]((evt: ConsoleMessage) => {
          stateStore.consoleStore.updateState { consoleStore =>
            val opId =
              VirtualIdentityUtils.getPhysicalOpId(
                ActorVirtualIdentity(evt.workerId)
              )
            addConsoleMessage(consoleStore, opId.logicalOpId.id, evt)
          }
        })
    )

  }

  addSubscription(
    client.registerCallback[ExecutionStateUpdate] {
      case ExecutionStateUpdate(state: WorkflowAggregatedState.Recognized)
          if Set(COMPLETED, FAILED, KILLED).contains(state) =>
        logger.info("Workflow execution terminated. Commit console messages.")
        commitConsoleMessages()
      case _ =>
    }
  )

  /**
    * Flush and close all console-message writers so the persisted documents are
    * complete and readable.
    *
    * Console messages (including `print(...)` output) live only in each operator's
    * buffered writer until it is closed — close() is what flushes the buffer to the
    * underlying document. Normally this is driven by the engine's terminal
    * COMPLETED/FAILED/KILLED state update above. The synchronous execution path,
    * however, tears the client down (kill + manual state override) before that event
    * propagates, so without an explicit commit the prints would never reach the
    * document and the agent would only ever see error messages (which the sync path
    * reads from the in-memory store). SyncExecutionResource calls this before reading
    * the console documents.
    *
    * The close runs on the single writer thread so it serializes *after* any pending
    * putOne writes, and we block (bounded) until it finishes. The map is cleared so a
    * subsequent terminal-state callback is a no-op rather than a double close.
    */
  def commitConsoleMessages(): Unit = {
    val task = consoleWriterThread.submit(new Runnable {
      override def run(): Unit = {
        consoleMessageOpIdToWriterMap.values.foreach { writer =>
          try {
            writer.close()
          } catch {
            case e: Exception =>
              logger.error("Failed to close console message writer", e)
          }
        }
        consoleMessageOpIdToWriterMap.clear()
      }
    })
    try {
      task.get(10, TimeUnit.SECONDS)
    } catch {
      case e: Exception =>
        logger.error("Timed out committing console messages", e)
    }
  }

  /**
    * Processes a console message for display, performing truncation if needed.
    * This method uses the shared implementation in ConsoleMessageProcessor.
    *
    * @param consoleMessage The original console message to process
    * @return The truncated console message
    */
  def processConsoleMessage(consoleMessage: ConsoleMessage): ConsoleMessage = {
    // Do not truncate debugger messages
    if (consoleMessage.msgType == ConsoleMessageType.DEBUGGER) {
      return consoleMessage
    }
    ConsoleMessageProcessor.processConsoleMessage(consoleMessage, consoleMessageDisplayLength)
  }

  /**
    * Updates the console store by adding a console message to an operator's console.
    * This method uses the shared implementation in ConsoleMessageProcessor.
    *
    * @param consoleStore The console store to update
    * @param opId The operator ID
    * @param processedMessage The processed console message
    * @return The updated console store
    */
  def addMessageToOperatorConsole(
      consoleStore: ExecutionConsoleStore,
      opId: String,
      processedMessage: ConsoleMessage
  ): ExecutionConsoleStore = {
    ConsoleMessageProcessor.addMessageToOperatorConsole(
      consoleStore,
      opId,
      processedMessage,
      bufferSize
    )
  }

  private[this] def addConsoleMessage(
      consoleStore: ExecutionConsoleStore,
      opId: String,
      consoleMessage: ConsoleMessage
  ): ExecutionConsoleStore = {
    // Write the original full message to the database
    consoleWriterThread.execute(() => {
      val writer = getOrCreateWriter(OperatorIdentity(opId))
      try {
        val tuple = new Tuple(
          ResultSchema.consoleMessagesSchema,
          Array(consoleMessage.toProtoString)
        )
        writer.putOne(tuple)
      } catch {
        case e: Exception =>
          logger.error(s"Error while writing console message for operator $opId", e)
      }
    })

    // Process the message (truncate if needed) and update store
    val truncatedMessage = processConsoleMessage(consoleMessage)
    addMessageToOperatorConsole(consoleStore, opId, truncatedMessage)
  }

  //Receive retry request
  addSubscription(wsInput.subscribe((req: RetryRequest, uidOpt) => {
    // empty implementation
  }))

  //Receive evaluate python expression
  addSubscription(wsInput.subscribe((req: PythonExpressionEvaluateRequest, uidOpt) => {
    val result = Await.result(
      client.coordinatorInterface.evaluatePythonExpression(
        EvaluatePythonExpressionRequest(req.expression, req.operatorId),
        ()
      ),
      Duration.fromSeconds(10)
    )
    stateStore.consoleStore.updateState(consoleStore => {
      val opInfo = consoleStore.operatorConsole.getOrElse(req.operatorId, OperatorConsole())
      consoleStore.addOperatorConsole(
        (
          req.operatorId,
          opInfo.addEvaluateExprResults((req.expression, EvaluatedValueList(result.values)))
        )
      )
    })

    // TODO: remove the following hack after fixing the frontend
    // currently frontend is not prepared for re-receiving the eval-expr messages
    // so we add it to the state and remove it from the state immediately
    stateStore.consoleStore.updateState(consoleStore => {
      val opInfo = consoleStore.operatorConsole.getOrElse(req.operatorId, OperatorConsole())
      consoleStore.addOperatorConsole((req.operatorId, opInfo.clearEvaluateExprResults))
    })
  }))

  //Receive debug command
  addSubscription(wsInput.subscribe((req: DebugCommandRequest, uidOpt) => {
    stateStore.consoleStore.updateState { consoleStore =>
      val newMessage = new ConsoleMessage(
        req.workerId,
        Timestamp(Instant.now),
        COMMAND,
        "USER-" + uidOpt.getOrElse("UNKNOWN"),
        req.cmd,
        ""
      )
      addConsoleMessage(consoleStore, req.operatorId, newMessage)
    }

    client.coordinatorInterface.debugCommand(AmberDebugCommandRequest(req.workerId, req.cmd), ())

  }))

  // The console-writer executor is per-execution; without this it outlives the
  // execution and its thread leaks for the life of the JVM.
  override def unsubscribeAll(): Unit = {
    super.unsubscribeAll()
    consoleWriterThread.shutdown()
  }
}
