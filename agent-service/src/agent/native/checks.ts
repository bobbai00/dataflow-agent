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
 * `check:` lines. Every operator carries assumptions about the tables it
 * reads: a scan's first row is a header, and the rows a sum adds are distinct
 * records rather than one record listed by several sources. Only assumptions
 * whose violation is unambiguous qualify: a join that drops or repeats rows
 * may be doing exactly what was meant, so joins have no check. The runtime tests the
 * assumptions of the operator that just ran on the full tables and records
 * only violations (`operations` in the table profile); this module words them.
 * Nothing here samples, ranks or budgets: an operator with no violation has no
 * line, and each line names what was found and, where the engine found one,
 * the alternative.
 */

import type { OperatorInfo } from "../../types/execution";
import type { OperatorPredicate } from "../../types/workflow";

const MAX_LINES = 4;
const json = (x: unknown) => JSON.stringify(x);
const record = (x: unknown): Record<string, any> =>
  x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, any>) : {};
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const list = (x: unknown): string[] => (Array.isArray(x) ? x.map(v => json(String(v))) : []);
const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;

export function scanLines(operations: Record<string, any>): string[] {
  const lines: string[] = [];
  for (const source of Array.isArray(record(operations.scan).sources) ? record(operations.scan).sources : []) {
    const s = record(source);
    const check = record(s.headerCheck);
    if (!Object.keys(check).length || typeof s.path !== "string") continue;
    const file = `\`${basename(s.path)}\``;
    const suggest = record(check.suggest);
    const alternative = num(suggest.skipLines)
      ? `; skip_lines=${suggest.skipLines} gives the header ${list(suggest.header).join(", ")}`
      : "";
    if (Array.isArray(check.dataLike) && check.dataLike.length)
      lines.push(
        `the header of ${file} reads as data (${list(check.dataLike).join(", ")})${alternative || "; a file without a header row needs header=False with names"}.`
      );
    else if (num(check.blank)) lines.push(`${check.blank} header cells of ${file} are blank${alternative}.`);
    if (num(check.repeats))
      lines.push(
        `the header row of ${file} recurs ${check.repeats} time${check.repeats === 1 ? "" : "s"} among its data rows (stacked tables or repeated headers).`
      );
  }
  return lines;
}

function repeatedLine(type: string, operations: Record<string, any>): string[] {
  const r = record(operations.repeatedRecords);
  if (!num(r.rows) || !num(r.of) || !num(r.records)) return [];
  const ignoring = Array.isArray(r.ignoring) && r.ignoring.length ? ` apart from ${list(r.ignoring).join(", ")}` : "";
  return [
    `${r.rows} of ${r.of} input rows are ${r.records} records each listed once by ${num(r.sources) ? `${r.sources} different sources` : "several sources"}${ignoring}, e.g. ${json(r.example)}; ${type === "Aggregate" ? "the aggregate counts" : "a sum, mean or count counts"} every copy.`,
  ];
}

function processLines(operations: Record<string, any>): string[] {
  const lines: string[] = [];
  for (const item of Array.isArray(record(operations.process).events) ? record(operations.process).events : []) {
    const e = record(item);
    const at = `inside the function, line ${e.line}:`;
    const ins: number[] = Array.isArray(e.in) ? e.in : [];
    if (e.op === "merge" && e.issue === "empty") lines.push(`${at} a merge of ${ins.join(" and ")} rows returned 0 rows.`);
    else if ((e.op === "filter" || e.op === "query") && e.issue === "empty")
      lines.push(`${at} a row selection kept 0 of ${ins[0]} rows.`);
    else if (e.op === "concat" && e.issue === "duplicates")
      lines.push(
        `${at} concatenating ${ins.length} tables: ${e.rows} of ${e.of} rows are ${e.records} records each listed once by several of the tables, e.g. ${json(e.example)}.`
      );
  }
  return lines;
}

/** The violated assumptions of one executed native operator, worded; empty when none. */
export function nativeCheckLines(op: OperatorPredicate, info: OperatorInfo): string[] {
  const view = op.nativeOp;
  const operations = record(info.tableProfile?.native?.operations);
  if (!view || !Object.keys(operations).length) return [];
  const lines =
    view.type === "Scan"
      ? scanLines(operations)
      : view.type === "Process"
        ? [...repeatedLine(view.type, operations), ...processLines(operations)]
        : view.type === "Aggregate"
          ? repeatedLine(view.type, operations)
          : [];
  return lines.slice(0, MAX_LINES);
}

/**
 * Adjustments the runtime made instead of failing, worded for every executed
 * operator regardless of settings: an output that replaced an existing column,
 * a right-side join column renamed past its suffix, a boolean column reduced
 * as 1/0. The model reads them in the execution receipt.
 */
export function nativeAdjustmentLines(op: OperatorPredicate, info: OperatorInfo): string[] {
  const operations = record(info.tableProfile?.native?.operations);
  if (!op.nativeOp || !Object.keys(operations).length) return [];
  const lines: string[] = [];
  const replaced = Array.isArray(operations.replacedColumns) ? operations.replacedColumns : [];
  if (replaced.length)
    lines.push(`note: existing column${replaced.length === 1 ? "" : "s"} ${list(replaced).join(", ")} replaced by the new output.`);
  const renamed = Object.entries(record(record(operations.join).renamedRight));
  if (renamed.length)
    lines.push(
      `note: right column${renamed.length === 1 ? "" : "s"} renamed to avoid a collision: ${renamed.map(([from, to]) => `${json(from)} → ${json(String(to))}`).join(", ")}.`
    );
  const bools = Array.isArray(operations.boolAsInt) ? operations.boolAsInt : [];
  if (bools.length) lines.push(`note: boolean column${bools.length === 1 ? "" : "s"} ${list(bools).join(", ")} reduced as 1/0.`);
  return lines;
}
