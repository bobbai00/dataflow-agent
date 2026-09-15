/**
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

import { expect, test } from "bun:test";
import { compileNativeOp } from "./codegen";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("compiled native runtime fits a multi-version workflow and still executes", () => {
  const compiled = compileNativeOp(
    {
      version: "v2",
      type: "UDF",
      inputs: [],
      properties: { code: "def load():\n    import pandas as pd\n    return pd.DataFrame({'x':[3,7]})" },
    },
    "source"
  );
  // A ~90 KB runtime per node exceeded PostgreSQL's MeCab search-index limit
  // near 24 nodes, despite the user's own code being tiny.
  expect(Buffer.byteLength(compiled.code)).toBeLessThan(30000);
  const python = process.env.UDF_PYTHON_PATH ?? fileURLToPath(new URL("../../../../.venv/bin/python", import.meta.url));
  const result = spawnSync(python, ["-c", compiled.code + "\nprint(load()['x'].sum())"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("10");
});
