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

package org.apache.texera.amber.operator.udf.python

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.scala.DefaultScalaModule
import org.apache.texera.amber.operator.LogicalOp
import org.apache.texera.amber.operator.udf.python.source.DataLoadingOpDesc
import org.scalatest.funsuite.AnyFunSuite

class DataProcessingOpDescSpec extends AnyFunSuite {

  private val mapper: ObjectMapper = {
    val m = new ObjectMapper()
    m.registerModule(DefaultScalaModule)
    m
  }

  test("DataProcessing operator type deserializes via Jackson polymorphism") {
    val json =
      """{
        |  "operatorType": "DataProcessing",
        |  "code": "def process(orders, customers) -> pd.DataFrame:\n    return orders.merge(customers, on='id')\n"
        |}""".stripMargin
    val op = mapper.readValue(json, classOf[LogicalOp])
    assert(op.isInstanceOf[DataProcessingOpDesc])
  }

  test("DataLoading operator type deserializes via Jackson polymorphism") {
    val json =
      """{
        |  "operatorType": "DataLoading",
        |  "code": "def load() -> pd.DataFrame:\n    return pd.DataFrame({'x': [1,2]})\n"
        |}""".stripMargin
    val op = mapper.readValue(json, classOf[LogicalOp])
    assert(op.isInstanceOf[DataLoadingOpDesc])
  }

  test("DataProcessing parses single-parameter signature into 1 input port") {
    val desc = new DataProcessingOpDesc
    desc.code = "def process(users) -> pd.DataFrame:\n    return users\n"
    val info = desc.operatorInfo
    assert(info.inputPorts.size == 1)
    assert(info.inputPorts.head.displayName == "users")
    // First port has no dependencies
    assert(info.inputPorts.head.dependencies.isEmpty)
  }

  test("DataProcessing parses two-parameter signature into 2 input ports with sequential deps") {
    val desc = new DataProcessingOpDesc
    desc.code =
      "def process(orders, customers) -> pd.DataFrame:\n    return orders.merge(customers, on='id')\n"
    val info = desc.operatorInfo
    assert(info.inputPorts.size == 2)
    assert(info.inputPorts(0).displayName == "orders")
    assert(info.inputPorts(1).displayName == "customers")
    // Port 1 depends on port 0
    assert(info.inputPorts(1).dependencies.size == 1)
    assert(info.inputPorts(1).dependencies.head.id == 0)
  }

  test("DataProcessing strips type annotations from parameter names") {
    val desc = new DataProcessingOpDesc
    desc.code =
      "def process(users: pd.DataFrame, lookup: pd.DataFrame) -> pd.DataFrame:\n    return users\n"
    val info = desc.operatorInfo
    assert(info.inputPorts.size == 2)
    assert(info.inputPorts(0).displayName == "users")
    assert(info.inputPorts(1).displayName == "lookup")
  }

  test("DataProcessing falls back to single 'input_0' port when no valid def found") {
    val desc = new DataProcessingOpDesc
    desc.code = "# just a comment, no function"
    val info = desc.operatorInfo
    assert(info.inputPorts.size == 1)
    assert(info.inputPorts.head.displayName == "input_0")
  }

  test("DataLoading is a source operator with 0 input ports") {
    val desc = new DataLoadingOpDesc
    desc.code = "def load() -> pd.DataFrame:\n    return pd.DataFrame()\n"
    val info = desc.operatorInfo
    assert(info.inputPorts.isEmpty)
    assert(info.outputPorts.size == 1)
  }

  // ────────────────────────────────────────────────────────────────
  //  Wrapper-code generation must NOT eat the user's leading `|`
  //  characters. Regression: stripMargin used to run over the whole
  //  template (including the interpolated $code), so a chained pandas
  //  mask like `  | (df[...].isna())` lost its `|` after substitution,
  //  the wrapped operator ran `isna()(...)`, and the user saw
  //  `'Series' object is not callable` at runtime. We now apply
  //  stripMargin to the template only and concatenate `code` after.
  // ────────────────────────────────────────────────────────────────

