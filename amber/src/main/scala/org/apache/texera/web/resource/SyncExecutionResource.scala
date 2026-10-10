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

package org.apache.texera.web.resource

import com.fasterxml.jackson.databind.node.ObjectNode
import com.typesafe.scalalogging.LazyLogging
import io.dropwizard.auth.Auth
import org.apache.texera.common.config.ApplicationConfig
import org.apache.texera.amber.core.storage.DocumentFactory
import org.apache.texera.amber.operator.LogicalOp
import org.apache.texera.amber.core.storage.model.VirtualDocument
import org.apache.texera.amber.core.tuple.Tuple
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{PortIdentity, WorkflowContext, WorkflowSettings}
import org.apache.texera.amber.engine.architecture.rpc.controlcommands.{
  ConsoleMessage,
  ConsoleMessageType
}
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState
import org.apache.texera.amber.engine.architecture.rpc.controlreturns.WorkflowAggregatedState._
import org.apache.texera.amber.engine.common.executionruntimestate.{
  ExecutionConsoleStore,
  ExecutionMetadataStore,
  ExecutionStatsStore
}
import io.reactivex.rxjava3.core.Observable
import org.apache.texera.auth.SessionUser
import org.apache.texera.dao.SqlServer
import org.apache.texera.dao.jooq.generated.Tables.OPERATOR_EXECUTIONS
import org.apache.texera.common.compiler.model.LogicalPlanPojo
import org.apache.texera.web.model.websocket.request.WorkflowExecuteRequest
import org.apache.texera.common.compiler.model.LogicalLink
import org.apache.texera.common.compiler.{CompilationErrorHandling, WorkflowCompiler}
import org.apache.texera.web.resource.dashboard.user.workflow.WorkflowExecutionsResource
import org.apache.texera.web.service.{
  ExecutionPhaseMetrics,
  ExecutionResultService,
  ResultField,
  ResultMaterialization,
  StructuredResultTransport,
  WorkflowService,
  WorkflowExecutionService
}
import org.apache.texera.web.storage.ExecutionStateStore.updateWorkflowState

import java.net.URI
import java.util.concurrent.TimeUnit
import javax.annotation.security.RolesAllowed
import javax.ws.rs._
import javax.ws.rs.core.MediaType
import scala.collection.mutable
import scala.jdk.CollectionConverters._
import com.fasterxml.jackson.databind.ObjectMapper

case class SyncExecutionRequest(
    executionName: String,
    logicalPlan: LogicalPlanPojo,
    workflowSettings: Option[WorkflowSettings],
    targetOperatorIds: List[String],
    timeoutSeconds: Int,
    maxOperatorResultCharLimit: Int,
    maxOperatorResultCellCharLimit: Int,
    structuredResults: Boolean = false
)

case class ConsoleMessageInfo(
    msgType: String,
    title: String,
    message: String
)

case class PortShape(
    portIndex: Int,
    rows: Long
)

case class OperatorInfo(
    state: String,
    inputTuples: Long,
    outputTuples: Long,
    inputPortShapes: Option[List[PortShape]],
    resultMode: String, // "table" or "visualization"
    result: Option[Any], // JSON array (List[ObjectNode])
    totalRowCount: Option[Int],
    displayedRows: Option[Int],
    truncated: Option[Boolean],
    consoleLogs: Option[List[ConsoleMessageInfo]],
    error: Option[String],
    warnings: Option[List[String]],
    // Per-column result statistics from data_processor.py's
    // _compute_column_stats. JSON-encoded value per column. None when the
    // operator did not produce stats (non-DataProcessing/DataLoading, or
    // stats not yet propagated).
    columnStats: Option[Map[String, String]],
    resultMetadata: Option[Map[String, String]] = None,
    metadataOmissions: Option[List[String]] = None,
    numWorkers: Option[Int] = None,
    resultSchema: Option[List[ResultField]] = None,
    materialization: Option[ResultMaterialization] = None
)

case class SyncExecutionResult(
    success: Boolean,
    state: String,
    operators: Map[String, OperatorInfo],
    compilationErrors: Option[Map[String, String]],
    errors: Option[List[String]],
    executionId: Option[String] = None,
    capabilities: Option[List[String]] = None,
    inputMaterializations: Option[Map[String, ResultMaterialization]] = None,
    phaseMetrics: Option[ExecutionPhaseMetrics] = None
)

sealed trait TerminationReason
case class TerminalStateReached(state: ExecutionMetadataStore) extends TerminationReason
case class ConsoleErrorDetected(consoleState: ExecutionConsoleStore) extends TerminationReason
case class TargetResultsReady(statsState: ExecutionStatsStore) extends TerminationReason

@Path("/execution")
@Consumes(Array(MediaType.APPLICATION_JSON))
@Produces(Array(MediaType.APPLICATION_JSON))
class SyncExecutionResource extends LazyLogging {

  // Hard caps applied regardless of request — guard against runaway payloads.
  private val MAX_OPERATOR_RESULT_CHARS = 100000
  private val MAX_OPERATOR_RESULT_CELL_CHARS = 20000

