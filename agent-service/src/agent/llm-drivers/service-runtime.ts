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

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ServiceRuntimeFingerprint } from "../../types/agent";

/** All relevant service sources, excluding only unit tests. Keep this exact
 * inventory rule aligned with the benchmark's loaded-source verifier. */
export function inventoryServiceSources(sourceRoot: URL): Record<string, URL> {
  const root = fileURLToPath(sourceRoot);
  const files: string[] = [];
  const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".json", ".md", ".txt", ".yaml", ".yml"]);
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase()) && !entry.name.endsWith(".test.ts"))
        files.push(path);
    }
  }
  walk(root);
  return {
    ...Object.fromEntries(
      files.sort().map(path => [`src/${relative(root, path).replaceAll("\\", "/")}`, pathToFileURL(path)])
    ),
    "package.json": new URL("../package.json", sourceRoot),
    "bun.lock": new URL("../bun.lock", sourceRoot),
  };
}

/** Capture once when the server module loads. Later file changes require a
 * restart; metrics must identify the source this process originally loaded. */
export function captureServiceRuntime(sourceFiles: Record<string, URL>): ServiceRuntimeFingerprint {
  return {
    version: 1,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    sourceHashes: Object.fromEntries(
      Object.entries(sourceFiles).map(([name, path]) => [
        name,
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      ])
    ),
  };
}