  /** Invoke the private `generateFullCode` via reflection so the test can
    * see the literal Python the engine writes to disk. */
  private def invokeGenerateFullCode(desc: AnyRef): String = {
    val m = desc.getClass.getDeclaredMethod("generateFullCode")
    m.setAccessible(true)
    m.invoke(desc).asInstanceOf[String]
  }

  test("DataProcessing wrapper preserves leading `|` in user code (chained mask)") {
    val desc = new DataProcessingOpDesc
    // Realistic agent-emitted code: a 5-clause bitwise-OR mask with each
    // continuation line starting with whitespace + `|` (the pandas idiom
    // and the LLM's preferred layout under PEP 8 W503/W504).
    desc.code =
      """def process(t) -> pd.DataFrame:
        |    import pandas as pd
        |    df = t.copy()
        |    df['col'] = df['col'].astype('string')
        |    mask_bad = (
        |        df['col'].isna()
        |        | (df['col'].str.strip() == '')
        |        | (df['col'].str.contains('foo'))
        |        | (df['col'].str.contains('bar'))
        |    )
        |    return df[~mask_bad]
        |""".stripMargin

    val out = invokeGenerateFullCode(desc)

    // All four `|`-prefixed continuation lines must still start with their
    // leading whitespace + `|` after wrapping. The exact match guards against
    // accidental indent shifts as well.
    assert(out.contains("        | (df['col'].str.strip() == '')"),
      s"missing first | line; output was:\n$out")
    assert(out.contains("        | (df['col'].str.contains('foo'))"),
      s"missing second | line; output was:\n$out")
    assert(out.contains("        | (df['col'].str.contains('bar'))"),
      s"missing third | line; output was:\n$out")

    // Negative check: the post-stripMargin failure mode produced lines like
    // ` (df['col'].str.strip() == '')` (just a leading space + paren). If
    // that string appears anywhere in the output, the bug is back.
    assert(!out.contains("\n (df['col'].str.strip() == '')"),
      s"leading `|` was stripped from continuation line:\n$out")
  }

  test("DataLoading wrapper preserves leading `|` in user code (chained mask)") {
    val desc = new DataLoadingOpDesc
    desc.code =
      """def load() -> pd.DataFrame:
        |    import pandas as pd
        |    df = pd.read_csv('data.csv')
        |    mask = (
        |        df['name'].isna()
        |        | (df['name'].str.strip() == '')
        |    )
        |    return df[~mask]
        |""".stripMargin

    val out = invokeGenerateFullCode(desc)
    assert(out.contains("        | (df['name'].str.strip() == '')"),
      s"missing | line in DataLoading wrapper; output was:\n$out")
    assert(!out.contains("\n (df['name'].str.strip() == '')"),
      s"leading `|` was stripped from continuation line:\n$out")
  }

  test("DataProcessing wrapper still produces syntactically reasonable Python boilerplate") {
    // Tighter regression: the wrapper must still emit the class header,
    // INPUT_PORTS line, and process_tables stub. Catches accidental damage
    // to the template (e.g. losing a `|` margin on the *template* lines
    // while fixing the user-code issue).
    val desc = new DataProcessingOpDesc
    desc.code = "def process(users) -> pd.DataFrame:\n    return users\n"
    val out = invokeGenerateFullCode(desc)
    assert(out.startsWith("from pytexera import *"), s"missing header:\n$out")
    assert(out.contains("class ProcessTablesOperator(UDFMultiTableOperator):"))
    assert(out.contains("    INPUT_PORTS = [\"users\"]"))
    assert(out.contains("    def process_tables(self) -> Iterator[Optional[TableLike]]:"))
    assert(out.contains("        yield process(self.users)"))
    // User code is appended at column 0, after the wrapper class.
    assert(out.contains("\ndef process(users) -> pd.DataFrame:\n"))
  }
}
