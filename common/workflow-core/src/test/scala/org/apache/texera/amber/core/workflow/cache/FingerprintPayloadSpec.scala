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

package org.apache.texera.amber.core.workflow.cache

import org.apache.texera.amber.core.executor.OpExecWithCode
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema}
import org.apache.texera.amber.core.virtualidentity.{
  ExecutionIdentity,
  OperatorIdentity,
  PhysicalOpIdentity,
  WorkflowIdentity
}
import org.apache.texera.amber.core.workflow.{
  GlobalPortIdentity,
  InputPort,
  OutputPort,
  PhysicalLink,
  PhysicalOp,
  PhysicalPlan,
  PortIdentity
}
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class FingerprintPayloadSpec extends AnyFlatSpec with Matchers {
  private def id(name: String): PhysicalOpIdentity =
    PhysicalOpIdentity(OperatorIdentity(name), "main")
  private def op(name: String, code: String): PhysicalOp =
    PhysicalOp
      .oneToOnePhysicalOp(
        id(name),
        WorkflowIdentity(1L),
        ExecutionIdentity(1L),
        OpExecWithCode(code, "python", true)
      )
      .withInputPorts(List(InputPort(PortIdentity(0)), InputPort(PortIdentity(1))))
      .withOutputPorts(List(OutputPort(PortIdentity(0))))
  private def link(from: String, to: String, port: Int = 0): PhysicalLink =
    PhysicalLink(id(from), PortIdentity(0), id(to), PortIdentity(port))
  private def fingerprint(plan: PhysicalPlan): Fingerprint =
    FingerprintUtil.computeSubdagFingerprint(
      plan,
      GlobalPortIdentity(id("result"), PortIdentity(0), input = false)
    )

  "A cache fingerprint" should "bound serialized metadata even for large generated programs" in {
    val largeCode = "# α🙂 generated runtime\n" * 10000
    val nodes =
      (0 until 12).map(i => op(s"n$i", largeCode + i)).toSet + op("result", "return table")
    val links = (0 until 11).map(i => link(s"n$i", s"n${i + 1}")).toSet + link("n11", "result")
    val payload = fingerprint(PhysicalPlan(nodes, links))
    payload.fingerprintJson.length should be < 12000
    payload.fingerprintJson should not include "generated runtime"
    payload.subdagHash should have length 64
  }

  it should "invalidate on upstream code changes while ignoring disconnected changes" in {
    def plan(code: String, unusedCode: String = "unused") =
      PhysicalPlan(
        Set(op("source", code), op("result", "return table"), op("unused", unusedCode)),
        Set(link("source", "result"))
      )
    val before = fingerprint(plan("α🙂 = 1"))
    fingerprint(plan("α🙂 = 1")) shouldEqual before
    fingerprint(plan("α🙂 = 2")).subdagHash should not equal before.subdagHash
    fingerprint(plan("α🙂 = 1", "changed")).subdagHash shouldEqual before.subdagHash
  }

  it should "preserve input positions and ignore set insertion order" in {
    val a = op("a", "return 1")
    val b = op("b", "return 2")
    val result = op("result", "return left - right")
    val plan = PhysicalPlan(Set(a, b, result), Set(link("a", "result"), link("b", "result", 1)))
    val reversed = PhysicalPlan(Set(result, b, a), Set(link("b", "result", 1), link("a", "result")))
    fingerprint(reversed) shouldEqual fingerprint(plan)
    val swapped = plan.copy(links = Set(link("a", "result", 1), link("b", "result")))
    fingerprint(swapped).subdagHash should not equal fingerprint(plan).subdagHash
  }

  it should "include execution language, schema mode, and output schema in cache identity" in {
    val result = op("result", "return table")
    def hash(node: PhysicalOp): String = fingerprint(PhysicalPlan(Set(node), Set.empty)).subdagHash
    val before = hash(result)
    hash(
      result.copy(opExecInitInfo = OpExecWithCode("return table", "other", true))
    ) should not equal before
    hash(
      result.copy(opExecInitInfo = OpExecWithCode("return table", "python", false))
    ) should not equal before
    val port = PortIdentity(0)
    val (definition, links, _) = result.outputPorts(port)
    val schema = Schema().add(new Attribute("value", AttributeType.STRING))
    hash(
      result.copy(outputPorts = Map(port -> (definition, links, Right(schema))))
    ) should not equal before
  }
}
