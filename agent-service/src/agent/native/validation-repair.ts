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

import { createHash } from "node:crypto";
import { sanitizeDiagnosticText, type NativeDiagnostic, type NativeErrorSummary } from "./diagnostics";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)])
    );
  return value;
}

function fingerprint(op: string, params: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify([op, canonical(params)]))
    .digest("hex");
}

/** A minimal JSON-schema example, never copied from submitted arguments. Code
 * fields deliberately contain placeholders rather than callback bodies. This
 * illustrates shape only: callers must choose real input/column names/source. */
export function nativeSchemaExample(schema: Record<string, any>, field = "value", index = 0): unknown {
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  const variant = schema.oneOf?.[0] ?? (schema.type ? undefined : schema.anyOf?.[0]);
  if (variant) return nativeSchemaExample(variant, field, index);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "object") {
    const required = new Set<string>([...(schema.required ?? []), ...(schema.anyOf?.[0]?.required ?? [])]);
    const entries = [...required].map(name => [name, nativeSchemaExample(schema.properties[name], name)]);
    if (!entries.length && schema.minProperties)
      entries.push(["column", nativeSchemaExample(schema.additionalProperties, "value")]);
    return Object.fromEntries(entries);
  }
  if (type === "array")
    return Array.from({ length: schema.minItems ?? 0 }, (_, i) => nativeSchemaExample(schema.items, field, i));
  if (type === "integer" || type === "number") return schema.minimum ?? 0;
  if (type === "boolean") return false;
  if (type === "null") return null;
  if (field === "func" || field === "code") return "<Python source>";
  const example =
    field === "id" ? "operator_id" : ["input", "left", "right", "inputs"].includes(field) ? "input_id" : "column";
  return example + (index ? String(index + 1) : "");
}

interface Failure {
  pattern: string;
  diagnostic: NativeDiagnostic;
  example: string;
}

interface OperatorFailures {
  counts: Map<string, number>;
  submissions: Map<string, Failure>;
  currentDiagnosticId?: string;
}

/** Owned by one agent and cleared at task/branch boundaries. Only fingerprints
 * and bounded diagnostics are retained, never submitted callback bodies. Graph
 * and infrastructure failures must not enter this tracker: another edit or a
 * recovered service can make identical arguments valid without inspection. */
export class NativeValidationRepair {
  private readonly operators = new Map<string, OperatorFailures>();
  private generation = 0;

  get epoch(): number {
    return this.generation;
  }

  clear(operatorId?: string): void {
    if (operatorId === undefined) {
      this.operators.clear();
      this.generation++;
    } else this.operators.delete(operatorId);
  }

  record(
    op: string,
    params: Record<string, unknown>,
    diagnostic: NativeDiagnostic,
    signature: string,
    pattern = JSON.stringify([diagnostic.stage, diagnostic.code, diagnostic.field])
  ): NativeDiagnostic {
    const id = diagnostic.operatorId;
    let entry = this.operators.get(id);
    if (!entry) {
      entry = { counts: new Map(), submissions: new Map() };
      this.operators.set(id, entry);
    }
    const key = `${op}:${pattern}`;
    const count = (entry.counts.get(key) ?? 0) + 1;
    entry.counts.set(key, count);
    // Until post-step capture binds this submission, an older inspection is
    // never allowed to acknowledge the new failure.
    entry.currentDiagnosticId = undefined;
    const { source, hint: _hint, ...identity } = diagnostic;
    const failure: Failure = {
      pattern: key,
      diagnostic: {
        ...identity,
        message: sanitizeDiagnosticText(diagnostic.message).slice(0, 180),
        // Keep coordinates for revision-pinned inspection, but leave the
        // source text in the existing private diagnostic record only.
        ...(source ? { source: { ...source, excerpt: "" } } : {}),
      },
      example: signature,
    };
    entry.submissions.set(fingerprint(op, params), failure);
    return count >= 2 ? this.render(failure, count, false) : diagnostic;
  }

  blocked(op: string, params: Record<string, unknown>): NativeDiagnostic | undefined {
    if (typeof params.id !== "string") return;
    const entry = this.operators.get(params.id);
    const failure = entry?.submissions.get(fingerprint(op, params));
    if (!entry || !failure) return;
    const count = entry.counts.get(failure.pattern) ?? 0;
    return count >= 2 ? this.render(failure, count, true) : undefined;
  }

  bind(op: string, params: Record<string, unknown>, summary: NativeErrorSummary): void {
    const entry = this.operators.get(summary.operatorId);
    if (entry?.submissions.has(fingerprint(op, params))) entry.currentDiagnosticId = summary.diagnosticId;
  }

  acknowledge(summary: NativeErrorSummary): void {
    if (this.operators.get(summary.operatorId)?.currentDiagnosticId === summary.diagnosticId)
      this.clear(summary.operatorId);
  }

  private render(failure: Failure, count: number, blocked: boolean): NativeDiagnostic {
    const prefix = `${blocked ? "Identical invalid submission paused" : `Repeated validation failure (${count})`}: `;
    const example = `\nSignature: ${failure.example}`;
    // Preserve the complete schema example inside the diagnostic renderer's
    // 400-character message allowance; field/hint have their own allowances.
    const detail = failure.diagnostic.message.slice(0, Math.max(0, 400 - prefix.length - example.length));
    return {
      ...failure.diagnostic,
      message: `${prefix}${detail}${example}`,
      hint: "An identical resubmission stays paused; submit corrected arguments that follow the signature and the diagnostic above.",
      retryable: false,
    };
  }
}
