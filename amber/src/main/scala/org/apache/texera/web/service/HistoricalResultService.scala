/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
package org.apache.texera.web.service

import com.fasterxml.jackson.databind.node.ObjectNode
import com.fasterxml.jackson.databind.annotation.JsonDeserialize
import org.apache.texera.amber.core.storage.{DocumentFactory, VFSResourceType, VFSURIFactory}
import org.apache.texera.amber.core.storage.model.VirtualDocument
import org.apache.texera.amber.core.tuple.Tuple
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, OperatorIdentity, PhysicalOpIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.{CachedOutput, GlobalPortIdentity, PhysicalPlan, PortIdentity, SavedOutputReference}
import org.apache.texera.amber.core.workflow.cache.FingerprintUtil
import org.apache.texera.amber.util.serde.GlobalPortIdentitySerde
import org.apache.texera.amber.util.serde.GlobalPortIdentitySerde.SerdeOps
import org.apache.texera.dao.SqlServer
import org.apache.texera.web.dao.OperatorPortCacheDao
import org.apache.texera.web.resource.dashboard.user.workflow.WorkflowExecutionsResource

import java.net.URI
import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest
import scala.collection.mutable

case class SavedResultReadRequest(reference: SavedOutputReference, offset: Int = 0,
    pageSize: Int = 500, columns: Option[List[String]] = None,
    materializationId: Option[String] = None,
    @JsonDeserialize(contentAs = classOf[java.lang.Long]) expectedRows: Option[Long] = None)
case class SavedResultPage(materializationId: String, totalRows: Long, schema: List[ResultField],
    rows: List[ObjectNode], nextOffset: Int, complete: Boolean)
case class RetainResultsRequest(references: List[SavedOutputReference])

/** Historical reads resolve the original producer and never execute a plan.
  * An evicted or mismatched producer fails, rather than returning latest state. */
object HistoricalResultService {
  val savedLayer = "saved-version"
  private def digest(text: String): String = MessageDigest.getInstance("SHA-256")
    .digest(text.getBytes(UTF_8)).map(b => f"${b & 0xff}%02x").mkString

  def validateSource(workflow: WorkflowIdentity, reference: SavedOutputReference, uri: URI): URI = {
    require(reference.executionId.matches("[1-9][0-9]*") && reference.outputPort >= 0,
      "Invalid historical producer identity")
    val decoded = VFSURIFactory.decodeURI(uri)
    require(decoded.workflowId == workflow && decoded.executionId.id.toString == reference.executionId &&
      decoded.resourceType == VFSResourceType.RESULT && decoded.globalPortId.exists(port =>
        !port.portId.internal && !port.input && port.opId.logicalOpId.id == reference.operatorId &&
          port.portId.id == reference.outputPort), "Historical producer does not match the saved result")
    uri
  }

  def resolve(workflow: WorkflowIdentity, reference: SavedOutputReference): URI = {
    require(reference.executionId.matches("[1-9][0-9]*"), "Invalid historical execution identity")
    val uri = WorkflowExecutionsResource.getResultUriByLogicalPortId(
      ExecutionIdentity(reference.executionId.toLong), OperatorIdentity(reference.operatorId),
      PortIdentity(reference.outputPort)).getOrElse(
      throw new IllegalArgumentException("HISTORICAL_RESULT_UNAVAILABLE: exact materialization was not retained"))
    validateSource(workflow, reference, uri)
  }

  def unreferenced(uris: Seq[URI], retained: Set[URI]): Seq[URI] = uris.distinct.filterNot(retained)

  /** A cached alias keeps the producer URI. Match the registered destination
    * port, since decoding that URI yields the original operator's name. */
  def registeredResult(entries: Seq[(String, URI)], operator: OperatorIdentity,
      port: PortIdentity): Option[URI] = entries.collectFirst {
    case (serialized, uri) if {
      val registered = GlobalPortIdentitySerde.deserializeFromString(serialized)
      !registered.input && !registered.portId.internal &&
        registered.opId.logicalOpId == operator && registered.portId == port &&
        VFSURIFactory.decodeURI(uri).resourceType == VFSResourceType.RESULT
    } => uri
  }

