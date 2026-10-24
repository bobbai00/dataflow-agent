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
 * Operators a final reply hands over. A reply can name result tables in a JSON
 * object (a file-to-operator mapping, such as `{"output_01.csv": "o1"}`); the
 * caller then reads those operators' stored results. `set` only declares an
 * operator and `show result` computes a table and its ancestors, so a table
 * declared below the last one shown has no result unless something computes it.
 */
import type { OperatorPredicate } from "../../types/workflow";
import type { OperatorInfo } from "../../types/execution";

/** Operator IDs given as string values of the JSON objects in a reply, in
 * order of first appearance; only IDs of operators that exist count. */
export function namedOperatorIds(text: string, known: ReadonlySet<string>): string[] {
  const named: string[] = [];
  for (const match of text.match(/\{[^{}]*\}/g) ?? []) {
    let value: unknown;
    try {
      value = JSON.parse(match);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const item of Object.values(value))
      if (typeof item === "string" && known.has(item) && !named.includes(item)) named.push(item);
  }
  return named;
}

/** A completed result of the operator's current definition. */
export function hasCurrentResult(op: OperatorPredicate | undefined, info: OperatorInfo | undefined): boolean {
  if (!op || !info || info.error || !["Completed", "CompletedFromCache"].includes(info.state)) return false;
  const revision = op.nativeOp?.revision;
  const resultRevision = info.resultVersion?.operatorRevision;
  return !(revision && resultRevision && resultRevision !== revision);
}

/** The correction for a reply that names tables still without a result. */
export function namedResultsFeedback(missing: ReadonlyArray<{ id: string; error?: string }>): string {
  const ids = missing.map(item => `\`${item.id}\``).join(", ");
  const errors = missing
    .filter(item => item.error)
    .map(item => `\`${item.id}\`: ${item.error}`)
    .join("; ");
  return (
    `Your reply names ${ids}, which ${missing.length === 1 ? "has" : "have"} no result: ` +
    (errors ? `computing ${missing.length === 1 ? "it" : "them"} failed (${errors}). ` : "nothing computed it. ") +
    "Fix the graph with the dataflow tool, show the table, then reply again."
  );
}
