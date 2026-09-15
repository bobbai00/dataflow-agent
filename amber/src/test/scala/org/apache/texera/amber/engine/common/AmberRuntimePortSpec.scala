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

package org.apache.texera.amber.engine.common

import org.scalatest.flatspec.AnyFlatSpec

class AmberRuntimePortSpec extends AnyFlatSpec {
  "AmberRuntime master actor port" should "preserve the default and accept an isolated listener" in {
    assert(AmberRuntime.parseMasterActorPort(None) == 2552)
    assert(AmberRuntime.parseMasterActorPort(Some("2553")) == 2553)
    assert(AmberRuntime.parseMasterActorPort(Some("65535")) == 65535)
  }

  it should "reject invalid ports before actor startup" in {
    Seq("0", "65536", "-1", "", "not-a-port", "1.0", "02553").foreach { value =>
      assertThrows[IllegalArgumentException] {
        AmberRuntime.parseMasterActorPort(Some(value))
      }
    }
  }

  it should "use the same isolated port for listener and seed" in {
    val config = AmberRuntime.actorMasterConfig("localhost", 2553)
    assert(config.getInt("pekko.remote.artery.canonical.port") == 2553)
    assert(config.getStringList("pekko.cluster.seed-nodes").get(0) == "pekko://Amber@localhost:2553")
  }
}
