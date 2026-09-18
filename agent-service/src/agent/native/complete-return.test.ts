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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { needsCompleteResult, readRetainedRows, withCompleteRows } from "./complete-return";
import { resolveDirectReturn } from "./direct-return";

const python = process.env.UDF_PYTHON_PATH ?? fileURLToPath(new URL("../../../../.venv/bin/python", import.meta.url));

/** Write an Arrow IPC file the way the engine's retention does, with a long
 * JSON cell the display path would have cut at 2,000 characters. */
async function retainedFixture(): Promise<{ path: string; sha256: string; rowCount: number; answer: string }> {
  const dir = mkdtempSync(join(tmpdir(), "complete-return-"));
  const path = join(dir, "answer.arrow");
  const answer = JSON.stringify({ rows: Array.from({ length: 120 }, (_, i) => ({ team: `T${i}`, score: i / 7 })) });
  const script = [
    "import hashlib, json, sys, pyarrow as pa, pyarrow.ipc as ipc",
    `table = pa.table({'answer': [${JSON.stringify(answer)}], 'big': pa.array([9007199254740993], pa.int64())})`,
    `with pa.OSFile(${JSON.stringify(path)}, 'wb') as sink:`,
    "    with ipc.new_file(sink, table.schema) as writer:",
    "        writer.write_table(table)",
    `print(hashlib.sha256(open(${JSON.stringify(path)}, 'rb').read()).hexdigest())`,
  ].join("\n");
  const child = Bun.spawn([python, "-c", script], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(stderr);
  return { path, sha256: stdout.trim(), rowCount: 1, answer };
}

test("a display result that was cut or sampled needs the complete table; a whole one does not", () => {
  const whole = { state: "Completed", result: [{ a: 1 }], totalRowCount: 1, displayedRows: 1, truncated: false } as any;
  expect(needsCompleteResult(whole)).toBe(false);
  expect(needsCompleteResult({ ...whole, truncated: true })).toBe(true);
  expect(needsCompleteResult({ ...whole, truncated: undefined })).toBe(true);
  expect(needsCompleteResult({ ...whole, totalRowCount: 5 })).toBe(true);
  expect(needsCompleteResult({ ...whole, displayedRows: undefined })).toBe(true);
  expect(needsCompleteResult(undefined)).toBe(false);
});

test("the retained copy delivers the whole cell the display path truncated, digest-checked", async () => {
  const artifact = await retainedFixture();
  expect(artifact.answer.length).toBeGreaterThan(2000);
  const payload = await readRetainedRows(artifact);
  expect(payload.rowCount).toBe(1);
  expect(payload.rows[0].answer).toBe(artifact.answer);
  expect(payload.schema.map(f => f.name)).toEqual(["answer", "big"]);
  // The display result had the cell cut; the completed result returns it whole
  // through the ordinary json path, with every completeness check still on.
  const display = {
    state: "Completed",
    resultMode: "table",
    inputTuples: 0,
    outputTuples: 1,
    result: [{ answer: artifact.answer.slice(0, 2000) + "...[truncated]...", big: 9007199254740993 }],
    resultSchema: [
      { name: "answer", type: "string", encoding: "json" },
      { name: "big", type: "long", encoding: "json-number" },
    ],
    totalRowCount: 1,
    displayedRows: 1,
    truncated: true,
  } as any;
  expect(() => resolveDirectReturn({ operator: "x", format: "json", column: "answer" }, display)).toThrow();
  const complete = withCompleteRows(display, payload);
  expect(complete.truncated).toBe(false);
  expect(resolveDirectReturn({ operator: "x", format: "json", column: "answer" }, complete)).toBe(artifact.answer);
  // A wrong digest or an oversize payload is a refusal, never a partial answer.
  await expect(readRetainedRows({ ...artifact, sha256: "0".repeat(64) })).rejects.toThrow(/missing or has changed/);
  await expect(readRetainedRows(artifact, 100)).rejects.toThrow(/exceeds the 100-byte/);
});
