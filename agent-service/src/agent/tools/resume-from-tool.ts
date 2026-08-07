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
 * RESUME FROM A TURN — the session as a version tree.
 *
 * A long analytical session is not a straight line. Measured over the ten
 * LongDS tasks: 47% of turns' newest dependency is NOT the immediately
 * preceding turn, and half of all counterfactual ("what if") turns are depended
 * on again by a later turn. The history branches, so the state a turn should
 * start from is a CHOICE, and until now that choice was made for the model by a
 * recency heuristic it could not see or override.
 *
 * `resumeFrom` makes it explicit: the model names the turn it builds on, the
 * dataflow becomes that turn's state, and its new work branches from there.
 * `recallState` remains the read-only pull for looking at a turn without moving
 * to it. Read vs. move is the whole distinction between the two tools.
 *
 * WHY THIS IS ALLOWED ONLY BEFORE THE TURN'S FIRST WRITE. Moving the base after
 * the turn has built something orphans that work onto an abandoned branch — the
 * operator still exists in the tree but is no longer an ancestor of HEAD, so it
 * silently vanishes from the dataflow. Recovering it would need a merge, which
 * is deliberately not implemented (measured: on all 20 observed multi-turn
 * recalls, checking out the newest turn alone would have sufficed, because the
 * agent creates new operators far more often than it revises old ones, which
 * makes history effectively append-only). This is git's "you have uncommitted
 * changes" guard, for the same reason.
 *
 * Turn numbers here are GLOBAL — the order turns were asked in, over the whole
 * session, not their position on the current branch. After a resume the branch
 * is shorter than the session, and numbering by branch position would silently
 * renumber every turn, so `turn: 5` in the tool would mean a different turn than
 * "Turn 5" in the catalogue. That exact disagreement once cost a turn 44 recall
 * calls and no answer.
 */

import { z } from "zod";
import { tool } from "ai";
import { createErrorResult } from "./tools-utility";

export const TOOL_NAME_RESUME_FROM = "resumeFrom";

/** Tool calls that constitute "the turn has started building". */
export const WRITE_TOOL_NAMES = new Set([
  "createOrModifyOperator",
  "addOperator",
  "modifyOperator",
  "deleteOperator",
]);

export interface ResumeOutcome {
  ok: boolean;
  message: string;
}

/** Resume attempts allowed per turn.
 *
 *  A backstop against the error loop, not a design constraint: a legitimate
 *  turn resumes once, occasionally twice if it changes its mind before
 *  building. The cap exists because a rejected call is a step spent for nothing
 *  and a model that cannot get what it asked for retries verbatim — measured at
 *  35 identical failing calls in one turn, the entire step budget, no answer.
 *  Wording the errors better reduces that; only a hard limit ends it.
 */
export const RESUME_CALLS_PER_TURN = 4;

export interface ResumeFromDeps {
  /** Perform the checkout. Implemented by the agent, which owns the step tree. */
  resumeToTurn: (turn: number) => ResumeOutcome;
  /** How many completed turns exist, for the argument description. */
  turnCount: () => number;
  /** Identifies the turn in progress, so the budget resets at a turn boundary. */
  getCurrentTurnKey?: () => string;
}

export function createResumeFromTool(deps: ResumeFromDeps) {
  let budgetTurnKey: string | undefined;
  let callsThisTurn = 0;

  return tool({
    description:
      "Start this turn from the state as it stood at the end of an EARLIER turn. The dataflow becomes that turn's " +
      "dataflow, and everything you build now branches from there. Call this FIRST, before building anything.\n" +
      "\n" +
      "WHICH TURN — decide, do not default. Ask: which earlier turn produced the state THIS request is about? The " +
      "request usually names it indirectly — a quantity, a table, a definition, a filter or a result that some turn " +
      "established. Find that turn in the `# Catalog` and resume from it.\n" +
      "\n" +
      "Then check whether what you need was CHANGED since. The catalogue marks operators a later turn revised. If the " +
      "request wants something as it originally was — 'the original', 'the first', 'before the change', 'without the " +
      "later adjustment' — resume from the turn BEFORE that revision. Resuming from the newest turn would hand you " +
      "the revised version, which is the wrong state and produces a confidently wrong answer.\n" +
      "\n" +
      "Going back is normal and costs nothing: no turn is deleted, and every turn stays resumable.\n" +
      "\n" +
      "This MOVES you. To look at an earlier turn without moving to it, use `recallState` instead.\n" +
      "\n" +
      "You can change your mind and resume again — but only until you build something. Once this turn has created or " +
      "edited an operator, the base is locked, because moving it would strand the work you just did on an abandoned " +
      "branch.",
    inputSchema: z.object({
      turn: z
        .number()
        .int()
        .min(1)
        .describe("The turn whose end state to start from, numbered as in the `# Catalog`."),
    }),
    execute: async (args: { turn: number }) => {
      try {
        const key = deps.getCurrentTurnKey?.() ?? "";
        if (key !== budgetTurnKey) {
          budgetTurnKey = key;
          callsThisTurn = 0;
        }
        callsThisTurn += 1;
        if (callsThisTurn > RESUME_CALLS_PER_TURN) {
          return createErrorResult(
            `You have called resumeFrom ${RESUME_CALLS_PER_TURN} times this turn. ` +
              "Stop calling it and proceed with the dataflow you have — build the operators this request " +
              "needs, and read `# Catalog` / `# Dataflow` for anything you are missing."
          );
        }
        const out = deps.resumeToTurn(args.turn);
        return out.ok ? out.message : createErrorResult(out.message);
      } catch (error: any) {
        return createErrorResult(error.message || String(error));
      }
    },
  });
}
