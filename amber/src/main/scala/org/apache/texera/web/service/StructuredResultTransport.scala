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

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import org.apache.texera.amber.core.tuple.{AttributeType, Schema}
import org.apache.texera.web.model.websocket.event.CachedPortUsage

import java.nio.charset.StandardCharsets.UTF_8
import scala.collection.mutable
import scala.util.Try

case class ResultField(name: String, `type`: String, encoding: String)
case class ResultMaterialization(
    outputPort: Int,
    executionId: Option[String],
    cached: Boolean,
    subdagHash: Option[String]
)
case class PartitionedStatistics(
    columnStats: Map[String, String],
    metadata: Map[String, String],
    omissions: List[String]
)

/** Reserved worker envelopes are not display strings. In particular, never
  * shorten their revisions, decimal integers or values with the cell budget.
  * Full semantic validation/partition merging belongs to the consuming agent.
  */
object StructuredResultTransport {
  val capabilities: List[String] =
    List("table-profile-v1", "typed-scalar-v1", "input-materialization-v1", "schema-fields-only-v1")
  private val profileKey = "__texera_profile_v1__:[0-9a-f]{32}".r
  private val mapper = new ObjectMapper()

  /** V2 rows contain only schema-declared user fields. Legacy clients still
    * receive their synthetic index, but it cannot overwrite a V2 user column.
    */
  def annotateSampleRow(row: ObjectNode, index: Int, structuredResults: Boolean): Unit = {
    if (!structuredResults) row.put("__row_index__", index)
  }

  /** Input identities must not depend on which table bodies were requested.
    * Completed fresh outputs use this execution; cache hits retain their origin.
    * Never assign a fresh producer to a skipped/failed/unknown-cache operator.
    */
  def inputMaterializations(
      operatorIds: Iterable[String],
      completed: Set[String],
      completedFromCache: Set[String],
      retrievalExecutionId: String,
      cachedOutputs: List[CachedPortUsage]
  ): Map[String, ResultMaterialization] = {
    val cachedIds = cachedOutputs.filter(c => c.portId == 0 && !c.internal).map(_.logicalOpId).toSet
    operatorIds.flatMap { id =>
      if (cachedIds.contains(id) || completed.contains(id))
        Some(id -> materialization(id, retrievalExecutionId, cachedOutputs))
      else if (completedFromCache.contains(id))
        Some(id -> ResultMaterialization(0, None, true, None))
      else None
    }.toMap
  }

  /** A cache hit was materialized by its source execution, not this retrieval.
    * Unknown or ambiguous cache provenance stays unknown. Never expose URIs.
    */
  def materialization(
      operatorId: String,
      retrievalExecutionId: String,
      cachedOutputs: List[CachedPortUsage]
  ): ResultMaterialization = {
    val cached =
      cachedOutputs.filter(c => c.logicalOpId == operatorId && c.portId == 0 && !c.internal)
    cached match {
      case Nil => ResultMaterialization(0, Some(retrievalExecutionId), false, None)
      case entry :: Nil =>
        ResultMaterialization(
          0,
          entry.sourceExecutionId.map(_.toString),
          true,
          Some(entry.subdagHash)
        )
      case _ => ResultMaterialization(0, None, true, None)
    }
  }

  def partitionStatistics(
      statistics: Map[String, String],
      maxBytes: Int = 262144,
      maxWorkers: Int = 64
  ): PartitionedStatistics = {
    val columns = mutable.Map[String, String]()
    val metadata = mutable.Map[String, String]()
    val omissions = mutable.Set[String]()
    var used = 0
    statistics.toSeq.sortBy(_._1).foreach {
      case (key, payload) =>
        if (!profileKey.matches(key)) columns(key) = payload
        else if (payload.length > 65536 || payload.getBytes(UTF_8).length > 65536) {
          omissions += "metadata_payload_budget"
        } else {
          val isEnvelope = Try {
            val parsed = mapper.readTree(payload)
            parsed != null && parsed.isObject &&
            parsed.path("protocol").asText() == "texera.table-profile" &&
            parsed.path("version").isIntegralNumber && parsed.path("version").asInt() == 1
          }.getOrElse(false)
          if (!isEnvelope) columns(key) = payload
          else if (metadata.size >= maxWorkers) omissions += "metadata_worker_budget"
          else if (used + payload.getBytes(UTF_8).length > maxBytes) {
            omissions += "metadata_payload_budget"
          } else {
            metadata(key) = payload
            used += payload.getBytes(UTF_8).length
          }
        }
    }
    PartitionedStatistics(columns.toMap, metadata.toMap, omissions.toList.sorted)
  }

  def schemaFields(schema: Schema): List[ResultField] =
    schema.getAttributes.map { attribute =>
      val (kind, encoding) = attribute.getType match {
        case AttributeType.LONG      => ("int64", "number-or-decimal-string")
        case AttributeType.INTEGER   => ("int64", "number")
        case AttributeType.DOUBLE    => ("float64", "number")
        case AttributeType.BOOLEAN   => ("bool", "boolean")
        case AttributeType.STRING    => ("str", "string")
        case AttributeType.TIMESTAMP => ("datetime", "iso8601-utc")
        case _                       => ("unsupported", "display")
      }
      ResultField(attribute.getName, kind, encoding)
    }.toList
}
