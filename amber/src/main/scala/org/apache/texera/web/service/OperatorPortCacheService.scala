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

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.scala.DefaultScalaModule
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.cache.FingerprintUtil
import org.apache.texera.amber.core.workflow.{CachedOutput, GlobalPortIdentity, PhysicalPlan}
import org.apache.texera.amber.util.serde.GlobalPortIdentitySerde
import org.apache.texera.amber.util.serde.GlobalPortIdentitySerde.SerdeOps
import org.apache.texera.dao.SqlServer
import org.apache.texera.dao.jooq.generated.Tables.{OPERATOR_PORT_CACHE, OPERATOR_PORT_EXECUTIONS}
import org.apache.texera.web.dao.{OperatorPortCacheDao, OperatorPortCacheRecord}
import org.apache.texera.amber.core.storage.DocumentFactory

import java.net.URI
import scala.jdk.CollectionConverters._
import scala.util.Try

private object OperatorPortCacheJson {
  val mapper: ObjectMapper = new ObjectMapper().registerModule(DefaultScalaModule)
}

/**
  * Service for operator port result caching.
  * Provides high-level cache operations with business logic for workflow execution.
  *
  * Key responsibilities:
  * - Batch lookup of cached outputs at workflow submission time
  * - Cache entry creation when output ports complete
  * - Fingerprint computation and serialization
  * - Cache invalidation and lifecycle management
  * - Manual eviction by logical operator and compile-time mismatch cleanup
  *
  * @param dao OperatorPortCacheDao for database access
  */
class OperatorPortCacheService(dao: OperatorPortCacheDao) {
  private val context = SqlServer.getInstance().createDSLContext()

  /**
    * Result of cache invalidation by source executions.
    *
    * @param deletedRows number of rows removed from operator_port_cache
    * @param deletedResultUris cached result URIs deleted/cleared during invalidation
    */
  case class SourceExecutionInvalidationResult(
      deletedRows: Int,
      deletedResultUris: Set[URI]
  )

  /**
    * Lookup cached outputs for all materializable ports in the physical plan.
    * Called at workflow submission time by WorkflowExecutionService.
    *
    * For each output port in the plan:
    * 1. Compute fingerprint of upstream subDAG
    * 2. Query cache by (workflow_id, port_id, fingerprint_hash)
    * 3. Collect all cache hits
    *
    * @param workflowId Workflow ID to lookup cache for
    * @param physicalPlan Physical plan containing operators and ports
    * @return Map from GlobalPortIdentity to CachedOutput for all cache hits
    */
  def lookupCachedOutputs(
      workflowId: WorkflowIdentity,
      physicalPlan: PhysicalPlan
  ): Map[GlobalPortIdentity, CachedOutput] = {
    physicalPlan.operators
      .flatMap(op => op.outputPorts.keys.map(pid => GlobalPortIdentity(op.id, pid)))
      .flatMap { gpid =>
        val fingerprint = FingerprintUtil.computeSubdagFingerprint(physicalPlan, gpid)
        dao.get(workflowId.id, gpid.serializeAsString, fingerprint.subdagHash).map { record =>
          gpid -> CachedOutput(
            resultUri = record.resultUri,
            fingerprintJson = record.fingerprintJson,
            tupleCount = record.tupleCount,
            sourceExecutionId = record.sourceExecutionId.map(ExecutionIdentity(_)),
            resultStatistics = decodeResultStatistics(record.resultStatisticsJson)
          )
        }
      }
      .toMap
  }

  /**
    * Decode the per-column result statistics blob persisted in the cache. Returns
    * an empty map if the blob is missing, empty, or malformed (cache hits should
    * survive stats corruption — the column profiler is best-effort metadata).
    */
  private def decodeResultStatistics(raw: Option[String]): Map[String, String] = {
    raw.filter(_.nonEmpty) match {
      case None => Map.empty
      case Some(json) =>
        Try {
          OperatorPortCacheJson.mapper
            .readValue(json, classOf[java.util.Map[String, String]])
            .asScala
            .toMap
        }.getOrElse(Map.empty)
    }
  }

