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

import type { PathNode } from "../../../util/context-utils";

/**
 * SELECT reinjection rung — "error reflection", FOLDED INTO THE OPERATOR.
 *
 * LATEST shows only the leaf snapshot, so it folds away an operator's *past*
 * attempts and the errors each produced. The model is told (system prompt) to
 * change strategy after repeated failures — but in LATEST it can't see that it is
 * on attempt N with the same error, so a weak model resubmits a near-identical
 * edit until the step cap (the observed loader/operator death-loops).
 *
 * This rung recovers the missing evidence and renders it **inside the failing
 * operator's own block** in `# Current Dataflow` (the operator stays in the DAG —
 * no separate section, no quarantine). For an op that has errored across attempts:
 *   - attempt count + deduped error signatures (with a "same error repeating →
 *     blocked, change strategy" verdict);
 *   - the **code diff of the last attempt vs the previous one** (changed lines
 *     only) — surfaces trivial-variation churn far more cheaply than full code;
 *   - the operator's **input schema** is rendered by the serializer alongside this.
 *
 * Pure: derives only from the path.
 */

/** Default N: consecutive same-operator (re)fixing attempts before the folded
 *  error/attempt history is included. Overridable per-run via errorReflectionThreshold. */
export const DEFAULT_REFLECTION_THRESHOLD = 3;
/** Distinct error signatures listed (most recent first). */
const MAX_DISTINCT_ERRORS = 3;
/** Per-error first-line cap. */
const ERR_MAX_CHARS = 160;
/** Cap on diff lines shown (each side). */
const MAX_DIFF_LINES = 12;

export interface ErrorReflectionEntry {
  /** total createOrModifyOperator calls on this op along the path. */
  attempts: number;
  /** of those, how many returned an error / rejection. */
  erroredAttempts: number;
  /** distinct error first-lines, most-recent-first, capped. */
  distinctErrors: string[];
  /** the last >= 2 errored attempts produced the SAME first-line. */
  repeating: boolean;
  /** code submitted on each attempt, in order (for diffing the last two). */
  codes: string[];
  /** longest run of BACK-TO-BACK edits to this op (the "stuck on it" signal). */
  consecutive: number;
}

function firstErrorLine(output: unknown): string | undefined {
  const txt = typeof output === "string" ? output : output ? JSON.stringify(output) : "";
  const m = /\[ERROR\][^\n]*/.exec(txt);
  if (!m) return undefined;
  const line = m[0].replace(/\s+/g, " ").trim();
  return line.length <= ERR_MAX_CHARS ? line : line.slice(0, ERR_MAX_CHARS - 1) + "…";
}

/** Walk the path once, accumulating per-operator attempt/error/code history. */
export function buildErrorReflection(fullPath: PathNode[]): Map<string, ErrorReflectionEntry> {
  const seq = new Map<string, { err: string | undefined; code: string }[]>();
  const order: string[] = []; // global edit order, for consecutive-run counting

  for (const node of fullPath) {
    const step = node.step;
    if (step.role !== "agent") continue;
    const calls = step.toolCalls ?? [];
    const trs = step.toolResults ?? [];
    calls.forEach((tc, i) => {
      if (tc.toolName !== "createOrModifyOperator") return;
      const inp = (tc.input ?? {}) as Record<string, unknown>;
      const opId = typeof inp.operatorId === "string" ? inp.operatorId : "";
      if (!opId) return;
      const tr = trs[i];
      const isErr = !!(tr && (tr as any).isError) || !!firstErrorLine(tr?.output);
      const code = typeof inp.code === "string" ? inp.code : "";
      const arr = seq.get(opId) ?? [];
      arr.push({ err: isErr ? (firstErrorLine(tr?.output) ?? "[ERROR] (unspecified)") : undefined, code });
      seq.set(opId, arr);
      order.push(opId);
    });
  }

  // Longest run of back-to-back edits to each op (N "consecutive fixing attempts").
  const maxConsecutive = new Map<string, number>();
  let runOp: string | null = null;
  let runLen = 0;
  for (const op of order) {
    if (op === runOp) runLen++;
    else { runOp = op; runLen = 1; }
    maxConsecutive.set(op, Math.max(maxConsecutive.get(op) ?? 0, runLen));
  }

  const out = new Map<string, ErrorReflectionEntry>();
  for (const [opId, arr] of seq) {
    const errs = arr.map(a => a.err).filter((e): e is string => e !== undefined);
    const distinct: string[] = [];
    for (let i = arr.length - 1; i >= 0; i--) {
      const e = arr[i].err;
      if (e && !distinct.includes(e)) distinct.push(e);
      if (distinct.length >= MAX_DISTINCT_ERRORS) break;
    }
    const lastTwo = errs.slice(-2);
    const repeating = lastTwo.length === 2 && lastTwo[0] === lastTwo[1];
    out.set(opId, {
      attempts: arr.length,
      erroredAttempts: errs.length,
      distinctErrors: distinct,
      repeating,
      codes: arr.map(a => a.code),
      consecutive: maxConsecutive.get(opId) ?? 0,
    });
  }
  return out;
}

/** Minimal line diff: the lines removed (from prev) and added (in curr). */
function lineDiff(prev: string, curr: string): { removed: string[]; added: string[] } {
  const a = prev.split("\n");
  const b = curr.split("\n");
  const bSet = new Set(b);
  const aSet = new Set(a);
  const removed = a.filter(l => l.trim() && !bSet.has(l));
  const added = b.filter(l => l.trim() && !aSet.has(l));
  return { removed, added };
}

/**
 * Render the attempt/error history lines to fold INTO the operator's block.
 * Returns [] when the op hasn't churned enough. The op's current error and code
 * are already shown by the serializer (Result/[ERROR]); this adds only the
 * history the serializer can't see: count, repeated-error verdict, last diff.
 */
export function renderFoldedError(entry: ErrorReflectionEntry | undefined): string[] {
  if (!entry) return [];
  const { attempts, erroredAttempts, distinctErrors, repeating, codes } = entry;
  const lines: string[] = [];

  // Plain facts, in the tool's own vocabulary ("modify"/"no-op"/"fails") — no
  // editorializing verdict (the steering instruction lives in the system prompt).
  const t = attempts === 1 ? "time" : "times";
  let head = `You have modified this operator ${attempts} ${t}; ${erroredAttempts} failed with an error.`;
  if (erroredAttempts >= 2 && repeating) head += " The last modifications failed with the same error.";
  lines.push(head);

  // Code diff: current vs the previous modification.
  if (codes.length >= 2) {
    const { removed, added } = lineDiff(codes[codes.length - 2], codes[codes.length - 1]);
    if (removed.length || added.length) {
      lines.push("Diff from your previous modification:");
      for (const l of removed.slice(0, MAX_DIFF_LINES)) lines.push(`  - ${l.trim()}`);
      for (const l of added.slice(0, MAX_DIFF_LINES)) lines.push(`  + ${l.trim()}`);
    } else {
      lines.push("Your last modification used the same code as the one before it (a no-op).");
    }
  }

  if (distinctErrors.length > 1) {
    lines.push("Errors so far (most recent first):");
    for (const e of distinctErrors) lines.push(`  - ${e}`);
  }
  return lines;
}
