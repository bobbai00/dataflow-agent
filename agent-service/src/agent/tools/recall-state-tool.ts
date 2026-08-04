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
 * MULTI-TURN STATE RECALL — the model decides what history it needs.
 *
 * Motivation (LongDS-Bench, arXiv 2605.30434): in a long analytical session the
 * failures are not retrieval failures, they are STATE failures — the agent
 * inherits, revises, temporarily perturbs and rolls back an evolving analytical
 * state, and its accuracy collapses as that state accumulates. Pushing the whole
 * history forward does not fix it (it buries the live request and costs
 * quadratically); paraphrasing the history is worse (a wrong paraphrase of an
 * earlier definition IS the cascade failure).
 *
 * A dataflow agent has an unusual advantage here: the analytical state is not
 * prose in a transcript, it is addressable objects — named operators, their code,
 * their revisions per turn, and their materialized results. So the third option
 * is to catalogue what exists (`# Prior Turns`, the push side) and let the model
 * fetch the specific piece it needs (this tool, the pull side).
 *
 * Cache-wise this is deliberately turn-aligned: the reorganization happens at a
 * turn boundary, which is where the prompt prefix necessarily changes anyway,
 * so within a turn the prefix stays stable and cacheable.
 *
 * Read-only. Never executes anything, never mutates the DAG.
 */

import { z } from "zod";
import { tool } from "ai";
import type { OperatorInfo } from "../../types/execution";
import type { WorkflowContent } from "../../types/workflow";
import type { WorkflowState } from "../workflow-state";
import { formatOperatorResult } from "./result-formatting";
import { createErrorResult } from "./tools-utility";

export const TOOL_NAME_RECALL_STATE = "recallState";

/** One past turn, as the agent's own step tree records it. */
export interface RecalledTurn {
  /** 1-based turn number, matching the `# Prior Turns` catalogue. */
  turn: number;
  /** The user's request, verbatim. */
  request: string;
  /** What the agent answered at the end of that turn, verbatim. */
  answer?: string;
  /** Operator ids the turn created or modified, in order. */
  operators: string[];
  /** Workflow content as of the end of that turn (carries operator code). */
  workflow?: WorkflowContent;
}

/** Recall calls allowed per turn.
 *
 *  Retrieval is cheap but not free of risk: a model that cannot find what it
 *  wants will re-ask instead of proceeding. Observed before this cap: 44 recall
 *  calls in a single turn (chasing an off-by-one in turn numbering) which
 *  consumed the whole 40-step budget and produced no answer. The cap converts
 *  that failure mode from "turn produces nothing" into "turn proceeds with what
 *  it has".
 */
export const RECALL_CALLS_PER_TURN = 10;

export interface RecallStateDeps {
  /** All COMPLETED turns before the current one, oldest first. */
  getTurns: () => RecalledTurn[];
  /** Identifies the current turn, so the budget resets at a turn boundary. */
  getCurrentTurnKey?: () => string;
  /** Current cached result for an operator at HEAD (undefined if never run). */
  getResult: (operatorId: string) => OperatorInfo | undefined;
  workflowState: WorkflowState;
}

function operatorsOf(workflow: WorkflowContent | undefined): any[] {
  return (workflow?.operators as any[]) ?? [];
}

function findOperator(workflow: WorkflowContent | undefined, opId: string): any {
  return operatorsOf(workflow).find(o => o?.operatorID === opId);
}

/** Every operator id the session has seen: current DAG first, then historical. */
function knownIds(current: WorkflowContent | undefined, turns: RecalledTurn[]): string[] {
  const ids = new Set<string>();
  for (const op of operatorsOf(current)) if (op?.operatorID) ids.add(op.operatorID);
  for (const t of turns) for (const id of t.operators) ids.add(id);
  return [...ids];
}

