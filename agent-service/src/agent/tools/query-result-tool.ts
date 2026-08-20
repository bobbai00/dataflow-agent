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
 * `queryResult` — ONE read-only pandas expression over an operator's
 * materialized result, instead of a ladder of sampling policies.
 *
 * Why it exists, measured twice over:
 *   * the render clamps tables, and models answer from the clipped view as if
 *     it were complete (a session arm reported 5 of 10 qualifying niches —
 *     exactly the rows its truncated render happened to show);
 *   * when the model needs a value it cannot see, it builds a probe operator —
 *     14.8 s of engine execution plus a full LLM step, and the versioned arm
 *     wrote 1.7x more operators than its baseline largely to look at data.
 *
 * A query over rows the service already holds costs neither. The model states
 * WHAT it needs (any pandas expression); the existing budget discipline bounds
 * HOW MUCH comes back (char clamp, per-turn call budget). No sampling policy
 * to design, nothing to re-execute, nothing mutated.
 *
 * Evaluation runs in a python subprocess (the UDF venv's interpreter, so the
 * pandas version matches what operators run under) with no builtins, a
 * deny-list on the expression text, and a hard timeout. The dataframe is built
 * from the snapshot storage's stored rows — the same rows every other render
 * reads — so the tool can never see anything the trajectory does not hold.
 */

import { z } from "zod";
import { tool } from "ai";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { OperatorInfo } from "../../types/execution";
import { createErrorResult } from "./tools-utility";

export const TOOL_NAME_QUERY_RESULT = "queryResult";

/** Output clamp per call. Same rationale as recall's: the result persists in
 *  the step log for the rest of the turn, so width is paid repeatedly. */
export const QUERY_RESULT_CHARS_MAX = 4000;

/** Per-turn call budget — the same loop-stopper recall carries. */
export const QUERY_CALLS_PER_TURN = 15;

/** Subprocess wall clamp. A groupby over the few thousand rows the service
 *  holds is milliseconds; anything near this is a runaway expression. */
const PY_TIMEOUT_MS = 10_000;

/** Expression deny-list. The subprocess already runs with empty builtins and
 *  `-I`, so this is belt on top of braces — it exists to give a TEACHING
 *  error before python produces an opaque NameError. */
