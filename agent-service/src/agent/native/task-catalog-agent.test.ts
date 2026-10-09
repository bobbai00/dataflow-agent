/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { AgentMode, ContextMode } from "../../types/agent";
import { buildContextAssembler } from "../../server";
import { buildRegisteredNativeSystemPrompt } from "../prompts";
import { TexeraAgent } from "../texera-agent";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";

/** Each request runs its scripted batches through the real dataflow tool and
 * records the exact context every model call would receive. */
function session(requests: unknown[][][]) {
  WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  const contexts: { request: number; messages: ModelMessage[] }[] = [];
  let request = 0;
  const agent = new TexeraAgent({
    agentId: "task-catalog",
    modelType: "test",
    contextAssembler: buildContextAssembler("vercel-tool-use", {} as never),
    driver: {
      async runTurn(input: any) {
        const batches = requests[request++];
        for (const [i, actions] of batches.entries()) {
          contexts.push({ request, messages: (await input.prepareStep({ stepNumber: i, messages: [] })).messages });
          const args = { reasoning: "Next step.", actions };
          const output = await input.tools.dataflow.execute(args);
          const id = `r${request}-${i}`;
          await input.onStepFinish({
            text: "",
            toolCalls: [{ toolName: "dataflow", toolCallId: id, input: args }],
            toolResults: [{ toolCallId: id, output }],
          });
          if (input.getFinalAnswer?.() !== undefined) break;
        }
        return { text: input.getFinalAnswer?.() ?? "", messages: [], usage: {} };
      },
    } as any,
  });
  agent.updateSettings({
    agentMode: AgentMode.NATIVE,
    contextMode: ContextMode.DELTA,
    messageLayout: "native",
    stateHistory: true,
    multiTask: true,
    taskContext: "dependencies",
  });
  // Every operator completes with the same three-row table.
  (agent as any).executePostStepChanges = async () => {
    for (const op of agent.getWorkflowState().getAllOperators())
      agent.getSnapshotStorage().setOperatorResult(agent.getHead()!, op.operatorID, {
        state: "Completed",
        inputTuples: 3,
        outputTuples: 3,
        totalRowCount: 3,
        resultMode: "table",
        result: [{ value: 1 }, { value: 2 }, { value: 3 }],
        resultSchema: [{ name: "value", type: "int64", encoding: "" }],
      });
  };
  return { agent, contexts };
}

const text = (messages: ModelMessage[]) =>
  messages.map(m => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n\n");
const card = (messages: ModelMessage[], task: number) =>
  messages.find(m => m.role === "assistant" && String(m.content).startsWith(`## Task ${task} `))?.content as string;

const definitions = [
  "import pandas as pd",
  "RATE = 2",
  "def priced(table):",
  '    """Multiply value by the rate."""',
  "    return table.assign(value=table['value'] * RATE)",
  "def keep(row):",
  '    """Keep positive rows."""',
  "    return row['value'] > 0",
].join("\n");

test("an earlier task is its request and a card of what it changed, in place of its calls", async () => {
  const s = session([
    [
      [
        {
          type: "edit",
          python: definitions,
          changes:
            "set raw: scan(files='data.csv')\nset prices: priced(raw)\nset kept: filter(prices, predicate='keep')",
        },
        { type: "execute" },
      ],
      [{ type: "answer", content: "Three rows." }],
    ],
    [
      [
        // Re-sending keep unchanged changes nothing; RATE changes what priced computes.
        {
          type: "edit",
          python: 'RATE = 3\ndef keep(row):\n    """Keep positive rows."""\n    return row[\'value\'] > 0',
          changes: "delete kept\nset doubled: priced(prices)",
        },
        { type: "execute" },
      ],
      [{ type: "answer", content: "Rate three." }],
    ],
    [[{ type: "inspect", target: "graph" }], [{ type: "answer", content: "Same." }]],
  ]);
  await s.agent.sendMessage("First request.");
  await s.agent.sendMessage("Second request.");
  await s.agent.sendMessage("Third request.");
  const third = s.contexts.filter(c => c.request === 3);
  const context = text(third[0].messages);

  // The first task's calls are gone; its card carries its code once and its operators.
  expect(context).not.toContain('"type":"edit"');
  expect(context).toContain("# Prior Tasks\n\nEach earlier task appears as its request and a card");
  expect(context).not.toMatch(/inspect (this|the) task/);
  const first = card(third[0].messages, 1);
  expect(first).toContain(
    `Answer: Three rows.\nDependencies: none recorded\n\nDefinitions registered or changed:\n\`\`\`python\nimport pandas as pd\nRATE = 2\n\ndef priced(table):`
  );
  expect(first).toContain("| raw | `scan(files='data.csv')` | 3 rows, 1 column | value |");
  expect(first).toContain("| prices | `priced(raw)` | 3 rows, 1 column | as raw |");
  expect(first).toContain("| kept | `filter(prices, predicate='keep')` | 3 of 3 rows, 1 column | as prices |");

  // The second card is the delta: the changed constant, the operator whose
  // definitions changed, the new operator and the deletion.
  const second = card(third[0].messages, 2);
  expect(second).toContain("Definitions registered or changed:\n```python\nRATE = 3\n```");
  expect(second).not.toContain("def keep");
  expect(second).toContain("| prices | `priced(raw)` | 3 rows, 1 column | as raw |");
  expect(second).toContain("| doubled | `priced(prices)` | 3 rows, 1 column | as prices |");
  expect(second).not.toContain("| raw |");
  expect(second).toContain("Operators deleted: kept");

  // Cards never change once written: the earlier prefix stays cacheable.
  const secondRequest = s.contexts.filter(c => c.request === 2);
  expect(card(secondRequest[0].messages, 1)).toBe(first);
  expect(card(third[1].messages, 2)).toBe(second);
});

test("the prompt describes earlier tasks as cards only in the catalog layout", () => {
  expect((session([]).agent as any).systemPrompt).toContain(
    "Each earlier task appears as its request and a card instead"
  );
  const catalog = buildRegisteredNativeSystemPrompt(ContextMode.DELTA, {
    multiTask: true,
    taskContext: "dependencies",
  });
  const trajectory = buildRegisteredNativeSystemPrompt(ContextMode.DELTA, { multiTask: true });
  expect(catalog).not.toContain("Your context contains earlier calls and observations.");
  expect(trajectory).toContain("Your context contains earlier calls and observations.");
  expect(trajectory).not.toContain("appears as its request and a card");
  // One task alone has no earlier tasks to describe.
  expect(buildRegisteredNativeSystemPrompt(ContextMode.DELTA, { taskContext: "dependencies" })).toBe(
    buildRegisteredNativeSystemPrompt(ContextMode.DELTA)
  );
});
