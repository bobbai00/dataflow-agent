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
 * SELECT reinjection ladder — rung "timeline" (W3, claude/CONTEXT-DESIGN.md §4.3).
 *
 * The lowest rung above LATEST: re-inject the ACTION trajectory in
 * STRUCTURAL-COMPRESSED form — the last K create/modify/delete actions and their
 * ok/ERROR status — so a LATEST (aggregated) context regains a view of the
 * construction sequence it folded away. This is "selective recovery of the
 * lossy part of aggregation" with the *structural* (not code-bearing) content;
 * the campaign measured it FLAT (it re-injects which ops changed, not what code
 * failed — info the model can already infer from the snapshot). The code-bearing
 * rung (code_replay) is the open higher rung.
 *
 * Pure: derives only from the path. Returns undefined when there are no actions.
 */
function escapeQuotes(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildTimeline(fullPath: PathNode[], maxEvents = 14): string | undefined {
  const events: string[] = [];
  const known = new Set<string>();
  for (const node of fullPath) {
    if (node.step.role !== "agent" || !node.step.toolCalls) continue;
    const trs = node.step.toolResults ?? [];
    node.step.toolCalls.forEach((tc, i) => {
      const inp = (tc.input ?? {}) as Record<string, unknown>;
      const opId = typeof inp.operatorId === "string" ? inp.operatorId : "";
      if (!opId) return;
      let verb: string;
      if (tc.toolName === "createOrModifyOperator") {
        verb = known.has(opId) ? "modified" : "created";
        known.add(opId);
      } else if (tc.toolName === "deleteOperator") {
        verb = "deleted";
        known.delete(opId);
      } else return;
      const out = trs[i]?.output;
      const txt = typeof out === "string" ? out : out ? JSON.stringify(out) : "";
      const errM = /\[ERROR\][^\n]*/.exec(txt);
      const status = errM ? `ERROR ${errM[0].replace("[ERROR]", "").trim().slice(0, 80)}` : "ok";
      events.push(`${verb} \`${escapeQuotes(opId)}\` → ${status}`);
    });
  }
  if (events.length === 0) return undefined;
  const shown = events.slice(-maxEvents);
  const omitted = events.length - shown.length;
  const lines = shown.map((e, i) => `${omitted + i + 1}. ${e}`);
  return (omitted > 0 ? `(… ${omitted} earlier steps …)\n` : "") + lines.join("\n");
}
