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
 * RESULT SELECTION — which operator results to ship to the model, at what
 * fidelity (`resultSelection: "rule"`).
 *
 * The agent wrote the parameters; the data wrote the results. Ship a result
 * only where the data, not the parameters, decided it. Native operators make
 * this decidable per type (catalog.ts `rowEffect`), and the engine's
 * per-table statistics say whether the data actually moved.
 *
 *   full    schema + stats + sample      Scan, Aggregate, Join, UDF outputs;
 *                                        the INPUT of any Aggregate / Join /
 *                                        UDF (its grain is what the consumer
 *                                        depends on, and this table is the
 *                                        last place it is visible); every
 *                                        frontier operator (no consumer yet —
 *                                        the table the agent is about to act
 *                                        on); anything errored or non-native.
 *   count   `Output Table: N rows (from M)`  Filter, Distinct, Union, Limit
 *                                        whose output feeds a row-preserving
 *                                        operator or another row-dropper.
 *   header  operator + Properties only   Project, Sort; Compute whose new /
 *                                        replaced columns have the same null
 *                                        and distinct counts as before.
 *
 * Between two shipped tables the operators fuse into one stage from the
 * agent's point of view: it sees the stage's input, the stage's output, and
 * one count per row-set change inside.
 */

import type { OperatorInfo } from "../../types/execution";
import type { OperatorLink, OperatorPredicate } from "../../types/workflow";

export type ResultShape = "full" | "count" | "header";

export interface ShapeDecision {
  shape: ResultShape;
  /** Compute only: which columns' null/distinct counts moved, rendered on the count line. */
  note?: string;
}

/** Consumers whose result depends on the grain of their input table. */
const GRAIN_SENSITIVE = new Set(["Aggregate", "Join", "UDF"]);

interface ColFacts {
  nulls?: number;
  distinct?: number;
}

function parseFacts(text: string | undefined): ColFacts | undefined {
  if (!text) return undefined;
  const n = /null=(\d+)/.exec(text);
  const d = /distinct=(\d+)/.exec(text);
  return { nulls: n ? Number(n[1]) : undefined, distinct: d ? Number(d[1]) : undefined };
}

/** `files` of a Scan as a list of path patterns. */
function scanFiles(op: OperatorPredicate): string[] {
  const f = op.nativeOp?.properties?.files;
  return Array.isArray(f) ? f.map(String) : typeof f === "string" ? [f] : [];
}

/** True when `path` is `pattern` or matches it as a glob (`*`, `?`, `**`). */
function globCovers(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  if (!/[*?[]/.test(pattern)) return false;
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|\\]/g, "\\$&")
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/\u0000/g, ".*") +
      "$"
  );
  return re.test(path);
}

/**
 * PROBE RETIREMENT — a `preview` Scan exists to inspect a file before its real
 * Scan. Once a real Scan covers the same file(s) and nothing reads the preview,
 * its raw lines are spent: render the header only, pointing at the real Scan.
 * An errored preview nobody reads collapses the same way, carrying the error's
 * first line. Independent of `resultSelection` (it is about probes, not about
 * what the data decided), so LATEST and DELTA both apply it.
 */
export function retiredPreviews(
  operators: readonly OperatorPredicate[],
  links: readonly OperatorLink[],
  getInfo: (opId: string) => OperatorInfo | undefined
): Map<string, ShapeDecision> {
  const out = new Map<string, ShapeDecision>();
  const hasConsumer = new Set(links.map(l => l.source.operatorID));
  const realScans = operators.filter(o => o.nativeOp?.type === "Scan" && !o.nativeOp.properties?.preview);
  for (const op of operators) {
    if (op.nativeOp?.type !== "Scan" || !op.nativeOp.properties?.preview || hasConsumer.has(op.operatorID)) continue;
    const info = getInfo(op.operatorID);
    if (info?.error) {
      out.set(op.operatorID, { shape: "header", note: `[ERROR] ${info.error.split("\n")[0].slice(0, 200)}` });
      continue;
    }
    const files = scanFiles(op);
    const by = realScans.find(r => files.length > 0 && files.every(f => scanFiles(r).some(pat => globCovers(pat, f))));
    if (by) out.set(op.operatorID, { shape: "header", note: `(preview superseded by scan \`${by.operatorID}\`)` });
  }
  return out;
}

