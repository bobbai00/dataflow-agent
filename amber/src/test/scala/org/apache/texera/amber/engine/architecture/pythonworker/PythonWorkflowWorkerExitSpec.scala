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

package org.apache.texera.amber.engine.architecture.pythonworker

import org.scalatest.flatspec.AnyFlatSpec

class PythonWorkflowWorkerExitSpec extends AnyFlatSpec {

  "unexpectedExitMessage" should "name the operator and the signal that killed its Python worker" in {
    assert(
      PythonWorkflowWorker.unexpectedExitMessage("weather", 143) ==
        "The Python worker for operator weather exited with code 143 (killed by signal 15, SIGTERM) " +
          "while the operator was running; the operator produced no complete result."
    )
    assert(
      PythonWorkflowWorker
        .unexpectedExitMessage("weather", 137)
        .contains("code 137 (killed by signal 9, SIGKILL)")
    )
    assert(
      PythonWorkflowWorker
        .unexpectedExitMessage("weather", 140)
        .contains("code 140 (killed by signal 12)")
    )
  }

  it should "report a plain exit code when no signal ended the process" in {
    for (code <- Seq(0, 1, 128, 200))
      assert(
        PythonWorkflowWorker
          .unexpectedExitMessage("weather", code)
          .contains(s"exited with code $code while the operator was running")
      )
  }
}