/** Code + summary as recorded in a workflow snapshot, or "" when absent. */
function describeOperator(op: any): string {
  if (!op) return "";
  const props = op.operatorProperties ?? {};
  const parts: string[] = [];
  if (props.summary) parts.push(`Summary: ${props.summary}`);
  if (props.code) parts.push(`Code:\n\`\`\`python\n${String(props.code).trim()}\n\`\`\``);
  return parts.join("\n");
}

/**
 * Build the read-only `recallState` tool.
 *
 * One tool with a `what` selector rather than four tools: the choice the model
 * has to make is "which slice of history", and keeping that a single decision
 * with an enum makes the failure mode a wrong argument (recoverable, visible in
 * the trace) instead of a wrong tool.
 */
export function createRecallStateTool(deps: RecallStateDeps) {
  let budgetTurnKey: string | undefined;
  let callsThisTurn = 0;

  return tool({
    description:
      "Recall specific state from EARLIER turns of this session. The `# Prior Turns` catalogue lists what exists; " +
      "this fetches it verbatim. Use it whenever the current request depends on earlier work — for example when it " +
      "says to restore, roll back to, reuse, or compare against something from an earlier turn, or when it names a " +
      "definition, filter, metric or table you no longer have in front of you. Prefer recalling the exact earlier " +
      "definition over re-deriving it from memory: re-deriving is how small numeric differences creep in. " +
      "Read-only — it never runs or changes the dataflow.\n" +
      "  what='turn_log'         → every earlier turn: its request, the operators it touched, the answer it gave.\n" +
      "  what='turn'             → one turn in full (`turn` required): its exact request and answer, and the code of " +
      "the operators it touched AS OF that turn.\n" +
      "  what='operator'         → one operator's summary and code (`operatorId` required), current by default, or as " +
      "of a past turn when `turn` is given.\n" +
      "  what='operator_history' → how one operator changed across turns (`operatorId` required), so you can see which " +
      "turn introduced which version before rolling back to one.\n" +
      "  what='result'           → a sample of one operator's current computed output (`operatorId` required).",
    inputSchema: z.object({
      what: z
        .enum(["turn_log", "turn", "operator", "operator_history", "result"])
        .describe("Which slice of earlier state to fetch."),
      turn: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Turn number, as shown in `# Prior Turns`. Required for what='turn'; optional for what='operator'."),
      operatorId: z
        .string()
        .optional()
        .describe("Operator id. Required for what='operator', 'operator_history' and 'result'."),
      maxRows: z.number().int().min(1).optional().describe("Rows to show for what='result' (default 20)."),
    }),
    execute: async (args: { what: string; turn?: number; operatorId?: string; maxRows?: number }) => {
      try {
        const turnKey = deps.getCurrentTurnKey?.() ?? "";
        if (turnKey !== budgetTurnKey) {
          budgetTurnKey = turnKey;
          callsThisTurn = 0;
        }
        callsThisTurn += 1;
        if (callsThisTurn > RECALL_CALLS_PER_TURN) {
          return createErrorResult(
            `Recall budget for this turn is used up (${RECALL_CALLS_PER_TURN} calls). ` +
              "Proceed with what you have: build the operators this request needs, and read the " +
              "`# Current Dataflow` / `# Prior Turns` sections already in front of you."
          );
        }
        const turns = deps.getTurns();

        if (args.what === "turn_log") {
          if (turns.length === 0) return "No earlier turns yet — this is the first request of the session.";
          const lines = turns.map(t => {
            const ops = t.operators.length > 0 ? t.operators.join(", ") : "(no operator changes)";
            return [
              `## Turn ${t.turn}`,
              `Request: ${t.request}`,
              `Operators: ${ops}`,
              `Answer: ${t.answer ?? "(no answer recorded)"}`,
            ].join("\n");
          });
          return `${turns.length} earlier turn(s):\n\n${lines.join("\n\n")}`;
        }

        if (args.what === "turn") {
          if (args.turn === undefined) return createErrorResult("what='turn' requires `turn`.");
          const t = turns.find(x => x.turn === args.turn);
          if (!t) {
            return createErrorResult(
              `Turn ${args.turn} is not available. Earlier turns are ${turns.length > 0 ? `1..${turns.length}` : "(none yet)"}.`
            );
          }
          const blocks = [`# Turn ${t.turn}`, "", `Request:\n${t.request}`, "", `Answer:\n${t.answer ?? "(none)"}`];
          const described = t.operators
            .map(opId => {
              const body = describeOperator(findOperator(t.workflow, opId));
              return body ? `### \`${opId}\` (as of turn ${t.turn})\n${body}` : "";
            })
            .filter(Boolean);
          if (described.length > 0) {
            blocks.push("", `Operators touched by this turn:`, "", described.join("\n\n"));
          }
          return blocks.join("\n");
        }

        if (args.what === "operator") {
          if (!args.operatorId) return createErrorResult("what='operator' requires `operatorId`.");
          if (args.turn !== undefined) {
            const t = turns.find(x => x.turn === args.turn);
            if (!t) return createErrorResult(`Turn ${args.turn} is not available.`);
            const body = describeOperator(findOperator(t.workflow, args.operatorId));
            return body
              ? `\`${args.operatorId}\` as of turn ${t.turn}:\n${body}`
              : createErrorResult(`\`${args.operatorId}\` did not exist as of turn ${t.turn}.`);
          }
          const current = deps.workflowState.getWorkflowContent?.() as WorkflowContent | undefined;
          const body = describeOperator(findOperator(current, args.operatorId));
          if (body) return `\`${args.operatorId}\` (current):\n${body}`;
          return createErrorResult(
            `\`${args.operatorId}\` does not exist in the current dataflow. ` +
              `Existing operator ids: ${knownIds(current, turns).join(", ") || "(none)"}.`
          );
        }

        if (args.what === "operator_history") {
          if (!args.operatorId) return createErrorResult("what='operator_history' requires `operatorId`.");
          const rows: string[] = [];
          let lastCode: string | undefined;
          for (const t of turns) {
            const op = findOperator(t.workflow, args.operatorId);
            if (!op) continue;
            const code = String(op.operatorProperties?.code ?? "");
            if (code !== lastCode) {
              rows.push(
                `## As of turn ${t.turn}\n${describeOperator(op) || "(no code recorded)"}`
              );
              lastCode = code;
            }
          }
          const current = deps.workflowState.getWorkflowContent?.() as WorkflowContent | undefined;
          const currentOp = findOperator(current, args.operatorId);
          if (currentOp) {
            const code = String(currentOp.operatorProperties?.code ?? "");
            if (code !== lastCode) rows.push(`## Current\n${describeOperator(currentOp)}`);
          }
          if (rows.length === 0) {
            return createErrorResult(
              `No recorded versions of \`${args.operatorId}\` in this session. ` +
                `Known operator ids: ${knownIds(deps.workflowState.getWorkflowContent?.() as WorkflowContent | undefined, turns).join(", ") || "(none)"}.`
            );
          }
          return (
            `Revision history of \`${args.operatorId}\` (only turns where it CHANGED are listed; ` +
            `it is unchanged in between):\n\n${rows.join("\n\n")}`
          );
        }

        if (args.what === "result") {
          if (!args.operatorId) return createErrorResult("what='result' requires `operatorId`.");
          const info = deps.getResult(args.operatorId);
          if (!info) {
            return createErrorResult(
              `\`${args.operatorId}\` has no computed result (it may not exist, or has not been executed).`
            );
          }
          const rendered = formatOperatorResult(args.operatorId, info, deps.workflowState, {
            maxResultRows: args.maxRows ?? 20,
            schemaInResult: true,
            inputsInResult: false,
          });
          return `Current result of \`${args.operatorId}\`:\n${rendered}`;
        }

        return createErrorResult(`Unknown what='${args.what}'.`);
      } catch (error: any) {
        return createErrorResult(error.message || String(error));
      }
    },
  });
}
