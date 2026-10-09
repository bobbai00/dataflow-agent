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

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileNativeOp } from "./codegen";

// Execute the generated source: string-only assertions cannot detect an ignored
// offset. Use the provisioned worker interpreter, not a system Python that may
// have different pandas/reader dependencies.
const python = process.env.UDF_PYTHON_PATH ?? fileURLToPath(new URL("../../../../.venv/bin/python", import.meta.url));
const fixtures: string[] = [];
const runPython = `
import json, sys
import pandas as pd
spec = json.load(sys.stdin)
if spec.get('workbook'):
    with pd.ExcelWriter(spec['files'], engine='openpyxl') as writer:
        for sheet, rows in spec['workbook'].items():
            pd.DataFrame(rows).to_excel(writer, sheet_name=sheet, index=False, header=False)
namespace = {}
exec(compile(spec['code'], '<native-scan-preview>', 'exec'), namespace)
try:
    result = namespace['load']()
    print(json.dumps({'columns': list(result.columns), 'rows': json.loads(result.to_json(orient='records'))}))
except Exception as error:
    print(json.dumps({'error': type(error).__name__ + ': ' + str(error)}))
`;

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(name: string, content: string | Buffer): string {
  const directory = mkdtempSync(join(tmpdir(), "native-scan-preview-"));
  fixtures.push(directory);
  const path = join(directory, name);
  writeFileSync(path, content);
  return path;
}