  @POST
  @Path("/{wid}/{cuid}/run")
  @RolesAllowed(Array("REGULAR", "ADMIN"))
  def executeWorkflowSync(
      @PathParam("wid") workflowId: Long,
      @PathParam("cuid") computingUnitId: Int,
      request: SyncExecutionRequest,
      @Auth user: SessionUser
  ): SyncExecutionResult = {
    val timeoutSeconds = request.timeoutSeconds

    val maxOperatorResultCharLimit =
      Math.min(request.maxOperatorResultCharLimit, MAX_OPERATOR_RESULT_CHARS)
    val maxOperatorResultCellCharLimit =
      Math.min(request.maxOperatorResultCellCharLimit, MAX_OPERATOR_RESULT_CELL_CHARS)

    logger.info(
      s"Starting sync execution for workflow $workflowId with limits: " +
        s"maxOperatorResultCharLimit=${request.maxOperatorResultCharLimit} (capped to $maxOperatorResultCharLimit), " +
        s"maxOperatorResultCellCharLimit=${request.maxOperatorResultCellCharLimit} (capped to $maxOperatorResultCellCharLimit)"
    )

    // Kept request-local, never recovered from a previous run's cache/store.
    // Early authorization/initialization/HTTP failures have unknown phases.
    var activeExecution: Option[WorkflowExecutionService] = None
    try {
      val workflowService = WorkflowService.getOrCreate(
        WorkflowIdentity(workflowId),
        computingUnitId
      )

      shutdownPreviousExecution(workflowService)

      // "Execute To" semantics: when a single target is given, run only its upstream sub-DAG.
      val effectiveLogicalPlan =
        computeSubDAGIfNeeded(request.logicalPlan, request.targetOperatorIds)

      val executeRequest = WorkflowExecuteRequest(
        executionName = request.executionName,
        engineVersion = "1.0",
        logicalPlan = effectiveLogicalPlan,
        replayFromExecution = None,
        workflowSettings = request.workflowSettings
          .getOrElse(
            WorkflowSettings(dataTransferBatchSize = ApplicationConfig.defaultDataTransferBatchSize)
          ),
        emailNotificationEnabled = false,
        computingUnitId = computingUnitId
      )

      workflowService.initExecutionService(
        executeRequest,
        Some(user.getUser),
        new URI(s"sync-execution://$workflowId")
      )

      val executionService = workflowService.executionService.getValue
      if (executionService == null) {
        return SyncExecutionResult(
          success = false,
          state = "Error",
          operators = Map.empty,
          compilationErrors = None,
          errors = Some(List("Failed to initialize execution service"))
        )
      }
      activeExecution = Some(executionService)

      // Snapshot before subscribing — handles the race where a fast execution finishes
      // before the Observable below sees any state change.
      val currentState = executionService.executionStateStore.metadataStore.getState
      val currentConsoleState = executionService.executionStateStore.consoleStore.getState
      val currentStatsState = executionService.executionStateStore.statsStore.getState

      // Multi-region operators (e.g., HashJoin: build region then probe region) report their
      // aggregated logical state as COMPLETED for a brief window after the first region
      // terminates and before the second region's workers are added to regionExecutions.
      // Guard against firing during that window by also requiring every declared external
      // input port to be present in the operator's input metrics — port-1 stats only appear
      // once probe actually starts consuming, which closes the race.
      val targetExpectedExternalInputs: Map[String, Int] = effectiveLogicalPlan.operators
        .filter(op => request.targetOperatorIds.contains(op.operatorIdentifier.id))
        .map(op => op.operatorIdentifier.id -> op.operatorInfo.inputPorts.count(!_.id.internal))
        .toMap

      // Require COMPLETED, not just "has output", so upstream operators finish flushing
      // their data downstream before we tear the execution down.
      def allTargetsCompleted(stats: ExecutionStatsStore): Boolean = {
        request.targetOperatorIds.nonEmpty && request.targetOperatorIds.forall { opId =>
          stats.operatorInfo.get(opId).exists { metrics =>
            val externalInputPortsReporting =
              metrics.operatorStatistics.inputMetrics.count(!_.portId.internal)
            val expectedExternalInputs = targetExpectedExternalInputs.getOrElse(opId, 0)
            // A cache-hit target is as done as a freshly completed one — its result
            // is already materialized. Without this, an execution whose targets all
            // cache-hit waits for the aggregate terminal state instead of returning
            // as soon as the (replayed) results are available.
            (metrics.operatorState == COMPLETED || metrics.operatorState == COMPLETED_FROM_CACHE) &&
            externalInputPortsReporting >= expectedExternalInputs
          }
        }
      }

      val terminationReason: TerminationReason =
        if (isTerminalState(currentState.state)) {
          TerminalStateReached(currentState)
        } else if (hasConsoleError(currentConsoleState)) {
          ConsoleErrorDetected(currentConsoleState)
        } else if (allTargetsCompleted(currentStatsState)) {
          TargetResultsReady(currentStatsState)
        } else {
          val terminalStateObservable: Observable[TerminationReason] =
            executionService.executionStateStore.metadataStore.getStateObservable
              .filter((state: ExecutionMetadataStore) => isTerminalState(state.state))
              .map[TerminationReason](state => TerminalStateReached(state))

          val consoleErrorObservable: Observable[TerminationReason] =
            executionService.executionStateStore.consoleStore.getStateObservable
              .filter((consoleState: ExecutionConsoleStore) => hasConsoleError(consoleState))
              .map[TerminationReason](consoleState => ConsoleErrorDetected(consoleState))

          val targetResultsObservable: Observable[TerminationReason] =
            executionService.executionStateStore.statsStore.getStateObservable
              .filter((stats: ExecutionStatsStore) => allTargetsCompleted(stats))
              .map[TerminationReason](stats => TargetResultsReady(stats))

          try {
            Observable
              .amb(
                java.util.Arrays.asList(
                  terminalStateObservable,
                  consoleErrorObservable,
                  targetResultsObservable
                )
              )
              .firstOrError()
              .timeout(timeoutSeconds.toLong, TimeUnit.SECONDS)
              .blockingGet()
          } catch {
            case _: java.util.concurrent.TimeoutException =>
              killExecution(executionService)
              return SyncExecutionResult(
                success = false,
                state = "Killed",
                operators = Map.empty,
                compilationErrors = None,
                errors = Some(List(s"Timeout after $timeoutSeconds seconds")),
                executionId = Some(executionService.workflowContext.executionId.id.toString),
                phaseMetrics = Some(executionService.phaseMetrics)
              )
            case e: Exception =>
              logger.error(s"Error waiting for execution: ${e.getMessage}", e)
              return SyncExecutionResult(
                success = false,
                state = "Error",
                operators = Map.empty,
                compilationErrors = None,
                errors = Some(List(e.getMessage)),
                executionId = Some(executionService.workflowContext.executionId.id.toString),
                phaseMetrics = Some(executionService.phaseMetrics)
              )
          }
        }

      val (finalState, terminatedByConsoleError, terminatedByTargetResults) =
        terminationReason match {
          case TerminalStateReached(state) =>
            (state, false, false)
          case ConsoleErrorDetected(_) =>
            killExecution(executionService)
            (executionService.executionStateStore.metadataStore.getState, true, false)
          case TargetResultsReady(_) =>
            // RegionExecutionManager caches upstream results asynchronously after operators
            // complete; sleep gives that caching a chance to finish before we shut down the client.
            // TODO: replace with a synchronous signal from the engine.
            Thread.sleep(500)
            killExecution(executionService)
            // Override to COMPLETED — we have everything we asked for, even though the engine
            // sees this as a kill.
            executionService.executionStateStore.metadataStore.updateState(metadataStore =>
              updateWorkflowState(COMPLETED, metadataStore)
            )
            (executionService.executionStateStore.metadataStore.getState, false, true)
        }

      // Let the result writer flush before we read storage.
      Thread.sleep(500)

      // Console messages (incl. print output) only reach their document when the
      // writers are closed. The engine normally closes them on the terminal state
      // event, but the kill/target-results path tears the client down before that
      // fires — so flush explicitly here, for every termination path (including a
      // half-way failure), so prints land in the document we're about to read.
      try {
        if (executionService.executionConsoleService != null) {
          executionService.executionConsoleService.commitConsoleMessages()
        }
      } catch {
        case e: Exception =>
          logger.warn(s"Failed to commit console messages: ${e.getMessage}")
      }

      // Pass the LIVE in-memory console store (freshest snapshot, for every
      // termination path). It holds every console message received so far —
      // including prints emitted before an operator failed half-way — which the DB
      // document can miss when the client is torn down before its writer flushes.
      // collectConsoleLogs merges this with the DB so prints survive either way.
      val inMemoryConsoleState: Option[ExecutionConsoleStore] =
        Some(executionService.executionStateStore.consoleStore.getState)

      val executionId = executionService.workflowContext.executionId
      val operatorInfos = collectOperatorInfos(
        executionId,
        executionService,
        request.targetOperatorIds,
        maxOperatorResultCharLimit,
        maxOperatorResultCellCharLimit,
        inMemoryConsoleState,
        request.structuredResults
      )

      val fatalErrors = finalState.fatalErrors
        .map(err => s"${err.`type`}: ${err.message}")
        .toList

      val hasOperatorConsoleError = operatorInfos.values.exists(_.error.isDefined)

      val stateString =
        if (terminatedByConsoleError) "Failed"
        else if (terminatedByTargetResults) "Completed"
        else stateToString(finalState.state)

      val isSuccess = (finalState.state == COMPLETED || terminatedByTargetResults) &&
        !hasOperatorConsoleError && !terminatedByConsoleError

      SyncExecutionResult(
        success = isSuccess,
        state = stateString,
        operators = operatorInfos,
        compilationErrors = None,
        errors = if (fatalErrors.nonEmpty) Some(fatalErrors) else None,
        executionId = Some(executionId.id.toString),
        phaseMetrics = Some(executionService.phaseMetrics),
        capabilities =
          if (request.structuredResults) Some(StructuredResultTransport.capabilities) else None,
        inputMaterializations = Option.when(request.structuredResults) {
          val states = executionService.executionStateStore.statsStore.getState.operatorInfo
          StructuredResultTransport.inputMaterializations(
            effectiveLogicalPlan.operators.map(_.operatorIdentifier.id),
            states.collect { case (id, metrics) if metrics.operatorState == COMPLETED => id }.toSet,
            states.collect {
              case (id, metrics) if metrics.operatorState == COMPLETED_FROM_CACHE => id
            }.toSet,
            executionId.id.toString,
            executionService.executionStateStore.cacheUsageStore.getState.cachedOutputs
          )
        }
      )

    } catch {
      case e: Exception =>
        logger.error(s"Sync execution error: ${e.getMessage}", e)
        handleExecutionError(e).copy(
          executionId = activeExecution.map(_.workflowContext.executionId.id.toString),
          phaseMetrics = activeExecution.map(_.phaseMetrics)
        )
    } finally {
      // A console error, target completion, or timeout can shut the client
      // down before its terminal statistics callback. Flush before returning:
      // callers may delete this workflow's tables immediately afterwards.
      activeExecution.foreach { execution =>
        Option(execution.executionStatsService).foreach { statistics =>
          try statistics.commitRuntimeStatistics()
          catch {
            case e: Exception =>
              logger.warn(s"Failed to commit runtime statistics: ${e.getMessage}")
          }
        }
      }
    }
  }

