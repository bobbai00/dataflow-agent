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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileNativeOp, datasetFilesStagingCode, nativeSpecOf, withNativeDatasetFiles } from "../native/codegen";
import type { NativeOpView } from "../native/catalog";
import { datasetFilePath, withDatasetFiles } from "./dataset-files";

const python = process.env.UDF_PYTHON_PATH ?? fileURLToPath(new URL("../../../../.venv/bin/python", import.meta.url));
const datasetFilesSource = readFileSync(new URL("../native/python/dataset_files.py", import.meta.url), "utf8");
const originalFetch = globalThis.fetch;
const fixtures: string[] = [];
/** Dataset path → the link the stub file service hands out; anything else is a 404. */
let presigned: Record<string, string>;
let asked: string[];
let tokens = 0;
// Links are cached per user token, so every test speaks as a fresh user.
const token = () => `token-${++tokens}-${Date.now()}`;

beforeEach(() => {
  presigned = {};
  asked = [];
  globalThis.fetch = Object.assign(
    async (input: any, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/dataset/presign-download");
      expect(new Headers(init?.headers).get("Authorization")).toStartWith("Bearer token-");
      const path = url.searchParams.get("filePath")!;
      asked.push(path);
      return path in presigned
        ? Response.json({ presignedUrl: presigned[path] })
        : new Response("not found", { status: 404 });
    },
    { preconnect: originalFetch.preconnect }
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const created = mkdtempSync(join(tmpdir(), "dataset-files-"));
  fixtures.push(created);
  return created;
}

const scan = (files: string, id = "records") =>
  compileNativeOp({ type: "Scan", properties: { files }, inputs: [] } as NativeOpView, id);

/** Run `code` the way the worker does (module namespace, then `load()`), with
 * the download cache inside `cache` so it is cleaned up with the fixtures. */
function load(code: string, cache: string): { rows?: Record<string, unknown>[]; error?: string } {
  if (!existsSync(python)) throw new Error("Dataset file tests need the worker venv; run uv sync --all-extras");
  const result = spawnSync(
    python,
    [
      "-c",
      `
import json, sys
namespace = {"__name__": "udf"}
try:
    exec(compile(json.load(sys.stdin)["code"], "<udf>", "exec"), namespace)
    print(json.dumps({"rows": json.loads(namespace["load"]().to_json(orient="records"))}))
except Exception as error:
    print(json.dumps({"error": type(error).__name__ + ": " + str(error)}))
`,
    ],
    { input: JSON.stringify({ code }), encoding: "utf8", timeout: 30_000, env: { ...process.env, TMPDIR: cache } }
  );
  if (result.status !== 0) throw new Error(`worker Python failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

describe("datasetFilePath", () => {
  test("recognizes dataset file paths, with or without the leading slash", () => {
    expect(datasetFilePath("/texera/agent-uploads/v1/drop.csv")).toBe("/texera/agent-uploads/v1/drop.csv");
    expect(datasetFilePath("texera/agent-uploads/v1/drop.csv")).toBe("/texera/agent-uploads/v1/drop.csv");
    expect(datasetFilePath("/bob@texera.com/twitter/v12 - cleaned/ca/tw1.csv")).toBe(
      "/bob@texera.com/twitter/v12 - cleaned/ca/tw1.csv"
    );
  });

  test("leaves local paths, globs and directories alone", () => {
    for (const value of [
      "data/legal/input/fraud.csv",
      "/data/customers.csv",
      "/texera/agent-uploads/v1/*.csv",
      "/texera/agent-uploads/v1/",
      "/texera/agent-uploads/latest/drop.csv",
      "drop.csv",
      "def load(p='a/b/v1/c.csv'):\n    return p",
    ])
      expect(datasetFilePath(value)).toBeUndefined();
  });
});

describe("withDatasetFiles", () => {
  test("gives a native scan's spec the link without changing its properties, revision or last line", async () => {
    presigned["/texera/up/v1/homes.csv"] = "http://minio/object?sig=1";
    const compiled = scan("/texera/up/v1/homes.csv");
    const [operator] = await withDatasetFiles(
      [{ operatorID: "records", operatorType: compiled.operatorType, code: compiled.code }],
      token()
    );
    const before = nativeSpecOf(compiled.code)!;
    const after = nativeSpecOf(operator!.code)!;
    expect(after.datasetFiles).toEqual({ "/texera/up/v1/homes.csv": "http://minio/object?sig=1" });
    expect(after.properties).toEqual(before.properties);
    expect(after.revision).toBe(before.revision);
    // PythonCodeValidator only skips the runtime's text while its exec is the last line.
    expect(operator!.code.split("\n").at(-1)).toStartWith("exec(");
  });

  test("asks nothing for local paths and returns those operators as they were", async () => {
    const compiled = scan("data/archeology/input/conflict_brecke.csv");
    const operator = { operatorID: "records", operatorType: compiled.operatorType, code: compiled.code };
    const [same] = await withDatasetFiles([operator], token());
    expect(same).toBe(operator);
    expect(asked).toEqual([]);
  });

  test("leaves a dataset-shaped path the file service does not resolve to the runtime's own error", async () => {
    const compiled = scan("/texera/up/v1/missing.csv");
    const operator = { operatorID: "records", operatorType: compiled.operatorType, code: compiled.code };
    const [same] = await withDatasetFiles([operator], token());
    expect(same).toBe(operator);
    expect(asked).toEqual(["/texera/up/v1/missing.csv"]);
  });

  test("appends staging after a code-mode loader, keyed by the literal as written", async () => {
    presigned["/texera/up/v1/homes.csv"] = "http://minio/object?sig=2";
    const code = "import pandas as pd\ndef load():\n    return pd.read_csv('texera/up/v1/homes.csv')\n";
    const [operator] = await withDatasetFiles([{ operatorID: "loader", operatorType: "DataLoading", code }], token());
    expect(operator!.code.startsWith(code)).toBe(true);
    expect(operator!.code).toContain(
      JSON.stringify(JSON.stringify({ "texera/up/v1/homes.csv": "http://minio/object?sig=2" }))
    );
    expect(asked).toEqual(["/texera/up/v1/homes.csv"]);
  });

  test("leaves operators that do not run Python code to the engine", async () => {
    presigned["/texera/up/v1/homes.csv"] = "http://minio/object?sig=3";
    const operator = { operatorID: "csv", operatorType: "CSVFileScan", fileName: "/texera/up/v1/homes.csv" };
    const [same] = await withDatasetFiles([operator], token());
    expect(same).toBe(operator);
    expect(asked).toEqual([]);
  });

  test("reuses one link across executions so repeated runs send identical code", async () => {
    presigned["/texera/up/v1/homes.csv"] = "http://minio/object?sig=4";
    const compiled = scan("/texera/up/v1/homes.csv");
    const plan = [{ operatorID: "records", operatorType: compiled.operatorType, code: compiled.code }];
    const user = token();
    const [first] = await withDatasetFiles(plan, user);
    const [second] = await withDatasetFiles(plan, user);
    expect(second!.code).toBe(first!.code);
    expect(asked).toHaveLength(1);
  });
});

describe("dataset files in the worker", () => {
  // file:// links stand in for presigned URLs; urllib opens both.
  const HOMES = "city,homes\nDorchester,4210\nBackBay,980\n";

  test("a native scan reads the dataset file through its link, then from the cached copy", () => {
    const here = directory();
    const csv = join(here, "homes.csv");
    writeFileSync(csv, HOMES);
    const code = withNativeDatasetFiles(scan("/texera/up/v1/homes.csv").code, {
      "/texera/up/v1/homes.csv": pathToFileURL(csv).href,
    });
    const rows = [
      { city: "Dorchester", homes: 4210 },
      { city: "BackBay", homes: 980 },
    ];
    expect(load(code, here)).toEqual({ rows });
    rmSync(csv); // the next execution must not need the link again
    expect(load(code, here)).toEqual({ rows });
  });

  test("a native scan without a link for the path still reports SCAN_NOT_FOUND", () => {
    const result = load(scan("/texera/up/v1/homes.csv").code, directory());
    expect(result.error).toContain("SCAN_NOT_FOUND");
  });

  test("a code-mode loader reads its dataset path literals, globals and lambdas from the local copy", () => {
    const here = directory();
    const csv = join(here, "homes.csv");
    writeFileSync(csv, HOMES);
    const code =
      [
        "import pandas as pd",
        "SOURCE = '/texera/up/v1/homes.csv'",
        "def load():",
        "    first = pd.read_csv('/texera/up/v1/homes.csv')",
        "    again = (lambda: pd.read_csv(SOURCE))()",
        "    return pd.concat([first, again])",
      ].join("\n") + datasetFilesStagingCode({ "/texera/up/v1/homes.csv": pathToFileURL(csv).href });
    expect(load(code, here).rows).toHaveLength(4);
  });

  test("a registered function's setting naming a dataset file arrives as the local copy", () => {
    const here = directory();
    const csv = join(here, "homes.csv");
    writeFileSync(csv, HOMES);
    const result = spawnSync(
      python,
      [
        "-c",
        `
import json, sys
request = json.load(sys.stdin)
scope = {}
exec(request["source"], scope)
settings = scope["localize_settings"](request["files"], {"path": "texera/up/v1/homes.csv", "limit": 2, "paths": ["/texera/up/v1/homes.csv"]})
with open(settings["path"]) as handle:
    print(json.dumps({"same": settings["path"] == settings["paths"][0], "limit": settings["limit"], "text": handle.read()}))
`,
      ],
      {
        input: JSON.stringify({
          source: datasetFilesSource,
          files: { "/texera/up/v1/homes.csv": pathToFileURL(csv).href },
        }),
        encoding: "utf8",
        env: { ...process.env, TMPDIR: here },
      }
    );
    expect(JSON.parse(result.stdout)).toEqual({ same: true, limit: 2, text: HOMES });
  });

  test("staging passes the engine's file-I/O screen for DataProcessing code", () => {
    // The patterns of PythonCodeValidator.validateNoFileIO (common/workflow-operator).
    const screened = [
      /(?<![.\w])open\s*\(/,
      /\.read\s*\(/,
      /\.write\s*\(/,
      /\.readline\s*\(/,
      /\.readlines\s*\(/,
      /\.writelines\s*\(/,
      /^(?:from\s+os\s+import|import\s+os)/m,
      /^(?:from\s+shutil\s+import|import\s+shutil)/m,
      /^(?:from\s+pathlib\s+import|import\s+pathlib)/m,
      /^(?:from\s+io\s+import|import\s+io)/m,
      /^(?:from\s+subprocess\s+import|import\s+subprocess)/m,
      /^(?:from\s+glob\s+import|import\s+glob)/m,
      /Path\s*\(/,
    ];
    const staging = datasetFilesStagingCode({ "/texera/up/v1/homes.csv": "http://minio/object?sig=5" });
    for (const pattern of screened) expect(staging).not.toMatch(pattern);
  });
});
