/**
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { expect, test } from "bun:test";
import { verifyLoadedService } from "./native_integrity";

const hashes = Object.fromEntries(
  [
    "src/server.ts",
    "src/agent/texera-agent.ts",
    "src/agent/prompts/native-mode-single.md",
    "src/agent/native/catalog.ts",
    "src/agent/native/python/runtime.py",
    "src/agent/util/context-utils.ts",
    "package.json",
    "bun.lock",
  ].map((key) => [key, "abc"]),
);
const ledger = {
  version: 1,
  source: "transport",
  attemptedRequests: 0,
  serviceRuntime: {
    version: 1,
    pid: 123,
    sourceHashes: hashes,
  },
};

test("loaded service hashes and owned PID match before any inference", () => {
  expect(() => verifyLoadedService(ledger, hashes, 123)).not.toThrow();
});
test("stale process or disk source drift stops inference", () => {
  expect(() =>
    verifyLoadedService(ledger, { ...hashes, "src/server.ts": "changed" }, 123),
  ).toThrow("Loaded source drift");
  expect(() => verifyLoadedService(ledger, hashes, 456)).toThrow(
    "Owned agent-service PID",
  );
  expect(() =>
    verifyLoadedService({ ...ledger, source: "trace" }, {}, 123),
  ).toThrow("transport");
});
test("partial startup maps cannot omit native prompts, catalog or context", () => {
  expect(() =>
    verifyLoadedService(
      {
        ...ledger,
        serviceRuntime: {
          ...ledger.serviceRuntime,
          sourceHashes: { "src/server.ts": "abc" },
        },
      },
      hashes,
      123,
    ),
  ).toThrow("Loaded source drift");
  expect(() =>
    verifyLoadedService(ledger, { "src/server.ts": "abc" }, 123),
  ).toThrow("Incomplete expected startup inventory");
});
