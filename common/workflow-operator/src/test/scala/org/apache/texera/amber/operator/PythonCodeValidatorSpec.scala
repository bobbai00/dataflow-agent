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

package org.apache.texera.amber.operator

import org.scalatest.funsuite.AnyFunSuite

class PythonCodeValidatorSpec extends AnyFunSuite {

  test("validateNoFileIO passes for clean code") {
    PythonCodeValidator.validateNoFileIO("def f(x):\n    return x + 1")
  }

  test("validateNoFileIO rejects open()") {
    val ex = intercept[RuntimeException] {
      PythonCodeValidator.validateNoFileIO(
        "def f():\n    return open('/etc/passwd').read()"
      )
    }
    assert(ex.getMessage.contains("open() function"))
  }

  test("validateNoFileIO rejects os import") {
    val ex = intercept[RuntimeException] {
      PythonCodeValidator.validateNoFileIO("import os\ndef f():\n    return 1")
    }
    assert(ex.getMessage.contains("os module import"))
  }

  test("validateNoFileIO rejects pathlib import and Path()") {
    val ex = intercept[RuntimeException] {
      PythonCodeValidator.validateNoFileIO(
        "from pathlib import Path\ndef f():\n    return Path('/x')"
      )
    }
    assert(ex.getMessage.contains("pathlib module import"))
  }

  test("validateNoFileIO ignores comments") {
    PythonCodeValidator.validateNoFileIO(
      "def f():\n    # import os should be ignored\n    return 1"
    )
  }

  test("validateNoFileIO ignores triple-single-quoted docstrings") {
    val code = "def f():\n    '''do not open() this'''\n    return 1"
    PythonCodeValidator.validateNoFileIO(code)
  }

  test("validateNoFileIO ignores triple-double-quoted docstrings") {
    // Use Scala string concat to embed literal triple-double-quotes.
    val tq = "\"" + "\"" + "\""
    val code = "def f():\n    " + tq + "do not open() this" + tq + "\n    return 1"
    PythonCodeValidator.validateNoFileIO(code)
  }

  test("validateNoFileIO accumulates multiple violations") {
    val ex = intercept[RuntimeException] {
      PythonCodeValidator.validateNoFileIO(
        "import os\nimport shutil\ndef f():\n    return open('x').read()"
      )
    }
    val msg = ex.getMessage
    assert(msg.contains("os module import"))
    assert(msg.contains("shutil module import"))
    assert(msg.contains("open() function"))
  }

  test("generatePythonCodeForRaisingException returns a comment") {
    val msg = PythonCodeValidator.generatePythonCodeForRaisingException(
      new RuntimeException("boom")
    )
    assert(msg.startsWith("#EXCEPTION DURING CODE GENERATION:"))
    assert(msg.contains("boom"))
  }
}
