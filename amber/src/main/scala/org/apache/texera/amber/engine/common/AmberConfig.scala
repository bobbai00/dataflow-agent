/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package org.apache.texera.amber.engine.common

import org.apache.pekko.actor.Address

object AmberConfig {
  private[common] def parseMasterPort(value: Option[String]): Int = {
    val port = value
      .map(_.toIntOption.getOrElse(throw new IllegalArgumentException("Invalid AMBER_MASTER_PORT")))
      .getOrElse(2552)
    require(port > 0 && port <= 65535, "AMBER_MASTER_PORT must be between 1 and 65535")
    port
  }
  val masterPort: Int = parseMasterPort(sys.env.get("AMBER_MASTER_PORT"))
  var masterNodeAddr: Address = Address("pekko", "Amber", "localhost", masterPort)
}
