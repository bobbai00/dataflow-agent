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
import { AgentMode, ContextMode, type CatalogSource, type MultiRequestMode } from "../types/agent";
import { VercelToolUseDriver } from "./llm-drivers/vercel-tool-use-driver";
import { NativeCatalogSettingsError } from "./native/settings";
import { TexeraAgent } from "./texera-agent";
import { assembleContext, catalogedRequests } from "./util/context-utils";
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
  scores_rate70: { columns: ["unit", "orders", "volume", "rate", "score"], rows: 8 },
};
const TYPES: Record<string, string> = { order_id: "int64", value: "float64", unit: "string", orders: "int64" };

/** A native session whose model replies with the given calls and texts in order, across requests. */
function session(
  multiRequest: MultiRequestMode,
  replies: Reply[],
  catalog: { catalogSource?: CatalogSource; catalogRecent?: number } = {},
  settings: { answerStatement?: boolean } = {}
) {
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
  const agent: TexeraAgent = new TexeraAgent({
    agentId: "request-catalog",
    modelType: "test",
    driver: new VercelToolUseDriver({ model, maxRetries: 0 }),
    contextAssembler: input =>
      assembleContext(input.visibleSteps, input.workflowState, input.snapshotStorage, ContextMode.DELTA, {
        agentMode: AgentMode.NATIVE,
        messageLayout: "native",
        multiRequest,
        ...catalog,
        turnNumberByMessageId: agent.turnNumberMap(),
      }),
  });
  agent.updateSettings({
    agentMode: AgentMode.NATIVE,
    maxSteps: 25,
    thoughtReplay: false,
    retrievalViews: ["sample", "full"],
    multiRequest,
    ...catalog,
    ...settings,
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

test("a request whose sender chose earlier requests sees only those, with its own calls; the next request sees what it chose", async () => {
  const { agent, prompts } = session("transcript", REPLIES);
  await agent.sendMessage(FIRST);
  await agent.sendMessage(SECOND);
  // The third request's context leaves the second request out.
  await agent.sendMessage(THIRD, undefined, { contextRequests: [1] });
  // The system prompt's own example mentions ten orders, so only the messages are checked.
  const third = prompts[4].slice(1).map(textOf).join("\n");
  expect(third).toContain(FIRST);
  expect(third).toContain("set units: eligible_units(orders, min_orders=5)");
  expect(third).not.toContain(SECOND);
  expect(third).not.toContain("min_orders=10");
  expect(third).not.toContain("Final Answer: u1, u3, u4");
  expect(third).toContain(THIRD);
  // Its own second call still sees its first.
  const thirdLater = prompts[5].slice(1).map(textOf).join("\n");
  expect(thirdLater).toContain("set scores_rate70: unit_scores(units, rate_weight=0.7)");
  expect(thirdLater).not.toContain(SECOND);
  // A request without a choice sees the whole path again, the second request included.
  await agent.sendMessage("Which units are in the top three under both weightings?");
  const fourth = prompts[prompts.length - 1].slice(1).map(textOf).join("\n");
  expect(fourth).toContain(SECOND);
  expect(fourth).toContain(THIRD);
});

test("a request that names earlier tables sees one block instead of the earlier requests: instructions, every table, the named ones in full", async () => {
  const { agent, prompts } = session("transcript", REPLIES);
  await agent.sendMessage(FIRST);
  await agent.sendMessage(SECOND);
  await agent.sendMessage(THIRD, undefined, { contextTables: ["units", "nowhere"] });
  const third = prompts[4].slice(1).map(textOf).join("\n");
  // No earlier request or call is in view; the block stands for them.
  expect(third).not.toContain(SECOND);
  expect(third).not.toContain("show result top, n_units");
  expect(third).toContain("## Context for this request");
  expect(third).toContain(`### Session instructions (task 1)\n${FIRST}`);
  expect(third).toContain(
    "### Tables in the graph\n- task 1: `orders` = scan() 40 rows × 3 columns; `units` = eligible_units(orders) 8 rows × 4 columns; `scores` = unit_scores(units) 8 rows × 5 columns"
  );
  expect(third).toContain(
    "#### Task 1\nanswered: Final Answer: u1, u2, u3\n- `set units: eligible_units(orders, min_orders=10)` (last set in task 2)"
  );
  expect(third).toContain("  reads: `orders` (task 1, 40 rows × 3 columns)");
  expect(third).toContain(
    "  result: 8 rows × 4 columns; columns: unit str, orders int64, volume float64, rate float64"
  );
  expect(third).toContain("def eligible_units(orders, *, min_orders=5):");
  expect(third).toContain("Not in the graph: `nowhere`.");
  expect(third).toContain(THIRD);
  // The request's own later calls still see its first.
  expect(prompts[5].slice(1).map(textOf).join("\n")).toContain(
    "set scores_rate70: unit_scores(units, rate_weight=0.7)"
  );
  // The block is shown, not stored: the request's text stays as it was sent.
  const third_step = agent
    .getReActSteps()
    .filter(step => step.role === "user")
    .at(-1)!;
  expect(third_step.content).toBe(THIRD);
  // So a later block quotes that request's own text, and blocks never nest.
  await agent.sendMessage("Which units lead under both weightings?", undefined, { contextTables: ["top_rate70"] });
  const fourth = prompts[prompts.length - 1].slice(1).map(textOf).join("\n");
  expect(fourth).toContain(
    `#### Task 3\nasked: ${THIRD}\nanswered: Final Answer: u3, u1, u4\n- \`set top_rate70: limit(ranked_rate70, n=3)\``
  );
  expect(fourth.split("## Context for this request").length).toBe(2);
});

test("with upstream, the block shows what the picked tables are built from; a rewritten import line is not a change", async () => {
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
  await agent.sendMessage("How many tagged orders?", undefined, { contextTables: ["tagged"], contextUpstream: true });
  const third = prompts[4].slice(1).map(textOf).join("\n");
  // ... but its statement and function are unchanged, so the block does not call it set again.
  expect(third).toContain("#### Task 1\nanswered: Final Answer: 1\n- `set tagged: tag(orders)`\n");
  expect(third).not.toContain("last set in task");
  expect(third).toContain("the tables picked for this request in full, and the tables they are built from");
  expect(third).toContain(
    "### What the picked tables are built from\nTheir upstream tables, back to the files: each one's statement, and its function's source when it is not shown above.\n- `set orders: scan(files='data/x/input/orders.csv')` (task 1, "
  );
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
  // The earlier requests themselves are not in view, and the table block's sections are not used.
  expect(fourth).not.toContain("### Tables picked for this request");
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

test("an answer statement renders its tables as the reply and ends the request", async () => {
  const replies: Reply[] = [
    {
      call: {
        python: "",
        statements:
          "set orders: scan(files='data/x/input/orders.csv')\nset n_units: aggregate(orders, outputs={'n': count()})\nanswer n_units",
      },
    },
    { text: "never asked" },
  ];
  const { agent, prompts } = session("transcript", replies, {}, { answerStatement: true });
  const result = await agent.sendMessage("How many units?");
  // A one-row, one-column table is its value; no model call follows the answer.
  expect(result.response).toBe("1");
  expect(prompts.length).toBe(1);
  const last = agent.getReActSteps()[agent.getReActSteps().length - 1];
  expect([last.role, last.isEnd, last.content, last.toolCalls?.length ?? 0]).toEqual(["agent", true, "1", 0]);
  // The prompt and the tool describe the answer statement.
  const system = (prompts[0][0] as any).content as string;
  expect(system).toContain("Give the final answer with an answer statement");
  expect(system).not.toContain("a reply without the tool is your final answer");
});

test("an answer over a table it cannot render whole is refused, and a text reply is sent back once", async () => {
  const replies: Reply[] = [
    {
      call: {
        python: "",
        statements:
          "set orders: scan(files='data/x/input/orders.csv')\nset n_units: aggregate(orders, outputs={'n': count()})\nanswer n=n_units, rows=orders",
      },
    },
    { text: "There are 1 units." },
    { call: { python: "", statements: "answer n=n_units" } },
  ];
  const { agent, prompts } = session("transcript", replies, {}, { answerStatement: true });
  const result = await agent.sendMessage("How many units, and which orders?");
  expect(result.response).toBe('{"n":1}');
  expect(prompts.length).toBe(3);
  // The refused answer says why, in the receipt the next call reads.
  const second = prompts[1].slice(1).map(textOf).join("\n");
  expect(second).toContain("## answer n=n_units, rows=orders");
  expect(second).toContain("not answered: `orders` has 40 rows and an answer renders every row (1 are held)");
  // The text reply came back with the correction instead of ending the request.
  const third = prompts[2].slice(1).map(textOf).join("\n");
  expect(third).toContain("in this session the final answer is an answer statement");
});

test("with no correction left, a text reply stands as the answer under answer statements", async () => {
  const replies: Reply[] = [
    { text: "Thinking", cut: true },
    { text: "Still thinking", cut: true },
    {
      call: {
        python: "",
        statements: "set orders: scan(files='data/x/input/orders.csv')\nset n_units: aggregate(orders, outputs={'n': count()})\nshow result n_units",
      },
    },
    { text: '{"n": 1}' },
  ];
  const { agent, prompts } = session("transcript", replies, {}, { answerStatement: true });
  const result = await agent.sendMessage("How many units?");
  // Two cut-off replies used both corrections; the JSON reply is the answer rather than an error.
  expect(prompts.length).toBe(4);
  expect(result.response).toBe('{"n": 1}');
  const last = agent.getReActSteps()[agent.getReActSteps().length - 1];
  expect([last.role, last.isEnd, last.endReason]).toEqual(["agent", true, undefined]);
});

test("compact entries list a documented function by its signature and docstring, and keep the rest's source", async () => {
  const python = `${RULES}

LIMIT = 3

def _rank_pct(values):
    return values.rank(pct=True)

def raw_counts(orders):
    return orders.groupby('unit', as_index=False).size()`;
  const { agent, prompts } = session(
    "catalog",
    [
      {
        call: {
          python,
          statements:
            "set orders: scan(files='data/x/input/orders.csv')\nset units: eligible_units(orders, min_orders=5)\nshow result units",
        },
      },
      { text: "Final Answer: 8" },
      { call: { python: "", statements: "show result units" } },
      { text: "Final Answer: 8" },
    ],
    { catalogSource: "docstring" }
  );
  await agent.sendMessage(FIRST);
  await agent.sendMessage(SECOND);
  const entry = textOf(prompts[2][2]);
  expect(entry).toStartWith(`## Task 1 (answered)
functions:
- \`eligible_units(orders, *, min_orders=5)\` — Units with at least min_orders orders, with their share of orders and their volume.
- \`unit_scores(units, *, rate_weight=0.5)\` — Score per unit: rate_weight times the rate percentile plus the rest times the volume percentile.
- \`raw_counts(orders)\`
helpers: \`_rank_pct(values)\`
\`\`\`python
LIMIT = 3

def raw_counts(orders):
    return orders.groupby('unit', as_index=False).size()
\`\`\`
\`show function <name>\` reads a function's source.
operators:`);
  expect(entry).not.toContain("units['orders'] >= min_orders");
  expect(agent.getSystemInfo().systemPrompt).toContain(
    "with their signatures and docstrings (source only for a function without one; `show function` reads any source)"
  );
});

test("a catalog keeps the most recent K to 2K-1 requests as transcript and adds entries K at a time", async () => {
  expect([0, 1, 3, 4, 5, 6, 7, 8].map(n => catalogedRequests(n, 2))).toEqual([0, 0, 0, 2, 2, 4, 4, 6]);
  expect([9, 10, 14, 15, 21].map(n => catalogedRequests(n, 5))).toEqual([0, 5, 5, 10, 15]);
  expect(catalogedRequests(7)).toBe(7);
  const replies: Reply[] = [
    { call: { python: "", statements: "set orders: scan(files='data/x/input/orders.csv')\nshow result orders" } },
    { text: "Final Answer: 1" },
  ];
  for (let i = 2; i <= 7; i++)
    replies.push({ call: { python: "", statements: "show result orders" } }, { text: `Final Answer: ${i}` });
  const { agent, prompts } = session("catalog", replies, { catalogRecent: 2 });
  for (let i = 1; i <= 7; i++) expect((await agent.sendMessage(`request ${i}`)).error).toBeUndefined();
  // The first call of request q is prompts[2 * (q - 1)].
  const firstCall = (q: number) => prompts[2 * (q - 1)];
  const entries = (q: number) =>
    firstCall(q)
      .filter(message => message.role === "assistant")
      .map(textOf)
      .filter(text => text.startsWith("## Task"))
      .map(text => text.split("\n")[0]);
  const calls = (q: number) => firstCall(q).filter(message => message.role === "tool").length;
  // Up to request 4 every earlier request is transcript; at 5 requests 1-2 become entries; at 7, 3-4 join them.
  expect([3, 4, 5, 6, 7].map(entries)).toEqual([
    [],
    [],
    ["## Task 1 (answered)", "## Task 2 (answered)"],
    ["## Task 1 (answered)", "## Task 2 (answered)"],
    ["## Task 1 (answered)", "## Task 2 (answered)", "## Task 3 (answered)", "## Task 4 (answered)"],
  ]);
  expect([4, 5, 6, 7].map(calls)).toEqual([3, 2, 3, 2]);
  expect(textOf(firstCall(5).find(message => message.role === "user" && textOf(message).includes("request 3")))).toBe(
    "request 3"
  );
  // Between additions the context only grows: request 6 starts with all of request 5's first prompt.
  expect(JSON.stringify(firstCall(6).slice(0, firstCall(5).length))).toBe(JSON.stringify(firstCall(5)));
  expect(agent.getSystemInfo().systemPrompt).toContain(
    "Your context contains the calls and observations of this task and of the most recent earlier tasks. Each older task appears"
  );
  expect(() => agent.updateSettings({ catalogRecent: 5 })).toThrow(NativeCatalogSettingsError);
  expect(() => agent.updateSettings({ catalogSource: "docstring" })).toThrow(NativeCatalogSettingsError);
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
