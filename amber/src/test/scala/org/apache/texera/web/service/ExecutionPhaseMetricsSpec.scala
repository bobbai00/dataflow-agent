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
import org.apache.texera.web.resource.SyncExecutionResult
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

class ExecutionPhaseMetricsSpec extends AnyFlatSpec with Matchers {
  "ExecutionPhaseTracker" should "keep unattempted phases distinct from passes" in {
    val tracker = new ExecutionPhaseTracker()
    tracker.snapshot.version shouldBe 1
    tracker.snapshot.compilation shouldBe "not_attempted"
    tracker.snapshot.compilationDurationMs shouldBe None
    tracker.snapshot.runtimeStartAttempted shouldBe false
  }

  it should "time only compilation and preserve immutable snapshots" in {
    var now = 1000000L
    val tracker = new ExecutionPhaseTracker(() => now)
    val before = tracker.snapshot
    val value = tracker.observeCompilation {
      tracker.snapshot.compilation shouldBe "running"
      now += 2500000L
      42
    }
    value shouldBe 42
    tracker.snapshot.compilation shouldBe "passed"
    tracker.snapshot.compilationDurationMs shouldBe Some(2.5)
    tracker.snapshot.runtimeStartAttempted shouldBe false
    val compiled = tracker.snapshot
    now += 9000000L // cache preparation / runtime setup is not compiler time
    tracker.markRuntimeStartAttempted()
    tracker.snapshot.runtimeStartAttempted shouldBe true
    tracker.snapshot.compilationDurationMs shouldBe Some(2.5)
    compiled.runtimeStartAttempted shouldBe false
    before.compilation shouldBe "not_attempted"
  }

  it should "record failure at the call site without interpreting error text" in {
    var now = 0L
    val tracker = new ExecutionPhaseTracker(() => now)
    val failure = new IllegalStateException("unrelated text; no compiler keyword")
    val thrown = intercept[IllegalStateException] {
      tracker.observeCompilation {
        now = 700000L
        throw failure
      }
    }
    thrown should be theSameInstanceAs failure
    tracker.snapshot.compilation shouldBe "failed"
    tracker.snapshot.compilationDurationMs shouldBe Some(0.7)
    tracker.snapshot.runtimeStartAttempted shouldBe false
  }

  it should "not reclassify later infrastructure errors as compile failures" in {
    val tracker = new ExecutionPhaseTracker()
    tracker.observeCompilation(())
    intercept[IllegalStateException] {
      throw new IllegalStateException("operator cache schema unavailable")
    }
    tracker.snapshot.compilation shouldBe "passed"
    tracker.snapshot.runtimeStartAttempted shouldBe false
  }

  it should "serialize explicit phases independently of the heuristic display state" in {
    val mapper = new ObjectMapper().registerModule(DefaultScalaModule)
    val response = SyncExecutionResult(
      success = false,
      state = "Failed",
      operators = Map.empty,
      compilationErrors = None,
      errors = None,
      executionId = Some("123"),
      phaseMetrics =
        Some(ExecutionPhaseMetrics(compilation = "failed", compilationDurationMs = Some(0.7)))
    )
    val json = mapper.readTree(mapper.writeValueAsString(response))
    json.get("executionId").asText() shouldBe "123"
    json.get("state").asText() shouldBe "Failed"
    json.get("phaseMetrics").get("compilation").asText() shouldBe "failed"
    json.get("phaseMetrics").get("compilationDurationMs").asDouble() shouldBe 0.7
    json.get("phaseMetrics").get("runtimeStartAttempted").asBoolean() shouldBe false
    val earlyFailure =
      mapper.readTree(mapper.writeValueAsString(response.copy(phaseMetrics = None)))
    earlyFailure.get("phaseMetrics").isNull shouldBe true
  }
}
