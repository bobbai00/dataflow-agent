/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/** Fixed-trajectory comparison of history representations. No API calls.
 * Run: bun benchmark/context/compare-native-history.ts trace.json [...]
 * Serialized bytes are a size diagnostic, not billed tokens or cached tokens.
 */
import { readFileSync } from "node:fs";
import { renderMarkdownIteration } from "../../src/agent/native/markdown-iteration";
import { renderDataflowActionsResult, asDataflowActionsResult } from "../../src/agent/tools/dataflow-actions";
import type { ReActStep } from "../../src/types/agent";

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const rows = process.argv.slice(2).map(path => {
  const saved = JSON.parse(readFileSync(path, "utf8"));
  const steps: ReActStep[] = Array.isArray(saved) ? saved : saved.steps;
  let nativeBytes = 0,
    markdownBytes = 0,
    iterations = 0;
  for (const step of steps) {
    const calls = step.toolCalls ?? [];
    if (!calls.length || calls.some(call => call.toolName !== "dataflow")) continue;
    const receipts = calls.map(call => step.toolResults?.find(result => result.toolCallId === call.toolCallId));
    // Final answers have no subsequent within-task decision; compare working
    // iterations only. Missing receipts remain an explicit renderer concern.
    if (calls.every(call => call.input?.actions?.length === 1 && call.input.actions[0].type === "answer")) continue;
    const native = [
      {
        role: "assistant",
        content: [
          ...(step.content ? [{ type: "text", text: step.content }] : []),
          ...calls.map(call => ({
            type: "tool-call",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: call.input,
          })),
        ],
      },
      {
        role: "tool",
        content: calls.map((call, index) => {
          const output = receipts[index]?.output;
          const action = asDataflowActionsResult(output);
          return {
            type: "tool-result",
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: {
              type: "text",
              value: action
                ? `dataflow-actions: ${action.status}\n\n${renderDataflowActionsResult(action)}`
                : JSON.stringify(output ?? null),
            },
          };
        }),
      },
    ];
    iterations++;
    nativeBytes += bytes(native);
    markdownBytes += bytes([
      { role: "user", content: `# Environment history\n\n${renderMarkdownIteration(step, iterations)}` },
    ]);
  }
  return {
    trace: path,
    iterations,
    nativeHistoryBytes: nativeBytes,
    markdownHistoryBytes: markdownBytes,
    reductionPercent: nativeBytes ? 100 * (1 - markdownBytes / nativeBytes) : null,
  };
});
console.log(
  JSON.stringify(
    {
      metric:
        "Serialized working-iteration history bytes on identical frozen traces; excludes system prompt, tools and task text. Not a provider-token or cost estimate.",
      rows,
      totals: {
        iterations: rows.reduce((n, r) => n + r.iterations, 0),
        nativeHistoryBytes: rows.reduce((n, r) => n + r.nativeHistoryBytes, 0),
        markdownHistoryBytes: rows.reduce((n, r) => n + r.markdownHistoryBytes, 0),
      },
    },
    null,
    2
  )
);
