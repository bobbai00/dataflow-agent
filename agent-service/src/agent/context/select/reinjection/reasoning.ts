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
import { asNativeBatchResult, TOOL_NAME_DATAFLOW } from "../../../tools/native-batch-tools";

/**
 * SELECT reinjection ladder — rung "thought-replay" (claude/CONTEXT-DESIGN.md §4.3).
 *
 * LATEST folds the whole edit history into one current DAG, discarding the
 * agent's own reasoning — and, because `prepareStep` rebuilds context from the
 * snapshot tree on every model call, that reasoning is dropped even between
 * steps of a single turn. This rung selectively recovers it: the last K agent
 * EVENTS, each rendered as its `Thought` followed by the compressed actions it
 * produced (`created`/`modified`/`deleted` `op` → ok|ERROR …).
 *
 * The reinjection unit is the ReAct STEP, not the operator: a thought binds to
 * a step, and one step can touch several operators (thought : step : operators
 * = 1 : 1 : N). Indexing by event keeps the thought rendered exactly once with
 * its N actions nested beneath it; `opToEvent` then lets each operator block
 * carry a cheap `Last edited: step N` back-pointer into this block (latest-edit
 * grain) without duplicating the thought text.
 *
 * Supersedes the structural-only "timeline" rung (which re-injected actions but
 * no thoughts and measured flat). Pure: derives only from the path.
 */

export type ActionVerb = "created" | "modified" | "deleted";

export interface ReasoningAction {
  verb: ActionVerb;
  opId: string;
  /** "ok", or "ERROR <first-line, truncated>" parsed from the tool result. */
  status: string;
}

export interface EventReasoning {
  /** 1-based event index in path order (matches PathNode.eventIndex). */
  eventIndex: number;
  /** the step's thought (truncated/single-lined); "" when the step had none. */
  thought: string;
  actions: ReasoningAction[];
}

export interface Reasoning {
  /** Events that carried a thought and/or an operator action, in path order.
   *  The single source of truth for each thought (the dedup store). */
  events: EventReasoning[];
  /** operatorId → the eventIndex of the LAST step that created/modified it
   *  (latest-edit grain). Drives the per-operator `Last edited:` back-pointer. */
  opToEvent: Map<string, number>;
}

/** Upper bound on a single rendered thought. Thoughts carry the rationale, so
 *  we keep more than a one-liner — but bound it so a long chain-of-thought
 *  can't blow up the per-turn context. */
const THOUGHT_MAX_CHARS = 200;
/** Upper bound on the parsed ERROR summary appended to an action's status. */
const STATUS_MAX_CHARS = 80;

/** Collapse a thought to a single bounded line. */
function compressThought(content: string | undefined): string {
  if (!content) return "";
  const oneLine = content.replace(/\s+/g, " ").trim();
  if (oneLine.length <= THOUGHT_MAX_CHARS) return oneLine;
  return oneLine.slice(0, THOUGHT_MAX_CHARS - 1).trimEnd() + "…";
}

/** Parse a tool result into a compact `ok` / `ERROR <msg>` status. */
function classifyStatus(output: unknown): string {
  const txt = typeof output === "string" ? output : output ? JSON.stringify(output) : "";
  const errM = /\[ERROR\][^\n]*/.exec(txt);
  return errM ? `ERROR ${errM[0].replace("[ERROR]", "").trim().slice(0, STATUS_MAX_CHARS)}` : "ok";
}

function escapeBacktick(s: string): string {
  // op ids are simple identifiers in practice; guard against a stray backtick
  // breaking the inline code span.
  return s.replace(/`/g, "'");
}

/**
 * Walk the path once, grouping each agent step's operator actions under that
 * step's thought, and tracking each operator's latest-edit event. `created` vs
 * `modified` is decided by a running known-set (a `deleteOperator` removes the
 * id so a later create-on-same-id reads as `created` again), mirroring
 * `buildCreateFlagsByStep` in context-utils.
 */
export function buildReasoning(fullPath: PathNode[]): Reasoning {
  const events: EventReasoning[] = [];
  const opToEvent = new Map<string, number>();
  const known = new Set<string>();

  for (const node of fullPath) {
    const step = node.step;
    if (step.role !== "agent") continue;
    // A thought-only agent step (no tool calls — e.g. a plain reply or the
    // terminal answer) is still an event: its thought is the reasoning we want
    // to recover. Steps with neither a thought nor an action are dropped below.
    const calls = step.toolCalls ?? [];
    const trs = step.toolResults ?? [];
    const actions: ReasoningAction[] = [];
    calls.forEach((tc, i) => {
      const inp = (tc.input ?? {}) as Record<string, unknown>;
      const batch =
        tc.toolName === TOOL_NAME_DATAFLOW
          ? asNativeBatchResult(trs.find(tr => tr.toolCallId === tc.toolCallId)?.output)
          : undefined;
      if (batch) {
        for (const op of batch.operators) {
          if (op.status !== "added" && op.status !== "modified" && op.status !== "deleted") continue;
          const verb = op.status === "deleted" ? "deleted" : op.status === "added" ? "created" : "modified";
          if (verb === "deleted") {
            known.delete(op.id);
            opToEvent.delete(op.id);
          } else {
            known.add(op.id);
            opToEvent.set(op.id, node.eventIndex);
          }
          actions.push({ verb, opId: op.id, status: "ok" });
        }
        return;
      }
      const opId = typeof inp.operatorId === "string" ? inp.operatorId : "";
      if (!opId) return;
      let verb: ActionVerb;
      if (tc.toolName === "createOrModifyOperator") {
        verb = known.has(opId) ? "modified" : "created";
        known.add(opId);
        opToEvent.set(opId, node.eventIndex); // overwrite ⇒ latest-edit grain
      } else if (tc.toolName === "deleteOperator") {
        verb = "deleted";
        known.delete(opId);
        opToEvent.delete(opId); // gone from the DAG; no block to point at
      } else {
        return; // non-operator tool: not part of the construction trajectory
      }
      actions.push({ verb, opId, status: classifyStatus(trs[i]?.output) });
    });

    const rationale = calls
      .map(tc => tc.input?.reasoning)
      .filter(value => typeof value === "string")
      .join(" ");
    const thought = compressThought(step.content || rationale);
    if (actions.length > 0 || thought.length > 0) {
      events.push({ eventIndex: node.eventIndex, thought, actions });
    }
  }

  return { events, opToEvent };
}

/**
 * Render the last `k` events as the `# Reasoning` block body. Each event is its
 * thought header followed by indented action lines. Returns undefined when there
 * is nothing to show.
 */
export function renderReasoning(reasoning: Reasoning, k: number): string | undefined {
  const { events } = reasoning;
  if (events.length === 0) return undefined;
  const cap = k > 0 ? k : events.length;
  const shown = events.slice(-cap);
  const omitted = events.length - shown.length;

  const lines: string[] = [];
  if (omitted > 0) lines.push(`(… ${omitted} earlier steps …)`);
  for (const e of shown) {
    lines.push(e.thought ? `Step ${e.eventIndex}: "${e.thought}"` : `Step ${e.eventIndex}:`);
    for (const a of e.actions) {
      lines.push(`  ${a.verb} \`${escapeBacktick(a.opId)}\` → ${a.status}`);
    }
  }
  return lines.join("\n");
}
