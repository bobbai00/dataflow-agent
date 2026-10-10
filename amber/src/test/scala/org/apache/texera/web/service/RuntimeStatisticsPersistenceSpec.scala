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

package org.apache.texera.web.service

import org.scalatest.flatspec.AnyFlatSpec

import java.util.concurrent.{CountDownLatch, ExecutionException, TimeUnit, TimeoutException}
import java.util.concurrent.atomic.AtomicInteger
import scala.collection.mutable.ArrayBuffer

class RuntimeStatisticsPersistenceSpec extends AnyFlatSpec {
  "RuntimeStatisticsPersistence" should "report write failures after safely closing the writer" in {
    val closes = new AtomicInteger()
    val persistence = new RuntimeStatisticsPersistence(() => { closes.incrementAndGet(); () })
    val failure = new IllegalStateException("storage unavailable")
    persistence.persist { throw failure }
    val error = intercept[ExecutionException] { persistence.close().get(5, TimeUnit.SECONDS) }
    assert(error.getCause eq failure)
    assert(closes.get() == 1)
  }

  it should "wait for slow close without declaring the writer safe for deletion" in {
    val started = new CountDownLatch(1)
    val release = new CountDownLatch(1)
    val persistence = new RuntimeStatisticsPersistence(() => {
      started.countDown()
      assert(release.await(5, TimeUnit.SECONDS))
    })
    try {
      val completion = persistence.close()
      assert(started.await(5, TimeUnit.SECONDS))
      intercept[TimeoutException] { completion.get(10, TimeUnit.MILLISECONDS) }
      assert(!completion.isDone)
      release.countDown()
      completion.get(5, TimeUnit.SECONDS)
    } finally release.countDown()
  }

  it should "expose a close failure and close only once" in {
    val closes = new AtomicInteger()
    val failure = new IllegalStateException("flush failed")
    val persistence = new RuntimeStatisticsPersistence(() => {
      closes.incrementAndGet(); throw failure
    })
    val error = intercept[ExecutionException] { persistence.close().get(5, TimeUnit.SECONDS) }
    assert(error.getCause eq failure)
    assert(persistence.close().isCompletedExceptionally)
    assert(closes.get() == 1)
  }

  "RuntimeStatisticsPersistence" should "drain accepted writes before closing and ignore later events" in {
    val started = new CountDownLatch(1)
    val release = new CountDownLatch(1)
    val closed = new CountDownLatch(1)
    val order = ArrayBuffer.empty[String]
    val closes = new AtomicInteger()
    val persistence = new RuntimeStatisticsPersistence(() => {
      order += "close"
      closes.incrementAndGet()
      closed.countDown()
    })
    try {
      persistence.persist {
        started.countDown()
        assert(release.await(5, TimeUnit.SECONDS))
        order += "first"
      }
      assert(started.await(5, TimeUnit.SECONDS))
      persistence.persist { order += "last" }
      persistence.close()
      persistence.close()
      persistence.persist { order += "too late" }
      assert(closed.getCount == 1, "Close must wait for the active writer")
      release.countDown()
      assert(closed.await(5, TimeUnit.SECONDS))
      persistence.close().get(5, TimeUnit.SECONDS)
      assert(order.toList == List("first", "last", "close"))
      assert(closes.get() == 1)
    } finally {
      release.countDown()
      persistence.close()
    }
  }
}
