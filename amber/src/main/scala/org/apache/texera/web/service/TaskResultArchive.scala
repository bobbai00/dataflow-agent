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
import org.apache.arrow.vector.VectorSchemaRoot
import org.apache.arrow.vector.ipc.ArrowFileWriter
import org.apache.texera.amber.core.storage.DocumentFactory
import org.apache.texera.amber.core.storage.model.VirtualDocument
import org.apache.texera.amber.core.tuple.{AttributeType, Schema, Tuple}
import org.apache.texera.amber.core.virtualidentity.{ExecutionIdentity, OperatorIdentity}
import org.apache.texera.amber.core.workflow.PortIdentity
import org.apache.texera.amber.util.ArrowUtils
import org.apache.texera.web.resource.dashboard.user.workflow.WorkflowExecutionsResource
import java.nio.file.{Files, Path, Paths, StandardCopyOption}
import java.security.MessageDigest
import java.util.UUID
import javax.ws.rs.{BadRequestException, NotFoundException}
import scala.util.Using

case class RetainedTaskResult(path: String, sha256: String, rowCount: Long)

/** Immutable Arrow copies owned by a research session's isolated engine.
  * Cache invalidation never touches this directory. The configured directory
  * must be visible to its Python workers. The service never accepts file paths
  * from a caller. Archives are retained until the isolated stack is cleaned up.
  */
object TaskResultArchive {
  def retain(workflowId: Long, executionId: Long, operatorId: String): RetainedTaskResult = {
    val base = sys.env
      .get("TEXERA_TASK_RESULT_DIR")
      .filter(_.nonEmpty)
      .getOrElse(
        throw new BadRequestException("Task result retention is not configured on this engine")
      )
    val uri = WorkflowExecutionsResource
      .getResultUriByLogicalPortId(
        ExecutionIdentity(executionId),
        OperatorIdentity(operatorId),
        PortIdentity()
      )
      .getOrElse(throw new NotFoundException("Exact producing result is unavailable"))
    val (opened, maybeSchema) = DocumentFactory.openDocument(uri)
    val doc = opened.asInstanceOf[VirtualDocument[Tuple]]
    val schema =
      maybeSchema.getOrElse(throw new BadRequestException("Result schema is unavailable"))
    val supported = Set(
      AttributeType.STRING,
      AttributeType.INTEGER,
      AttributeType.LONG,
      AttributeType.DOUBLE,
      AttributeType.BOOLEAN,
      AttributeType.TIMESTAMP
    )
    if (schema.getAttributes.exists(a => !supported(a.getType)))
      throw new BadRequestException("Task history currently supports native scalar tables only")
    val directory = Paths.get(base).toAbsolutePath.resolve(workflowId.toString)
    Files.createDirectories(directory)
    val target = directory.resolve(UUID.randomUUID().toString + ".arrow")
    val partial = target.resolveSibling(target.getFileName.toString + ".partial")
    try {
      val expected = doc.getCount
      val count = writeArrow(partial, schema, doc.get())
      if (count != expected)
        throw new IllegalStateException("Result changed while retaining its data")
      Files.move(partial, target, StandardCopyOption.ATOMIC_MOVE)
      val digest = MessageDigest.getInstance("SHA-256")
      Using.resource(Files.newInputStream(target)) { stream =>
        val buffer = new Array[Byte](65536)
        var n = stream.read(buffer)
        while (n != -1) { digest.update(buffer, 0, n); n = stream.read(buffer) }
      }
      RetainedTaskResult(
        target.toString,
        digest.digest().map(b => f"${b & 0xff}%02x").mkString,
        count
      )
    } catch {
      case error: Exception => Files.deleteIfExists(target); throw error
    } finally Files.deleteIfExists(partial)
  }

  /** Streams the actual complete table, including an empty table's schema. */
  private[service] def writeArrow(path: Path, schema: Schema, rows: Iterator[Tuple]): Long = {
    Using.Manager { use =>
      val allocator = use(new RootAllocator())
      val root = use(VectorSchemaRoot.create(ArrowUtils.fromTexeraSchema(schema), allocator))
      val channel = use(
        Files.newByteChannel(
          path,
          java.nio.file.StandardOpenOption.CREATE,
          java.nio.file.StandardOpenOption.TRUNCATE_EXISTING,
          java.nio.file.StandardOpenOption.WRITE
        )
      )
      val writer = use(new ArrowFileWriter(root, null, channel))
      writer.start()
      var total = 0L
      while (rows.hasNext) {
        root.allocateNew()
        var count = 0
        while (rows.hasNext && count < 1024) {
          ArrowUtils.setTexeraTuple(rows.next(), count, root)
          count += 1
        }
        root.setRowCount(count)
        writer.writeBatch()
        total += count
        root.clear()
      }
      writer.end()
      total
    }.get
  }
}