  private def shutdownPreviousExecution(workflowService: WorkflowService): Unit = {
    try {
      val previousEs = workflowService.executionService.getValue
      if (previousEs != null && previousEs.client != null) {
        logger.info(s"Shutting down previous execution client")
        previousEs.client.shutdown()
      }
    } catch {
      case e: Exception =>
        logger.warn(s"Error shutting down previous execution client: ${e.getMessage}")
    }
  }

  private def killExecution(
      executionService: org.apache.texera.web.service.WorkflowExecutionService
  ): Unit = {
    try {
      if (executionService.client != null) {
        executionService.client.shutdown()
      }
      executionService.executionStateStore.statsStore.updateState(stats =>
        stats.withEndTimeStamp(System.currentTimeMillis())
      )
      executionService.executionStateStore.metadataStore.updateState(metadataStore =>
        updateWorkflowState(KILLED, metadataStore)
      )
    } catch {
      case e: Exception =>
        logger.warn(s"Error killing execution: ${e.getMessage}")
    }
  }

  private def collectOperatorInfos(
      executionId: ExecutionIdentity,
      executionService: org.apache.texera.web.service.WorkflowExecutionService,
      targetOperatorIds: List[String],
      maxOperatorResultCharLimit: Int,
      maxOperatorResultCellCharLimit: Int,
      inMemoryConsoleState: Option[ExecutionConsoleStore] = None,
      structuredResults: Boolean = false
  ): Map[String, OperatorInfo] = {
    val operatorInfos = mutable.Map[String, OperatorInfo]()

    val statsState = executionService.executionStateStore.statsStore.getState
    val operatorStats = statsState.operatorInfo

    val baseTargetOps = if (targetOperatorIds.nonEmpty) {
      targetOperatorIds
    } else {
      operatorStats.keys.toList
    }

    // Pull in any operator that logged a console error even if it isn't a target —
    // otherwise the caller can't see why an upstream op failed.
    val consoleErrorOps = inMemoryConsoleState
      .map { consoleState =>
        consoleState.operatorConsole.keys.toList
      }
      .getOrElse(List.empty)

    val targetOps = (baseTargetOps ++ consoleErrorOps).distinct

    for (opId <- targetOps) {
      val stats = operatorStats.get(opId)
      val (state, inputTuples, outputTuples): (String, Long, Long) = stats match {
        case Some(s) =>
          val inputCount = s.operatorStatistics.inputMetrics.map(_.tupleMetrics.count).sum
          val outputCount = s.operatorStatistics.outputMetrics.map(_.tupleMetrics.count).sum
          (stateToString(s.operatorState), inputCount, outputCount)
        case None => ("Unknown", 0L, 0L)
      }

      val inputPortShapes: Option[List[PortShape]] = stats
        .map { s =>
          s.operatorStatistics.inputMetrics.map { pm =>
            PortShape(pm.portId.id, pm.tupleMetrics.count)
          }.toList
        }
        .filter(_.nonEmpty)

      val (resultMode, result, totalRowCount, displayedRows, truncated, resultSchema) =
        collectOperatorResult(
          executionId,
          opId,
          maxOperatorResultCharLimit,
          maxOperatorResultCellCharLimit,
          structuredResults
        )

      // Merge the persisted DB document (full-fidelity, authoritative when present)
      // with the in-memory store. Neither alone is complete: the DB can miss a print
      // when the writer is torn down before flushing (e.g. an operator that fails
      // half-way), while the in-memory store truncates print titles to the display
      // length. Union them so prints survive regardless of which source captured them.
      val dbConsoleLogs = collectConsoleLogs(executionId, opId)
      val memConsoleLogs = inMemoryConsoleState.flatMap { consoleState =>
        consoleState.operatorConsole
          .get(opId)
          .map { opConsole =>
            opConsole.consoleMessages.map { msg =>
              ConsoleMessageInfo(
                msgType = msg.msgType.name,
                title = msg.title,
                message = msg.message
              )
            }.toList
          }
          .filter(_.nonEmpty)
      }
      val consoleLogs = mergeConsoleLogs(dbConsoleLogs, memConsoleLogs)

      // Python writes the full error text to `message`; Scala writes it to `title`
      // (with a stack trace in `message`). Pick whichever is longer to avoid losing detail.
      val errorMsg = consoleLogs.flatMap(
        _.find(_.msgType == "ERROR").map { e =>
          if (e.message.nonEmpty && e.message.length > e.title.length) e.message
          else e.title
        }
      )

      // Convention: PRINT messages prefixed with "WARNING: " surface as warnings.
      val warningMsgs = consoleLogs
        .map(_.filter(_.title.startsWith("WARNING: ")).map(_.title))
        .filter(_.nonEmpty)

      // Per-column stats forwarded from WorkerStatistics.result_statistics.
      // Each value is a JSON-encoded blob (count/null/distinct + type-specific
      // stats). Empty map -> None so the response stays compact.
      //
      // The blob's string-typed sub-fields (notably top_10[i].value for string
      // columns) are NOT bounded by the cell-char limit applied to tuple
      // results, so a column whose values are large strings (e.g. WKT
      // geometries) would otherwise ship multi-MB stats payloads that blow
      // the LLM context. Walk every value JSON and apply the same per-cell
      // truncation we use on tuple cells.
      val partitioned = StructuredResultTransport.partitionStatistics(
        stats.map(_.operatorStatistics.resultStatistics.toMap).getOrElse(Map.empty)
      )
      val columnStats = Option(partitioned.columnStats)
        .filter(_.nonEmpty)
        .map(m => truncateColumnStatsValues(m, maxOperatorResultCellCharLimit))

      operatorInfos(opId) = OperatorInfo(
        state = state,
        inputTuples = inputTuples,
        outputTuples = outputTuples,
        inputPortShapes = inputPortShapes,
        resultMode = resultMode,
        result = result,
        totalRowCount = totalRowCount,
        displayedRows = displayedRows,
        truncated = truncated,
        consoleLogs = consoleLogs,
        error = errorMsg,
        warnings = warningMsgs,
        columnStats = columnStats,
        resultMetadata =
          Option.when(structuredResults && partitioned.metadata.nonEmpty)(partitioned.metadata),
        metadataOmissions =
          Option.when(structuredResults && partitioned.omissions.nonEmpty)(partitioned.omissions),
        numWorkers = if (structuredResults) stats.map(_.operatorStatistics.numWorkers) else None,
        resultSchema = resultSchema,
        materialization = Option.when(structuredResults && result.isDefined)(
          StructuredResultTransport.materialization(
            opId,
            executionId.id.toString,
            executionService.executionStateStore.cacheUsageStore.getState.cachedOutputs
          )
        )
      )
    }

    operatorInfos.toMap
  }