const FORBIDDEN = /__|\bimport\b|\bopen\s*\(|\beval\b|\bexec\b|\bgetattr\b|\bsetattr\b|\bglobals\b|\blocals\b|to_(csv|pickle|parquet|json|sql|excel|clipboard)|read_(csv|pickle|parquet|json|sql|excel)|\bos\b|\bsys\b|\bsubprocess\b/;

/** Pure, non-introspective builtins the expression may use. An empty
 *  `__builtins__` was measured costing 54 failed calls in one 5-task run —
 *  `any`, `len`, `sorted` are ordinary pandas idiom (`[c for c in df.columns
 *  if any(k in c for k in ...)]`), and their absence reads to the model as its
 *  own syntax error, so it retries variants of a call that can never work.
 *  Nothing here can import, open a file, or reach an attribute — the
 *  FORBIDDEN deny-list still rejects dunders and I/O method names. */
const SAFE_BUILTINS =
  "abs all any bool dict divmod enumerate filter float format frozenset int len list map max min " +
  "range repr reversed round set slice sorted str sum tuple zip";

const PY_RUNNER = `
import json, sys
payload = json.load(sys.stdin)
import builtins
import pandas as pd
import numpy as np
safe = {n: getattr(builtins, n) for n in "${SAFE_BUILTINS}".split() if hasattr(builtins, n)}
df = pd.DataFrame(payload["rows"])
with pd.option_context("display.max_columns", 200, "display.width", 240,
                       "display.max_colwidth", 80):
    result = eval(payload["expr"], {"__builtins__": safe}, {"df": df, "pd": pd, "np": np})
    out = result.to_string() if hasattr(result, "to_string") else repr(result)
print(out[: payload["clamp"]])
if len(out) > payload["clamp"]:
    print(f"... (clipped at {payload['clamp']} of {len(out)} chars — narrow the expression)")
`;

/** The UDF venv's interpreter when present (pandas matches the engine), else
 *  whatever python3 is on PATH. Resolved once. */
function resolvePython(): string {
  const fromEnv = process.env.QUERY_PYTHON_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const candidate of [
    join(process.cwd(), "../.venv/bin/python"),
    join(process.cwd(), ".venv/bin/python"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return "python3";
}

export interface QueryResultDeps {
  /** Result info for an operator at HEAD — same source every render reads. */
  getResult: (operatorId: string) => OperatorInfo | undefined;
  /** Known operator ids, for the teaching error on a typo. */
  listOperators: () => string[];
  /** Per-turn budget key (the current messageId). */
  getCurrentTurnKey?: () => string;
}

export function createQueryResultTool(deps: QueryResultDeps) {
  const python = resolvePython();
  let budgetTurnKey: string | undefined;
  let callsThisTurn = 0;

  return tool({
    description:
      "Run ONE read-only pandas expression against an operator's already-computed result table and get the " +
      "printed value back. The table is bound as `df` (with `pd` and `np` available); nothing executes on the " +
      "engine and nothing changes. Use it instead of building a probe operator, and use it whenever a rendered " +
      "table was truncated — NEVER answer from a clipped render when one query returns the exact rows.\n" +
      "\n" +
      "Example queries:\n" +
      '  { operatorId: "pressure_rows", expr: "df.shape" }                              — how big is it really\n' +
      '  { operatorId: "pressure_rows", expr: "df.nlargest(5, \'pressure_score\')" }     — true top-5, not the visible slice\n' +
      '  { operatorId: "clean_orders",  expr: "df[df.restaurant_code == \'R025\']" }     — the exact row you need\n' +
      '  { operatorId: "ratings",       expr: "df.groupby(\'market\')[\'score\'].mean().round(3)" }\n' +
      '  { operatorId: "merged",        expr: "df[\'order_id\'].nunique()" }             — cheap count check on inherited state\n' +
      '  { operatorId: "ledger",        expr: "df.iloc[10:15]" }                        — a specific row range\n' +
      "\n" +
      "One expression per call — no imports, no file access, no assignments.",
    inputSchema: z.object({
      operatorId: z.string().describe("Which operator's result table to query (bound as `df`)."),
      expr: z
        .string()
        .max(500)
        .describe(
          'One pandas expression over `df`, e.g. "df.nlargest(5, \'score\')" or "df[df.col > 10].shape[0]". ' +
            "Its printed value is returned, clamped — ask for the smallest thing that answers your question."
        ),
    }),
    execute: async (args: { operatorId: string; expr: string }) => {
      try {
        const turnKey = deps.getCurrentTurnKey?.() ?? "";
        if (turnKey !== budgetTurnKey) {
          budgetTurnKey = turnKey;
          callsThisTurn = 0;
        }
        callsThisTurn += 1;
        if (callsThisTurn > QUERY_CALLS_PER_TURN) {
          return createErrorResult(
            `Query budget for this turn is used up (${QUERY_CALLS_PER_TURN} calls). Your earlier query results ` +
              "are still in your steps — proceed with what you have."
          );
        }

        if (FORBIDDEN.test(args.expr)) {
          return createErrorResult(
            "queryResult evaluates ONE read-only pandas expression over `df` — no imports, file access, " +
              "dunder attributes, or I/O methods. Rewrite the expression using only df/pd/np operations."
          );
        }

        const info = deps.getResult(args.operatorId);
        if (!info || !Array.isArray(info.result)) {
          const known = deps.listOperators();
          return createErrorResult(
            `No materialized result for \`${args.operatorId}\`. Operators with results right now: ` +
              `${known.slice(0, 40).join(", ") || "(none)"}. Results exist only after an operator has executed.`
          );
        }
        if (info.error) {
          return createErrorResult(
            `\`${args.operatorId}\` last errored (${String(info.error).split("\n")[0]}) — there is no healthy ` +
              "result table to query. Fix the operator first."
          );
        }

        const proc = spawnSync(python, ["-I", "-c", PY_RUNNER], {
          input: JSON.stringify({ rows: info.result, expr: args.expr, clamp: QUERY_RESULT_CHARS_MAX }),
          timeout: PY_TIMEOUT_MS,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
        });
        if (proc.error) {
          return createErrorResult(`queryResult runner failed: ${proc.error.message}`);
        }
        if (proc.status !== 0) {
          // The expression raised — hand back the exception line, it is the teaching signal.
          const tail = (proc.stderr || "").trim().split("\n").slice(-1)[0] || "expression failed";
          return createErrorResult(`expression raised: ${tail}`);
        }
        const out = (proc.stdout || "").trimEnd();
        const rows = info.result.length;
        const total = info.totalRowCount ?? info.outputTuples;
        // TRUTH ABOUT SCOPE. The service holds only the rows that fit the
        // per-operator char budget: on a WIDE table (297 survey columns, 2k
        // budget) that is ONE row of 21,879, and `value_counts()` over it
        // prints a one-row inventory that is indistinguishable from the real
        // one. Measured on kaggle turn 1 — the exact place a value inventory
        // decides a mapping dict. The tool's own prompt tells the model to use
        // it INSTEAD of a clipped render, so silence here is the worst
        // possible framing: it promises completeness it cannot deliver.
        const partial = typeof total === "number" && total > rows;
        const header = partial
          ? `# queryResult: ${args.operatorId} — \`${args.expr}\`\n` +
            `[PARTIAL] This query ran over the ${rows} row(s) the service holds, NOT the operator's ` +
            `${total} rows (the per-operator char budget decides how many are held, and a wide table ` +
            `holds very few). Anything aggregate — counts, means, value_counts, top-N, nunique — ` +
            `describes those ${rows} row(s) only. To compute over all ${total} rows, build an operator; ` +
            `for the full per-column value inventory, read the catalog entry's ` +
            `"Column Schema and stats" block, which the engine computes over the whole table.`
          : `# queryResult: ${args.operatorId} (${rows} rows, the operator's whole result) — \`${args.expr}\``;
        return `${header}\n${out || "(empty output)"}`;
      } catch (error: any) {
        return createErrorResult(`queryResult failed: ${error?.message || String(error)}`);
      }
    },
  });
}
