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

package org.apache.texera.web.resource

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import org.apache.texera.amber.core.storage.model.VirtualDocument
import org.apache.texera.amber.core.tuple.{Attribute, AttributeType, Schema, Tuple}
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.net.URI
import scala.util.Random

class SyncExecutionResourceTailRowsSpec extends AnyFlatSpec with Matchers {

  private val schema = Schema(List(new Attribute("size", AttributeType.INTEGER)))

  /** Rows whose rendered size is their one column; counts the rows ranges read. */
  private class SizedRows(sizes: IndexedSeq[Int]) extends VirtualDocument[Tuple] {
    var rowsRead = 0
    override def getURI: URI = new URI("memory:///rows")
    override def clear(): Unit = ()
    override def getCount: Long = sizes.length.toLong
    override def getRange(from: Int, until: Int, columns: Option[Seq[String]]): Iterator[Tuple] =
      (from until until).iterator.map { i =>
        rowsRead += 1
        Tuple.builder(schema).addSequentially(Array[Any](sizes(i))).build()
      }
  }

  private val mapper = new ObjectMapper()
  private def render(tuple: Tuple, index: Int): (ObjectNode, Int) =
    (mapper.createObjectNode().put("index", index), tuple.getField[Int]("size"))

  /** The sliding window tailRows replaced, over every row from `start`. */
  private def slidingWindow(sizes: IndexedSeq[Int], start: Int, budget: Int): List[Int] = {
    val window = scala.collection.mutable.ArrayBuffer[(Int, Int)]()
    var size = 0
    for (i <- start until sizes.length) {
      window += ((i, sizes(i)))
      size += sizes(i)
      while (size > budget && window.size > 1) size -= window.remove(0)._2
    }
    window.map(_._1).toList
  }

  private val resource = new SyncExecutionResource()
  private def tail(doc: SizedRows, start: Int, budget: Int): List[Int] =
    resource
      .tailRows(doc, start, doc.getCount.toInt, budget, render)
      .map(_.get("index").asInt())

  "tailRows" should "keep exactly the rows the sliding window kept" in {
    val random = new Random(7)
    for (_ <- 1 to 300) {
      val sizes = IndexedSeq.fill(random.nextInt(400) + 1)(random.nextInt(60) + 1)
      val start = random.nextInt(sizes.length)
      val budget = random.nextInt(900) + 1
      tail(new SizedRows(sizes), start, budget) shouldBe slidingWindow(sizes, start, budget)
    }
  }

  it should "read only the end of a large result" in {
    val doc = new SizedRows(IndexedSeq.fill(100000)(12))
    tail(doc, 5, 950) shouldBe (100000 - 79 until 100000).toList
    doc.rowsRead should be < 200
  }

  it should "keep the last row even when it alone exceeds the budget" in {
    tail(new SizedRows(IndexedSeq(5, 5, 5000)), 0, 100) shouldBe List(2)
  }
}