  private def handleExecutionError(e: Exception): SyncExecutionResult = {
    val errorMsg = e.getMessage
    val isCompilationError = errorMsg != null && (
      errorMsg.contains("compilation") ||
        errorMsg.contains("Compilation") ||
        errorMsg.contains("operator") ||
        errorMsg.contains("schema")
    )

    if (isCompilationError) {
      SyncExecutionResult(
        success = false,
        state = "CompilationFailed",
        operators = Map.empty,
        compilationErrors = Some(Map("error" -> errorMsg)),
        errors = Some(List(errorMsg))
      )
    } else {
      SyncExecutionResult(
        success = false,
        state = "Error",
        operators = Map.empty,
        compilationErrors = None,
        errors = Some(List(Option(e.getMessage).getOrElse("Unknown error")))
      )
    }
  }

  /**
    * Symmetric truncation: fill half the char budget from the front of the result, keep a
    * sliding-window of the most recent tuples for the back half. Returns a JSON array;
    * serialization to table/toon format happens in agent-service.
    */
  private def collectOperatorResult(
      executionId: ExecutionIdentity,
      opId: String,
      maxOperatorResultCharLimit: Int,
      maxOperatorResultCellCharLimit: Int,
      structuredResults: Boolean = false
  ): (String, Option[Any], Option[Int], Option[Int], Option[Boolean], Option[List[ResultField]]) = {
    import com.fasterxml.jackson.databind.node.ObjectNode

    try {
      val storageUriOption = WorkflowExecutionsResource.getResultUriByLogicalPortId(
        executionId,
        OperatorIdentity(opId),
        PortIdentity()
      )

      storageUriOption match {
        case Some(storageUri) =>
          val (openedDocument, storedSchema) = DocumentFactory.openDocument(storageUri)
          val document = openedDocument.asInstanceOf[VirtualDocument[Tuple]]
          val resultSchema =
            if (structuredResults) storedSchema.map(StructuredResultTransport.schemaFields)
            else None

          val totalCount = document.getCount.toInt
          val mapper = new ObjectMapper()
          val tupleIterator = document.get()
          // One row as the response shows it, with its rendered size.
          def render(tuple: Tuple, index: Int): (ObjectNode, Int) = {
            val json = ExecutionResultService
              .convertTuplesToJson(List(tuple), structuredResults = structuredResults)
              .head
            val truncated = truncateSingleTuple(json, maxOperatorResultCellCharLimit, resultSchema)
            StructuredResultTransport.annotateSampleRow(truncated, index, structuredResults)
            (truncated, estimateTupleSize(truncated, mapper))
          }

          if (totalCount == 0 || !tupleIterator.hasNext) {
            return (
              "table",
              Some(List.empty[ObjectNode].asJava),
              Some(0),
              Some(0),
              Some(false),
              resultSchema
            )
          }

          // A single tuple with html-content / json-content is a visualization payload —
          // the frontend renders it as an iframe rather than a table.
          val firstTuple = tupleIterator.next()
          if (totalCount == 1 && isVisualizationTuple(firstTuple, structuredResults)) {
            val jsonResults =
              ExecutionResultService.convertTuplesToJson(List(firstTuple), isVisualization = true)
            jsonResults.foreach(
              _.asInstanceOf[ObjectNode].put("__is_visualization__", true)
            )
            return (
              "visualization",
              Some(jsonResults),
              Some(totalCount),
              Some(1),
              Some(false),
              resultSchema
            )
          }

          // __row_index__ preserves the original position so the frontend can show
          // "row N" correctly after symmetric truncation drops the middle.
          var rowIndex = 0
          val (truncatedFirst, firstSize) = render(firstTuple, rowIndex)

          if (firstSize >= maxOperatorResultCharLimit) {
            return (
              "table",
              Some(List(truncatedFirst).asJava),
              Some(totalCount),
              Some(1),
              Some(true),
              resultSchema
            )
          }

          val halfLimit = maxOperatorResultCharLimit / 2
          val truncationNoticeSize = 50 // reserved for the "...skipped..." marker

          val frontTuples = mutable.ListBuffer[ObjectNode](truncatedFirst)
          var frontSize = firstSize

          while (tupleIterator.hasNext && frontSize < halfLimit) {
            val tuple = tupleIterator.next()
            rowIndex += 1
            val (truncatedTuple, tupleSize) = render(tuple, rowIndex)

            if (frontSize + tupleSize <= halfLimit) {
              frontTuples += truncatedTuple
              frontSize += tupleSize
            } else {
              // Front is full: the back half comes from the rows from this one on.
              val backTuples = tailRows(
                document,
                rowIndex,
                totalCount,
                halfLimit - truncationNoticeSize,
                render
              )
              val allTuples = frontTuples.toList ++ backTuples
              val skippedRows = totalCount - allTuples.size

              return (
                "table",
                Some(allTuples.asJava),
                Some(totalCount),
                Some(allTuples.size),
                Some(skippedRows > 0),
                resultSchema
              )
            }
          }

          if (tupleIterator.hasNext) {
            val backTuples = tailRows(
              document,
              rowIndex + 1,
              totalCount,
              halfLimit - truncationNoticeSize,
              render
            )
            val allTuples = frontTuples.toList ++ backTuples
            val skippedRows = totalCount - allTuples.size

            (
              "table",
              Some(allTuples.asJava),
              Some(totalCount),
              Some(allTuples.size),
              Some(skippedRows > 0),
              resultSchema
            )
          } else {
            (
              "table",
              Some(frontTuples.toList.asJava),
              Some(totalCount),
              Some(frontTuples.size),
              Some(false),
              resultSchema
            )
          }

        case None =>
          ("table", None, None, None, None, None)
      }
    } catch {
      case e: Exception =>
        logger.warn(s"Error collecting result for operator $opId: ${e.getMessage}", e)
        ("table", None, None, None, None, None)
    }
  }