export function selectResultShapes(
  operators: readonly OperatorPredicate[],
  links: readonly OperatorLink[],
  getInfo: (opId: string) => OperatorInfo | undefined
): Map<string, ShapeDecision> {
  const byId = new Map(operators.map(o => [o.operatorID, o]));
  const consumers = new Map<string, OperatorPredicate[]>();
  for (const l of links) {
    const tgt = byId.get(l.target.operatorID);
    if (!tgt) continue;
    const arr = consumers.get(l.source.operatorID) ?? [];
    arr.push(tgt);
    consumers.set(l.source.operatorID, arr);
  }

  const out = new Map<string, ShapeDecision>();
  for (const op of operators) {
    out.set(op.operatorID, decide(op, consumers.get(op.operatorID) ?? [], getInfo));
  }
  for (const [id, d] of retiredPreviews(operators, links, getInfo)) out.set(id, d);
  return out;
}

function decide(
  op: OperatorPredicate,
  consumers: OperatorPredicate[],
  getInfo: (opId: string) => OperatorInfo | undefined
): ShapeDecision {
  const nat = op.nativeOp;
  if (!nat) return { shape: "full" };
  const info = getInfo(op.operatorID);
  if (!info || info.error) return { shape: "full" };
  // Frontier: nothing consumes this table yet — it is what the agent acts on next.
  if (consumers.length === 0) return { shape: "full" };
  // A grain-sensitive consumer (or an opaque one) needs the whole input table.
  if (consumers.some(c => !c.nativeOp || GRAIN_SENSITIVE.has(c.nativeOp.type))) return { shape: "full" };

  switch (nat.type) {
    case "Scan":
    case "Aggregate":
    case "Join":
    case "UDF":
      return { shape: "full" };
    case "Filter":
    case "Distinct":
    case "Union":
    case "Unpivot":
    case "Limit":
      return { shape: "count" };
    case "Project":
    case "Sort":
      return { shape: "header" };
    case "Compute":
      return decideCompute(nat.properties, nat.inputs[0], info, getInfo);
    default:
      return { shape: "full" };
  }
}

function decideCompute(
  props: Record<string, unknown>,
  inputId: string | undefined,
  info: OperatorInfo,
  getInfo: (opId: string) => OperatorInfo | undefined
): ShapeDecision {
  const cols = Object.keys((props.columns as Record<string, unknown>) ?? {});
  const inInfo = inputId ? getInfo(inputId) : undefined;
  const notes: string[] = [];
  for (const c of cols) {
    const after = parseFacts(info.columnStats?.[c]);
    const before = parseFacts(inInfo?.columnStats?.[c]);
    if (!after) continue;
    if (!before) {
      // New column: its profile is new information — one line.
      notes.push(`"${c}": ${info.columnStats?.[c] ?? "new column"}`);
      continue;
    }
    const nullMoved = before.nulls !== undefined && after.nulls !== undefined && before.nulls !== after.nulls;
    const distinctMoved =
      before.distinct !== undefined && after.distinct !== undefined && before.distinct !== after.distinct;
    if (nullMoved || distinctMoved) {
      const parts: string[] = [];
      if (nullMoved) parts.push(`null ${before.nulls} → ${after.nulls}`);
      if (distinctMoved) parts.push(`distinct ${before.distinct} → ${after.distinct}`);
      notes.push(`"${c}": ${parts.join(", ")}`);
    }
  }
  if (notes.length === 0) return { shape: "header" };
  return { shape: "count", note: notes.join("; ") };
}
