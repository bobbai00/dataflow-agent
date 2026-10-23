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
 * Presentation of native operators: operators the dataflow agent defines with a
 * statement such as `set agg: aggregate(...)` and the engine runs as a Python
 * UDF. The canvas shows what such an operator computes — its native type, icon
 * and doc — instead of the engine operator and the generated code that runs it,
 * and its editor works on the statement, one field per argument.
 */

import { NativeOperatorDefinition, OperatorPredicate } from "../../types/workflow-common.interface";

/** One built-in native operator type, as the agent-service serves its catalog. */
export interface NativeCatalogEntry {
  /** Statement name: `scan`, `aggregate`, … */
  name: string;
  /** Native type: `Scan`, `Aggregate`, … */
  type: string;
  inputs: 0 | 1 | 2 | "many";
  rowEffect: string;
  signature: string;
  /** The type's contract, as the agent's prompt shows it. */
  doc: string;
  /** JSON schema of the operator's `properties`. */
  schema: { properties?: Record<string, unknown> };
}

/** Icons by native type: Texera's icon for the equivalent operator, or one of
 * the native ones (window, pivot, unpivot have no Texera counterpart). */
const ICONS: Record<string, string> = {
  Scan: "CSVFileScan",
  Filter: "Filter",
  Project: "Projection",
  Cast: "TypeCasting",
  Map: "PythonLambdaFunction",
  Aggregate: "Aggregate",
  Join: "HashJoin",
  Union: "Union",
  Distinct: "Distinct",
  Sort: "Sort",
  Limit: "Limit",
  Window: "NativeWindow",
  Unpivot: "NativeUnpivot",
  Pivot: "NativePivot",
  Process: "PythonUDFV2",
};

export function isNativeOperator(
  operator: OperatorPredicate | undefined
): operator is OperatorPredicate & { nativeOp: NativeOperatorDefinition } {
  return !!operator?.nativeOp?.type;
}

export function nativeOperatorIcon(definition: NativeOperatorDefinition): string {
  const icon =
    definition.registeredName && definition.type === "Process"
      ? isVisualizationOperator(definition)
        ? "BarChart"
        : "PythonUDFV2"
      : ICONS[definition.type];
  return `assets/operator_images/${icon ?? "PythonUDFV2"}.png`;
}

/** A registered function's operator set with `is_visualization=True`: its result is a chart's HTML. */
export function isVisualizationOperator(definition: NativeOperatorDefinition): boolean {
  const registered = definition.properties?.["registered"] as { visualization?: unknown } | undefined;
  return registered?.visualization === true;
}

/** The names of the files a scan reads, without their directories: `listings.csv`. */
export function nativeScanFiles(definition: NativeOperatorDefinition): string[] {
  const files = definition.properties?.["files"];
  const paths = typeof files === "string" ? [files] : Array.isArray(files) ? files : [];
  return paths
    .filter((path): path is string => typeof path === "string" && path.trim().length > 0)
    .map(
      path =>
        path
          .replace(/[\\/]+$/, "")
          .split(/[\\/]/)
          .pop() ?? path
    );
}