  /** Keep a separate immutable alias, so edit-time eviction of a current port
    * cannot discard a task snapshot. Identical versions share the same table. */
  def retain(workflow: WorkflowIdentity, references: List[SavedOutputReference]): Int = {
    val dao = new OperatorPortCacheDao(SqlServer.getInstance())
    val sources = references.distinct.map { reference =>
      val uri = resolve(workflow, reference)
      dao.listBySourceExecutionIds(Seq(reference.executionId.toLong)).find(record =>
        record.workflowId == workflow.id && record.resultUri == uri).getOrElse(
        throw new IllegalArgumentException("HISTORICAL_RESULT_UNAVAILABLE: completed output is not cached"))
    }
    sources.foreach { source =>
      val hash = digest(source.resultUri.toString)
      val original = VFSURIFactory.decodeURI(source.resultUri).globalPortId.get
      val retainedPort = original.copy(opId = PhysicalOpIdentity(OperatorIdentity(s"_retained_${hash.take(20)}"), savedLayer))
      dao.upsert(source.copy(globalPortId = retainedPort.serializeAsString, subdagHash = hash))
    }
    sources.size
  }

  def bindings(workflow: WorkflowIdentity, plan: PhysicalPlan,
      references: Map[String, SavedOutputReference]): Map[GlobalPortIdentity, CachedOutput] = {
    references.map { case (targetId, reference) =>
      val candidates = plan.operators.filter(_.id.logicalOpId.id == targetId)
        .flatMap(op => op.outputPorts.keys.filter(p => !p.internal && p.id == 0).map(p => GlobalPortIdentity(op.id, p)))
      require(candidates.size == 1, s"Saved result target $targetId must have one external output")
      val target = candidates.head
      require(plan.getUpstreamPhysicalLinks(target.opId).isEmpty, "Saved result handles cannot have current inputs")
      val uri = resolve(workflow, reference)
      val (document, schema) = DocumentFactory.openDocument(uri)
      require(schema.nonEmpty, "HISTORICAL_RESULT_UNAVAILABLE: saved table is no longer readable")
      val fingerprint = FingerprintUtil.computeSubdagFingerprint(plan, target)
      target -> CachedOutput(uri, fingerprint.fingerprintJson, Some(document.getCount),
        Some(ExecutionIdentity(reference.executionId.toLong)), Map.empty)
    }
  }

  def read(workflow: WorkflowIdentity, request: SavedResultReadRequest): SavedResultPage = {
    require(request.offset >= 0 && request.pageSize > 0 && request.pageSize <= 500, "Invalid result page bounds")
    val uri = resolve(workflow, request.reference)
    val (document, schemaOption) = DocumentFactory.openDocument(uri)
    val schema = schemaOption.getOrElse(throw new IllegalArgumentException("HISTORICAL_RESULT_UNAVAILABLE: saved schema is unavailable"))
    val total = document.getCount
    require(request.expectedRows.forall(_ == total), "HISTORICAL_RESULT_UNAVAILABLE: saved table row count changed")
    val identity = digest(s"$uri|$total|$schema")
    require(request.materializationId.forall(_ == identity), "HISTORICAL_RESULT_UNAVAILABLE: result page changed materialization")
    request.columns.foreach(cols => require(cols.nonEmpty && cols.distinct.size == cols.size &&
      cols.forall(schema.getAttributeNames.contains), "Result projection contains an unknown or duplicate column"))
    require(request.offset <= total && total <= Int.MaxValue, "Invalid result offset or oversized table")
    val iterator = document.asInstanceOf[VirtualDocument[Tuple]]
      .getRange(request.offset, math.min(total, request.offset.toLong + request.pageSize).toInt, request.columns)
    val rows = mutable.ListBuffer.empty[ObjectNode]
    var bytes = 0
    var bounded = false
    while (iterator.hasNext && !bounded) {
      val row = ExecutionResultService.convertTuplesToJson(List(iterator.next()), structuredResults = true).head
      val size = row.toString.getBytes(UTF_8).length
      require(size <= 1048576, "A result row exceeds the page budget; project fewer columns")
      if (bytes + size > 1048576) bounded = true
      else { rows += row; bytes += size }
    }
    val next = request.offset + rows.size
    SavedResultPage(identity, total, StructuredResultTransport.schemaFields(schema), rows.toList, next, next >= total)
  }
}
