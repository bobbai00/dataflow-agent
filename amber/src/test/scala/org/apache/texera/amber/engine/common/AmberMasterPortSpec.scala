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

package org.apache.texera.amber.engine.common

import org.scalatest.funsuite.AnyFunSuite

class AmberMasterPortSpec extends AnyFunSuite {
  test("isolated masters use an explicit port and preserve the default") {
    assert(AmberConfig.parseMasterPort(None) == 2552)
    assert(AmberConfig.parseMasterPort(Some("12552")) == 12552)
    Seq("0", "65536", "oops", "-1").foreach { value =>
      intercept[IllegalArgumentException](AmberConfig.parseMasterPort(Some(value)))
    }
  }
}