/** What a scan's box says: its file, or its first file and how many more. */
export function nativeScanFileLabel(definition: NativeOperatorDefinition): string {
  const names = nativeScanFiles(definition);
  if (names.length === 0) return "";
  return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1} more`;
}

/** The kind of file a scan reads, for its glyph: `CSV`, `JSON`, `XLSX`…; `FILE` when the name has no extension. */
export function nativeScanFileKind(definition: NativeOperatorDefinition): string {
  const first = nativeScanFiles(definition)[0] ?? "";
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(first.replace(/\.(gz|bz2|zip)$/i, ""));
  return match ? match[1].toUpperCase() : "FILE";
}

/** The type a box and the panel name: the registered function, else the native type. */
export function nativeOperatorTypeName(definition: NativeOperatorDefinition): string {
  return definition.registeredName ?? definition.type;
}

/** A statement without its `set <id>: ` head: `aggregate(joined, by=[...])`. */
export function nativeStatementBody(source: string | undefined): string {
  return (source ?? "").replace(/^\s*set\s+\w+\s*:\s*/, "").trim();
}

/** What a box says: the operator's doc, else what its statement computes. */
export function nativeOperatorSummary(operator: OperatorPredicate & { nativeOp: NativeOperatorDefinition }): string {
  return operator.nativeOp.doc?.trim() || nativeStatementBody(operator.nativeOp.source) || operator.operatorID;
}

/** One argument of a statement, as the agent-service splits it (`NativeStatementForm`). */
export interface NativeStatementField {
  /** The argument's Python source, as written. */
  source: string;
  kind: "string" | "number" | "boolean" | "strings" | "lambda" | "code";
  /** The literal's value, for the kinds a form edits without source. */
  value?: string | number | boolean | string[];
}

export interface NativeStatementKeyword extends NativeStatementField {
  name: string;
}

/** An operator's statement split into fields, for the canvas editor. */
export interface NativeStatementForm {
  id: string;
  /** What the statement calls: a built-in (`filter`) or a registered function (`widen`). */
  op: string;
  inputs: string[];
  /** Positional arguments after the inputs: a filter's condition, a map's row function. */
  positional: NativeStatementField[];
  /** Keyword arguments in call order, without `doc`. */
  keywords: NativeStatementKeyword[];
  doc?: string;
  /** The statement as it stands. */
  statement: string;
  /** The registered Python function the statement calls, when it calls one. */
  definition?: { name: string; signature: string; source: string };
}

/** Labels for arguments the keyword alone would spell poorly, by operator then keyword. */
const ARGUMENT_LABELS: Record<string, Record<string, string>> = {
  aggregate: { by: "Group by" },
  sort: { by: "Sort by" },
  join: { on: "Join keys", how: "Join type" },
  limit: { n: "Rows" },
  cast: { columns: "Column types" },
  window: { partition_by: "Partition by", order_by: "Order by" },
  pivot: { values: "Values" },
};
const POSITIONAL_LABELS: Record<string, string> = { filter: "Condition", map: "Row function" };

/** A readable label for a keyword argument (`partition_by` → "Partition by"). */
export function nativeArgumentLabel(op: string, name: string): string {
  const label = ARGUMENT_LABELS[op]?.[name];
  if (label) return label;
  const words = name.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A label for a positional argument after the inputs. */
export function nativePositionalLabel(op: string, index: number): string {
  return POSITIONAL_LABELS[op] ?? `Argument ${index + 1}`;
}

/** A Python string literal for `value`, quoted the way Python's repr would. */
export function pythonString(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .split(quote)
    .join(`\\${quote}`);
  return `${quote}${escaped}${quote}`;
}

/** The Python source of an argument whose literal value the form edits. An
 * unchanged value keeps the source as written (`3.0` stays `3.0`). */
export function nativeFieldSource(field: NativeStatementField, original?: NativeStatementField): string {
  if (original && JSON.stringify(field.value) === JSON.stringify(original.value)) return original.source;
  switch (field.kind) {
    case "string":
      return pythonString(String(field.value ?? ""));
    case "number":
      return Number.isFinite(Number(field.value)) && field.value !== "" && field.value !== null
        ? String(Number(field.value))
        : field.source;
    case "boolean":
      return field.value ? "True" : "False";
    case "strings":
      return `[${((field.value as string[] | undefined) ?? []).map(pythonString).join(", ")}]`;
    default:
      return field.source;
  }
}

/** The statement a form's fields spell: `set id: op(inputs, arguments, keyword=value, doc='...')`. */
export function assembleNativeStatement(parts: {
  id: string;
  op: string;
  inputs: readonly string[];
  positional: readonly string[];
  keywords: ReadonlyArray<{ name: string; source: string }>;
  doc?: string;
}): string {
  const args = [
    ...parts.inputs.map(input => input.trim()).filter(Boolean),
    ...parts.positional.map(source => source.trim()).filter(Boolean),
    ...parts.keywords
      .filter(keyword => keyword.name.trim() && keyword.source.trim())
      .map(keyword => `${keyword.name.trim()}=${keyword.source.trim()}`),
    ...(parts.doc?.trim() ? [`doc=${pythonString(parts.doc.trim())}`] : []),
  ];
  return `set ${parts.id}: ${parts.op}(${args.join(", ")})`;
}
