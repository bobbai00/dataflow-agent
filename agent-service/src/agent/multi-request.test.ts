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
import type { MultiRequestMode } from "../types/agent";
import { VercelToolUseDriver } from "./llm-drivers/vercel-tool-use-driver";
import { NativeCatalogSettingsError } from "./native/settings";
import { TexeraAgent } from "./texera-agent";
import { assembleContext } from "./util/context-utils";
import { WorkflowSystemMetadata } from "./util/workflow-system-metadata";

type Reply = { text?: string; call?: { python: string; statements: string }; cut?: boolean };

/** Columns and rows each operator "executes" to; there is no engine in a unit test. */
const TABLES: Record<string, { columns: string[]; rows: number }> = {
  orders: { columns: ["order_id", "unit", "value"], rows: 40 },
  units: { columns: ["unit", "orders", "volume", "rate"], rows: 8 },
  n_units: { columns: ["n"], rows: 1 },
  scores: { columns: ["unit", "orders", "volume", "rate", "score"], rows: 8 },
  ranked: { columns: ["unit", "orders", "volume", "rate", "score"], rows: 8 },
  top: { columns: ["unit", "orders", "volume", "rate", "score"], rows: 3 },
};
const TYPES: Record<string, string> = { order_id: "int64", value: "float64", unit: "string", orders: "int64" };

