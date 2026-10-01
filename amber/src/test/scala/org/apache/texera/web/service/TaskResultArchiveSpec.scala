/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
package org.apache.texera.web.service

import org.apache.arrow.memory.RootAllocator
import org.apache.arrow.vector.ipc.ArrowFileReader
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema, Tuple}
import org.apache.texera.amber.util.ArrowUtils
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import java.nio.file.Files
import scala.util.Using

class TaskResultArchiveSpec extends AnyFlatSpec with Matchers {
  private val schema = Schema(
    List(new Attribute("id", AttributeType.LONG), new Attribute("text", AttributeType.STRING))
  )

  "Task result archive" should "preserve full rows, int64 and nulls beyond any display budget" in {
    val file = Files.createTempFile("task-result-test", ".arrow")
    val rows = (0 until 1100).map(i =>
      Tuple
        .builder(schema)
        .addSequentially(
          Array[Any](Long.box(9007199254740993L + i), if (i == 500) null else s"row-$i")
        )
        .build()
    )
    try {
      TaskResultArchive.writeArrow(file, schema, rows.iterator) shouldBe 1100L
      Using.Manager { use =>
        val allocator = use(new RootAllocator())
        val channel = use(Files.newByteChannel(file))
        val reader = use(new ArrowFileReader(channel, allocator))
        val restored = scala.collection.mutable.ArrayBuffer[Tuple]()
        while (reader.loadNextBatch()) {
          val root = reader.getVectorSchemaRoot
          for (i <- 0 until root.getRowCount) restored += ArrowUtils.getTexeraTuple(i, root)
        }
        restored.toSeq shouldBe rows
      }.get
    } finally Files.deleteIfExists(file)
  }

  it should "retain the schema of a complete empty table" in {
    val file = Files.createTempFile("task-result-empty", ".arrow")
    try {
      TaskResultArchive.writeArrow(file, schema, Iterator.empty) shouldBe 0L
      Using.Manager { use =>
        val allocator = use(new RootAllocator())
        val channel = use(Files.newByteChannel(file))
        val reader = use(new ArrowFileReader(channel, allocator))
        ArrowUtils.toTexeraSchema(reader.getVectorSchemaRoot.getSchema) shouldBe schema
        reader.loadNextBatch() shouldBe false
      }.get
    } finally Files.deleteIfExists(file)
  }
}
