// Licensed to the Apache Software Foundation (ASF) under one
// or more contributor license agreements. See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership. The ASF licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License. You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

package org.apache.texera.service.resource

import jakarta.ws.rs.container.AsyncResponse
import jakarta.ws.rs.core.{MultivaluedHashMap, Response}
import org.mockito.ArgumentMatchers.any
import org.mockito.Mockito.{mock, never, times, verify, when}
import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import java.util.concurrent.{CompletableFuture, CountDownLatch, Future, TimeUnit}

class LLMProxyRequestSpec extends AnyFlatSpec with Matchers {
  "The gateway deadline" should "bound absent and oversized budgets and reject invalid or expired input" in {
    LLMProxyRequest.remainingMillis(null, 1000) shouldBe Right(180000L)
    LLMProxyRequest.remainingMillis("1250", 1000) shouldBe Right(250L)
    LLMProxyRequest.remainingMillis(Long.MaxValue.toString, 1000) shouldBe Right(180000L)
    LLMProxyRequest.remainingMillis("999", 1000).left.toOption.get shouldBe 504
    LLMProxyRequest.remainingMillis("0", 1000).left.toOption.get shouldBe 400
    LLMProxyRequest.remainingMillis("NaN", 1000).left.toOption.get shouldBe 400
  }

  "A proxy request" should "cancel pending upstream work at its deadline without fabricating usage" in {
    val async = mock(classOf[AsyncResponse])
    val future = mock(classOf[Future[Response]])
    val call = new LLMProxyRequest(async)
    call.attach(future)
    call.expire()
    call.expire()
    verify(future, times(1)).cancel(true)
    val response = org.mockito.ArgumentCaptor.forClass(classOf[Object])
    verify(async, times(1)).resume(response.capture())
    val returned = response.getValue.asInstanceOf[Response]
    returned.getStatus shouldBe 504
    returned.getEntity.toString should include("unknown")
    returned.getEntity.toString should not include "\"usage\""
  }

  it should "cancel a future attached after a disconnect and discard late responses" in {
    val async = mock(classOf[AsyncResponse])
    val future = mock(classOf[Future[Response]])
    val upstream = mock(classOf[Response])
    val call = new LLMProxyRequest(async)
    call.disconnect()
    call.attach(future)
    call.completed(upstream)
    verify(future).cancel(true)
    verify(upstream).close()
    verify(upstream, never()).readEntity(classOf[String])
    verify(async, never()).resume(any(classOf[Object]))
  }

  it should "forward completed status, body and headers and close the consumed response" in {
    val async = mock(classOf[AsyncResponse])
    val upstream = mock(classOf[Response])
    when(upstream.getStatus).thenReturn(429)
    when(upstream.readEntity(classOf[String])).thenReturn("{\"error\":\"busy\"}")
    val headers = new MultivaluedHashMap[String, Object]()
    headers.add("Retry-After", "3")
    when(upstream.getHeaders).thenReturn(headers)
    val call = new LLMProxyRequest(async)
    call.completed(upstream)
    val response = org.mockito.ArgumentCaptor.forClass(classOf[Object])
    verify(async).resume(response.capture())
    val returned = response.getValue.asInstanceOf[Response]
    returned.getStatus shouldBe 429
    returned.getEntity shouldBe "{\"error\":\"busy\"}"
    returned.getHeaderString("Retry-After") shouldBe "3"
    verify(upstream).close()
  }

  it should "close a stalled response body and prevent its late completion from replacing the timeout" in {
    val async = mock(classOf[AsyncResponse])
    val future = mock(classOf[Future[Response]])
    val upstream = mock(classOf[Response])
    val reading = new CountDownLatch(1)
    val release = new CountDownLatch(1)
    when(upstream.readEntity(classOf[String])).thenAnswer(_ => {
      reading.countDown()
      release.await(5, TimeUnit.SECONDS)
      "{\"choices\":[]}"
    })
    when(upstream.getStatus).thenReturn(200)
    when(upstream.getHeaders).thenReturn(new MultivaluedHashMap[String, Object]())
    val call = new LLMProxyRequest(async)
    call.attach(future)
    val completion = CompletableFuture.runAsync(() => call.completed(upstream))
    try {
      reading.await(5, TimeUnit.SECONDS) shouldBe true
      call.expire()
      verify(future).cancel(true)
      verify(upstream).close()
    } finally release.countDown()
    completion.get(5, TimeUnit.SECONDS)
    val response = org.mockito.ArgumentCaptor.forClass(classOf[Object])
    verify(async, times(1)).resume(response.capture())
    response.getValue.asInstanceOf[Response].getStatus shouldBe 504
  }
}
