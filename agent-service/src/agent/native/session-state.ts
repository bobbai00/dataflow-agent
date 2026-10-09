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
import type { OperatorInfo } from "../../types/execution";
import type { OperatorPredicate, WorkflowContent } from "../../types/workflow";
import { nativeOperatorName } from "./catalog";
import { renderTable, tableCell, topologicalOperators } from "./observation-format";

/** The results that operator rows describe. */
export interface OperatorRowSource {
  /** The operator's current result, if it has one. */
  result: (operatorId: string) => OperatorInfo | undefined;
  /** Whether the operator had a result that a later change made stale. */
  hadResult: (operatorId: string) => boolean;
}

/** What the session holds when a later request starts. */
export interface SessionStateSource extends OperatorRowSource {
  workflow: WorkflowContent;
  /** The earlier request that set the operator's current definition. */
  origin: (operatorId: string) => number | undefined;
  tableFormat?: "markdown" | "tsv";
}

const completed = (info: OperatorInfo | undefined): boolean =>
  !!info && !info.error && ["Completed", "CompletedFromCache"].includes(info.state);
// Operators whose rows are a subset of their first input's rows.
const SELECTS_ROWS = new Set(["Filter", "Limit", "Distinct"]);
const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);

/**
 * One operator as a table row: its statement, its result's shape, and every
 * column name. Columns repeat only where they differ from the first input's,
 * so a wide table is spelled out once per chain.
 */
export function operatorRow(
  op: OperatorPredicate,
  source: OperatorRowSource
): { id: string; definition: string; result: string; columns: string } {
  const view = op.nativeOp!;
  const id = op.operatorID;
  const columnsOf = (operatorId: string) => {
    const info = source.result(operatorId);
    return info && completed(info) ? (info.resultSchema ?? []).map(field => field.name) : undefined;
  };
  const info = source.result(id);
  const statement = (view.source ?? "").replace(/\s+/g, " ").trim();
  const definition =
    (view.savedFrom ? `as of task ${view.savedFrom.task}: ` : "") +
    (statement.replace(/^set\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s*/, "") ||
      (view.registeredName ?? nativeOperatorName(view.type)));
  const columns = columnsOf(id);
  let result = "not run";
  if (info && completed(info)) {
    const rowCount = info.totalRowCount ?? info.outputTuples;
    const upstream = view.inputs[0] ? source.result(view.inputs[0]) : undefined;
    const of =
      SELECTS_ROWS.has(view.type) && upstream && completed(upstream)
        ? ` of ${count(upstream.totalRowCount ?? upstream.outputTuples)}`
        : "";
    result = `${count(rowCount)}${of} ${plural(rowCount, "row")}, ${columns?.length ?? 0} ${plural(columns?.length ?? 0, "column")}`;
  } else if (info?.error) result = "failed";
  else if (source.hadResult(id)) result = "stale";
  const upstreamColumns = view.inputs[0] ? columnsOf(view.inputs[0]) : undefined;
  let columnText = columns?.join(", ") ?? "";
  if (columns && upstreamColumns && columns.length >= upstreamColumns.length) {
    const sameStart = upstreamColumns.every((name, index) => columns[index] === name);
    if (sameStart && columns.length === upstreamColumns.length) columnText = `as ${view.inputs[0]}`;
    else if (sameStart) columnText = `${view.inputs[0]} + ${columns.slice(upstreamColumns.length).join(", ")}`;
  }
  return { id, definition: `\`${definition}\``, result, columns: columnText };
}

/**
 * The definitions and results a later request inherits, rendered once when it
 * starts: every registered function by signature, and one row per operator
 * with the request that set it.
 */
export function renderSessionState(source: SessionStateSource): string {
  const { workflow } = source;
  const format = source.tableFormat ?? "markdown";
  const functions = Object.values(workflow.nativeNamespace?.functions ?? {}).filter(fn => fn.exported);
  const operators = topologicalOperators(workflow.operators.filter(op => op.nativeOp));
  if (!functions.length && !operators.length) return "";
  const rows = operators.map(op => {
    const row = operatorRow(op, source);
    const origin = source.origin(op.operatorID);
    return [row.id, row.definition, row.result, origin === undefined ? "" : String(origin), row.columns].map(value =>
      tableCell(value, format)
    );
  });
  const lines = ["## Session state at the start of this request", ""];
  if (functions.length) {
    lines.push("Registered functions:");
    for (const fn of functions) {
      const summary = fn.doc.split("\n")[0].trim();
      lines.push(`- \`${fn.name}${fn.signature}\`${summary ? `: ${summary}` : ""}`);
    }
    lines.push("");
  }
  if (operators.length) lines.push(renderTable(["operator", "definition", "result", "task", "columns"], rows, format));
  return lines.join("\n").trimEnd();
}