  private[web] def truncateSingleTuple(
      tuple: ObjectNode,
      maxCellChars: Int,
      resultSchema: Option[List[ResultField]] = None
  ): ObjectNode = {
    import com.fasterxml.jackson.databind.ObjectMapper
    import com.fasterxml.jackson.databind.node.TextNode

    val mapper = new ObjectMapper()
    val truncatedTuple = mapper.createObjectNode()
    val fieldNames = tuple.fieldNames()
    val scalarEncodings = resultSchema.toList.flatten
      .filter(f => f.encoding == "number-or-decimal-string" || f.encoding == "iso8601-utc")
      .map(_.name)
      .toSet

    while (fieldNames.hasNext) {
      val fieldName = fieldNames.next()
      val fieldValue = tuple.get(fieldName)
      if (fieldValue.isTextual && !scalarEncodings.contains(fieldName)) {
        val text = fieldValue.asText()
        if (text.length > maxCellChars) {
          val truncatedText = symmetricTruncateCellValue(text, maxCellChars)
          truncatedTuple.set(fieldName, new TextNode(truncatedText))
        } else {
          truncatedTuple.set(fieldName, fieldValue)
        }
      } else {
        truncatedTuple.set(fieldName, fieldValue)
      }
    }
    truncatedTuple
  }

