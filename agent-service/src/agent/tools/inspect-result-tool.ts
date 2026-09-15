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
 * DIRECTION B — the on-demand result-inspection ("pull") tool.
 *
 * The PUSH side (summarize/selector) decides pre-emptively how much of each
 * operator to render. This is the complement: a read-only, model-callable tool
 * that re-renders an ALREADY-COMPUTED operator result with more detail on
 * demand — more sample rows (up to what's cached), full per-column stats, a
 * column projection, or a targeted slice (non-numeric / null / distinct values
 * of a column). It never re-executes the workflow and never mutates the DAG
 * (v1: it re-renders the cached result the snapshot storage already holds).
 *
 * Two payoffs:
 *   1. The agent can self-serve the detail a lean default render omitted (e.g.
 *      "show me the non-numeric values in `amount`" for a dtype anomaly) instead
 *      of creating a throwaway inspection operator.
 *   2. Every call is a free supervised LABEL for training the push selector:
 *      "(state) → operator O needed detail D." Mining these calls is route B
 *      (pull-to-push distillation) in docs/selector-architecture.md.
 */

import { z } from "zod";
import { tool } from "ai";
import type { OperatorInfo } from "../../types/execution";
import type { WorkflowState } from "../workflow-state";
import { formatOperatorResult } from "./result-formatting";
import { createErrorResult } from "./tools-utility";

export const TOOL_NAME_INSPECT_RESULT = "inspectResult";

const HIDDEN = new Set(["__row_index__", "__is_visualization__"]);

function cleanNumeric(s: string): boolean {
  const t = s.trim();
  if (t === "") return false;
  const c = t.replace(/^\((.*)\)$/, "-$1").replace(/[$,%\s]/g, "");
  return c !== "" && c !== "-" && Number.isFinite(Number(c));
}

/** Apply a `where` focus to the cached sample rows. Read-only; over the sample
 *  the service holds (v1). Supported: `nonnumeric:<col>`, `nulls:<col>`,
 *  `distinct:<col>`. Unknown/absent ⇒ rows unchanged. */
function applyWhere(rows: Record<string, any>[], where: string | undefined): Record<string, any>[] {
  if (!where) return rows;
  const m = /^(nonnumeric|nulls|distinct):(.+)$/.exec(where.trim());
  if (!m) return rows;
  const [, mode, col] = m;
  if (mode === "nulls") return rows.filter(r => r[col] === null || r[col] === undefined || r[col] === "");
  if (mode === "nonnumeric") return rows.filter(r => typeof r[col] === "string" && !cleanNumeric(r[col]));
  // distinct: one row per distinct value of col (first occurrence).
  const seen = new Set<string>();
  const out: Record<string, any>[] = [];
  for (const r of rows) {
    const k = String(r[col]);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** Project the sample rows to a subset of columns (keeps __row_index__). */
function projectColumns(rows: Record<string, any>[], columns: string[] | undefined): Record<string, any>[] {
  if (!columns || columns.length === 0) return rows;
  return rows.map(r => {
    const o: Record<string, any> = {};
    if ("__row_index__" in r) o.__row_index__ = r.__row_index__;
    for (const c of columns) if (c in r) o[c] = r[c];
    // silently ignore requested columns not present; the schema line will show truth
    return o;
  });
}

export interface InspectResultDeps {
  /** Resolve the operator's current cached result at HEAD (or undefined). */
  getResult: (operatorId: string) => OperatorInfo | undefined;
  workflowState: WorkflowState;
}

/**
 * Build the read-only `inspectResult` tool. `deps.getResult` reads the cached
 * OperatorInfo at the agent's HEAD; the tool re-renders it at the requested
 * detail. Returns an [ERROR] result string on a missing/absent operator so the
 * agent gets a normal tool-error frame (never throws).
 */
export function createInspectResultTool(deps: InspectResultDeps) {
  return tool({
    description:
      "Inspect an EXISTING operator's already-computed result in more detail, without re-running the workflow. " +
      "Use it to see more of a result the default view abbreviated: more sample rows, full per-column statistics, " +
      "a subset of columns of a wide table, or a targeted slice of rows. Read-only — it does not change the dataflow. " +
      "Rows and row filters are limited to the cached sample, not the full stored table; no matching sampled rows does not establish that the full table has none. " +
      "For `where`, use `nonnumeric:<column>` to see the non-numeric values in a column that loaded as text " +
      "(the ones forcing a string dtype), `nulls:<column>` for empty/null rows, or `distinct:<column>` for one row per distinct value.",
    inputSchema: z.object({
      operatorId: z.string().describe("The operator whose result to inspect."),
      maxRows: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("How many sample rows to show (default 30; capped by what is cached)."),
      columns: z
        .array(z.string())
        .optional()
        .describe("Only show these columns in samples, schema, and statistics. Empty or omitted keeps all columns."),
      stats: z
        .boolean()
        .optional()
        .describe("Include full-output column statistics, restricted to the requested columns."),
      where: z.string().optional().describe("Focus rows: nonnumeric:<col> | nulls:<col> | distinct:<col>."),
    }),
    execute: async (args: {
      operatorId: string;
      maxRows?: number;
      columns?: string[];
      stats?: boolean;
      where?: string;
    }) => {
      try {
        const info = deps.getResult(args.operatorId);
        if (!info) {
          return createErrorResult(
            `Operator ${args.operatorId} has no computed result to inspect (it may not exist yet, or has not been executed).`
          );
        }
        if (info.error) {
          // Errors are already fully surfaced; re-show the error verbatim.
          return formatOperatorResult(args.operatorId, info, deps.workflowState, {});
        }
        // Re-render the cached sample with the requested focus/detail.
        let rows = Array.isArray(info.result) ? (info.result as Record<string, any>[]) : [];
        rows = applyWhere(rows, args.where);
        rows = projectColumns(rows, args.columns);
        // Project worker schema/stats as well as sample rows. Passing only
        // projected rows leaves the original wide-table stats attached, leaking
        // unrelated columns back into this explicitly scoped inspection.
        const columnStats =
          args.columns?.length && info.columnStats
            ? Object.fromEntries(Object.entries(info.columnStats).filter(([name]) => args.columns!.includes(name)))
            : info.columnStats;
        const focused: OperatorInfo = { ...info, result: rows, columnStats };
        const cols = rows.length > 0 ? Object.keys(rows[0]).filter(k => !HIDDEN.has(k)) : [];
        const rendered = formatOperatorResult(args.operatorId, focused, deps.workflowState, {
          maxResultRows: args.maxRows ?? 30,
          schemaInResult: true,
          columnStats: args.stats === true,
          inputsInResult: false,
        });
        const header =
          `Inspection of \`${args.operatorId}\`` +
          (args.where ? ` (where ${args.where})` : "") +
          (args.columns ? ` (columns: ${args.columns.join(", ")})` : "") +
          ` — showing ${Math.min(rows.length, args.maxRows ?? 30)} of ${rows.length} matching sampled row(s), ${cols.length} column(s):`;
        const statsScope =
          args.stats === true && columnStats && Object.keys(columnStats).length > 0
            ? "Column statistics describe the full operator output; row filters affect the cached sample only.\n"
            : "";
        return `${header}\nRow selection searches the cached sample only; rows outside that sample are not retrieved.\n${statsScope}${rendered}`;
      } catch (error: any) {
        return createErrorResult(error.message || String(error));
      }
    },
  });
}
