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

package org.apache.texera.amber.core.executor

import scala.reflect.internal.util.{AbstractFileClassLoader, BatchSourceFile}
import scala.tools.nsc.io.VirtualDirectory
import scala.tools.nsc.reporters.ConsoleReporter
import scala.tools.nsc.{Global, Settings}

object ScalaRuntimeCompilation {

  /**
    * Compile a snippet of Scala code at runtime and return the resulting class.
    *
    * The code is wrapped in package `org.apache.texera.amber.operator.udf.scala`
    * and is expected to define a class named `ScalaUDFOpExec`.
    */
  def compileCode(code: String): Class[_] = {
    val packageName = "org.apache.texera.amber.operator.udf.scala"
    val codeToCompile = s"package $packageName;\n$code"
    val defaultClassName = s"$packageName.ScalaUDFOpExec"

    val settings = new Settings()
    settings.usejavacp.value = true

    val virtualDirectory = new VirtualDirectory("(memory)", None)
    settings.outputDirs.setSingleOutput(virtualDirectory)

    val outputStream = new java.io.ByteArrayOutputStream()
    val printWriter = new java.io.PrintWriter(outputStream)
    val reporter = new ConsoleReporter(settings, null, printWriter)

    val global = new Global(settings, reporter)
    val run = new global.Run

    val sourceFile = new BatchSourceFile("(inline)", codeToCompile)
    run.compileSources(List(sourceFile))

    if (reporter.hasErrors) {
      printWriter.flush()
      throw new RuntimeException("Scala compilation failed:\n" + outputStream.toString)
    }

    new CustomClassLoader(virtualDirectory).loadClass(defaultClassName)
  }

  private class CustomClassLoader(outputDir: VirtualDirectory)
      extends AbstractFileClassLoader(outputDir, this.getClass.getClassLoader)
}