  /**
    * Upsert cache entry when an output port completes.
    * Called by PortCompletedHandler at runtime when a materialized output is produced.
    *
    * Steps:
    * 1. Compute fingerprint of upstream subDAG
    * 2. Upsert to operator_port_cache table with fingerprint, URI, metadata
    *
    * @param workflowId Workflow ID
    * @param executionId Execution ID that produced this output
    * @param portId GlobalPortIdentity of the completed port
    * @param physicalPlan Physical plan (needed for fingerprint computation)
    * @param resultUri URI where the materialized output is stored
    * @param tupleCount Number of tuples in the output (optional, best-effort)
    */
  def upsertCachedOutput(
      workflowId: WorkflowIdentity,
      executionId: ExecutionIdentity,
      portId: GlobalPortIdentity,
      physicalPlan: PhysicalPlan,
      resultUri: URI,
      tupleCount: Option[Long],
      resultStatistics: Map[String, String]
  ): Unit = {
    val fingerprint = FingerprintUtil.computeSubdagFingerprint(physicalPlan, portId)

    val statsJson =
      if (resultStatistics.isEmpty) None
      else Some(OperatorPortCacheJson.mapper.writeValueAsString(resultStatistics))

    dao.upsert(
      OperatorPortCacheRecord(
        workflowId = workflowId.id,
        globalPortId = portId.serializeAsString,
        subdagHash = fingerprint.subdagHash,
        fingerprintJson = fingerprint.fingerprintJson,
        resultUri = resultUri,
        tupleCount = tupleCount,
        sourceExecutionId = Some(executionId.id),
        resultStatisticsJson = statsJson
      )
    )
  }

  /**
    * Invalidate all cache entries for a workflow and remove associated result artifacts.
    * This is used for manual cache clearing, workflow deletion, and testing.
    *
    * Steps:
    * 1. Collect cached result URIs
    * 2. Remove operator_port_executions rows referencing those URIs
    * 3. Delete cache entries
    * 4. Clear stored result documents (best-effort)
    *
    * @param workflowId Workflow ID whose cache entries should be deleted
    */
  def invalidateWorkflowCache(workflowId: WorkflowIdentity): Unit = {
    val cacheEntries = dao.listByWorkflow(workflowId.id, Int.MaxValue, 0)
    deleteCacheEntriesByPorts(workflowId, cacheEntries)
  }

  /**
    * Invalidate cache entries produced by the specified executions.
    *
    * This removes cache metadata as well as cache-linked storage artifacts:
    * - operator_port_executions rows referencing cached URIs
    * - cached result documents
    *
    * @param executionIds Execution IDs whose produced cache entries should be deleted
    * @return Number of cache rows deleted
    */
  def invalidateCacheBySourceExecutions(executionIds: Seq[ExecutionIdentity]): Int = {
    invalidateCacheBySourceExecutionsWithArtifacts(executionIds).deletedRows
  }

  /**
    * Invalidate cache entries produced by the specified executions and return deleted URI artifacts.
    *
    * This helper is used by lifecycle cleanup to avoid re-clearing cached documents.
    *
    * @param executionIds Execution IDs whose produced cache entries should be deleted
    * @return deleted rows and deleted result URIs
    */
  def invalidateCacheBySourceExecutionsWithArtifacts(
      executionIds: Seq[ExecutionIdentity]
  ): SourceExecutionInvalidationResult = {
    val sourceExecutionIds = executionIds.map(_.id)
    val cacheEntries = dao.listBySourceExecutionIds(sourceExecutionIds)
    if (cacheEntries.isEmpty) {
      return SourceExecutionInvalidationResult(0, Set.empty)
    }
    val resultUris = cacheEntries.map(_.resultUri).distinct
    val deleted = dao.deleteBySourceExecutionIds(sourceExecutionIds)
    val released = HistoricalResultService.unreferenced(resultUris, lookupResultUrisInCache(resultUris))
    deleteOperatorPortResultsByUris(released)
    clearCachedResultDocuments(released)
    SourceExecutionInvalidationResult(deleted, released.toSet)
  }

  /**
    * Invalidate cache entries for outputs owned by the provided logical operators.
    * This is used by editor actions that evict cache for selected operators.
    *
    * @param workflowId Workflow ID whose cache entries should be deleted
    * @param logicalOpIds Logical operator IDs whose output caches should be removed
    * @return Number of cache entries invalidated
    */
  def invalidateCacheForLogicalOperators(
      workflowId: WorkflowIdentity,
      logicalOpIds: Seq[String]
  ): Int = {
    val normalizedIds = logicalOpIds.map(_.trim).filter(_.nonEmpty).toSet
    if (normalizedIds.isEmpty) {
      return 0
    }
    val cacheEntries = dao.listByWorkflow(workflowId.id, Int.MaxValue, 0)
    val entriesToDelete = cacheEntries.filter { entry =>
      val logicalOpIdOpt =
        Try(GlobalPortIdentitySerde.deserializeFromString(entry.globalPortId))
          .toOption
          .map(_.opId.logicalOpId.id)
      logicalOpIdOpt.exists(normalizedIds.contains)
    }
    deleteCacheEntriesByPorts(workflowId, entriesToDelete)
    entriesToDelete.size
  }

