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

/**
 * GRAIN SPLIT — TypeScript side of `grain_split.py`.
 *
 * Cut a submitted code operator where row identity changes (filter / merge /
 * concat / dedup / groupby-aggregate) into a chain of operators, each stage
 * carrying a full-data CHECK of the assumption its row-changing step makes
 * about its input. The Python module does the AST work; this wrapper runs it
 * as a subprocess (same pattern as `validatePythonSyntax`) and never throws —
 * any failure means "no split", i.e. legacy behavior.
 */

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { OperatorInfo } from "../../types/execution";

export interface GrainStage {
  /** Operator id of this stage (the last stage keeps the model's id). */
  id: string;
  /** "filter" | "merge" | "concat" | "dedup" | "groupby" | "final" */
  kind: string;
  /** Upstream operator ids this stage's `def process(...)` names, in order. */
  inputs: string[];
  /** Complete function source (with fenced `# <<check>>` blocks). */
  code: string;
}

export interface GrainSplitResult {
  split: boolean;
  stages: GrainStage[];
  checks: number;
  /** `[plan]` lines (estimates + static warnings) the compiler pass produced. */
  plan?: string[];
  note: string;
}

/** Abstract state of one input frame, seeded from the engine's full-data stats. */
export interface AbstractInput {
  rows: number | null;
  dup: number | null;
  cols: Record<string, { type: string; null: number | null; distinct: number | null; top: Record<string, number> | null }> | null;
}

const RESERVED = new Set(["__join_telemetry__", "__coercion_telemetry__", "__table_hints__", "__file_io__"]);

/** Parse the worker's per-column stats strings into the abstract domain the
 *  Python pass consumes: `(str): null=0, distinct=672, top_5={"a"=1, ...}`. */
export function abstractInputs(
  params: string[],
  getResult: ((opId: string) => OperatorInfo | undefined) | undefined
): Record<string, AbstractInput> {
  const out: Record<string, AbstractInput> = {};
  if (!getResult) return out;
  for (const p of params) {
    const info = getResult(p);
    if (!info) continue;
    const rows = typeof info.totalRowCount === "number" ? info.totalRowCount : typeof info.outputTuples === "number" ? info.outputTuples : null;
    let dup: number | null = null;
    let cols: AbstractInput["cols"] = null;
    const stats = info.columnStats ?? {};
    const hints = stats["__table_hints__"];
    if (typeof hints === "string") {
      const m = /duplicate rows:\s*([\d,]+)\s*of/.exec(hints);
      dup = m ? Number(m[1].replace(/,/g, "")) : 0;
    }
    const names = Object.keys(stats).filter(k => !RESERVED.has(k));
    if (names.length > 0) {
      cols = {};
      for (const name of names) {
        const s = String(stats[name] ?? "");
        const tm = /^\((\w+)\)/.exec(s);
        const type = tm ? tm[1] : "unk";
        const nm = /(?:^|[,\s])null=(\d+)/.exec(s);
        const dm = /(?:^|[,\s])distinct=(\d+)/.exec(s);
        let top: Record<string, number> | null = null;
        const tp = /top_\d+=\{(.*?)\}(?:,|$)/.exec(s);
        if (tp) {
          top = {};
          const re = /"((?:[^"\\]|\\.)*)"=(\d+)|([^,=\s][^=,]*?)=(\d+)/g;
          let mm: RegExpExecArray | null;
          while ((mm = re.exec(tp[1])) !== null) {
            const key = mm[1] !== undefined ? mm[1].replace(/\\"/g, '"') : (mm[3] ?? "").trim();
            top[key] = Number(mm[2] ?? mm[4]);
          }
        }
        cols[name] = { type, null: nm ? Number(nm[1]) : null, distinct: dm ? Number(dm[1]) : null, top };
      }
    } else if (Array.isArray(info.result) && info.result.length > 0) {
      cols = {};
      for (const k of Object.keys(info.result[0])) {
        if (k.startsWith("__")) continue;
        cols[k] = { type: "unk", null: null, distinct: null, top: null };
      }
    }
    out[p] = { rows, dup, cols };
  }
  return out;
}

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "grain_split.py");
export const CHECK_OPEN = "# <<check>>";
export const CHECK_CLOSE = "# <</check>>";

/** Remove fenced check blocks from code the MODEL reads (Code:/Operator code:). */
export function stripCheckBlocks(code: string): string {
  if (!code || !code.includes(CHECK_OPEN)) return code;
  const re = new RegExp(`[ \\t]*${escapeRe(CHECK_OPEN)}[\\s\\S]*?${escapeRe(CHECK_CLOSE)}\\n?`, "g");
  return code.replace(re, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function grainSplit(
  code: string,
  operatorId: string,
  opts: { maxCuts?: number; timeoutMs?: number; inputs?: Record<string, AbstractInput> } = {}
): Promise<GrainSplitResult | null> {
  const { spawn } = await import("child_process");
  const timeoutMs = opts.timeoutMs ?? 15000;
  // A generated stage (id carries `__`) is already at grain granularity: when
  // the model edits it, refresh its checks but never split it again — otherwise
  // ids grow (`x__filter__filter`) and stale stages pile up.
  const maxCuts = opts.maxCuts ?? (operatorId.includes("__") ? 0 : 5);
  return new Promise(resolve => {
    let stdout = "";
    let done = false;
    const finish = (v: GrainSplitResult | null) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      const proc = spawn("python3", [SCRIPT]);
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* ignore */
        }
        finish(null);
      }, timeoutMs);
      proc.stdout.on("data", d => (stdout += d.toString()));
      proc.on("error", () => {
        clearTimeout(timer);
        finish(null);
      });
      proc.on("close", () => {
        clearTimeout(timer);
        try {
          const out = JSON.parse(stdout) as GrainSplitResult;
          if (!out || !Array.isArray(out.stages)) return finish(null);
          finish(out);
        } catch {
          finish(null);
        }
      });
      proc.stdin.write(JSON.stringify({ code, operatorId, maxCuts, inputs: opts.inputs ?? {} }));
      proc.stdin.end();
    } catch {
      finish(null);
    }
  });
}
