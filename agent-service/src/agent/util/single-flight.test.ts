/**
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
import { expect, test } from "bun:test";
import { singleFlight } from "./single-flight";

test("one run in flight; calls during it coalesce into one more run that sees the latest state", async () => {
  let state = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const seen: number[] = [];
  const releases: Array<() => void> = [];
  const save = singleFlight(async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise<void>(resolve => releases.push(resolve));
    seen.push(state);
    inFlight--;
  });
  const first = save();
  for (state = 1; state <= 5; state++) void save();
  state = 5;
  releases.shift()!(); // the first run ends; one more run starts for the five calls
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  releases.shift()!();
  await first;
  expect(seen).toEqual([5, 5]);
  expect(maxInFlight).toBe(1);
  // Idle again: the next call runs at once.
  const next = save();
  releases.shift()!();
  await next;
  expect(seen).toEqual([5, 5, 5]);
});
