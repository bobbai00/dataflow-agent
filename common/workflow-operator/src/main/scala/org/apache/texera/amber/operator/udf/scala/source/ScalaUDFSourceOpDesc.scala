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

package org.apache.texera.amber.operator.udf.scala.source

import com.fasterxml.jackson.annotation.{JsonProperty, JsonPropertyDescription}
import com.kjetland.jackson.jsonSchema.annotations.JsonSchemaTitle
import org.apache.texera.amber.core.executor.OpExecWithCode
import org.apache.texera.amber.core.tuple.{Attribute, Schema}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.{OutputPort, PhysicalOp, SchemaPropagationFunc}
import org.apache.texera.amber.operator.metadata.{OperatorGroupConstants, OperatorInfo}
import org.apache.texera.amber.operator.source.SourceOperatorDescriptor

class ScalaUDFSourceOpDesc extends SourceOperatorDescriptor {

  @JsonProperty(
    required = true,
    defaultValue =
      "import org.apache.texera.amber.core.executor.SourceOperatorExecutor\n" +
        "import org.apache.texera.amber.core.tuple.TupleLike\n" +
        "\n" +
        "class ScalaUDFOpExec extends SourceOperatorExecutor {\n" +
        "  override def produceTuple(): Iterator[TupleLike] = {\n" +
        "    // Your logic here\n" +
        "    Iterator.empty\n" +
        "  }\n" +
        "}"
  )
  @JsonSchemaTitle("Scala script")
  @JsonPropertyDescription("Input your code here")
  var code: String = _

  @JsonProperty(required = true, defaultValue = "1")
  @JsonSchemaTitle("Worker count")
  @JsonPropertyDescription("Specify how many parallel workers to launch")
  var workers: Int = 1

  @JsonProperty()
  @JsonSchemaTitle("Columns")
  @JsonPropertyDescription("The columns of the source")
  var columns: List[Attribute] = List.empty

  override def getPhysicalOp(
      workflowId: WorkflowIdentity,
      executionId: ExecutionIdentity
  ): PhysicalOp = {
    require(workers >= 1, "Need at least 1 worker.")
    val physicalOp = PhysicalOp
      .sourcePhysicalOp(workflowId, executionId, operatorIdentifier, OpExecWithCode(code, "scala"))
      .withInputPorts(operatorInfo.inputPorts)
      .withOutputPorts(operatorInfo.outputPorts)
      .withIsOneToManyOp(true)
      .withPropagateSchema(
        SchemaPropagationFunc(_ => Map(operatorInfo.outputPorts.head.id -> sourceSchema()))
      )
      .withLocationPreference(Option.empty)

    if (workers > 1) {
      physicalOp
        .withParallelizable(true)
        .withSuggestedWorkerNum(workers)
    } else {
      physicalOp.withParallelizable(false)
    }
  }

  override def operatorInfo: OperatorInfo = {
    OperatorInfo(
      "Scala UDF Source",
      "Source user-defined function operator in Scala script",
      OperatorGroupConstants.SCALA_GROUP,
      List.empty,
      List(OutputPort()),
      supportReconfiguration = true
    )
  }

  override def sourceSchema(): Schema = {
    if (columns != null && columns.nonEmpty) {
      Schema().add(columns)
    } else {
      Schema()
    }
  }
}
