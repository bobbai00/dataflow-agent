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
 * An operator's data as its panel shows it: each table it reads and the table
 * it produces, with its size, its columns and its first records.
 */
import type { OperatorResultSummary } from "./agent.service";
import type { OperatorPredicate } from "../../types/workflow-common.interface";
import { isNativeOperator, nativeArgumentLabel, nativePositionalLabel, NativeStatementForm } from "./native-operator";

export interface OperatorTable {
  /** Its rows, when known. */
  rows?: number;
  columns: Array<{ name: string; type?: string }>;
  /** Its first records. */
  records: Array<Record<string, unknown>>;
  /** The chart an operator that draws one produced (HTML). */
  html?: string;
  /** The engine reused it from cache. */
  cached: boolean;
}

/** What an operator's result is: a table, a failure, or nothing yet. */
export interface OperatorOutcome {
  table?: OperatorTable;
  error?: string;
}

/** One setting of an operator, as its panel lists it. */
export interface OperatorProperty {
  label: string;
  value: string;
}

/** Keys the engine adds to records for its own bookkeeping. */
const isInternalKey = (key: string): boolean => key.startsWith("__") || key === "html-content";

/** A table from an agent's result summary: its first `limit` records. */
export function summaryTable(summary: OperatorResultSummary, limit: number): OperatorTable {
  const sample = summary.sampleRecords ?? [];
  const html = sample[0]?.["__is_visualization__"] === true ? String(sample[0]["html-content"] ?? "") : undefined;
  const columns = summary.resultSchema?.length
    ? summary.resultSchema.map(({ name, type }) => ({ name, type }))
    : Object.keys(sample[0] ?? {})
        .filter(key => !isInternalKey(key))
        .map(name => ({ name }));
  const rows = summary.totalRowCount ?? summary.outputTuples;
  return {
    rows: rows !== undefined && rows >= 0 ? rows : undefined,
    columns: html === undefined ? columns : [],
    records: html === undefined ? sample.slice(0, limit) : [],
    ...(html !== undefined ? { html } : {}),
    cached: summary.cached === true,
  };
}

/** What an agent's summary says of an operator: its table, or why it has none. */
export function summaryOutcome(
  operatorId: string,
  summary: OperatorResultSummary | undefined,
  limit: number
): OperatorOutcome {
  if (!summary) return {};
  if (summary.error) return { error: errorText(operatorId, summary.error) };
  return /complet/i.test(summary.state) ? { table: summaryTable(summary, limit) } : {};
}

/** A failure as a person reads it: a native operator's diagnostic message, not
 * its envelope, naming the operator that failed when it is another one. */
export function errorText(operatorId: string, error: string): string {
  const envelope = /^NATIVE_ERROR_V2:(.*)$/s.exec(error);
  if (!envelope) return error;
  try {
    const diagnostic = JSON.parse(envelope[1]) as { operatorId?: string; message?: string };
    const message = diagnostic.message ?? error;
    return diagnostic.operatorId && diagnostic.operatorId !== operatorId
      ? `${diagnostic.operatorId} failed: ${message}`
      : message;
  } catch {
    return error;
  }
}

/** The operators feeding `operator`, one per input port, in port order. */
export function inputOperatorIds(
  operator: OperatorPredicate,
  links: ReadonlyArray<{ source: { operatorID: string }; target: { operatorID: string; portID: string } }>
): string[] {
  if (isNativeOperator(operator)) return [...operator.nativeOp.inputs];
  const port = (portID: string) => operator.inputPorts.findIndex(p => p.portID === portID);
  return links
    .filter(link => link.target.operatorID === operator.operatorID)
    .sort((a, b) => port(a.target.portID) - port(b.target.portID))
    .map(link => link.source.operatorID);
}

/** A native operator's settings as its edit form names them: inputs, then each argument. */
export function formProperties(form: NativeStatementForm): OperatorProperty[] {
  return [
    ...(form.inputs.length
      ? [{ label: form.inputs.length > 1 ? "Inputs" : "Input", value: form.inputs.join(", ") }]
      : []),
    ...(form.definition ? [{ label: "Function", value: form.definition.signature }] : []),
    ...form.positional.map((field, index) => ({ label: nativePositionalLabel(form.op, index), value: field.source })),
    ...form.keywords.map(field => ({ label: nativeArgumentLabel(form.op, field.name), value: field.source })),
  ];
}

/** An operator's settings without its edit form: a native operator's inputs and
 * statement, or a Texera operator's properties. */
export function operatorProperties(operator: OperatorPredicate): OperatorProperty[] {
  if (isNativeOperator(operator))
    return [
      ...(operator.nativeOp.inputs.length ? [{ label: "Inputs", value: operator.nativeOp.inputs.join(", ") }] : []),
      ...(operator.nativeOp.source ? [{ label: "Statement", value: operator.nativeOp.source }] : []),
    ];
  return Object.entries(operator.operatorProperties)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => ({
      label: key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, first => first.toUpperCase()),
      value: cellText(value),
    }));
}

/** A cell as text: strings as they are, everything else as JSON. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "null";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** "3 rows · 2 columns", or what of it is known. */
export function tableShape(table: OperatorTable): string {
  const plural = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
  return [
    ...(table.rows !== undefined ? [plural(table.rows, "row")] : []),
    ...(table.columns.length ? [plural(table.columns.length, "column")] : []),
  ].join(" · ");
}
