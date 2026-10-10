/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { OperatorInfo } from "../../types/execution";
import type { OperatorPredicate, WorkflowContent } from "../../types/workflow";
import { renderTable, tableCell } from "../native/observation-format";

/** A table function or the row predicate attached to a semantic filter. */
export function registeredInspectionName(op: OperatorPredicate): string | undefined {
  if (op.nativeOp?.registeredName) return op.nativeOp.registeredName;
  const predicate = op.nativeOp?.type === "Filter" ? record(op.nativeOp.properties.registered).entry : undefined;
  return typeof predicate === "string" ? predicate : undefined;
}

/** Inspect saved declarations only. No Python, imports, arbitrary repr, or
 * registration initialization is executed by this read-only path. */
export function inspectRegisteredNamespace(workflow: WorkflowContent, names?: string[], implementation = false) {
  const namespace = workflow.nativeNamespace;
  const bindings = namespace?.bindings ?? {};
  const selected = names ?? Object.keys(bindings).sort();
  const missing = selected.filter(name => !Object.hasOwn(bindings, name));
  if (missing.length) throw new Error(`UNKNOWN_NAME: no registered declaration ${missing.join(", ")}.`);
  const entries = selected.map(name => {
    const binding = bindings[name];
    const fn = namespace && Object.hasOwn(namespace.functions, name) ? namespace.functions[name] : undefined;
    return {
      name,
      kind: fn ? (fn.exported ? "operator function" : "helper") : binding.kind,
      signature: fn?.signature,
      description: fn?.doc,
      used_by: workflow.operators.filter(op => registeredInspectionName(op) === name).map(op => op.operatorID),
      ...(implementation ? { source: binding.source, cell: binding.cell } : {}),
    };
  });
  const text = entries.length
    ? [
        "Current registered definitions. Operator invocations have isolated execution variables.",
        renderTable(
          ["name", "kind", "signature", "description", "direct graph users"],
          entries.map(entry =>
            [
              entry.name,
              entry.kind,
              entry.signature ?? "",
              entry.description?.split("\n")[0] ?? "",
              entry.used_by.join(", ") || "—",
            ].map(value => tableCell(value, "markdown"))
          ),
          "markdown"
        ),
        ...(implementation
          ? [...new Set(entries.map(entry => entry.source).filter((source): source is string => !!source))].map(
              source => {
                const fence = "`".repeat(Math.max(3, ...(source.match(/`+/g) ?? []).map(run => run.length + 1)));
                return `${fence}python\n${source}\n${fence}`;
              }
            )
          : []),
        ...(implementation
          ? [
              "Source shows the selected current declarations. Other globals resolve from the current namespace; show function reads them when needed. Function defaults retain their definition-time bindings.",
            ]
          : []),
      ].join("\n\n")
    : "No registered Python definitions. Register a function with edit.python before using it as an operator type.";
  return { namespace_revision: namespace?.revision, entries, text };
}

const INSPECTION_PAGE_LIMIT = 200;
const INSPECTION_TEXT_BUDGET = 20_000;

function validatePage(offset: number, limit: number) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > INSPECTION_PAGE_LIMIT)
    throw new Error("INVALID_PAGE: offset must be a nonnegative integer; limit must be 1..200.");
}

function currentResult(op: OperatorPredicate, info: OperatorInfo | undefined): OperatorInfo {
  if (!info || !["Completed", "CompletedFromCache"].includes(info.state))
    throw new Error(
      info?.error || info?.state === "Failed"
        ? `RESULT_FAILED: the last execution of \`${op.operatorID}\` failed. Repair it and execute before inspecting its results.`
        : `RESULT_NOT_RUN: \`${op.operatorID}\` has no current completed result. Execute it before inspecting its results.`
    );
  if (info.error) throw new Error(`RESULT_FAILED: the last execution of \`${op.operatorID}\` failed.`);
  if (
    op.nativeOp?.revision &&
    info.resultVersion?.operatorRevision &&
    op.nativeOp.revision !== info.resultVersion.operatorRevision
  )
    throw new Error(
      `RESULT_STALE: \`${op.operatorID}\` changed since execution. Execute it before inspecting its results.`
    );
  return info;
}

/** Schema comes from materialization metadata, never sampled records. Exact
 * names stay usable in a later column selection, including whitespace/newlines. */
export function inspectRegisteredSchema(
  op: OperatorPredicate,
  saved: OperatorInfo | undefined,
  offset = 0,
  limit = INSPECTION_PAGE_LIMIT
) {
  validatePage(offset, limit);
  const info = currentResult(op, saved);
  if (!Array.isArray(info.resultSchema))
    throw new Error(`SCHEMA_UNAVAILABLE: no schema was retained for \`${op.operatorID}\`.`);
  const all = info.resultSchema;
  const columns: Array<{ index: number; name: string; type: string }> = [];
  let budget = 0;
  for (let index = offset; index < Math.min(all.length, offset + limit); index++) {
    const column = { index, name: all[index].name, type: all[index].type };
    const length = JSON.stringify(column).length;
    // Never split a name. A single unusually long name remains inspectable.
    if (columns.length && budget + length > INSPECTION_TEXT_BUDGET) break;
    columns.push(column);
    budget += length;
  }
  const next = offset + columns.length < all.length ? offset + columns.length : null;
  return {
    operator_id: op.operatorID,
    result_version: info.resultVersion?.id ?? null,
    total_columns: all.length,
    offset,
    columns,
    next_offset: next,
    complete: offset === 0 && columns.length === all.length,
    text: [
      `Schema for \`${op.operatorID}\`: ${columns.length ? `${offset + 1}–${offset + columns.length}` : "0"} of ${all.length} columns. Names are exact JSON strings; indices are zero-based.`,
      renderTable(
        ["index", "name", "type"],
        columns.map(c => [String(c.index), JSON.stringify(c.name), c.type].map(v => tableCell(v, "markdown"))),
        "markdown"
      ),
      ...(next === null ? [] : [`More columns: show schema ${op.operatorID} from ${next}.`]),
    ].join("\n"),
  };
}

const record = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
