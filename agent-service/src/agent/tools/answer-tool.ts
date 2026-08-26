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
 * `answer` — the terminal tool that ends a turn.
 *
 * Exists because of the nfl/acea convention-drift finding: a session arm
 * carries its own reasoning forward, so an interpretation committed at turn 1
 * ("higher kick = faster") stays committed; the catalog arm re-derives it from
 * artifacts each turn and re-rolls the dice. The second field captures that one
 * load-bearing sentence at the moment the agent knows which interpretations
 * mattered — answer time — and the catalog pins it into the turn's entry
 * forever. Schema-required structure, zero extra steps (this call REPLACES the
 * final free-text message; the driver stops on it via hasToolCall).
 *
 * Two variants of that second field, selected by `variant`:
 *   "conventions" (v39) — the interpretive choices, rendered as `### Conventions`.
 *   "decisions"  (v40d) — the decisions the turn settled, in the model's own
 *                 words, rendered as the entry's `### Solution` line.
 * They are separate `tool()` definitions rather than one schema built from a
 * conditional: the AI SDK's inputSchema is not a union type, and a spread-built
 * shape widens the inferred arg type to `never`.
 */

import { tool } from "ai";
import { z } from "zod";

export const TOOL_NAME_ANSWER = "answer";

export interface AnswerToolDeps {
  /** Called once with the structured answer; the agent composes the turn's
   *  final response from it. `note` is the second field's text regardless of
   *  variant (conventions or decisions). */
  onAnswer: (args: { answer: string; note: string }) => void;
  /** Which second field the tool asks for.
   *  - "conventions" (v39, default): the interpretive choices pinned per turn.
   *  - "decisions" (v40 lean catalog): the decisions the turn settled — how the
   *    answer was derived, described by the model in its own words. Renders as
   *    the entry's `### Solution` line. */
  variant?: "conventions" | "decisions";
}

export function createAnswerTool(deps: AnswerToolDeps) {
  if (deps.variant === "decisions") {
    return tool({
      description:
        "Finish the current turn by handing in your answer. Call this instead of writing a final " +
        "message — it is how a turn ends. Alongside the answer itself, write down the decisions this " +
        "turn settled: the choices you made that the task text left open, in your own words, precise " +
        "enough that a colleague continuing tomorrow — with only your note and the current dataflow — " +
        "would reproduce your numbers exactly. Future turns read this note instead of your reasoning.",
      inputSchema: z.object({
        answer: z
          .string()
          .describe(
            "Your final answer to the current task, exactly as it should be graded — same format " +
              "the task asked for (usually a single-line JSON object). Nothing else: no reasoning, " +
              "no preamble."
          ),
        decisions: z
          .string()
          .describe(
            "The decisions this turn settled, described in your own words — the definitions, rules " +
              "and interpretations behind the answer that the task text did not fully pin down. " +
              "Think: which direction a ranking runs ('rank 1 = highest mean_kick'), what population " +
              "a percentile is computed over, how a set or metric is defined, filters applied, " +
              "tie-break rules, seeds and split sizes. Short clauses separated by semicolons — NOT a " +
              "narrative of the steps you took; the choices, not the journey. If this turn changed a " +
              "standing decision from an earlier turn, say so explicitly ('supersedes turn 3\'s " +
              "definition of X'). If the turn settled nothing new, pass an empty string."
          ),
      }),
      execute: async ({ answer, decisions }) => {
        deps.onAnswer({ answer: answer ?? "", note: decisions ?? "" });
        return "Answer recorded — turn complete.";
      },
    });
  }
  return tool({
    description:
      "Finish the current turn by handing in your answer. Call this instead of writing a final " +
      "message — it is how a turn ends. Alongside the answer itself, take a moment to write down " +
      "the interpretive choices you committed to while solving this turn: the small decisions the " +
      "task text left open and that you had to settle one way or the other. Future turns will build " +
      "on your work, and they can only stay consistent with choices that are written down.",
    inputSchema: z.object({
      answer: z
        .string()
        .describe(
          "Your final answer to the current task, exactly as it should be graded — same format " +
            "the task asked for (usually a single-line JSON object). Nothing else: no reasoning, " +
            "no preamble."
        ),
      conventions: z
        .string()
        .describe(
          "The interpretations you settled this turn that the task text did not fully pin down — " +
            "the kind of thing a colleague continuing your work tomorrow would need to know to get " +
            "identical numbers. Think: which direction a ranking runs ('rank 1 = highest mean_kick'), " +
            "what grain a percentile is computed over ('global across all 86 players, not per side'), " +
            "how a set is defined ('complete sample = every candidate column non-null'), tie-break " +
            "rules, random seeds and split sizes. One short clause each, separated by semicolons. " +
            "If this turn changed a standing convention, say so explicitly. If the turn made no such " +
            "choices — it only read or extended existing definitions — pass an empty string."
        ),
    }),
    execute: async ({ answer, conventions }) => {
      deps.onAnswer({ answer: answer ?? "", note: conventions ?? "" });
      return "Answer recorded — turn complete.";
    },
  });
}
