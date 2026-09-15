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

const REPAIR_HINTS: Record<string, string> = {
  PYTHON_SYNTAX: "Repair the submitted Python source at the reported line.",
  CALLBACK_SIGNATURE: "Use the entry/signature required by this operator; do not change generated code.",
  CALLBACK_RUNTIME: "Repair the submitted function and relevant input handling before retrying.",
  CALLBACK_RETURN_TYPE: "Return the declared scalar type or None, not a table or truthy substitute.",
  UNDECLARED_COLUMN: "Declare every callback input column and use its exact name.",
  CAST_INVALID_VALUE: "Normalize the input or explicitly choose errors:null if losing those values is intended.",
  MISSING_COLUMN: "Observe the current input schema and update the referenced column.",
  COLUMN_COLLISION: "Choose unique output names; do not silently overwrite another column.",
  JOIN_CARDINALITY: "Inspect key uniqueness and the intended join; do not silently deduplicate.",
  PIVOT_DUPLICATE: "Aggregate first only if combining duplicate pairs is intended.",
  PYTHON_IMPORT: "Check package availability or import names; changing a predicate will not install a package.",
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
    if (origin?.nativeOp?.revision === parsed.operatorRevision) return parsed;
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
  if (/timed?\s*out|timeout/i.test(raw))
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