function preview(properties: Record<string, unknown>, workbook?: Record<string, unknown[][]>) {
  if (!existsSync(python)) {
    throw new Error(`Scan execution tests require the worker venv; run uv sync --all-extras or set UDF_PYTHON_PATH`);
  }
  const code = compileNativeOp({ type: "Scan", properties, inputs: [] }).code;
  const result = spawnSync(python, ["-c", runPython], {
    input: JSON.stringify({ code, files: properties.files, workbook }),
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Python preview test failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as {
    columns?: string[];
    rows?: Record<string, unknown>[];
    error?: string;
  };
}

describe("Scan preview executes an offset window", () => {
  test("text preview starts at skipLines and keeps absolute physical line numbers", () => {
    const files = fixture("data.csv", "metadata\n# comment\n\nvalue\n10\n20\n30\n");
    const result = preview({ files, preview: 2, skipLines: 4, comment: "#" });
    expect(result).toEqual({
      columns: ["file", "line_no", "line"],
      rows: [
        { file: "data.csv", line_no: 4, line: "10" },
        { file: "data.csv", line_no: 5, line: "20" },
      ],
    });
  });

  test("zero/omitted offset preserves the first raw lines, including blank lines", () => {
    const files = fixture("data.txt", "head\r\n\r\nbody\r\n");
    const expected = {
      columns: ["file", "line_no", "line"],
      rows: [
        { file: "data.txt", line_no: 0, line: "head" },
        { file: "data.txt", line_no: 1, line: "" },
      ],
    };
    expect(preview({ files, preview: 2 })).toEqual(expected);
    expect(preview({ files, preview: 2, skipLines: 0 })).toEqual(expected);
  });

  test("offset applies independently to each file, including the lines reader", () => {
    const a = fixture("a.txt", "a0\na1\na2\n");
    const b = fixture("b.txt", "b0\nb1\nb2\n");
    const result = preview({ files: [a, b], format: "lines", preview: 1, skipLines: 1 });
    expect(result.error).toBeUndefined();
    expect(result.rows?.map(row => [row.file, row.line_no, row.line]).sort()).toEqual([
      ["a.txt", 1, "a1"],
      ["b.txt", 1, "b1"],
    ]);
  });

  test("text offset at and beyond EOF returns an empty schemaful preview", () => {
    const files = fixture("data.txt", "first\nlast\n");
    for (const skipLines of [2, 20]) {
      expect(preview({ files, preview: 3, skipLines })).toEqual({
        columns: ["file", "line_no", "line"],
        rows: [],
      });
    }
  });

  test("an empty file remains a schemaful empty preview", () => {
    const files = fixture("empty.txt", "");
    expect(preview({ files, preview: 2, skipLines: 3 })).toEqual({
      columns: ["file", "line_no", "line"],
      rows: [],
    });
  });

  test("a short final window is not padded and honors text encoding", () => {
    const files = fixture("latin.csv", Buffer.from("header\ncaf\xe9\nfin", "latin1"));
    expect(preview({ files, preview: 10, skipLines: 1, encoding: "cp1252" }).rows).toEqual([
      { file: "latin.csv", line_no: 1, line: "café" },
      { file: "latin.csv", line_no: 2, line: "fin" },
    ]);
  });

  test("Excel offset applies to every sheet and retains absolute row positions", () => {
    const files = fixture("data.xlsx", "");
    const result = preview(
      { files, preview: 2, skipLines: 2 },
      {
        first: [["title"], ["x", "y"], ["a", "b"], ["c", "d"], ["e", "f"]],
        second: [["title"], ["header"], ["value"]],
      }
    );
    expect(result).toEqual({
      columns: ["sheet", "row_no", "line"],
      rows: [
        { sheet: "first", row_no: 2, line: "a | b" },
        { sheet: "first", row_no: 3, line: "c | d" },
        { sheet: "second", row_no: 2, line: "value" },
      ],
    });
  });

  test("Excel offset past every sheet returns an empty schemaful preview", () => {
    const files = fixture("data.xlsx", "");
    expect(preview({ files, preview: 2, skipLines: 20 }, { first: [["title"], ["value"]] })).toEqual({
      columns: ["sheet", "row_no", "line"],
      rows: [],
    });
  });

  test("HTML offset skips data rows, retaining one-based data positions and table IDs", () => {
    const files = fixture(
      "data.html",
      "<table><tr><th>x</th></tr><tr><td>a</td></tr><tr><td>b</td></tr><tr><td>c</td></tr></table>" +
        "<table><tr><th>y</th></tr><tr><td>d</td></tr><tr><td>e</td></tr></table>"
    );
    expect(preview({ files, preview: 1, skipLines: 1 })).toEqual({
      columns: ["table", "row_no", "line"],
      rows: [
        { table: 0, row_no: 2, line: "b" },
        { table: 1, row_no: 2, line: "e" },
      ],
    });
  });

  test("HTML zero offset preserves the synthetic header plus n data rows", () => {
    const files = fixture("data.html", "<table><tr><th>x</th></tr><tr><td>a</td></tr><tr><td>b</td></tr></table>");
    expect(preview({ files, preview: 1 })).toEqual({
      columns: ["table", "row_no", "line"],
      rows: [
        { table: 0, row_no: 0, line: "x" },
        { table: 0, row_no: 1, line: "a" },
      ],
    });
  });

  test("HTML offset past all data does not return a misleading header-only table", () => {
    const files = fixture("data.html", "<table><tr><th>x</th></tr><tr><td>a</td></tr></table>");
    expect(preview({ files, preview: 2, skipLines: 20 })).toEqual({
      columns: ["table", "row_no", "line"],
      rows: [],
    });
  });

  test("binary pointer preview rejects an inapplicable offset instead of ignoring it", () => {
    const files = fixture("data.npz", "pointer-only fixture");
    expect(preview({ files, preview: 2, skipLines: 1 }).error).toMatch(/binary pointer previews cannot use skipLines/i);
    const initial = preview({ files, preview: 2 });
    expect(initial.error).toBeUndefined();
    expect(initial.rows?.[0]?.file).toBe("data.npz");
    expect(initial.rows?.[0]?.note).toContain("custom Python loader");
  });

  test("full lines loading keeps absolute physical line numbers after skipLines", () => {
    const files = fixture("data.txt", "header\na\nb\n");
    expect(preview({ files, format: "lines", skipLines: 1 })).toEqual({
      columns: ["line_no", "line"],
      rows: [
        { line_no: 1, line: "a" },
        { line_no: 2, line: "b" },
      ],
    });
  });
});
