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
import { settingsChange } from "../task-catalog";
import { TexeraAgent } from "../texera-agent";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";

// Wider than the receipts' 16-column budget, without a numbered run to compress.
const WIDE = "abcdefghijklmnopqrst".split("").map(name => ({ name, type: "int64", encoding: "" }));

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
  // Every operator completes with the same three-row, twenty-column table.
  (agent as any).executePostStepChanges = async () => {
    for (const op of agent.getWorkflowState().getAllOperators())
      agent.getSnapshotStorage().setOperatorResult(agent.getHead()!, op.operatorID, {
        state: "Completed",
        inputTuples: 3,
        outputTuples: 3,
        totalRowCount: 3,
        resultMode: "table",
        result: [],
        resultSchema: WIDE,
        resultVersion: { id: `${op.operatorID}:${op.nativeOp?.revision}` } as any,
      });
  };
  return { agent, contexts };
}

const entry = (messages: ModelMessage[], task: number) =>
  messages.find(m => m.role === "assistant" && String(m.content).startsWith(`## Task ${task} `))?.content as string;

const definitions = [
  "import pandas as pd",
  "RATE = 2",
  "def priced(table):",
  '    """Multiply value by the rate."""',
  "    return table.assign(a=table['a'] * RATE)",
  "def scaled(table, *, factor=1):",
  '    """Multiply a by factor."""',
  "    return table.assign(a=table['a'] * factor)",
].join("\n");

test("an earlier task is its request and a catalog entry of what it changed, in place of its calls", async () => {
  const s = session([
    [
      [
        {
          type: "edit",
          python: definitions,
          changes:
            "set raw: scan(files='data.csv')\nset prices: priced(raw)\nset big: scaled(raw, factor=2)\nset top: limit(prices, n=2)",
        },
        { type: "execute" },
      ],
      [{ type: "answer", content: "Three rows." }],
    ],
    [
      [
        // Re-sending scaled unchanged registers nothing; RATE changes what priced computes.
        {
          type: "edit",
          python:
            'RATE = 3\ndef scaled(table, *, factor=1):\n    """Multiply a by factor."""\n    return table.assign(a=table[\'a\'] * factor)',
          changes:
            "delete top\nset big: scaled(raw, factor=5)\nset doubled: priced(raw, doc='Values at the current rate.')",
        },
        { type: "execute" },
      ],
      [{ type: "answer", content: "Rate three." }],
    ],
    [
      [{ type: "edit", python: "", changes: "set big: scaled(raw, factor=2)" }, { type: "execute" }],
      [{ type: "answer", content: "Back to two." }],
    ],
    [[{ type: "inspect", target: "graph" }], [{ type: "answer", content: "Same." }]],
  ]);
  for (const request of ["First request.", "Second request.", "Third request.", "Fourth request."])
    await s.agent.sendMessage(request);
  const fourth = s.contexts.filter(c => c.request === 4);
  const context = fourth[0].messages.map(m => String(m.content)).join("\n\n");

  // Earlier calls are gone; each task is its request and one entry.
  expect(context).not.toContain('"type":"edit"');
  expect(context).toContain(
    "# Prior Tasks\n\nEach entry lists the definitions that task registered or changed and the operators it created, changed or deleted, as it left them, and its answer."
  );
  expect(context).not.toContain("inspect this task");
  expect(context).not.toContain("select a candidate branch");

  const first = entry(fourth[0].messages, 1);
  expect(first).toStartWith(
    "## Task 1 (answered)\nDefinitions:\n```python\nimport pandas as pd\nRATE = 2\n\ndef priced(table):"
  );
  // Every column of a wide table, once per chain.
  expect(first).toContain(
    "- **raw** (scan, created)\n  - definition: `set raw: scan(files='data.csv')`\n  - result: 3 rows × 20 columns\n  - columns: a int64, b int64, c int64, d int64, e int64, f int64, g int64, h int64, i int64, j int64, k int64, l int64, m int64, n int64, o int64, p int64, q int64, r int64, s int64, t int64"
  );
  expect(first).toContain("- **prices** (priced, created)");
  expect(first).toContain("  - columns: same as `raw`");
  expect(first).toContain("- **top** (limit, created)");
  expect(first).toContain("  - note: limited table; its input has 3 rows.");
  expect(first.indexOf("**raw**")).toBeLessThan(first.indexOf("**prices**"));
  expect(first).toContain("Answer: Three rows.\nDependencies: none recorded\nAnswer sources: not declared");

  const second = entry(fourth[0].messages, 2);
  expect(second).toContain("Definitions:\n```python\nRATE = 3\n```");
  expect(second).not.toContain("def scaled");
  expect(second).toContain("- **prices** (priced, updated: the definitions its function uses changed)");
  // An update that kept the function and inputs names the settings that moved.
  expect(second).toContain("- **big** (scaled, updated: factor 2 → 5)");
  // An input from an earlier task names the task that saved it.
  expect(second).toContain(
    "- **doubled** (priced, created)\n  - definition: `set doubled: priced(raw, doc='Values at the current rate.')`\n  - signature: `(table)`\n  - inputs: `raw` (version at end of task 1)"
  );
  expect(second).not.toContain("**raw**");
  expect(second).toContain("Deleted operators:\n- **top** (limit, deleted)");

  // A statement that brings back an earlier task's definition is a restore.
  const third = entry(fourth[0].messages, 3);
  expect(third).toContain("- **big** (scaled, updated: restored task 1's version)");
  expect(third).not.toContain("Definitions:");

  // Entries never change once written: the earlier prefix stays cacheable.
  const secondRequest = s.contexts.find(c => c.request === 2)!;
  expect(entry(secondRequest.messages, 1)).toBe(first);
  expect(entry(fourth[1].messages, 3)).toBe(third);
});