/** A native session whose model replies with the given calls and texts in order, across requests. */
function session(multiRequest: MultiRequestMode, replies: Reply[]) {
  WorkflowSystemMetadata.getInstance().seedNativeOperatorDefaults();
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
          : reply.cut
            ? { unified: "length" as const, raw: "length" }
            : { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const agent = new TexeraAgent({
    agentId: "multi-request",
    modelType: "test",
    driver: new VercelToolUseDriver({ model, maxRetries: 0 }),
    contextAssembler: input => assembleContext(input.visibleSteps, input.workflowState, input.snapshotStorage, {}),
  });
  agent.updateSettings({ maxSteps: 25, retrievalViews: ["sample", "full"], multiRequest });
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
];

const textOf = (message: any): string =>
  typeof message.content === "string"
    ? message.content
    : message.content.map((part: any) => part.text ?? JSON.stringify(part.output ?? part.input ?? "")).join("");

test("receipts name each function's signature, and the prompt gains the section on working across requests", async () => {
  const { agent, prompts } = session("transcript", REPLIES);
  await agent.sendMessage(FIRST);
  const receipt = textOf(prompts[1][prompts[1].length - 1]);
  expect(receipt).toContain(
    "## edits applied\\nfunctions:\\n- eligible_units(orders, *, min_orders=5) registered\\n- unit_scores(units, *, rate_weight=0.5) registered\\n"
  );

  const transcript = agent.getSystemInfo().systemPrompt;
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
  expect(() => agent.updateSettings({ multiRequest: "off" })).toThrow(NativeCatalogSettingsError);
  expect(() => agent.updateSettings({ multiRequest: "transcript" })).not.toThrow();
});

test("in the task catalog, a rewritten import line is not a change to the tables built on it", async () => {
  const replies: Reply[] = [
    {
      call: {
        python: "import pandas as pd\n\ndef tag(orders):\n    return orders.assign(t=pd.Series(1, index=orders.index))",
        statements: "set orders: scan(files='data/x/input/orders.csv')\nset tagged: tag(orders)\nshow result tagged",
      },
    },
    { text: "Final Answer: 1" },
    {
      call: {
        python: "import pandas as pd, numpy as np\n\ndef first_rows(orders):\n    return orders.head(1)",
        statements: "set first: first_rows(orders)\nshow result first",
      },
    },
    { text: "Final Answer: 2" },
    { call: { python: "", statements: "set n: aggregate(tagged, outputs={'n': count()})\nshow result n" } },
    { text: "Final Answer: 3" },
  ];
  const { agent, prompts } = session("transcript", replies);
  await agent.sendMessage("Tag the orders.");
  await agent.sendMessage("Show the first order.");
  // The second request's import line re-registers `tag`, so the engine counts `tagged` as updated ...
  expect(textOf(prompts[3][prompts[3].length - 1])).toContain("tagged updated");
  await agent.sendMessage("How many tagged orders?", undefined, { contextTasks: [1] });
  const third = prompts[4].slice(1).map(textOf).join("\n");
  // ... but its statement and function are unchanged, so the catalog does not call it set again.
  expect(third).toMatch(
    /#### Task 2\nasked: Show the first order\.\nchanged: `first` = first_rows\(orders\) [^\n]+\nanswered: Final Answer: 2/
  );
  expect(third).toContain("- `set tagged: tag(orders)`\n");
  expect(third).not.toContain("set again");
});

test("the task catalog lists every earlier task by request, changes and answer, and details the tasks the request builds on", async () => {
  const replies: Reply[] = [
    {
      call: {
        python: "def tag(orders):\n    return orders.assign(t=1)",
        statements: "set orders: scan(files='data/x/input/orders.csv')\nset tagged: tag(orders)\nshow result tagged",
      },
    },
    { text: "Final Answer: 1" },
    // The second task only reads an earlier table; it changes nothing.
    { call: { python: "", statements: "show result tagged" } },
    { text: "Final Answer: 2" },
    { call: { python: "", statements: "set n: aggregate(tagged, outputs={'n': count()})\nshow result n" } },
    { text: "Final Answer: 3" },
    { call: { python: "", statements: "show result n" } },
    { text: "Final Answer: 4" },
    { call: { python: "", statements: "show result n" } },
    { text: "Final Answer: 5" },
  ];
  const { agent, prompts } = session("transcript", replies);
  await agent.sendMessage("Tag the orders.");
  await agent.sendMessage("How many tagged orders?");
  await agent.sendMessage("Count them.");
  await agent.sendMessage("Count them again.", undefined, { contextTasks: [2] });
  const fourth = prompts[6].slice(1).map(textOf).join("\n");
  expect(fourth).toContain("The tasks this request builds on (2) are shown in detail");
  expect(fourth).toContain("compute it again from that task's request and the files.");
  // Every earlier task appears, in order, with its request, its changes and its answer.
  expect(fourth).toMatch(
    /#### Task 1\nasked: the session instructions above\nchanged: `orders` = scan\(\) [^;]+; `tagged` = tag\(orders\) [^\n]+\nanswered: Final Answer: 1/
  );
  // A task the request builds on that changed nothing still shows what it asked, read and answered.
  expect(fourth).toContain(
    "#### Task 2  (this request builds on it)\nasked: How many tagged orders?\nchanged: nothing\nread: `tagged` (task 1, "
  );
  expect(fourth).toMatch(/read: `tagged` \(task 1, [^\n]+\nanswered: Final Answer: 2/);
  expect(fourth).toMatch(/#### Task 3\nasked: Count them\.\nchanged: `n` = aggregate\(tagged\) [^\n]+\nanswered: Final Answer: 3/);
  // What the detailed task read comes with its definition, back to the files.
  expect(fourth).toContain("### What the detailed tasks' tables are built from");
  expect(fourth).toContain("- `set tagged: tag(orders)` (task 1, ");
  expect(fourth).toContain("- `set orders: scan(files='data/x/input/orders.csv')` (task 1, ");
  // The earlier requests themselves are not in view: the catalog and the request are one message.
  expect(prompts[6].map(message => message.role)).toEqual(["system", "user"]);
  // Tasks that changed tables, in detail: a table the task displayed as the task saw it, and a table
  // it did not display with its rows.
  await agent.sendMessage("And once more.", undefined, { contextTasks: [1, 3] });
  const fifth = prompts[8].slice(1).map(textOf).join("\n");
  expect(fifth).toMatch(
    /#### Task 1  \(this request builds on it\)\nasked: the session instructions above\nchanged:\n- `set orders: scan\(files='data\/x\/input\/orders.csv'\)`\n  result: 40 rows × 3 columns; columns: [^\n]+\n  records: /
  );
  expect(fifth).toMatch(/- `set tagged: tag\(orders\)`\n  result: [^\n]+\n  as task 1 saw it:\n    records: /);
  expect(fifth).toMatch(
    /#### Task 3  \(this request builds on it\)\nasked: Count them\.\nchanged:\n- `set n: aggregate\(tagged, outputs=\{'n': count\(\)\}\)`\n  result: 1 row × 1 column; columns: value [^\n]+\n  as task 3 saw it:\n    records: /
  );
  expect(fifth).not.toContain("its answer was read from this table");
  expect(fifth).toContain("#### Task 2\nasked: How many tagged orders?\nchanged: nothing\nanswered: Final Answer: 2");
});

test("a function written with a trailing bare * registers without settings, and its receipt says so", async () => {
  const { agent, prompts } = session("transcript", [
    {
      call: {
        python: 'def tidy(table, *):\n    """The table unchanged."""\n    return table',
        statements: "set orders: scan(files='data/x/input/orders.csv')\nset tidied: tidy(orders)\nshow result tidied",
      },
    },
    { text: "Final Answer: 40" },
  ]);
  expect((await agent.sendMessage(FIRST)).error).toBeUndefined();
  expect(textOf(prompts[1][prompts[1].length - 1])).toContain("functions:\\n- tidy(table) registered (no settings)\\n");
});
