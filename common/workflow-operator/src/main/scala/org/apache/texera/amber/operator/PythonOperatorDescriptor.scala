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

import org.apache.texera.amber.config.UdfConfig
import org.apache.texera.amber.core.executor.OpExecWithCode
import org.apache.texera.amber.core.tuple.Schema
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, WorkflowIdentity}
import org.apache.texera.amber.core.workflow.{PhysicalOp, PortIdentity, SchemaPropagationFunc}

/**
  * Utility object for validating Python UDF code at workflow-compile time.
  *
  * Used opt-in by code-block descriptors (DataProcessingOpDesc,
  * DataLoadingOpDesc) to reject file I/O and print statements before the
  * code is sent to the worker. Existing descriptors that extend the
  * PythonOperatorDescriptor trait below are unaffected.
  */
object PythonCodeValidator {

  /**
    * Validates Python code for file I/O operations when file I/O is not allowed.
    * Honors UdfConfig.pythonAllowFileIO — when true, this is a no-op.
    *
    * @throws RuntimeException if file I/O operations are detected
    */
  def validateNoFileIO(code: String): Unit = {
    if (UdfConfig.pythonAllowFileIO) {
      return
    }

    // Patterns that indicate file I/O operations. Word boundaries and
    // context-aware patterns reduce false positives.
    val fileIOPatterns = Seq(
      ("""(?<![.\w])open\s*\(""".r, "open() function"),
      ("""\.read\s*\(""".r, ".read() method"),
      ("""\.write\s*\(""".r, ".write() method"),
      ("""\.readline\s*\(""".r, ".readline() method"),
      ("""\.readlines\s*\(""".r, ".readlines() method"),
      ("""\.writelines\s*\(""".r, ".writelines() method"),
      ("""(?m)^(?:from\s+os\s+import|import\s+os)""".r, "os module import"),
      ("""(?m)^(?:from\s+shutil\s+import|import\s+shutil)""".r, "shutil module import"),
      ("""(?m)^(?:from\s+pathlib\s+import|import\s+pathlib)""".r, "pathlib module import"),
      ("""(?m)^(?:from\s+io\s+import|import\s+io)""".r, "io module import"),
      ("""(?m)^(?:from\s+subprocess\s+import|import\s+subprocess)""".r, "subprocess module import"),
      ("""(?m)^(?:from\s+glob\s+import|import\s+glob)""".r, "glob module import"),
      ("""Path\s*\(""".r, "Path() constructor")
    )

    val codeWithoutComments = stripCommentsAndDocstrings(code)
    val detected = fileIOPatterns.flatMap {
      case (pattern, description) =>
        if (pattern.findFirstIn(codeWithoutComments).isDefined) Some(description) else None
    }

    if (detected.nonEmpty) {
      throw new RuntimeException(
        s"File I/O operations are not allowed in Python UDF. " +
          s"Detected: ${detected.mkString(", ")}. " +
          s"Please remove file I/O code"
      )
    }
  }

  /**
    * Generates Python code that embeds an error message as a comment.
    * Lets compile-time validation errors propagate without interrupting
    * schema propagation; the upper-level compiler surfaces it later.
    */
  def generatePythonCodeForRaisingException(ex: Throwable): String = {
    s"#EXCEPTION DURING CODE GENERATION: ${ex.getMessage}"
  }

  private def stripCommentsAndDocstrings(code: String): String = {
    code
      .replaceAll("""#.*$""", "")
      .replaceAll("""'''[\s\S]*?'''""", "\"\"")
      .replaceAll("\"\"\"[\\s\\S]*?\"\"\"", "\"\"")
  }
}

trait PythonOperatorDescriptor extends LogicalOp {
  private def generatePythonCodeForRaisingException(ex: Throwable): String = {
    s"#EXCEPTION DURING CODE GENERATION: ${ex.getMessage}"
  }

  override def getPhysicalOp(
      workflowId: WorkflowIdentity,
      executionId: ExecutionIdentity
  ): PhysicalOp = {
    val pythonCode =
      try {
        generatePythonCode()
      } catch {
        case ex: Throwable =>
          // instead of throwing error directly, we embed the error in the code
          // this can let upper-level compiler catch the error without interrupting the schema propagation
          generatePythonCodeForRaisingException(ex)
      }
    val physicalOp = if (asSource()) {
      PhysicalOp.sourcePhysicalOp(
        workflowId,
        executionId,
        operatorIdentifier,
        OpExecWithCode(pythonCode, "python")
      )
    } else {
      PhysicalOp.oneToOnePhysicalOp(
        workflowId,
        executionId,
        operatorIdentifier,
        OpExecWithCode(pythonCode, "python")
      )
    }

    physicalOp
      .withInputPorts(operatorInfo.inputPorts)
      .withOutputPorts(operatorInfo.outputPorts)
      .withParallelizable(parallelizable())
      .withPropagateSchema(SchemaPropagationFunc(inputSchemas => getOutputSchemas(inputSchemas)))
  }

  def parallelizable(): Boolean = false

  def asSource(): Boolean = false

  /**
    * This method is to be implemented to generate the actual Python source code
    * based on operators predicates.
    *
    * @return a String representation of the executable Python source code.
    */
  def generatePythonCode(): String

  def getOutputSchemas(inputSchemas: Map[PortIdentity, Schema]): Map[PortIdentity, Schema]

}
