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

import { fileURLToPath } from "node:url";
import type { OperatorInfo } from "../../types/execution";
import type { RetainedResult } from "./task-history";

/** Display results are bounded so the model can read them; the engine cuts
 * cells at `maxOperatorResultCellCharLimit` and rows at the result budget.
 * A direct return must deliver the whole table, so when the display copy is
 * incomplete the runtime reads the retained Arrow copy instead — the same
 * file an `atTask` input loads. Its own bound is bytes, not characters seen. */
export const COMPLETE_RETURN_MAX_BYTES = 262_144;

const readerPath = fileURLToPath(new URL("./python/retained_rows.py", import.meta.url));
const defaultPython = fileURLToPath(new URL("../../../../.venv/bin/python", import.meta.url));

export interface RetainedRows {
  rowCount: number;
  schema: Array<{ name: string; type: string }>;
  rows: Array<Record<string, unknown>>;
}

/** True when the display result cannot stand in for the table: a cell was
 * cut, rows were held back, or the sample is not the whole result. */
export function needsCompleteResult(info: OperatorInfo | undefined): boolean {
  if (!info) return false;
  return (
    info.truncated !== false ||
    !Array.isArray(info.result) ||
    info.result.length !== info.totalRowCount ||
    info.displayedRows !== info.totalRowCount
  );
}

export async function readRetainedRows(
  artifact: RetainedResult,
  maxBytes = COMPLETE_RETURN_MAX_BYTES
): Promise<RetainedRows> {
  const child = Bun.spawn(
    [process.env.UDF_PYTHON_PATH ?? defaultPython, readerPath, artifact.path, artifact.sha256, String(maxBytes)],
    { stdout: "pipe", stderr: "pipe" }
  );
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 30_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (timedOut) throw new Error("Complete return unavailable: reading the retained table timed out");
    if (code !== 0) {
      let reason = (stderr.trim() || stdout.trim()).split("\n").at(-1) ?? "";
      try {
        reason = JSON.parse(reason).error ?? reason;
      } catch {
        /* plain text stays as is */
      }
      throw new Error(`Complete return unavailable: ${reason.slice(0, 300)}`);
    }
    const payload = JSON.parse(stdout) as RetainedRows;
    if (payload.rowCount !== artifact.rowCount || payload.rows.length !== payload.rowCount)
      throw new Error("Complete return unavailable: retained row count does not match the result");
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

/** The display result's identity and schema with the complete rows in place
 * of the bounded sample, so every existing completeness check applies. */
export function withCompleteRows(info: OperatorInfo, payload: RetainedRows): OperatorInfo {
  const resultSchema =
    info.resultSchema ?? payload.schema.map(field => ({ name: field.name, type: field.type, encoding: "json" }));
  return {
    ...info,
    result: payload.rows,
    resultSchema,
    totalRowCount: payload.rowCount,
    displayedRows: payload.rows.length,
    truncated: false,
  };
}
