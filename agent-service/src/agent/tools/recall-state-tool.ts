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
 * is to catalogue what exists (`# Catalog`, the push side) and let the model
 * fetch the specific piece it needs (this tool, the pull side).
 *
 * THE ADDRESSING UNIT IS THE TURN. An earlier design offered five `what` modes
 * (turn_log / turn / operator / operator_history / result), which made the model
 * choose a retrieval strategy before it knew what was there — and a wrong mode
 * costs a step and returns nothing useful. The `# Catalog` already names every
 * turn and the operators it touched, so "turn N" is the only address the model
 * ever has to form. What it gets back is that turn's OPERATOR DELTA: exactly the
 * operators the turn added, revised or deleted, with as much or as little detail
 * per operator as the caller asks for.
 *
 * VERBOSITY IS THE CALLER'S CHOICE, not a fixed policy. Whether code, result
 * samples and per-column statistics come back — and how many characters of table
 * are worth spending — depends on why the model is looking, and only the model
 * knows that. It pays for what it asks for (every later step re-sends this
 * output), so the defaults are lean and the ceiling is enforced here rather than
 * trusted to the prompt.
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

/** How a turn changed one operator, as the snapshot diff records it. */
export type RecallVerb = "added" | "revised" | "deleted";

/** One past turn, as the agent's own step tree records it. */
export interface RecalledTurn {
  /** 1-based turn number, matching the `# Catalog`. */
  turn: number;
  /** The user's request, verbatim. */
  request: string;
  /** What the agent answered at the end of that turn, verbatim. */
  answer?: string;
  /** Operator ids the turn created, revised or deleted, in the order touched. */
  operators: string[];
  /** Verb per operator id, from the snapshot diff against the previous turn. */
  verbs?: Map<string, RecallVerb>;
  /** Workflow content as of the end of that turn (carries operator code). */
  workflow?: WorkflowContent;
  /** Operator results as of the end of that turn. */
  results?: Map<string, OperatorInfo>;
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

/** Hard ceiling for `includeOutputTableSample`, per operator.
 *
 *  Enforced here, not asked for in the prompt. A recalled block is re-rendered
 *  into `# Recalled State` for every remaining step of the turn, so an
 *  over-wide pull is not paid once — it is paid per step until the turn ends.
 *  A model that asks for 100000 characters of a wide table would spend more on
 *  one recall than on the rest of the turn combined.
 */
export const RECALL_RESULT_CHARS_MAX = 4000;

export interface RecallStateDeps {
  /** All COMPLETED turns before the current one, oldest first. */
  getTurns: () => RecalledTurn[];
  /** Identifies the current turn, so the budget resets at a turn boundary. */
  getCurrentTurnKey?: () => string;
  workflowState: WorkflowState;
}

function findOperator(workflow: WorkflowContent | undefined, opId: string): any {
  return ((workflow?.operators as any[]) ?? []).find(o => o?.operatorID === opId);
}

/** The model's own name for an operator: the write tool stores `summary` as the
 *  display name (code-op-tools.ts:849), not under operatorProperties. */
function summaryOf(op: any): string | undefined {
  return op?.customDisplayName || op?.operatorProperties?.summary || undefined;
}

const VERB_MARK: Record<RecallVerb, string> = { added: "+", revised: "~", deleted: "-" };

/**
 * Build the read-only `recallState` tool.
 *
 * One address (`turn`) and three render switches. The switches exist because the
 * right amount of detail is question-dependent: "which formula did I use" wants
 * code and no tables, "what were the numbers" wants a sample and no code, and
 * "why does this column look wrong" wants the statistics. A fixed policy is
 * wrong for two of those three every time.
 */
export function createRecallStateTool(deps: RecallStateDeps) {
  let budgetTurnKey: string | undefined;
  let callsThisTurn = 0;

  return tool({
    description:
      "Recall one EARLIER turn of this session, verbatim: what I asked, what you answered, and the operators that " +
      "turn added, revised or deleted — with their code and their results AS OF THAT TURN. The `# Catalog` lists " +
      "every turn and the operators it touched, so read it first and recall the turn you actually need. " +
      "Read-only — it never runs or changes the dataflow.\n" +
      "\n" +
      "WHEN TO CALL IT. Recall before you re-derive. If this request refers back to earlier work — restore, roll " +
      "back, 'the original', 'as before', 'compare with the earlier' — or it names a definition, filter, metric or " +
      "threshold you set previously and no longer have in front of you, fetch the exact earlier version instead of " +
      "reconstructing it from memory. Reconstructing is how a formula drifts by a small amount, and a small drift " +
      "in an inherited quantity makes every later answer built on it wrong too. To see how one operator evolved, " +
      "read the `~` marks in the `# Catalog` — they name the turns where it changed — and recall those turns.\n" +
      "\n" +
      "WHEN NOT TO CALL IT. Do not recall what is already on screen: the `# Catalog` already gives you every turn's " +
      "request, answer and operator list, and `# Dataflow` already gives you the current code and results of the " +
      "operators in play. Do not sweep turns speculatively — recall the one turn the request points at. Anything " +
      "you pull stays visible under `# Recalled State` for the rest of the turn, so never fetch the same turn twice.\n" +
      "\n" +
      "ASK FOR THE LEAST THAT ANSWERS YOUR QUESTION. Everything you pull is re-sent to the model on EVERY remaining " +
      "step of this turn, so an oversized pull is charged repeatedly, crowds out the live request, and slows the " +
      "turn down. Defaults are lean on purpose. Set `includeOutputTableSample` above 0 only when you need the " +
      "actual numbers, and keep it small — raise it only when a specific value you need was visibly cut off. " +
      "`includeOutputTableColumnStats` only when a column's distribution or null count is the actual question. " +
      "If you want a formula, ask for code alone and leave the table sample at 0.",
    inputSchema: z.object({
      turn: z
        .number()
        .int()
        .min(1)
        .describe("Which earlier turn to recall, numbered as in the `# Catalog`."),
      includeCode: z
        .boolean()
        .optional()
        .describe("Show each changed operator's code as of that turn. Default true — this is usually the point."),
      includeOutputTableSample: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Characters of sample rows to show for EACH changed operator's output table, as of that turn. " +
            `0 (default) = no sample rows — row/column counts and the schema show either way. Hard maximum ` +
            `${RECALL_RESULT_CHARS_MAX}; higher values are clamped. Keep it small: recalled output is re-sent on ` +
            "every remaining step of this turn."
        ),
      includeOutputTableColumnStats: z
        .boolean()
        .optional()
        .describe(
          "Per-column stats for each result: numeric → min/max/mean; string → distinct count + top values; " +
            "datetime → range; all → null count. Default false — use when a distribution or null count is the question."
        ),
    }),
    execute: async (args: {
      turn: number;
      includeCode?: boolean;
      includeOutputTableSample?: number;
      includeOutputTableColumnStats?: boolean;
    }) => {
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
              "`# Dataflow` / `# Catalog` sections already in front of you."
          );
        }

        const turns = deps.getTurns();
        if (turns.length === 0) {
          return createErrorResult(
            "There are no earlier turns yet — this is the first request of the session, so there is nothing to recall."
          );
        }
        const t = turns.find(x => x.turn === args.turn);
        if (!t) {
          return createErrorResult(
            `Turn ${args.turn} is not available. Earlier turns are 1..${turns.length} ` +
              "(the turn in progress cannot be recalled — its events are already in front of you)."
          );
        }

        const includeCode = args.includeCode !== false;
        // One knob instead of two: 0 = shapes and schemas only, N > 0 = show up
        // to N characters of sample rows per operator. The clamp is enforced
        // here rather than trusted to the prompt — recalled output is re-sent
        // on every remaining step of the turn, so an over-wide pull is charged
        // per step, not once.
        const requestedChars = args.includeOutputTableSample ?? 0;
        const includeResults = requestedChars > 0;
        const includeStats = args.includeOutputTableColumnStats === true;
        const maxResultChars = Math.min(requestedChars, RECALL_RESULT_CHARS_MAX);

        const out: string[] = [`# Turn ${t.turn}`, ""];
        out.push("Asked:");
        out.push(t.request || "(no request recorded)");
        out.push("");
        out.push("Answered:");
        out.push(t.answer ? t.answer : "(no answer recorded)");
        out.push("");

        if (t.operators.length === 0) {
          out.push("This turn changed no operators — it answered from the state that already existed.");
          return out.join("\n").trimEnd();
        }

        out.push(
          `Operators this turn changed (${t.operators.length}), as of the end of turn ${t.turn} ` +
            "(`+` added, `~` revised, `-` deleted):"
        );
        out.push("");

        for (const opId of t.operators) {
          const verb = t.verbs?.get(opId);
          const op = findOperator(t.workflow, opId);
          const mark = verb ? VERB_MARK[verb] : "~";
          const summary = summaryOf(op);
          out.push(`### ${mark} \`${opId}\`${summary ? ` — ${summary}` : ""}`);

          if (verb === "deleted" || !op) {
            out.push(
              verb === "deleted"
                ? "(deleted by this turn — it no longer existed at the end of it)"
                : "(no definition recorded in this turn's snapshot)"
            );
            out.push("");
            continue;
          }

          if (includeCode) {
            const code = String(op.operatorProperties?.code ?? "").trim();
            if (code) {
              out.push("Code:");
              out.push("```python");
              out.push(code);
              out.push("```");
            } else {
              out.push("(no code recorded)");
            }
          }

          const info = t.results?.get(opId);
          if (info) {
            // Shape and schema are cheap and almost always what orients the
            // model; the TSV body is the part that costs, so it is the part
            // behind the switch.
            // Telemetry facts ride along unconditionally: the lineage line and
            // any coercion-dataloss diagnostic recorded when this version ran.
            // They are the where-did-my-cascade-start signal — a recalled
            // result that hides a known defect (a join that silently dropped
            // rows back then) sends the reader chasing everything except the
            // cause. Both are a line or less, and the coercion line exists only
            // when something actually went wrong, so silence stays free.
            const rendered = formatOperatorResult(opId, info, deps.workflowState, {
              detail: includeResults ? "sample" : "shape",
              schemaInResult: true,
              columnStats: includeStats,
              coercionTelemetry: true,
              rowLineage: true,
              inputsInResult: false,
              maxResultChars: includeResults ? maxResultChars : undefined,
            });
            out.push(`Result (as of turn ${t.turn}):`);
            out.push(rendered);
          } else if (includeResults) {
            out.push("Result: (not materialized in this turn's snapshot)");
          }
          out.push("");
        }

        const notes: string[] = [];
        if (!includeCode) notes.push("code omitted (includeCode=false)");
        if (!includeResults)
          notes.push("table bodies omitted (includeOutputTableSample=0) — shapes and schemas shown");
        if (requestedChars > RECALL_RESULT_CHARS_MAX) {
          notes.push(
            `includeOutputTableSample ${requestedChars} clamped to ${RECALL_RESULT_CHARS_MAX} — ` +
              "recalled output is re-sent on every remaining step of this turn, so it is capped"
          );
        }
        if (notes.length > 0) out.push(`(${notes.join("; ")})`);

        return out.join("\n").trimEnd();
      } catch (error: any) {
        return createErrorResult(error.message || String(error));
      }
    },
  });
}
