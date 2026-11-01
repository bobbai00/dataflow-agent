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
import type { OperatorInfo } from "../../types/execution";
import type { OperatorPredicate, WorkflowContent } from "../../types/workflow";
import {
  parseNativeDiagnostic,
  resolveNativeDiagnostic,
  sanitizeDiagnosticText,
  type NativeDiagnostic,
  type NativeErrorSummary,
} from "./diagnostics";

export interface NativeDiagnosticRecord extends NativeErrorSummary {
  inputs: Array<{
    inputIndex: number;
    operatorId: string;
    operatorRevision: string | null;
    resultVersion: string | null;
  }>;
  /** Already sanitized and bounded; no console logs, locals or environment dumps. */
  traceback: string;
  tracebackComplete: boolean;
  submittedSource?: { field: string; text: string; complete: boolean; originalLines: number };
}

export interface DiagnosticCapture {
  stepId: string;
  op: OperatorPredicate;
  workflow: WorkflowContent;
  info: OperatorInfo;
  resolveInput: (id: string) => OperatorInfo | undefined;
  phase?: NativeErrorSummary["phase"];
  secrets?: readonly string[];
}

function sourceAt(op: OperatorPredicate, diagnostic: NativeDiagnostic): { field: string; text: string } | undefined {
  const view = op.nativeOp;
  if (!view || view.revision !== diagnostic.operatorRevision || op.operatorID !== diagnostic.operatorId) return;
  const field = diagnostic.field ?? (view.type === "Process" ? "code" : undefined);
  let source: unknown;
  if (field === "code" || field === "func") source = view.properties[field];
  else {
    const match = /^columns\[(\d+)\]\.func$/.exec(field ?? "");
    if (match && Array.isArray(view.properties.columns)) source = view.properties.columns[Number(match[1])]?.func;
  }
  return typeof source === "string" && field ? { field, text: source } : undefined;
}

export function captureNativeDiagnostic(input: DiagnosticCapture): NativeDiagnosticRecord {
  const { op, workflow, info, stepId } = input;
  const resolve = (id: string) => (id === op.operatorID ? op : workflow.operators.find(item => item.operatorID === id));
  let untrusted = resolveNativeDiagnostic(op, info.error ?? "Execution failed without a diagnostic.", resolve);
  if (input.phase === "attempt" && !parseNativeDiagnostic(info.error ?? ""))
    untrusted = {
      ...untrusted,
      stage: "validate",
      code: "EDIT_REJECTED",
      message: info.error ?? "The edit was rejected.",
      hint: "Repair the rejected operator arguments and resubmit; the stored definition was not changed.",
      retryable: false,
    };
  const clean = (value: string) => sanitizeDiagnosticText(value, input.secrets);
  const diagnostic: NativeDiagnostic = {
    ...untrusted,
    message: clean(untrusted.message),
    ...(untrusted.hint ? { hint: clean(untrusted.hint) } : {}),
    ...(untrusted.field ? { field: clean(untrusted.field) } : {}),
    ...(untrusted.source ? { source: { ...untrusted.source, excerpt: clean(untrusted.source.excerpt) } } : {}),
  };
  const origin = resolve(diagnostic.operatorId);
  const source =
    origin &&
    diagnostic.stage !== "dependency" &&
    diagnostic.code !== "DIAGNOSTIC_BINDING_MISMATCH" &&
    sourceAt(origin, diagnostic);
  const traceback = clean(info.error ?? "");
  const sourceText = source ? clean(source.text) : undefined;
  const identity = {
    operatorId: op.operatorID,
    operatorRevision: op.nativeOp?.revision ?? "unversioned",
    stepId,
    executionId: input.phase === "attempt" ? null : (info.executionContext?.executionId ?? null),
    phase: input.phase ?? "execution",
  };
  const record: NativeDiagnosticRecord = {
    ...identity,
    diagnosticId: `diag_${createHash("sha256")
      .update(JSON.stringify({ ...identity, diagnostic, traceback }))
      .digest("hex")
      .slice(0, 24)}`,
    diagnostic,
    inputs: (op.nativeOp?.inputs ?? []).map((id, inputIndex) => {
      const definition = workflow.operators.find(item => item.operatorID === id);
      const result = input.resolveInput(id);
      const binding = info.executionContext?.inputs?.find(
        item => item.inputPort === inputIndex && item.operatorId === id
      );
      const actual = result?.resultVersion;
      return {
        inputIndex,
        operatorId: id,
        operatorRevision: definition?.nativeOp?.revision ?? null,
        resultVersion:
          input.phase !== "attempt" &&
          binding?.executionId &&
          actual?.complete &&
          actual.executionId === binding.executionId &&
          actual.operatorRevision === definition?.nativeOp?.revision
            ? actual.id
            : null,
      };
    }),
    traceback: traceback.slice(0, 16384),
    tracebackComplete: traceback.length <= 16384,
    ...(source && sourceText !== undefined
      ? {
          submittedSource: {
            field: source.field,
            text: sourceText.slice(0, 12000),
            complete: sourceText.length <= 12000,
            originalLines: source.text.split("\n").length,
          },
        }
      : {}),
  };
  return record;
}

export function diagnosticSummary(record: NativeDiagnosticRecord): NativeErrorSummary {
  const { diagnosticId, operatorId, operatorRevision, stepId, executionId, phase, diagnostic } = record;
  return { diagnosticId, operatorId, operatorRevision, stepId, executionId, phase, diagnostic };
}
