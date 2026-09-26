/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * `lift` and the near-duplicate receipt (python/program_lift.py): the two
 * mechanisms that put the reuse decision at the turn it matters. The model
 * writes the specific def first and its variant many turns later; `lift`
 * turns the specific def into an operator with parameters after the fact,
 * and the receipt says when a new def is a variant of an existing one.
 */
import { runNativePython } from "./codegen";

export interface LiftRequest {
  /** The def to lift, by name (a shared function of the graph or a lifted one). */
  from: string;
  /** The operator's name; omitted, the def is revised in place. */
  as?: string;
  /** New parameter → the literal in the body it replaces (and its default). */
  params: Record<string, string | number | boolean | null>;
  /** The docstring, for a def that has none. */
  doc?: string;
}

export type LiftResult = { ok: true; source: string } | { ok: false; message: string };

export async function liftDefinition(source: string, request: LiftRequest): Promise<LiftResult> {
  return (await runNativePython({
    lift: { source, name: request.from, params: request.params, as: request.as, doc: request.doc },
  })) as LiftResult;
}

export interface NearDuplicate {
  /** The new def. */
  name: string;
  /** The existing def it is mostly the same as. */
  existing: string;
  ratio: number;
  /** What differs: names only, literals only, or structure. */
  kind: "names" | "literals" | "structure";
  /** For `literals`: (existing literal, new literal) pairs as written. */
  differences: Array<[string, string]>;
}

/** The closest existing def of each candidate that is at least 60% the same. */
export async function nearDuplicates(
  candidates: Record<string, string>,
  existing: Record<string, string>
): Promise<NearDuplicate[]> {
  if (!Object.keys(candidates).length || !Object.keys(existing).length) return [];
  const result = (await runNativePython({ nearDuplicates: { candidates, existing } })) as {
    ok: boolean;
    matches?: NearDuplicate[];
  };
  return result.matches ?? [];
}

/** A JSON literal as Python source. */
export function pythonLiteral(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pythonLiteral).join(", ")}]`;
  if (typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${JSON.stringify(k)}: ${pythonLiteral(v)}`)
      .join(", ")}}`;
  return String(value);
}

/** The receipt line for a near duplicate: the call or the lift that would
 * have replaced the new def. */
export function nearDuplicateNote(match: NearDuplicate): string {
  const pct = Math.round(match.ratio * 100);
  if (match.kind === "names")
    return `near-duplicate: \`${match.name}\` is the same code as \`${match.existing}\` up to names (${pct}% alike); call ${match.existing} instead of defining it again.`;
  if (match.kind === "literals" && match.differences.length) {
    const params = match.differences.map(([old], i) => `"value${i + 1}": ${old}`).join(", ");
    const call = match.differences.map(([, next], i) => `value${i + 1}=${next}`).join(", ");
    const diffs = match.differences.map(([old, next]) => `${old} → ${next}`).join(", ");
    return `near-duplicate: \`${match.name}\` differs from \`${match.existing}\` only in literals (${diffs}); next time lift ${match.existing} instead: lift=[{"from": "${match.existing}", "as": "${match.name}", "params": {${params}}}] (name the parameters as you like) then \`t = ${match.name}(..., ${call})\`.`;
  }
  return `near-duplicate: \`${match.name}\` is ${pct}% the same as \`${match.existing}\`; if it is ${match.existing} with one step changed, make that step a parameter (lift) or an operator both call.`;
}
