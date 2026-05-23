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
 * Context assembler for the local-react LLM driver. Produces the exact
 * user-message format the in-house model was trained on
 * (see `example_input_context.md` in the repo root, copied here verbatim):
 *
 *   # Event 1 (User Task)
 *   <user task text>
 *
 *   # Event 2 (Agent Actions)
 *   Thought: ...
 *
 *   Actions:
 *   - createOrModifyOperator(operatorId="X", summary="Y") (result: ...)
 *
 *   # Event N (Agent Actions)
 *   ...
 *
 *   User's request is: <verbatim repeat of the latest user task>
 *
 *   Above is user's request and the steps you already took. ...
 *
 *   # Current Dataflow
 *   ## Operators
 *   ### Operator `x` (Type)
 *   Summary: ...
 *   Result:
 *     <formatOperatorResult output, 2-space-indented>
 *
 *   ## Links
 *   - x → y
 *
 * The TSV / Result block is rendered by the shared `formatOperatorResult`
 * helper — same renderer the SDK-driver context uses — so caps and column
 * stats behave identically across drivers. The tool catalog itself is NOT
 * advertised here: it is baked into the model's training prompt, so the
 * wire message stays free of tool descriptions.
 */

import type { ModelMessage } from "ai";
import type { ReActStep } from "../../types/agent";
import type { WorkflowState } from "../workflow-state";
import type { WorkflowSnapshotStorage, SnapshotData } from "../workflow-snapshot-storage";
import type { OperatorPredicate, WorkflowContent } from "../../types/workflow";
import { formatOperatorResult } from "../tools/result-formatting";

export interface AssembleLocalReactContextOptions {
  /** Forwarded to `formatOperatorResult`. When true, every non-error
   *  operator result with a `columnStats` annotation gets a `Column stats:`
   *  block appended. Matches the AgentSettings flag of the same name. */
  statsEnabled?: boolean;
}

const SENTINEL_INSTRUCTION =
  "Above is user's request and the steps you already took. You as an assistant please keep working on solving user's request based on the progress of current workflow.";

export function assembleLocalReactContext(
  visibleSteps: ReActStep[],
  workflowState: WorkflowState,
  snapshotStorage: WorkflowSnapshotStorage,
  options: AssembleLocalReactContextOptions = {}
): ModelMessage[] {
  // Drop the synthetic `initialize` step — it has no event number in the
  // canonical training format. Its workflow effects are already reflected
  // in `# Current Dataflow` below.
  const events = visibleSteps.filter(s => !isInitStep(s));

  const sections: string[] = [];

  // 1. Numbered event blocks. Event numbers are 1-based and assigned in
  //    chronological order across both user and agent roles — matching the
  //    training distribution.
  events.forEach((step, idx) => {
    const eventIndex = idx + 1;
    if (step.role === "user") {
      sections.push(`# Event ${eventIndex} (User Task)`);
      sections.push("");
      sections.push(step.content ?? "");
    } else {
      sections.push(`# Event ${eventIndex} (Agent Actions)`);
      sections.push("");
      if (step.content) {
        sections.push(`Thought: ${step.content}`);
      }
      if (step.toolCalls && step.toolCalls.length > 0) {
        if (step.content) sections.push("");
        sections.push("Actions:");
        for (let i = 0; i < step.toolCalls.length; i++) {
          sections.push(renderActionBullet(step.toolCalls[i], step.toolResults?.[i]));
        }
      }
    }
    sections.push("");
  });

  // 2. `User's request is: …` — verbatim repeat of the latest user task,
  //    followed by the sentinel instruction. The pair anchors the model's
  //    attention back to the task description after the long action log.
  const latestUserContent = findLatestUserContent(events);
  if (latestUserContent) {
    sections.push(`User's request is: ${latestUserContent}`);
    sections.push("");
  }
  sections.push(SENTINEL_INSTRUCTION);
  sections.push("");

  // 3. `# Current Dataflow` — the snapshot at HEAD. Reads through the
  //    storage so it survives even when the HEAD step itself owns no
  //    snapshot (e.g. a user step on its own).
  const headStepId = visibleSteps.length > 0 ? visibleSteps[visibleSteps.length - 1].id : undefined;
  const snapshot: SnapshotData = headStepId
    ? snapshotStorage.getAssociatedSnapshot(headStepId)
    : snapshotStorage.getRootSnapshot();
  const dag = renderDataflow(snapshot, workflowState, options);
  if (dag) {
    sections.push("# Current Dataflow");
    sections.push(dag);
  }

  const content = sections.join("\n").trimEnd();
  return [{ role: "user", content }];
}

function isInitStep(step: ReActStep): boolean {
  if (step.role !== "agent") return false;
  if (!step.toolCalls || step.toolCalls.length !== 1) return false;
  return step.toolCalls[0].toolName === "initialize";
}

function findLatestUserContent(events: ReActStep[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const s = events[i];
    if (s.role === "user" && s.content) return s.content;
  }
  return undefined;
}

