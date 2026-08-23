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
 * artifacts each turn and re-rolls the dice. The `conventions` field captures
 * that one load-bearing sentence at the moment the agent knows which
 * interpretations mattered — answer time — and the catalog pins it into the
 * turn's entry forever. Schema-required structure, zero extra steps (this
 * call REPLACES the final free-text message; the driver stops on it via
 * hasToolCall).
 */

import { tool } from "ai";
import { z } from "zod";

export const TOOL_NAME_ANSWER = "answer";

export interface AnswerToolDeps {
  /** Called once with the structured answer; the agent composes the turn's
   *  final response from it. */
  onAnswer: (args: { answer: string; conventions: string }) => void;
}

export function createAnswerTool(deps: AnswerToolDeps) {
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
      deps.onAnswer({ answer: answer ?? "", conventions: conventions ?? "" });
      return "Answer recorded — turn complete.";
    },
  });
}