  /**
    * The rows the back half keeps from rows [start, total): the longest run
    * ending at the last row whose rendered sizes fit `budget`, and at least the
    * last row. Read backwards in growing ranges. The sliding window this
    * replaces rendered every remaining row to keep a few: 180 s of JSON
    * conversion for an 8.6 M-row result.
    */
  private[web] def tailRows(
      document: VirtualDocument[Tuple],
      start: Int,
      total: Int,
      budget: Int,
      render: (Tuple, Int) => (ObjectNode, Int)
  ): List[ObjectNode] = {
    var kept = List.empty[ObjectNode]
    var size = 0
    var until = total
    var chunk = 64
    var full = false
    while (!full && until > start) {
      val from = math.max(start, until - chunk)
      val rows = document.getRange(from, until).toVector
      var i = rows.length - 1
      while (!full && i >= 0) {
        val (row, rowSize) = render(rows(i), from + i)
        if (kept.nonEmpty && size + rowSize > budget) full = true
        else {
          kept = row :: kept
          size += rowSize
        }
        i -= 1
      }
      until = from
      chunk *= 2
    }
    kept
  }

  private def estimateTupleSize(
      tuple: ObjectNode,
      mapper: ObjectMapper
  ): Int = {
    mapper.writeValueAsString(tuple).length + 1 // +1 for the array separator
  }

