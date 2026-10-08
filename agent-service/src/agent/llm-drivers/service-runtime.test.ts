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

import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { captureServiceRuntime, inventoryServiceSources } from "./service-runtime";
import { ModelRequestLedger } from "./model-request-accounting";

test("service metrics attest the source captured at startup after disk source changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "service-runtime-test-"));
  try {
    const file = join(directory, "module.ts");
    await writeFile(file, "loaded source");
    const startup = captureServiceRuntime({ "src/module.ts": pathToFileURL(file) });
    const ledger = new ModelRequestLedger("runtime-test", undefined, startup);
    await writeFile(file, "changed source awaiting restart");
    expect(ledger.summary().serviceRuntime?.sourceHashes["src/module.ts"]).toBe(
      createHash("sha256").update("loaded source").digest("hex")
    );
    expect(ledger.summary().serviceRuntime?.pid).toBe(process.pid);
    expect(ledger.summary().serviceRuntime?.startedAt).toBe(startup.startedAt);
    const returned = ledger.summary().serviceRuntime!;
    returned.sourceHashes["src/module.ts"] = "client mutation";
    expect(ledger.summary().serviceRuntime?.sourceHashes["src/module.ts"]).not.toBe("client mutation");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup inventory includes native catalog, context, templates and Python runtime", () => {
  const sourceFiles = inventoryServiceSources(new URL("../../", import.meta.url));
  expect(sourceFiles["src/agent/native/catalog.ts"]).toBeDefined();
  expect(sourceFiles["src/agent/native/python/runtime.py"]).toBeDefined();
  expect(Object.keys(sourceFiles).some(path => path.startsWith("src/agent/context/") && path.endsWith(".ts"))).toBe(
    true
  );
  expect(Object.keys(sourceFiles).some(path => path.endsWith(".md") || path.endsWith(".txt"))).toBe(true);
  expect(Object.keys(sourceFiles).some(path => path.endsWith(".test.ts"))).toBe(false);
  expect(sourceFiles["package.json"]).toBeDefined();
  expect(sourceFiles["bun.lock"]).toBeDefined();
  expect(Object.keys(captureServiceRuntime(sourceFiles).sourceHashes).length).toBeGreaterThan(100);
});
