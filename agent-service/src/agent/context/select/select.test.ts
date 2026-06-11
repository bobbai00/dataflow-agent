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
import { HISTORY_MODES, historyModeDescriptor } from "./history-mode";

describe("SELECT history-mode axis", () => {
  test("LATEST is the aggregated pole (axisRank 0)", () => {
    const d = historyModeDescriptor("latest")!;
    expect(d.representation).toBe("aggregated");
    expect(d.axisRank).toBe(0);
  });
  test("DELTA is the bounded trajectory (axisRank 1); full was removed", () => {
    expect(historyModeDescriptor("delta")!.representation).toBe("trajectory");
    expect(historyModeDescriptor("delta")!.axisRank).toBe(1);
    expect(historyModeDescriptor("full")).toBeUndefined();
  });
  test("case-insensitive lookup; unknown ⇒ undefined", () => {
    expect(historyModeDescriptor("LATEST")!.mode).toBe("latest");
    expect(historyModeDescriptor("nope")).toBeUndefined();
  });
  test("modes are ranked monotonically aggregated→trajectory", () => {
    const ranks = HISTORY_MODES.map(m => m.axisRank);
    expect(ranks).toEqual([0, 1]);
  });
});