  /**
    * Recursively walk a parsed JSON node and replace every textual leaf whose
    * raw length exceeds `maxChars` with a symmetric-truncated copy. Numeric,
    * boolean, and null leaves are passed through; arrays and objects are
    * rebuilt with truncated children. Used to bound the size of per-column
    * stat blobs before they leave the engine — the `top_10[i].value` slot is
    * the dominant offender for high-cardinality string columns.
    */
  private def truncateStringsInJsonValue(
      node: com.fasterxml.jackson.databind.JsonNode,
      maxChars: Int
  ): com.fasterxml.jackson.databind.JsonNode = {
    import com.fasterxml.jackson.databind.node.{ArrayNode, ObjectNode, TextNode}

    if (node == null || node.isNull) {
      node
    } else if (node.isTextual) {
      val text = node.asText()
      if (text.length > maxChars) new TextNode(symmetricTruncateCellValue(text, maxChars)) else node
    } else if (node.isArray) {
      val arr = node.asInstanceOf[ArrayNode]
      val out = arr.arrayNode()
      val it = arr.elements()
      while (it.hasNext) out.add(truncateStringsInJsonValue(it.next(), maxChars))
      out
    } else if (node.isObject) {
      val obj = node.asInstanceOf[ObjectNode]
      val out = obj.objectNode()
      val it = obj.fields()
      while (it.hasNext) {
        val e = it.next()
        out.set(e.getKey, truncateStringsInJsonValue(e.getValue, maxChars))
      }
      out
    } else {
      node
    }
  }

  /**
    * Per-column stat blobs are currently a `String → "(type): k=v, …"`
    * pre-formatted display line per column (the renderer just wraps each
    * with `- "col" ` under a `Column stats:` block). For backward compat
    * with older callers that still ship JSON-typed values, we first try
    * parsing as a JSON object/array and walk it to truncate oversized
    * string leaves; if that doesn't apply (the typical new path), we fall
    * back to symmetric string truncation against the same per-cell budget.
    */
  private def truncateColumnStatsValues(
      stats: Map[String, String],
      maxCellChars: Int
  ): Map[String, String] = {
    val mapper = new ObjectMapper()
    stats.map {
      case (col, raw) =>
        val truncated =
          try {
            val node = mapper.readTree(raw)
            if (node != null && (node.isObject || node.isArray)) {
              mapper.writeValueAsString(truncateStringsInJsonValue(node, maxCellChars))
            } else {
              // Bare JSON scalar (string/number/bool/null) — not a structured
              // stat blob; treat as plain text and symmetric-truncate.
              symmetricTruncateCellValue(raw, maxCellChars)
            }
          } catch {
            case _: Exception => symmetricTruncateCellValue(raw, maxCellChars)
          }
        col -> truncated
    }
  }

  private def symmetricTruncateCellValue(text: String, maxChars: Int): String = {
    if (text.length <= maxChars) {
      text
    } else {
      val notice = "...[truncated]..."
      val availableChars = maxChars - notice.length
      if (availableChars <= 0) {
        text.substring(0, maxChars)
      } else {
        val halfChars = availableChars / 2
        text.substring(0, halfChars) + notice + text.substring(text.length - halfChars)
      }
    }
  }

  private[web] def isVisualizationTuple(
      tuple: Tuple,
      structuredResults: Boolean = false
  ): Boolean = {
    if (structuredResults) return false
    try {
      val schema = tuple.getSchema
      val fieldNames = schema.getAttributes.map(_.getName)
      fieldNames.exists(name => name == "html-content" || name == "json-content")
    } catch {
      case _: Exception => false
    }
  }

  /**
    * Union two console-log sources, deduplicating across them. DB messages are kept
    * verbatim (full fidelity) and take precedence; in-memory messages are appended
    * only when not already present. Dedup keys on msgType + the first 80 chars of the
    * body so an in-memory message (whose title is truncated to the display length)
    * still matches its full-text DB counterpart instead of being added twice.
    */
  private def mergeConsoleLogs(
      db: Option[List[ConsoleMessageInfo]],
      mem: Option[List[ConsoleMessageInfo]]
  ): Option[List[ConsoleMessageInfo]] = {
    val dbList = db.getOrElse(List.empty)
    val memList = mem.getOrElse(List.empty)
    if (dbList.isEmpty && memList.isEmpty) {
      None
    } else {
      def key(m: ConsoleMessageInfo): String = {
        val body = if (m.title.nonEmpty) m.title else m.message
        m.msgType + "|" + body.take(80)
      }
      val merged = mutable.LinkedHashMap[String, ConsoleMessageInfo]()
      dbList.foreach(m => merged.getOrElseUpdate(key(m), m))
      memList.foreach(m => merged.getOrElseUpdate(key(m), m))
      Some(merged.values.toList)
    }
  }

