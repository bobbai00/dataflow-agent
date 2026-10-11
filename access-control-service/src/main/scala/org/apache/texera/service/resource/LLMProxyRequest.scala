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
import jakarta.ws.rs.core.Response

import java.net.SocketTimeoutException
import java.util.concurrent.{Future, TimeoutException}
import java.util.concurrent.atomic.{AtomicBoolean, AtomicReference}
import scala.jdk.CollectionConverters._
import scala.util.control.NonFatal

private[resource] object LLMProxyRequest {
  val DeadlineHeader = "X-Texera-LLM-Deadline-Ms"
  // The server's upper bound per request: 180 s unless LLM_PROXY_MAX_DURATION_MS
  // sets another positive value (long-thinking models need several minutes).
  val MaxDurationMillis: Long =
    sys.env.get("LLM_PROXY_MAX_DURATION_MS").flatMap(_.toLongOption).filter(_ > 0).getOrElse(180000L)
  val TimeoutBody: String =
    """{"error":{"message":"LLM gateway request timed out; provider cancellation and usage are unknown","type":"gateway_timeout"}}"""

  // Absolute time includes transit/queueing at the gateway. A caller may shorten
  // this budget, but cannot remove or extend the server's upper bound.
  def remainingMillis(raw: String, now: Long): Either[Int, Long] = {
    if (raw == null) return Right(MaxDurationMillis)
    raw.toLongOption match {
      case Some(deadline) if deadline <= 0   => Left(400)
      case Some(deadline) if deadline <= now => Left(504)
      case Some(deadline)                    => Right(math.min(deadline - now, MaxDurationMillis))
      case None                              => Left(400)
    }
  }

  def isTimeout(error: Throwable): Boolean = {
    var current = error
    var depth = 0
    while (current != null && depth < 16) {
      if (current.isInstanceOf[SocketTimeoutException] || current.isInstanceOf[TimeoutException]) {
        return true
      }
      current = current.getCause
      depth += 1
    }
    false
  }
}

/** One terminal response owns cancellation and entity cleanup, including races
  * between deadline, disconnect, response headers, and response-body reading.
  * Cancelling our HTTP request does not prove a remote provider stopped billing.
  */
private[resource] final class LLMProxyRequest(async: AsyncResponse) {
  private val finished = new AtomicBoolean(false)
  private val pending = new AtomicReference[Future[_]]()
  private val upstream = new AtomicReference[Response]()

  def attach(future: Future[_]): Unit = {
    pending.set(future)
    if (finished.get()) future.cancel(true)
  }

  def completed(response: Response): Unit = {
    upstream.set(response)
    try {
      if (!finished.get()) {
        val body = response.readEntity(classOf[String])
        val result = Response.status(response.getStatus).entity(body)
        response.getHeaders.asScala.foreach {
          case (key, values) =>
            values.asScala.foreach(value => result.header(key, value))
        }
        if (finished.compareAndSet(false, true)) async.resume(result.build())
      }
    } catch {
      case NonFatal(error) => failed(error)
    } finally closeUpstream()
  }

  def failed(error: Throwable): Unit = {
    if (LLMProxyRequest.isTimeout(error)) expire()
    else if (finished.compareAndSet(false, true)) {
      closeUpstream()
      async.resume(
        Response
          .status(Response.Status.BAD_GATEWAY)
          .entity(
            """{"error":{"message":"Failed to proxy request to LiteLLM","type":"gateway_error"}}"""
          )
          .build()
      )
    }
  }

  def expire(): Unit = {
    if (finished.compareAndSet(false, true)) {
      cancelUpstream()
      async.resume(Response.status(504).entity(LLMProxyRequest.TimeoutBody).build())
    }
  }

  def disconnect(): Unit = {
    if (finished.compareAndSet(false, true)) cancelUpstream()
  }

  private def cancelUpstream(): Unit = {
    Option(pending.get()).foreach(_.cancel(true))
    closeUpstream()
  }

  private def closeUpstream(): Unit = {
    Option(upstream.getAndSet(null)).foreach { response =>
      try response.close()
      catch { case NonFatal(_) => () }
    }
  }
}
