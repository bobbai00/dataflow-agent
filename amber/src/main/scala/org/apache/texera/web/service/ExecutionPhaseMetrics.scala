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

/** Machine-only execution phase evidence, independent of display/error text.
  * Compilation is the strict WorkflowCompiler call, NOT Python callback
  * preflight or a claim that generated Python subsequently runs successfully.
  * Runtime start means the coordinator start RPC was attempted, not accepted.
  */
case class ExecutionPhaseMetrics(
    version: Int = 1,
    compilation: String = "not_attempted",
    compilationDurationMs: Option[Double] = None,
    runtimeStartAttempted: Boolean = false
)

/** A service owns one tracker. Immutable volatile snapshots can be read from
  * the synchronous response thread without exposing mutable engine state.
  */
final class ExecutionPhaseTracker(clockNanos: () => Long = () => System.nanoTime()) {
  @volatile private var current = ExecutionPhaseMetrics()

  def snapshot: ExecutionPhaseMetrics = current

  def observeCompilation[A](compile: => A): A = {
    val start = clockNanos()
    current = current.copy(compilation = "running", compilationDurationMs = None)
    def finished(status: String): Unit = {
      current = current.copy(
        compilation = status,
        compilationDurationMs = Some(math.max(0L, clockNanos() - start).toDouble / 1000000.0)
      )
    }
    try {
      val result = compile
      finished("passed")
      result
    } catch {
      case failure: Throwable =>
        finished("failed")
        throw failure
    }
  }

  def markRuntimeStartAttempted(): Unit = {
    current = current.copy(runtimeStartAttempted = true)
  }
}
