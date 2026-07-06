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
 * `compactContext` — the agent-triggered context-compaction MARKER tool (POC).
 *
 * The tool itself does almost nothing: it is a marker. When the agent calls it,
 * its tool-call lands in that step's `toolCalls`, and the DELTA context assembler
 * detects the newest `compactContext` mark and folds the trajectory up to that
 * point into a frozen `# Dataflow (compacted)` deck (via the existing compress
 * renderer), keeping only the raw event suffix after it. All fold parameters are
 * STATIC constants from settings (POC) — the model does not choose them; it only
 * chooses WHEN to compact. Read-only w.r.t. the DAG; never re-executes.
 *
 * See docs/agent-triggered-compaction-plan.md.
 */

import { tool } from "ai";
import { z } from "zod";
import { createToolResult } from "./tools-utility";

export const TOOL_NAME_COMPACT_CONTEXT = "compactContext";

export function createCompactContextTool() {
  return tool({
    description:
      "Compact the conversation so far to save context tokens. Earlier steps' thoughts, actions, and full result " +
      "tables are folded into a compact snapshot deck (schema + statistics + a small row sample per operator); the " +
      "current dataflow and your recent steps stay in full. Folded operators remain fully inspectable and are NOT " +
      "deleted — this only changes how history is shown to you. Read-only; it does not run or change the dataflow.\n" +
      "Call it at a natural boundary once earlier detail is no longer needed verbatim — e.g. after you have finished " +
      "loading/inspecting your sources and every loader now feeds a working downstream operator, after a stuck " +
      "operator is finally fixed, or when the trajectory has grown long. Do NOT compact while you are actively " +
      "debugging an operator that is still erroring — those recent failed attempts are working memory you still need.",
    inputSchema: z.object({
      reason: z
        .string()
        .optional()
        .describe("One short line: why compacting is safe here (e.g. 'sources loaded + consumed; building transforms')."),
    }),
    // The fold is performed at render time by the assembler (which detects this
    // mark); the tool result is a one-liner and must NOT contain the deck itself
    // (that would double-render it into the very context we are compacting).
    execute: async (args: { reason?: string }) => {
      const why = args.reason ? ` (${args.reason})` : "";
      return createToolResult(
        `Context compacted${why}. Earlier events are now shown as a compact snapshot deck; recent steps remain in full. ` +
          `Folded operators are unchanged and still inspectable. Continue with your next action.`
      );
    },
  });
}
