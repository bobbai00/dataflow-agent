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
 * SELECT reinjection rung — "error reflection".
 *
 * LATEST shows only the leaf snapshot, so it folds away an operator's *past*
 * attempts and the errors each produced. The model is told (system prompt) to
 * "change strategy after 2 failed attempts" — but in LATEST it can't see that
 * it is on attempt N with the same error, so a weak model resubmits a
 * byte-identical edit until the step cap (the observed loader/operator death-
 * loops). This rung recovers the missing evidence: per operator, how many times
 * it was (re)written, how many errored, the DISTINCT error signatures seen, and
 * whether the recent attempts are REPEATING (same error → blocked) — rendered
 * only for operators that are actually churning, inside the end-of-context
 * "Operators needing attention" section (composes with the lineage lines on the
 * same operator). Pure: derives only from the path.
 */

/** Min (re)writes before an operator's reflection is shown. Matches the prompt's
 *  "change strategy after 2 failed attempts" — a 3rd attempt is where it helps. */
export const REFLECTION_MIN_ATTEMPTS = 3;
/** Min errored attempts to trigger the crash-loop ("blocked") reflection. */
const MIN_ERRORED_ATTEMPTS = 2;
/** Distinct error signatures listed (most recent first). */
const MAX_DISTINCT_ERRORS = 3;
/** Per-error first-line cap. */
const ERR_MAX_CHARS = 160;

export interface ErrorReflectionEntry {
  /** total createOrModifyOperator calls on this op along the path. */
  attempts: number;
  /** of those, how many returned an error / rejection. */
  erroredAttempts: number;
  /** distinct error first-lines, most-recent-first, capped. */
  distinctErrors: string[];
  /** the last >= 2 errored attempts produced the SAME first-line. */
  repeating: boolean;
}

function firstErrorLine(output: unknown): string | undefined {
  const txt = typeof output === "string" ? output : output ? JSON.stringify(output) : "";
  const m = /\[ERROR\][^\n]*/.exec(txt);
  if (!m) return undefined;
  const line = m[0].replace(/\s+/g, " ").trim();
  return line.length <= ERR_MAX_CHARS ? line : line.slice(0, ERR_MAX_CHARS - 1) + "…";
}

/** Walk the path once, accumulating per-operator attempt/error history. */
export function buildErrorReflection(fullPath: PathNode[]): Map<string, ErrorReflectionEntry> {
  // operatorId → ordered list of error first-lines (undefined = a non-error attempt)
  const seq = new Map<string, (string | undefined)[]>();

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
      const arr = seq.get(opId) ?? [];
      arr.push(isErr ? (firstErrorLine(tr?.output) ?? "[ERROR] (unspecified)") : undefined);
      seq.set(opId, arr);
    });
  }

  const out = new Map<string, ErrorReflectionEntry>();
  for (const [opId, arr] of seq) {
    const errs = arr.filter((e): e is string => e !== undefined);
    // distinct, most-recent-first
    const distinct: string[] = [];
    for (let i = arr.length - 1; i >= 0; i--) {
      const e = arr[i];
      if (e && !distinct.includes(e)) distinct.push(e);
      if (distinct.length >= MAX_DISTINCT_ERRORS) break;
    }
    // repeating = the last two errored attempts share a first-line
    const lastTwo = errs.slice(-2);
    const repeating = lastTwo.length === 2 && lastTwo[0] === lastTwo[1];
    out.set(opId, {
      attempts: arr.length,
      erroredAttempts: errs.length,
      distinctErrors: distinct,
      repeating,
    });
  }
  return out;
}

/**
 * Render the per-operator reflection lines for the flow section, or [] when the
 * operator hasn't churned enough to warrant it. Two shapes:
 *   - crash/blocked loop (errors repeating): say it's blocked → change strategy.
 *   - semantic churn (rewritten, no errors): the result is wrong, not crashing.
 */
export function renderErrorReflection(entry: ErrorReflectionEntry | undefined): string[] {
  if (!entry || entry.attempts < REFLECTION_MIN_ATTEMPTS) return [];
  const { attempts, erroredAttempts, distinctErrors, repeating } = entry;
  const lines: string[] = [];

  if (erroredAttempts >= MIN_ERRORED_ATTEMPTS) {
    const verdict = repeating
      ? "the recent attempts returned the SAME error — this approach is BLOCKED. Do not resubmit a near-variant; change strategy (fix the root cause, restructure the logic, or use a different operator/input)."
      : "the errors are still changing — make sure each edit addresses the actual error, not a guess.";
    lines.push(`Attempts: rewritten ${attempts}× (${erroredAttempts} errored). ${verdict}`);
    if (distinctErrors.length > 0) {
      lines.push("Distinct errors seen (most recent first):");
      for (const e of distinctErrors) lines.push(`  - ${e}`);
    }
  } else {
    // edited many times but rarely/never errored → semantic thrashing
    lines.push(
      `Attempts: rewritten ${attempts}× with no execution error — the output is likely semantically WRONG, not crashing. Re-check the upstream input schema/values and this operator's actual Result above rather than rewriting the code again.`
    );
  }
  return lines;
}
