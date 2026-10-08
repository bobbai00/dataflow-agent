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
import { strict as assert } from "node:assert";

export function verifyLoadedService(
  ledger: any,
  expectedSourceHashes: Record<string, string>,
  ownedPid?: number,
): void {
  assert(
    ledger.version === 1 && ledger.source === "transport",
    "Authoritative transport model accounting is required",
  );
  assert.equal(
    ledger.attemptedRequests,
    0,
    "Fresh agent has prior model requests",
  );
  for (const required of [
    "src/server.ts",
    "src/agent/texera-agent.ts",
    "src/agent/prompts/native-mode-single.md",
    "src/agent/native/catalog.ts",
    "src/agent/native/python/runtime.py",
    "src/agent/util/context-utils.ts",
    "package.json",
    "bun.lock",
  ])
    assert(
      expectedSourceHashes[required],
      `Incomplete expected startup inventory: ${required}`,
    );
  const runtime = ledger.serviceRuntime;
  assert(
    runtime?.version === 1 &&
      Object.keys(runtime.sourceHashes ?? {}).length > 0,
    "Loaded service fingerprint is required",
  );
  if (ownedPid !== undefined)
    assert.equal(
      runtime.pid,
      ownedPid,
      "Owned agent-service PID differs from loaded server",
    );
  for (const [relative, hash] of Object.entries(expectedSourceHashes))
    assert.equal(
      runtime.sourceHashes[relative],
      hash,
      `Loaded source drift: ${relative}`,
    );
  for (const [relative, hash] of Object.entries(runtime.sourceHashes))
    assert.equal(
      hash,
      expectedSourceHashes[relative],
      `Loaded source drift: ${relative}`,
    );
}
