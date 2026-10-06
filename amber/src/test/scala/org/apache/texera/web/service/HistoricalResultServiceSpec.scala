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
import com.fasterxml.jackson.module.scala.DefaultScalaModule
import org.apache.texera.amber.core.storage.VFSURIFactory
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, OperatorIdentity, PhysicalOpIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.{GlobalPortIdentity, PortIdentity, SavedOutputReference}
import org.apache.texera.amber.util.serde.GlobalPortIdentitySerde.SerdeOps
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class HistoricalResultServiceSpec extends AnyFlatSpec with Matchers {
  private val workflow = WorkflowIdentity(10)
  private val reference = SavedOutputReference("41", "scores", 0)
  private val port = GlobalPortIdentity(PhysicalOpIdentity(OperatorIdentity("scores"), "main"), PortIdentity(0), input = false)
  private val uri = VFSURIFactory.resultURI(VFSURIFactory.createPortBaseURI(workflow, ExecutionIdentity(41), port))

  "Historical pagination requests" should "deserialize small JSON row counts as longs" in {
    val mapper = new ObjectMapper().registerModule(DefaultScalaModule)
    val request = mapper.readValue(
      """{"reference":{"executionId":"41","operatorId":"scores","outputPort":0},"expectedRows":3}""",
      classOf[SavedResultReadRequest])
    request.expectedRows.forall(_ == 3L) shouldBe true
    val large = mapper.readValue(
      """{"reference":{"executionId":"41","operatorId":"scores","outputPort":0},"expectedRows":2147483648}""",
      classOf[SavedResultReadRequest])
    large.expectedRows.get shouldBe 2147483648L
  }

  "Historical result binding" should "accept only the exact workflow, producer and output" in {
    HistoricalResultService.validateSource(workflow, reference, uri) shouldBe uri
    for (wrong <- List(reference.copy(executionId = "42"), reference.copy(operatorId = "other"), reference.copy(outputPort = 1))) {
      an[IllegalArgumentException] should be thrownBy HistoricalResultService.validateSource(workflow, wrong, uri)
    }
    an[IllegalArgumentException] should be thrownBy HistoricalResultService.validateSource(WorkflowIdentity(11), reference, uri)
  }

  it should "reject internal ports and non-result documents" in {
    val internal = VFSURIFactory.resultURI(VFSURIFactory.createPortBaseURI(workflow, ExecutionIdentity(41), port.copy(portId = PortIdentity(0, internal = true))))
    an[IllegalArgumentException] should be thrownBy HistoricalResultService.validateSource(workflow, reference, internal)
    val state = VFSURIFactory.stateURI(VFSURIFactory.createPortBaseURI(workflow, ExecutionIdentity(41), port))
    an[IllegalArgumentException] should be thrownBy HistoricalResultService.validateSource(workflow, reference, state)
  }

  "Historical cache cleanup" should "keep a materialization referenced by another alias" in {
    HistoricalResultService.unreferenced(List(uri), Set(uri)) shouldBe empty
    HistoricalResultService.unreferenced(List(uri, uri), Set.empty) shouldBe List(uri)
  }

  "Registered result lookup" should "resolve an alias by its registered output port, not the producer URI's name" in {
    val alias = port.copy(opId = PhysicalOpIdentity(OperatorIdentity("saved_scores"), "main"))
    HistoricalResultService.registeredResult(List(alias.serializeAsString -> uri),
      OperatorIdentity("saved_scores"), PortIdentity(0)) shouldBe Some(uri)
    HistoricalResultService.registeredResult(List(alias.serializeAsString -> uri),
      OperatorIdentity("scores"), PortIdentity(0)) shouldBe None
    HistoricalResultService.registeredResult(List(alias.copy(input = true).serializeAsString -> uri),
      OperatorIdentity("saved_scores"), PortIdentity(0)) shouldBe None
  }
}