test("the prompt describes earlier tasks as catalog entries only in the catalog layout", () => {
  expect((session([]).agent as any).systemPrompt).toContain(
    "Each earlier task appears as its request and a catalog entry"
  );
  const catalog = buildRegisteredNativeSystemPrompt(ContextMode.DELTA, {
    multiTask: true,
    taskContext: "dependencies",
  });
  const trajectory = buildRegisteredNativeSystemPrompt(ContextMode.DELTA, { multiTask: true });
  expect(catalog).not.toContain("Your context contains earlier calls and observations.");
  expect(trajectory).toContain("Your context contains earlier calls and observations.");
  expect(trajectory).not.toContain("appears as its request and a catalog entry");
  // Both layouts teach working across requests; a single task carries none of it.
  for (const prompt of [catalog, trajectory]) {
    expect(prompt).toContain("## 5. Working across requests");
    expect(prompt).toContain("set newcomers: join(top, top@1, on=['unit'], how='anti')");
  }
  const single = buildRegisteredNativeSystemPrompt(ContextMode.DELTA);
  expect(single).not.toContain("Working across requests");
  expect(single).not.toContain("{{");
  // One task alone has no earlier tasks to describe.
  expect(buildRegisteredNativeSystemPrompt(ContextMode.DELTA, { taskContext: "dependencies" })).toBe(single);
});

test("an update that keeps the function and inputs is summarized by the settings it moved", () => {
  const registered = (settings: Record<string, unknown>, entry = "unit_scores") =>
    ({ type: "Registered", inputs: ["orders"], properties: { registered: { entry, cells: [], settings } } }) as any;
  expect(settingsChange(registered({ min_orders: 5 }), registered({ min_orders: 10 }))).toBe("min_orders 5 → 10");
  expect(settingsChange(registered({}), registered({ label: "it's" }))).toBe("label default → 'it\\'s'");
  expect(settingsChange(registered({ a: 1 }), registered({ a: 1 }))).toBeUndefined();
  // Another function, or other inputs, is a new definition rather than a settings change.
  expect(settingsChange(registered({ a: 1 }), registered({ a: 2 }, "other"))).toBeUndefined();
  expect(settingsChange(registered({ a: 1 }), { ...registered({ a: 2 }), inputs: ["raw"] })).toBeUndefined();
  const limit = (n: number) => ({ type: "Limit", inputs: ["ranked"], properties: { n, offset: 0 } }) as any;
  expect(settingsChange(limit(3), limit(5))).toBe("n 3 → 5");
});
