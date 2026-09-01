/**
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

import { describe, expect, test } from "bun:test";
import { parseSourceRef } from "./general-op-tools";

describe("GENERAL-mode link wiring: source output-port selection", () => {
  test("a bare operator id means output port 0", () => {
    expect(parseSourceRef("op9")).toEqual({ operatorId: "op9", outputPortIndex: 0 });
    expect(parseSourceRef("  op9 ")).toEqual({ operatorId: "op9", outputPortIndex: 0 });
  });

  test("an `:N` suffix selects output port N (Split: 0 = training share, 1 = rest)", () => {
    expect(parseSourceRef("op9:1")).toEqual({ operatorId: "op9", outputPortIndex: 1 });
    expect(parseSourceRef("split_train_test:0")).toEqual({ operatorId: "split_train_test", outputPortIndex: 0 });
  });

  test("operator ids containing other punctuation are left intact", () => {
    expect(parseSourceRef("load-csv_v2")).toEqual({ operatorId: "load-csv_v2", outputPortIndex: 0 });
  });
});
