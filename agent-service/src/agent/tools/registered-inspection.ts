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
              "Source shows the selected current declarations. Other globals resolve from the current namespace; inspect their names when needed. Function defaults retain their definition-time bindings.",
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
      ...(next === null
        ? []
        : [
            `More columns: inspect target="schema", operator_id=${JSON.stringify(op.operatorID)}, offset=${next}, limit=${limit}.`,
          ]),
    ].join("\n"),
  };
}

const record = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};

/** Compact discovery from retained engine scan metadata and raw preview rows.
 * This does not open local files or reinterpret a raw row as a parsed schema. */
export function inspectRegisteredSource(
  op: OperatorPredicate,
  saved: OperatorInfo | undefined,
  offset = 0,
  limit = INSPECTION_PAGE_LIMIT
) {
  validatePage(offset, limit);
  if (op.nativeOp?.type !== "Scan")
    throw new Error("SOURCE_REQUIRES_SCAN: inspect source requires a scan operator, including a scan preview.");
  const info = currentResult(op, saved);
  const scan = record(record(info.tableProfile?.native?.operations).scan);
  const sources = (Array.isArray(scan.sources) ? scan.sources : []).map(record);
  const workbooks = sources.filter(source => source.format === "excel" || Array.isArray(source.sheets));
  const preview = !!op.nativeOp.properties.preview;
  const rawRows = preview ? (info.result ?? []).filter(row => typeof row.sheet === "string") : [];
  const names = [
    ...new Set([
      ...workbooks.flatMap(source =>
        Array.isArray(source.sheets)
          ? source.sheets.filter((name: unknown): name is string => typeof name === "string")
          : []
      ),
      ...rawRows.map(row => row.sheet as string),
    ]),
  ];
  const all = names.map(name => {
    const rows = rawRows.filter(
      row => row.sheet === name && typeof row.line === "string" && Number.isInteger(row.row_no)
    );
    const first = rows.sort((a, b) => a.row_no - b.row_no)[0];
    // Head/tail retention must not promote a later record to a header hint.
    const initial = first?.row_no === (op.nativeOp!.properties.skipLines ?? 0) ? first : undefined;
    const line = initial?.line as string | undefined;
    const clipped = !!line && (line.length > 8000 || line.includes("...[truncated]..."));
    return {
      name,
      first_raw_row: line === undefined ? null : line.slice(0, 8000),
      row_no: initial?.row_no ?? null,
      first_raw_row_truncated: clipped,
    };
  });
  const sheets: typeof all = [];
  let budget = 0;
  for (const sheet of all.slice(offset, offset + limit)) {
    const length = JSON.stringify(sheet).length;
    if (sheets.length && budget + length > INSPECTION_TEXT_BUDGET) break;
    sheets.push(sheet);
    budget += length;
  }
  const next = offset + sheets.length < names.length ? offset + sheets.length : null;
  const completeNames =
    preview &&
    op.nativeOp.properties.sheet === undefined &&
    workbooks.length === 1 &&
    Array.isArray(workbooks[0].sheets) &&
    !(scan.sourcesOmitted > 0) &&
    !(scan.omittedFiles > 0);
  const selectedSources = sources.map(source => ({
    path: typeof source.path === "string" ? source.path : null,
    format: source.format ?? null,
  }));
  const lines = [
    `Source discovery for \`${op.operatorID}\`: retained engine metadata only; never reads files or executes.`,
    ...(selectedSources.length
      ? [
          renderTable(
            ["source", "format"],
            selectedSources.map(source =>
              [JSON.stringify(source.path), String(source.format)].map(v => tableCell(v, "markdown"))
            ),
            "markdown"
          ),
        ]
      : ["Source paths and sheet-name metadata were not retained."]),
    ...(names.length
      ? [
          `Workbook sheets: ${completeNames ? "complete names for the scanned workbook" : "known names only; other sheets may exist"}; showing ${sheets.length} of ${names.length} retained names. First raw rows are raw layout hints, not parsed column schemas.`,
          renderTable(
            ["sheet", "first raw row", "status"],
            sheets.map(sheet =>
              [
                JSON.stringify(sheet.name),
                sheet.first_raw_row === null ? "—" : JSON.stringify(sheet.first_raw_row),
                sheet.first_raw_row === null
                  ? "empty or first raw row not retained"
                  : sheet.first_raw_row_truncated
                    ? "clipped"
                    : "retained",
              ].map(v => tableCell(v, "markdown"))
            ),
            "markdown"
          ),
        ]
      : [
          "No worksheet names were retained; a workbook preview scan keeps them.",
        ]),
    ...(scan.omittedFiles > 0
      ? [
          `Preview omitted ${scan.omittedFiles} resolved files; inspect another explicitly selected file to discover it.`,
        ]
      : []),
    ...(scan.sourcesOmitted > 0
      ? [`Source metadata omitted ${scan.sourcesOmitted} selected sources; this source list is partial.`]
      : []),
    ...(next === null
      ? []
      : [
          `More sheets: inspect target="source", operator_id=${JSON.stringify(op.operatorID)}, offset=${next}, limit=${limit}.`,
        ]),
  ];
  return {
    operator_id: op.operatorID,
    result_version: info.resultVersion?.id ?? null,
    sources: selectedSources,
    sources_omitted: scan.sourcesOmitted ?? null,
    selected_files: scan.selectedFiles ?? null,
    total_sheets_retained: names.length,
    sheets,
    sheet_names_complete: completeNames,
    offset,
    next_offset: next,
    text: lines.join("\n"),
  };
}
