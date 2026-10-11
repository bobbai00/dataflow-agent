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

import { expect, test } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import { AgentMode, ContextMode, type MultiRequestMode } from "../types/agent";
import { VercelToolUseDriver } from "./llm-drivers/vercel-tool-use-driver";
import { NativeCatalogSettingsError } from "./native/settings";
import { TexeraAgent } from "./texera-agent";
import { assembleContext } from "./util/context-utils";
import { WorkflowSystemMetadata } from "./util/workflow-system-metadata";

type Reply = { text?: string; call?: { python: string; statements: string } };

/** Columns and rows each operator "executes" to; there is no engine in a unit test. */
const TABLES: Record<string, { columns: string[]; rows: number }> = {
  orders: { columns: ["order_id", "unit", "value"], rows: 40 },
  units: { columns: ["unit", "orders", "volume", "rate"], rows: 8 },
  n_units: { columns: ["n"], rows: 1 },
  scores: { columns: ["unit", "orders", "volume", "rate", "score"], rows: 8 },
  ranked: { columns: ["unit", "orders", "volume", "rate", "score"], rows: 8 },
  top: { columns: ["unit", "orders", "volume", "rate", "score"], rows: 3 },
  scores_rate70: { columns: ["unit", "orders", "volume", "rate", "score"], rows: 8 },
};
const TYPES: Record<string, string> = { order_id: "int64", value: "float64", unit: "string", orders: "int64" };

