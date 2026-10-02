/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { OperatorPredicate } from "../../types/workflow";

/** Successful table budgets never consume the diagnostic detail allowance. */
export const NATIVE_DIAGNOSTIC_CHARS = 1200;
export const NATIVE_ERROR_INSPECTION_CHARS = 4000;

export interface NativeDiagnostic {
  version: 1;
  operatorId: string;
  operatorRevision: string;
  code: string;
  stage: "validate" | "compile" | "execute" | "contract" | "dependency" | "infrastructure";
  message: string;
  field?: string;
  source?: { entry: string; line: number; column?: number; excerpt: string };
  hint?: string;
  retryable?: boolean;
}

export interface NativeErrorSummary {
  diagnosticId: string;
  operatorId: string;
  operatorRevision: string;
  stepId: string;
  executionId: string | null;
  phase: "attempt" | "execution";
  diagnostic: NativeDiagnostic;
}

export interface NativeErrorQuery {
  operatorId: string;
  revision?: string;
  diagnosticId?: string;
}

/** Defense in depth for diagnostic text only; never dump environments/logging
 * context or transform user tables. Known delegated credentials may be supplied
 * by the owning agent. No environment is enumerated by this helper. */
export function sanitizeDiagnosticText(text: string, secrets: readonly string[] = []): string {
  const preserveLines = (original: string, replacement: string) =>
    replacement +
    "\n".repeat(Math.max(0, (original.match(/\n/g)?.length ?? 0) - (replacement.match(/\n/g)?.length ?? 0)));
  let result = text;
  for (const secret of secrets)
    if (secret.length >= 4) result = result.split(secret).join(preserveLines(secret, "[redacted]"));
  return result
    .replace(/environ\(\{[\s\S]*?\}\)/g, value => preserveLines(value, "[environment dump redacted]"))
    .replace(/\bBearer\s+[^\s"',;}]+/gi, value => preserveLines(value, "Bearer [redacted]"))
    .replace(
      /\b((?:[\w]*(?:API_?KEY|PASSWORD|SECRET|ACCESS_?TOKEN|AUTH_?TOKEN)|token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      (value, prefix) => preserveLines(value, `${prefix}[redacted]`)
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted JWT]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@");
}

function clipped(value: string, limit: number): string {
  const marker = " …[omitted]";
  return value.length <= limit ? value : value.slice(0, Math.max(0, limit - marker.length)) + marker;
}

/** Repair hint per code, rendered after the message in every receipt. */
export const REPAIR_HINTS: Record<string, string> = {
  // Program / arguments
  PROGRAM_SYNTAX: "Fix this statement at the reported line and resubmit it alone; the other statements already landed.",
  INVALID_ARGUMENTS: "Fix the named argument to match the signature; nothing about the data has been checked yet.",
  OPERATOR_UNAVAILABLE: "Use one of the catalog operators; the engine has no other implementation.",
  OPERATOR_ID: "Table names are Python identifiers: letters, digits and underscores, not starting with a digit.",
  INPUT_PORTS: "Pass exactly the number of input tables this operator takes, as positional arguments.",
  DTYPE: "Use one of str, int64, float64, bool, datetime.",
  PROJECT_OPTIONS: "Use keep OR drop (not both) and/or rename; each names existing columns.",
  CAST_OPTIONS: 'format and timezone apply to datetime only; errors is "raise" or "null".',
  AGGREGATE_ARGUMENT: "Every output is name=reducer(col); only count() may omit the column.",
  JOIN_ARGUMENT: "how is inner/left/right/full/cross; validate is many_to_many/many_to_one/one_to_many/one_to_one.",
  JOIN_KEYS: "Name the keys explicitly with on=; a cross join takes none. Keys are never inferred.",
  UNION_ARGUMENT: 'schema is "strict" (identical columns) or "align" (absent columns become null).',
  DISTINCT_ARGUMENT: 'keep is "first" or "last"; columns lists the key columns, or omit it for whole-row distinct.',
  SORT_ARGUMENT: 'by lists column names or (column, "asc"|"desc") pairs; nulls is "first" or "last".',
  LIMIT_ARGUMENT: "n is a positive integer and offset a non-negative one; sort first for a top-k.",
  WINDOW_ARGUMENT: "Outputs are name=lag/lead(col, offset) or name=row_number/rank/dense_rank(); order_by is required.",
  UNPIVOT_ARGUMENT: "List the columns to unpivot; name and value are the two new columns.",
  PIVOT_ARGUMENT: "index, columns and values must be distinct existing columns; aggregate first if pairs repeat.",
  SCAN_OPTIONS: "Check the scan options against the signature; names needs header=False.",
  SCAN_FORMAT: "Set format= explicitly when the extension does not identify the file type.",
  // Custom code
  PYTHON_SYNTAX: "Repair the submitted Python source at the reported line.",
  CALLBACK_SIGNATURE: "Use the entry/signature required by this operator; do not change generated code.",
  CALLBACK_RUNTIME: "Repair the submitted function and relevant input handling before retrying.",
  CALLBACK_RETURN_TYPE: "Return the declared scalar type or None, not a table or truthy substitute.",
  PYTHON_IMPORT: "Check package availability or import names; changing a predicate will not install a package.",
  PROCESS_RETURN_TYPE: "Return one pandas DataFrame from the process function.",
  MAP_SCHEMA:
    'Return the same keys from every row; use {**row, "column": value} to keep the input columns and add one.',
  OUTPUT_SCHEMA: "Return unique string column names.",
  OUTPUT_VALUE_TYPE:
    "Return scalar cells of one type per column: finite numbers, strings, booleans, UTC datetimes or None.",
  ROW_CONTRACT: "This operator must keep every input row; use filter or process to change the row count.",
  // Data (execute / contract)
  MISSING_COLUMN: "Observe the current input schema and update the referenced column.",
  COLUMN_COLLISION: "Choose unique output names; do not silently overwrite another column.",
  CAST_INVALID_VALUE: 'Normalize the input or explicitly choose errors="null" if losing those values is intended.',
  AGGREGATE_TYPE: "Cast the column to a numeric type first; sum/mean/stddev/median need numbers.",
  AGGREGATE_RANGE: "The reduced value does not fit the output type; use float64 or a smaller population.",
  JOIN_TYPE: "Cast both key columns to the same type before joining.",
  JOIN_CARDINALITY: "Inspect key uniqueness and the intended join; do not silently deduplicate.",
  UNION_SCHEMA: 'Project or rename the inputs to identical columns, or use schema="align".',
  UNION_TYPE: "Cast the named column to one type in every input before union.",
  UNPIVOT_TYPE: "Cast the selected columns to one type before unpivot.",
  PIVOT_NULL_KEY: "Filter or fill the null pivot keys first; decide what they mean.",
  PIVOT_DUPLICATE: "Aggregate first only if combining duplicate pairs is intended.",
  SCAN_NOT_FOUND: "Check the path or glob against the listed data files.",
  SCAN_HEADER: "Preview the raw lines, then set skip_lines/header/names to match the file layout.",
  SCAN_NAMES: "Provide exactly one name per column.",
  SCAN_PARSE:
    "Preview the raw lines and set delim/skip_lines/encoding to match; malformed rows are not skipped silently.",
  // Producer boundary
  INPUT_VALUE_TYPE: "Repair the producing operator's values; the consumer function has not run.",
  INPUT_SCHEMA: "Repair the producing operator's column names; the consumer function has not run.",
  INPUT_TABLE_TYPE: "The producing operator must return a pandas DataFrame.",
  UPSTREAM_FAILED: "Repair the root failure named in the message; this consumer did not run.",
};

/** Verify structured source attribution against the event's operator definition.
 * No current-source substitution on mismatch; unknown engine failures stay
 * distinct from user-code compile/contract failures. */
export function resolveNativeDiagnostic(
  op: OperatorPredicate,
  error: string,
  resolveOperator?: (id: string) => OperatorPredicate | undefined
): NativeDiagnostic {
  const base = {
    version: 1 as const,
    operatorId: op.operatorID,
    operatorRevision: op.nativeOp?.revision ?? "unversioned",
  };
  const parsed = parseNativeDiagnostic(error);
  if (parsed) {
    const origin = parsed.operatorId === op.operatorID ? op : resolveOperator?.(parsed.operatorId);
    if (origin?.nativeOp?.revision === parsed.operatorRevision) {
      if (origin.nativeOp.type === "Scan" && parsed.code === "UNION_TYPE")
        return {
          ...parsed,
          hint: "Set all_text=True in this scan and cast its output, or scan and cast each file before union.",
        };
      return parsed;
    }
    return {
      ...base,
      code: "DIAGNOSTIC_BINDING_MISMATCH",
      stage: "infrastructure",
      message: "The error payload does not match an available operator revision; source attribution is withheld.",
      hint: "Inspect the pinned diagnostic/execution before retrying; do not use today's source for this payload.",
      retryable: false,
    };
  }
  const raw = sanitizeDiagnosticText(error);
  if (/V2 requires a backend with/.test(raw))
    return {
      ...base,
      code: "BACKEND_CAPABILITY",
      stage: "infrastructure",
      message: clipped(raw, 320),
      hint: "Deploy the matching V2 engine/API; changing operator Python cannot add a backend capability.",
      retryable: false,
    };
  if (/Execution request failed:\s*(?:401|403)\b/i.test(raw))
    return {
      ...base,
      code: "WORKFLOW_AUTHORIZATION",
      stage: "infrastructure",
      message: "Texera denied execution access.",
      hint: "Check the delegated token and workflow permission; do not rewrite the computation.",
      retryable: false,
    };
  if (/Execution request failed:\s*(?:429|5\d\d)\b/i.test(raw))
    return {
      ...base,
      code: "BACKEND_UNAVAILABLE",
      stage: "infrastructure",
      message: clipped(raw, 320),
      hint: "Check backend health/rate limits before retrying unchanged code.",
      retryable: true,
    };
  // The result store refused a connection (Postgres 53300 while many workers
  // start) or a worker could not open an operator's stored input: the engine
  // was overloaded, not the operator's code at fault.
  const store = /Could not open the stored input [^\n]*|too many clients already/.exec(raw);
  if (store)
    return {
      ...base,
      code: "BACKEND_UNAVAILABLE",
      stage: "infrastructure",
      message: clipped(
        store[0].startsWith("Could not")
          ? store[0]
          : "The engine's result store refused a connection: sorry, too many clients already.",
        320
      ),
      hint: "Check backend health/rate limits before retrying unchanged code.",
      retryable: true,
    };
  // The engine's report of a Python worker process that ended mid-run
  // (PythonWorkflowWorker.unexpectedExitMessage). It names the operator whose
  // worker died; every unfinished operator of the run carries the same text.
  const exited = /The Python worker for operator \S+ exited with code (\d+)[^\n]*/.exec(raw);
  if (exited)
    return {
      ...base,
      code: "WORKER_EXITED",
      stage: "infrastructure",
      message: clipped(exited[0], 320),
      hint:
        Number(exited[1]) > 128
          ? "A worker killed by a signal usually ran out of memory; retrying unchanged may fail the same way. Make that operator hold fewer rows or columns."
          : "The worker process crashed; inspect that operator's inputs before retrying unchanged code.",
      retryable: true,
    };
  if (/input_port_materialization_reader_runnable\.py|Error reading cached input/.test(raw))
    return {
      ...base,
      code: "CACHE_INPUT_READ",
      stage: "infrastructure",
      message: clipped(raw.trim().split("\n").at(-1) ?? raw, 320),
      hint: "Check the stored input. Restore its materialization or recompute the producer before retrying.",
      retryable: false,
    };
  // Tracebacks can contain fut.result(timeout) even for a FileNotFoundError.
  // Require a deadline report, rather than the name of a library parameter.
  if (
    /\btimed?\s+out\b|\bTimeoutError\b|\bEXECUTION_TIMEOUT\b|\btimeout\s+after\b|\bkilled\s*\(timeout\)|\b(?:request|execution|workflow|engine|worker|operation|connection)\s+timeout\b/i.test(
      raw
    )
  )
    return {
      ...base,
      code: "EXECUTION_TIMEOUT",
      stage: "infrastructure",
      message: "Execution timed out before this operator produced a usable result.",
      hint: "Check worker health and execution size before deciding whether to retry.",
      retryable: true,
    };
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|worker.*(?:died|death|unavailable)|connection.*(?:refused|closed)/i.test(raw))
    return {
      ...base,
      code: "WORKER_UNAVAILABLE",
      stage: "infrastructure",
      message: clipped(raw, 320),
      hint: "Check the backend/worker connection before retrying unchanged code.",
      retryable: true,
    };
  if (/ModuleNotFoundError|ImportError/.test(raw))
    return { ...base, code: "PYTHON_IMPORT", stage: "infrastructure", message: clipped(raw, 320), retryable: false };
  return {
    ...base,
    code: "EXECUTION_ERROR",
    stage: "execute",
    message: clipped(raw.replace(/\(line \d+\) `[^`]*` - /g, ""), 320),
    hint: "Inspect this pinned error for details before changing the computation.",
  };
}

/** Decode the runtime's machine payload in the engine error channel, not a
 * rendered display string. Ignore incomplete/unrecognized payloads and retain
 * the raw error. Quoted/escaped user braces must not terminate the object. */
export function parseNativeDiagnostic(error: string): NativeDiagnostic | undefined {
  const marker = "NATIVE_ERROR_V2:";
  let offset = 0;
  for (;;) {
    const start = error.indexOf(marker, offset);
    if (start < 0) return undefined;
    const begin = start + marker.length;
    offset = begin;
    if (error[begin] !== "{") continue;
    let depth = 0,
      quoted = false,
      escaped = false;
    for (let end = begin; end < Math.min(error.length, begin + 4096); end++) {
      const character = error[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{") depth++;
      else if (character === "}" && --depth === 0) {
        try {
          const value = JSON.parse(error.slice(begin, end + 1));
          if (
            value.version !== 1 ||
            typeof value.operatorId !== "string" ||
            typeof value.operatorRevision !== "string" ||
            typeof value.code !== "string" ||
            typeof value.message !== "string" ||
            !["validate", "compile", "execute", "contract", "dependency", "infrastructure"].includes(value.stage)
          )
            break;
          if (value.field !== undefined && typeof value.field !== "string") break;
          if (
            value.source !== undefined &&
            (!value.source ||
              typeof value.source.entry !== "string" ||
              !Number.isSafeInteger(value.source.line) ||
              value.source.line < 1 ||
              typeof value.source.excerpt !== "string" ||
              (value.source.column !== undefined &&
                (!Number.isSafeInteger(value.source.column) || value.source.column < 0)))
          )
            break;
          return {
            version: 1,
            operatorId: value.operatorId,
            operatorRevision: value.operatorRevision,
            code: value.code,
            stage: value.stage,
            message: value.message,
            ...(value.field !== undefined ? { field: value.field } : {}),
            ...(value.source !== undefined ? { source: value.source } : {}),
            ...(typeof value.hint === "string" ? { hint: value.hint } : {}),
            ...(typeof value.retryable === "boolean" ? { retryable: value.retryable } : {}),
          };
        } catch {
          break;
        }
      }
    }
  }
}

export function formatNativeDiagnostic(diagnostic: NativeDiagnostic): string {
  // Mandatory identities are never shortened. The bounded detail allowance is
  // separate from that structural envelope, as with operator/receipt headers.
  const header = `[${diagnostic.code}; ${diagnostic.stage}; revision ${diagnostic.operatorRevision}]`;
  const hint = diagnostic.hint ?? REPAIR_HINTS[diagnostic.code];
  const details = [clipped(sanitizeDiagnosticText(diagnostic.message), 400)];
  if (hint) details.push(`Hint: ${clipped(sanitizeDiagnosticText(hint), 220)}`);
  if (diagnostic.field) details.push(`Field: ${clipped(sanitizeDiagnosticText(diagnostic.field), 100)}`);
  if (diagnostic.source) {
    const source = diagnostic.source;
    details.push(
      `${clipped(sanitizeDiagnosticText(source.entry), 50)} line ${source.line}${source.column === undefined ? "" : ` column ${source.column}`}: ${clipped(sanitizeDiagnosticText(source.excerpt.trim()), 180)}`
    );
  }
  if (diagnostic.retryable !== undefined)
    details.push(
      `${diagnostic.stage === "infrastructure" ? "Infrastructure retryable" : "Retryable unchanged"}: ${diagnostic.retryable}`
    );
  return `${header} ${clipped(details.join("\n"), NATIVE_DIAGNOSTIC_CHARS)}`;
}
