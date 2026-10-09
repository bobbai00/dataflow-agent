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

import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema, Tuple}
import org.apache.texera.web.resource.SyncExecutionResource
import org.apache.texera.web.model.websocket.event.CachedPortUsage
import com.fasterxml.jackson.databind.ObjectMapper
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class StructuredResultTransportSpec extends AnyFlatSpec with Matchers {
  "Structured timestamp results" should "preserve stored UTC clock values across server timezones" in {
    val previous = java.util.TimeZone.getDefault
    try {
      for (zone <- List("UTC", "America/Los_Angeles", "Asia/Kolkata")) {
        java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone(zone))
        for (clock <- List("2025-01-01 08:00:00", "2025-07-01 07:00:00.123456789")) {
          // Iceberg stores native timestamps without a timezone and its reader
          // reconstructs them using Timestamp.valueOf(LocalDateTime).
          val stored = java.sql.Timestamp.valueOf(clock)
          val tuple = Tuple
            .builder(Schema(List(new Attribute("when", AttributeType.TIMESTAMP))))
            .add("when", AttributeType.TIMESTAMP, stored)
            .build()
          val result = ExecutionResultService
            .convertTuplesToJson(List(tuple), structuredResults = true)
            .head
            .get("when")
            .asText()
          result shouldBe clock.replace(' ', 'T') + "Z"
        }
      }
    } finally java.util.TimeZone.setDefault(previous)
  }

  "Structured table annotations" should "never overwrite or inject a user column" in {
    StructuredResultTransport.capabilities should contain("schema-fields-only-v1")
    val mapper = new ObjectMapper()
    val row = mapper.createObjectNode().put("__row_index__", "user value")
    StructuredResultTransport.annotateSampleRow(row, 42, structuredResults = true)
    row.get("__row_index__").asText() shouldBe "user value"
    val ordinary = mapper.createObjectNode().put("x", 3)
    StructuredResultTransport.annotateSampleRow(ordinary, 42, structuredResults = true)
    ordinary.has("__row_index__") shouldBe false
    StructuredResultTransport.annotateSampleRow(ordinary, 42, structuredResults = false)
    ordinary.get("__row_index__").asInt() shouldBe 42
  }

  it should "not classify a V2 user table as visualization based on column names" in {
    val tuple = Tuple
      .builder(Schema(List(new Attribute("html-content", AttributeType.STRING))))
      .addSequentially(Array[Any]("<p>user data</p>"))
      .build()
    val resource = new SyncExecutionResource()
    resource.isVisualizationTuple(tuple, structuredResults = true) shouldBe false
    resource.isVisualizationTuple(tuple, structuredResults = false) shouldBe true
  }

  "Input provenance" should "include unrequested cached sources without table content" in {
    val cached = CachedPortUsage("gpid", "source", "main", 0, false, "hash", Some(2L), Some(41L))
    val result = StructuredResultTransport.inputMaterializations(
      List("source", "answer", "unfinished", "unknown_cache"),
      Set("answer"),
      Set("unknown_cache"),
      "42",
      List(cached)
    )
    result("source").executionId shouldBe Some("41")
    result("source").cached shouldBe true
    result("answer").executionId shouldBe Some("42")
    result("answer").cached shouldBe false
    result should not contain key("unfinished")
    result("unknown_cache").executionId shouldBe None
    result("unknown_cache").cached shouldBe true
  }

  private val metadataKey = "__texera_profile_v1__:" + ("a" * 32)
  private val envelope =
    """{"protocol":"texera.table-profile","version":1,"operatorId":"source","operatorRevision":"0123456789abcdef","producerId":"0123456789abcdef0123456789abcdef"}"""

  "Profile transport" should "separate metadata without applying cell display truncation" in {
    val result =
      StructuredResultTransport.partitionStatistics(Map(metadataKey -> envelope, "x" -> "(str): a"))
    result.metadata shouldBe Map(metadataKey -> envelope)
    result.columnStats shouldBe Map("x" -> "(str): a")
    result.omissions shouldBe empty
  }

  it should "leave ordinary column statistics alone even with a similar name" in {
    val stats = Map(metadataKey -> "(str): nonnull=3", "__texera_profile_v1__:user" -> "ordinary")
    val result = StructuredResultTransport.partitionStatistics(stats)
    result.columnStats shouldBe stats
    result.metadata shouldBe empty
  }

  it should "bound metadata independently and never truncate an accepted envelope" in {
    val stats = Map(metadataKey -> envelope, ("__texera_profile_v1__:" + ("b" * 32)) -> envelope)
    val result =
      StructuredResultTransport.partitionStatistics(stats, maxBytes = envelope.length + 1)
    result.metadata shouldBe Map(metadataKey -> envelope)
    result.columnStats shouldBe empty
    result.omissions should contain("metadata_payload_budget")
  }

  it should "omit oversized reserved payloads without parsing or leaking them into column stats" in {
    val result = StructuredResultTransport.partitionStatistics(Map(metadataKey -> ("x" * 65537)))
    result.metadata shouldBe empty
    result.columnStats shouldBe empty
    result.omissions should contain("metadata_payload_budget")
  }

  "Structured scalar results" should "preserve null, literal NULL, booleans and exact int64 values" in {
    val schema = Schema(
      List(
        new Attribute("missing", AttributeType.LONG),
        new Attribute("literal", AttributeType.STRING),
        new Attribute("flag", AttributeType.BOOLEAN),
        new Attribute("large", AttributeType.LONG),
        new Attribute("small", AttributeType.LONG),
        new Attribute("negative", AttributeType.LONG),
        new Attribute("longText", AttributeType.STRING)
      )
    )
    val tuple = Tuple
      .builder(schema)
      .addSequentially(
        Array[Any](
          null,
          "NULL",
          false,
          9007199254740993L,
          7L,
          Long.MinValue,
          "z" * 150
        )
      )
      .build()
    val result =
      ExecutionResultService.convertTuplesToJson(List(tuple), structuredResults = true).head
    result.get("missing").isNull shouldBe true
    result.get("literal").asText() shouldBe "NULL"
    result.get("flag").isBoolean shouldBe true
    result.get("flag").asBoolean() shouldBe false
    result.get("large").isTextual shouldBe true
    result.get("large").asText() shouldBe "9007199254740993"
    result.get("small").isIntegralNumber shouldBe true
    result.get("negative").asText() shouldBe Long.MinValue.toString
    result.get("longText").asText() shouldBe ("z" * 150)
    val legacy = ExecutionResultService.convertTuplesToJson(List(tuple)).head
    legacy.get("missing").asText() shouldBe "NULL"
    legacy.get("large").isIntegralNumber shouldBe true
    legacy.get("longText").asText().length shouldBe 103
  }

  it should "include a typed schema independent of rows or profile collection" in {
    val fields = StructuredResultTransport.schemaFields(
      Schema(
        List(
          new Attribute("id", AttributeType.LONG),
          new Attribute("text", AttributeType.STRING)
        )
      )
    )
    fields.map(_.name) shouldBe List("id", "text")
    fields.map(_.`type`) shouldBe List("int64", "str")
    fields.head.encoding shouldBe "number-or-decimal-string"
  }

  it should "not truncate a numeric encoding with the text-cell display budget" in {
    val mapper = new ObjectMapper()
    val row = mapper.createObjectNode()
    row.put("id", "9007199254740993")
    row.put("text", "ordinary long text")
    val fields = Some(
      List(
        ResultField("id", "int64", "number-or-decimal-string"),
        ResultField("text", "str", "string")
      )
    )
    val result = new SyncExecutionResource().truncateSingleTuple(row, 4, fields)
    result.get("id").asText() shouldBe "9007199254740993"
    result.get("text").asText() should not be "ordinary long text"
  }

  "Materialization provenance" should "keep cached source execution distinct from retrieval" in {
    val cached =
      CachedPortUsage("gpid", "source", "main", 0, false, "fingerprint", Some(3L), Some(41L))
    val result = StructuredResultTransport.materialization("source", "99", List(cached))
    result.executionId shouldBe Some("41")
    result.cached shouldBe true
    result.subdagHash shouldBe Some("fingerprint")
    StructuredResultTransport
      .materialization("fresh", "99", List(cached))
      .executionId shouldBe Some("99")
  }

  it should "not invent a source execution for an old cache entry without provenance" in {
    val cached = CachedPortUsage("gpid", "source", "main", 0, false, "fingerprint", Some(3L), None)
    val result = StructuredResultTransport.materialization("source", "99", List(cached))
    result.executionId shouldBe None
    result.cached shouldBe true
  }
}