/**
 * Render one tool call as a bullet line.
 *
 * Single-line result:
 *   - createOrModifyOperator(operatorId="X", summary="Y") (result: Added …)
 *
 * Multi-line result (e.g. `[WARNING] …\nAdded operator …`):
 *   - createOrModifyOperator(…) (result:
 *       <line 1>
 *       <line 2>
 *     )
 *
 * `code` is intentionally dropped from the args render — the training
 * format omits it to save tokens; the operator's current code is already
 * implicit in the trailing `# Current Dataflow` snapshot.
 */
function renderActionBullet(
  tc: { toolName: string; input: any },
  tr: { output: any; isError?: boolean } | undefined
): string {
  const args = formatArgs(tc.input);
  const head = `- ${tc.toolName}(${args})`;
  if (!tr) return head;
  const output = stringifyOutput(tr.output).trim();
  if (output.length === 0) return head;
  if (!output.includes("\n")) {
    return `${head} (result: ${output})`;
  }
  const indented = output
    .split("\n")
    .map(l => `    ${l}`)
    .join("\n");
  return `${head} (result:\n${indented}\n  )`;
}

function formatArgs(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const rec = input as Record<string, unknown>;
  const parts: string[] = [];
  // operatorId and summary first, in that fixed order — matches the
  // canonical sample's emission order so the rendered text is deterministic
  // across runs.
  if ("operatorId" in rec) parts.push(`operatorId=${stringifyArgValue(rec.operatorId)}`);
  if ("summary" in rec) parts.push(`summary=${stringifyArgValue(rec.summary)}`);
  for (const k of Object.keys(rec)) {
    if (k === "operatorId" || k === "summary" || k === "code") continue;
    parts.push(`${k}=${stringifyArgValue(rec[k])}`);
  }
  return parts.join(", ");
}

function stringifyArgValue(v: unknown): string {
  // JSON.stringify gives us `"..."` with proper escaping for strings, and
  // valid JSON for primitives / objects / arrays — matches the canonical
  // training format (e.g. `summary="..."` with embedded `\"` for quotes).
  return JSON.stringify(v);
}

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output == null) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function renderDataflow(
  snapshot: SnapshotData,
  workflowState: WorkflowState,
  options: AssembleLocalReactContextOptions
): string | null {
  const { workflow } = snapshot;
  if (workflow.operators.length === 0) return null;

  const lines: string[] = [];
  const sortedOps = topoSortOperators(workflow);

  lines.push("## Operators");
  lines.push("");
  for (const op of sortedOps) {
    lines.push(renderOperator(op, snapshot, workflowState, options));
    lines.push("");
  }

  if (workflow.links.length > 0) {
    lines.push("## Links");
    const opOrder = new Map(sortedOps.map((op, i) => [op.operatorID, i]));
    const sortedLinks = [...workflow.links].sort((a, b) => {
      const srcA = opOrder.get(a.source.operatorID) ?? 0;
      const srcB = opOrder.get(b.source.operatorID) ?? 0;
      if (srcA !== srcB) return srcA - srcB;
      return (opOrder.get(a.target.operatorID) ?? 0) - (opOrder.get(b.target.operatorID) ?? 0);
    });
    for (const link of sortedLinks) {
      lines.push(`- ${link.source.operatorID} → ${link.target.operatorID}`);
    }
  }

  return lines.join("\n").trimEnd();
}

function renderOperator(
  op: OperatorPredicate,
  snapshot: SnapshotData,
  workflowState: WorkflowState,
  options: AssembleLocalReactContextOptions
): string {
  const lines: string[] = [];
  lines.push(`### Operator \`${op.operatorID}\` (${op.operatorType})`);
  lines.push(`Summary: ${op.customDisplayName || op.operatorID}`);

  const info = snapshot.results.get(op.operatorID)?.info;
  if (info) {
    const execText = formatOperatorResult(op.operatorID, info, workflowState, {
      statsEnabled: options.statsEnabled,
    });
    lines.push("Result:");
    for (const l of execText.split("\n")) lines.push(`  ${l}`);
  }
  return lines.join("\n");
}

/** Stable upstream-before-downstream order. Cycles and disconnected
 *  components fall through in insertion order — matching what
 *  `context-utils.ts` does. */
function topoSortOperators(workflow: WorkflowContent): OperatorPredicate[] {
  const ops = workflow.operators;
  const opIds = new Set(ops.map(o => o.operatorID));
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const id of opIds) {
    inDegree.set(id, 0);
    children.set(id, []);
  }
  for (const link of workflow.links) {
    children.get(link.source.operatorID)?.push(link.target.operatorID);
    inDegree.set(link.target.operatorID, (inDegree.get(link.target.operatorID) ?? 0) + 1);
  }
  const queue: string[] = [...opIds].filter(id => (inDegree.get(id) ?? 0) === 0);
  const topoOrder = new Map<string, number>();
  let rank = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    topoOrder.set(node, rank++);
    for (const c of children.get(node) ?? []) {
      const newDeg = (inDegree.get(c) ?? 1) - 1;
      inDegree.set(c, newDeg);
      if (newDeg === 0) queue.push(c);
    }
  }
  return [...ops].sort(
    (a, b) => (topoOrder.get(a.operatorID) ?? 0) - (topoOrder.get(b.operatorID) ?? 0)
  );
}