  /**
    * Invalidate cache entries whose fingerprints no longer match the current plan.
    * This supports compile-time invalidation after workflow edits.
    *
    * @param workflowId Workflow ID whose cache entries should be checked
    * @param physicalPlan Latest compiled physical plan
    * @return Number of cache entries invalidated
    */
  def invalidateMismatchedCacheEntries(
      workflowId: WorkflowIdentity,
      physicalPlan: PhysicalPlan
  ): Int = {
    val cacheEntries = dao.listByWorkflow(workflowId.id, Int.MaxValue, 0)
    val entriesToDelete = cacheEntries.filter { entry =>
      val retained = Try(GlobalPortIdentitySerde.deserializeFromString(entry.globalPortId))
        .toOption.exists(_.opId.layerName == HistoricalResultService.savedLayer)
      val fingerprintHashOpt = Try {
        val portId = GlobalPortIdentitySerde.deserializeFromString(entry.globalPortId)
        FingerprintUtil.computeSubdagFingerprint(physicalPlan, portId).subdagHash
      }.toOption
      !retained && fingerprintHashOpt.forall(_ != entry.subdagHash)
    }
    deleteCacheEntriesByKeys(workflowId, entriesToDelete)
    entriesToDelete.size
  }

  /**
    * Returns the subset of the given URIs that are still referenced by `operator_port_cache`.
    * Used by execution cleanup to avoid clearing Iceberg tables that another execution still
    * needs via a cache hit (cached URIs point to a different execution's storage).
    */
  def lookupResultUrisInCache(uris: Seq[URI]): Set[URI] = {
    if (uris.isEmpty) {
      return Set.empty
    }
    val uriStrings = uris.map(_.toString).distinct.asJava
    context
      .select(OPERATOR_PORT_CACHE.RESULT_URI)
      .from(OPERATOR_PORT_CACHE)
      .where(OPERATOR_PORT_CACHE.RESULT_URI.in(uriStrings))
      .fetchInto(classOf[String])
      .asScala
      .map(URI.create)
      .toSet
  }

  /**
    * Deletes operator_port_executions rows that reference the provided result URIs.
    */
  private def deleteOperatorPortResultsByUris(resultUris: Seq[URI]): Unit = {
    if (resultUris.isEmpty) {
      return
    }
    val uriStrings = resultUris.map(_.toString).distinct.asJava
    context
      .deleteFrom(OPERATOR_PORT_EXECUTIONS)
      .where(OPERATOR_PORT_EXECUTIONS.RESULT_URI.in(uriStrings))
      .execute()
  }

  /**
    * Best-effort deletion of stored result documents referenced by cache entries.
    */
  private def clearCachedResultDocuments(resultUris: Seq[URI]): Unit = {
    resultUris.foreach { uri =>
      try {
        DocumentFactory.openDocument(uri)._1.clear()
      } catch {
        case _: Throwable =>
        // Document already deleted or unavailable - safe to ignore.
      }
    }
  }

  /**
    * Deletes cache entries by port ID, and removes associated result artifacts.
    */
  private def deleteCacheEntriesByPorts(
      workflowId: WorkflowIdentity,
      entries: Seq[OperatorPortCacheRecord]
  ): Unit = {
    if (entries.isEmpty) {
      return
    }
    val resultUris = entries.map(_.resultUri).distinct
    dao.deleteByGlobalPortIds(workflowId.id, entries.map(_.globalPortId).distinct)
    val released = HistoricalResultService.unreferenced(resultUris, lookupResultUrisInCache(resultUris))
    deleteOperatorPortResultsByUris(released)
    clearCachedResultDocuments(released)
  }

  /**
    * Deletes cache entries by (port ID, subDAG hash) pair, and removes associated result artifacts.
    */
  private def deleteCacheEntriesByKeys(
      workflowId: WorkflowIdentity,
      entries: Seq[OperatorPortCacheRecord]
  ): Unit = {
    if (entries.isEmpty) {
      return
    }
    val resultUris = entries.map(_.resultUri).distinct
    dao.deleteByGlobalPortAndHashes(
      workflowId.id,
      entries.map(entry => (entry.globalPortId, entry.subdagHash))
    )
    val released = HistoricalResultService.unreferenced(resultUris, lookupResultUrisInCache(resultUris))
    deleteOperatorPortResultsByUris(released)
    clearCachedResultDocuments(released)
  }

  /**
    * Future: Cost-aware eviction when storage quota is exceeded.
    * Phase 3: Lifecycle management research.
    *
    * Proposed approach:
    * - Calculate recompute_cost / storage_cost ratio for each cache entry
    * - Evict entries with lowest ratio first
    * - Use runtime_statistics table for cost estimation
    *
    * @param quotaBytes Storage quota in bytes
    */
  def evictLowValueEntries(quotaBytes: Long): Unit = {
    throw new UnsupportedOperationException(
      "Cost-aware eviction not yet implemented (Phase 3: Lifecycle management)"
    )
  }
}
