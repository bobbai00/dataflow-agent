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
}