  private def collectConsoleLogs(
      executionId: ExecutionIdentity,
      opId: String
  ): Option[List[ConsoleMessageInfo]] = {
    try {
      val uriOption = getConsoleMessageUri(executionId, OperatorIdentity(opId))

      uriOption.flatMap { uri =>
        val document = DocumentFactory
          .openDocument(uri)
          ._1
          .asInstanceOf[VirtualDocument[Tuple]]

        val messages = document.get().toList.flatMap { tuple =>
          try {
            val protoString = tuple.getField[String](0)
            val msg = ConsoleMessage.fromAscii(protoString)
            Some(
              ConsoleMessageInfo(
                msgType = msg.msgType.name,
                title = msg.title,
                message = msg.message
              )
            )
          } catch {
            case _: Exception => None
          }
        }

        if (messages.nonEmpty) Some(messages) else None
      }
    } catch {
      case _: Exception => None
    }
  }

  private def getConsoleMessageUri(
      eid: ExecutionIdentity,
      opId: OperatorIdentity
  ): Option[URI] = {
    val context = SqlServer.getInstance().createDSLContext()
    Option(
      context
        .select(OPERATOR_EXECUTIONS.CONSOLE_MESSAGES_URI)
        .from(OPERATOR_EXECUTIONS)
        .where(OPERATOR_EXECUTIONS.WORKFLOW_EXECUTION_ID.eq(eid.id.toInt))
        .and(OPERATOR_EXECUTIONS.OPERATOR_ID.eq(opId.id))
        .fetchOneInto(classOf[String])
    ).filter(uri => uri != null && uri.nonEmpty)
      .map(s => URI.create(s))
  }

  private def isTerminalState(state: WorkflowAggregatedState): Boolean = {
    state match {
      case COMPLETED | FAILED | KILLED | TERMINATED => true
      case _                                        => false
    }
  }

  private def hasConsoleError(consoleState: ExecutionConsoleStore): Boolean = {
    consoleState.operatorConsole.values.exists { opConsole =>
      opConsole.consoleMessages.exists(_.msgType == ConsoleMessageType.ERROR)
    }
  }

  private def stateToString(state: WorkflowAggregatedState): String = {
    state match {
      case UNINITIALIZED => "Uninitialized"
      case READY         => "Ready"
      case RUNNING       => "Running"
      case PAUSING       => "Pausing"
      case PAUSED        => "Paused"
      case RESUMING      => "Resuming"
      case COMPLETED     => "Completed"
      // Cached-region operators are short-circuited by the scheduler; their result
      // is replayed from the operator-port cache. Surface that as a completed
      // state (with provenance) instead of falling through to "Unknown".
      case COMPLETED_FROM_CACHE => "CompletedFromCache"
      case FAILED               => "Failed"
      case KILLED               => "Killed"
      case TERMINATED           => "Terminated"
      case _                    => "Unknown"
    }
  }

  private def computeSubDAGIfNeeded(
      logicalPlan: LogicalPlanPojo,
      targetOperatorIds: List[String]
  ): LogicalPlanPojo = {
    if (targetOperatorIds.length != 1) {
      return logicalPlan
    }

    val targetOpId = targetOperatorIds.head
    val operatorMap: Map[String, LogicalOp] =
      logicalPlan.operators.map(op => op.operatorIdentifier.id -> op).toMap

    if (!operatorMap.contains(targetOpId)) {
      logger.warn(s"Target operator $targetOpId not found in logical plan, using full DAG")
      return logicalPlan
    }

    val incomingLinks: Map[String, List[LogicalLink]] =
      logicalPlan.links.groupBy(_.toOpId.id)

    val visited = mutable.Set[String]()
    val subDagOperators = mutable.ListBuffer[LogicalOp]()
    val subDagLinks = mutable.ListBuffer[LogicalLink]()

    def dfs(currentOpId: String): Unit = {
      if (visited.contains(currentOpId)) return
      visited.add(currentOpId)

      operatorMap.get(currentOpId).foreach { op =>
        subDagOperators += op
        incomingLinks.getOrElse(currentOpId, List.empty).foreach { link =>
          subDagLinks += link
          dfs(link.fromOpId.id)
        }
      }
    }

    dfs(targetOpId)

    LogicalPlanPojo(
      operators = subDagOperators.toList,
      links = subDagLinks.toList,
      opsToViewResult = targetOperatorIds.filter(id => visited.contains(id)),
      opsToReuseResult = logicalPlan.opsToReuseResult.filter(id => visited.contains(id))
    )
  }

  // Returns operator-id -> error message; empty map means compilation succeeded.
  private def validateWorkflow(
      workflowId: Long,
      logicalPlan: LogicalPlanPojo
  ): Map[String, String] = {
    try {
      val tempContext = new WorkflowContext(WorkflowIdentity(workflowId))
      val compiler = new WorkflowCompiler(tempContext)
      compiler.compile(logicalPlan, CompilationErrorHandling.Strict)
      Map.empty
    } catch {
      case e: Exception =>
        val errorMsg = Option(e.getMessage).getOrElse("Compilation failed")
        val operatorIdPattern = """operator[- ]?(\S+)""".r
        val operatorId = operatorIdPattern
          .findFirstMatchIn(errorMsg.toLowerCase)
          .map(_.group(1))
          .getOrElse("workflow")
        Map(operatorId -> errorMsg)
    }
  }

  @GET
  @Path("/health")
  def healthCheck: Map[String, String] = Map("status" -> "ok")
}