/** A native session whose model replies with the given calls and texts in order, across requests. */
function session(multiRequest: MultiRequestMode, replies: Reply[]) {
  WorkflowSystemMetadata.getInstance().seedCodeModeDefaults();
  let calls = 0;
  const prompts: any[][] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async options => {
      prompts.push(structuredClone(options.prompt));
      const reply = replies[Math.min(calls++, replies.length - 1)];
      const content: any[] = reply.text !== undefined ? [{ type: "text" as const, text: reply.text }] : [];
      if (reply.call)
        content.push({
          type: "tool-call" as const,
          toolCallId: `call-${calls}`,
          toolName: "dataflow",
          input: JSON.stringify(reply.call),
        });
      return {
        content,
        finishReason: reply.call
          ? { unified: "tool-calls" as const, raw: "tool_calls" }
          : { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const agent: TexeraAgent = new TexeraAgent({
    agentId: "request-catalog",
    modelType: "test",
    driver: new VercelToolUseDriver({ model, maxRetries: 0 }),
    contextAssembler: input =>
      assembleContext(input.visibleSteps, input.workflowState, input.snapshotStorage, ContextMode.DELTA, {
        agentMode: AgentMode.NATIVE,
        messageLayout: "native",
        multiRequest,
        turnNumberByMessageId: agent.turnNumberMap(),
      }),
  });
  agent.updateSettings({
    agentMode: AgentMode.NATIVE,
    maxSteps: 25,
    thoughtReplay: false,
    retrievalViews: ["sample", "full"],
    multiRequest,
  });
  (agent as any).executePostStepChanges = async () => {
    for (const op of agent.getWorkflowState().getAllOperators()) {
      const table = TABLES[op.operatorID] ?? { columns: ["value"], rows: 1 };
      agent.getSnapshotStorage().setOperatorResult(agent.getHead()!, op.operatorID, {
        state: "Completed",
        inputTuples: 0,
        outputTuples: table.rows,
        totalRowCount: table.rows,
        resultMode: "table",
        result: [Object.fromEntries(table.columns.map(column => [column, 1]))],
        resultSchema: table.columns.map(name => ({ name, type: TYPES[name] ?? "float64", encoding: "" })),
      });
    }
  };
  return { agent, prompts };
}

const RULES = `def eligible_units(orders, *, min_orders=5):
    """Units with at least min_orders orders, with their share of orders and their volume."""
    units = orders.groupby('unit', as_index=False).agg(orders=('order_id', 'count'), volume=('value', 'sum'))
    units = units[units['orders'] >= min_orders]
    return units.assign(rate=units['orders'] / units['orders'].sum())

def unit_scores(units, *, rate_weight=0.5):
    """Score per unit: rate_weight times the rate percentile plus the rest times the volume percentile."""
    rate, volume = units['rate'].rank(pct=True), units['volume'].rank(pct=True)
    return units.assign(score=rate_weight * rate + (1 - rate_weight) * volume)`;

const FIRST =
  "Which three units score highest, counting units with at least five orders and weighting rate and volume equally?";
const SECOND = "From now on a unit needs ten orders. Which three units lead now?";
const THIRD = "How would the leaders change if the rate counted 70%?";
const REPLIES: Reply[] = [
  {
    call: {
      python: RULES,
      statements: `set orders: scan(files='data/x/input/orders.csv')
set units: eligible_units(orders, min_orders=5)
set n_units: aggregate(units, outputs={'n': count()})
set scores: unit_scores(units, rate_weight=0.5)
set ranked: sort(scores, by=[('score', 'desc')])
set top: limit(ranked, n=3)
show result top, n_units`,
    },
  },
  { text: "Final Answer: u1, u2, u3" },
  {
    call: {
      python: "",
      statements: "set units: eligible_units(orders, min_orders=10)\ndelete n_units\nshow result top",
    },
  },
  { text: "Final Answer: u1, u3, u4" },
  {
    call: {
      python: "",
      statements: `set scores_rate70: unit_scores(units, rate_weight=0.7)
set ranked_rate70: sort(scores_rate70, by=[('score', 'desc')])
set top_rate70: limit(ranked_rate70, n=3)
show result top, top_rate70`,
    },
  },
  { text: "Final Answer: u3, u1, u4" },
];

const textOf = (message: any): string =>
  typeof message.content === "string"
    ? message.content
    : message.content.map((part: any) => part.text ?? JSON.stringify(part.output ?? part.input ?? "")).join("");

test("each earlier request is its request and one catalog entry, and an entry never changes", async () => {
  const { agent, prompts } = session("catalog", REPLIES);
  for (const request of [FIRST, SECOND, THIRD]) expect((await agent.sendMessage(request)).error).toBeUndefined();
  expect(prompts).toHaveLength(6);

  // The first call of the second request: request 1 under its heading, its entry, then request 2 as a plain turn.
  const second = prompts[2];
  expect(second.map(message => message.role)).toEqual(["system", "user", "assistant", "user"]);
  expect(textOf(second[1])).toBe(`# Agent Events\n\n## User Event 1\n\n${FIRST}`);
  expect(textOf(second[3])).toBe(SECOND);
  expect(textOf(second[2])).toBe(`## Task 1 (answered)
functions:
- \`eligible_units(orders, *, min_orders=5)\` — Units with at least min_orders orders, with their share of orders and their volume.
- \`unit_scores(units, *, rate_weight=0.5)\` — Score per unit: rate_weight times the rate percentile plus the rest times the volume percentile.
\`\`\`python
${RULES}
\`\`\`
operators:
- **orders** (scan, created)
  - definition: \`set orders: scan(files='data/x/input/orders.csv')\`
  - result: 40 rows × 3 columns
  - columns: order_id int64, unit str, value float64
- **units** (eligible_units, created)
  - definition: \`set units: eligible_units(orders, min_orders=5)\`
  - inputs: \`orders\`
  - result: 8 rows × 4 columns
  - columns: unit str, orders int64, volume float64, rate float64
- **n_units** (aggregate, created)
  - definition: \`set n_units: aggregate(units, outputs={'n': count()})\`
  - inputs: \`units\`
  - result: 1 row × 1 column
  - columns: n float64
  - note: one-row aggregate.
- **scores** (unit_scores, created)
  - definition: \`set scores: unit_scores(units, rate_weight=0.5)\`
  - inputs: \`units\`
  - result: 8 rows × 5 columns
  - columns: same as \`units\`; plus score float64
- **ranked** (sort, created)
  - definition: \`set ranked: sort(scores, by=[('score', 'desc')])\`
  - inputs: \`scores\`
  - result: 8 rows × 5 columns
  - columns: same as \`scores\`
- **top** (limit, created)
  - definition: \`set top: limit(ranked, n=3)\`
  - inputs: \`ranked\`
  - result: 3 rows × 5 columns
  - columns: same as \`ranked\`
  - note: limited table; its input has 8 rows.
shown: \`top\`, \`n_units\`
answer: Final Answer: u1, u2, u3`);

  // The third request keeps the second's prefix byte for byte and appends request 2's entry.
  const third = prompts[4];
  expect(third.map(message => message.role)).toEqual(["system", "user", "assistant", "user", "assistant", "user"]);
  expect(JSON.stringify(third.slice(0, 4))).toBe(JSON.stringify(second.slice(0, 4)));
  expect(textOf(third[5])).toBe(THIRD);
  expect(textOf(third[4])).toBe(`## Task 2 (answered)
operators:
- **units** (eligible_units, updated: min_orders 5 → 10)
  - definition: \`set units: eligible_units(orders, min_orders=10)\`
  - inputs: \`orders\` (task 1)
  - result: 8 rows × 4 columns
  - columns: unit str, orders int64, volume float64, rate float64
deleted: \`n_units\`
shown: \`top\`
answer: Final Answer: u1, u3, u4`);
});

test("an entry says when an update restores an earlier version or follows a changed function, and when a request ended without an answer", async () => {
  const show = (statements: string): Reply => ({ call: { python: "", statements } });
  const { agent, prompts } = session("catalog", [
    {
      call: {
        python: RULES,
        statements:
          "set orders: scan(files='data/x/input/orders.csv')\nset units: eligible_units(orders, min_orders=5)\nshow result units",
      },
    },
    { text: "Final Answer: 8" },
    show("set units: eligible_units(orders, min_orders=10)\nshow result units"),
    { text: "Final Answer: 5" },
    show("set units: eligible_units(orders, min_orders=5)\nshow result units"),
    { text: "Final Answer: 8" },
    {
      call: {
        python: RULES.replace("units['orders'] >= min_orders", "units['orders'] > min_orders"),
        statements: "show result units",
      },
    },
    { text: "Final Answer: 7" },
    { text: "I cannot open the files." },
    { text: "I cannot open the files." },
    { text: "I cannot open the files." },
    show("show result units"),
    { text: "Final Answer: 7" },
  ]);
  for (const request of ["count units", "ten orders", "back to five", "strictly more", "refuse", "count again"])
    await agent.sendMessage(request);
  const last = prompts[prompts.length - 1];
  const entries = last
    .filter(message => message.role === "assistant")
    .map(textOf)
    .filter(text => text.startsWith("## Task"));
  expect(entries).toHaveLength(5);
  expect(entries[1]).toContain("- **units** (eligible_units, updated: min_orders 5 → 10)");
  expect(entries[2]).toContain("- **units** (eligible_units, updated: restored task 1's version)");
  expect(entries[3]).toStartWith("## Task 4 (answered)\nfunctions:\n- `eligible_units(orders, *, min_orders=5)`");
  expect(entries[3]).toContain("units['orders'] > min_orders");
  expect(entries[3]).toContain("- **units** (eligible_units, updated: the definitions its function uses changed)");
  expect(entries[4]).toBe("## Task 5 (incomplete)\nNo functions or operators changed.\nanswer: No completed answer.");
});

test("receipts name each function's signature, and the prompt gains the section on working across requests", async () => {
  const { agent, prompts } = session("catalog", REPLIES);
  await agent.sendMessage(FIRST);
  const receipt = textOf(prompts[1][prompts[1].length - 1]);
  expect(receipt).toContain(
    "## edits applied\\nfunctions:\\n- eligible_units(orders, *, min_orders=5) registered\\n- unit_scores(units, *, rate_weight=0.5) registered\\n"
  );
  const prompt = agent.getSystemInfo().systemPrompt;
  expect(prompt).toContain("## 5. Working across requests");
  expect(prompt).toContain("Each earlier task appears as its request and a catalog entry");

  const transcript = session("transcript", REPLIES).agent.getSystemInfo().systemPrompt;
  expect(transcript).toContain("## 5. Working across requests");
  expect(transcript).toContain("Your context contains earlier calls and observations.");
  const single = session("off", REPLIES).agent.getSystemInfo().systemPrompt;
  expect(single).not.toContain("Working across requests");
  expect(single).toBe(transcript.replace(/\n*## 5\. Working across requests[\s\S]*$/, ""));
});

test("the transcript layout keeps every earlier call; the choice is fixed once a request was asked", async () => {
  const { agent, prompts } = session("transcript", REPLIES);
  await agent.sendMessage(FIRST);
  await agent.sendMessage(SECOND);
  expect(prompts[2].map(message => message.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);
  expect(() => agent.updateSettings({ multiRequest: "catalog" })).toThrow(NativeCatalogSettingsError);
  expect(() => agent.updateSettings({ multiRequest: "transcript" })).not.toThrow();
});
