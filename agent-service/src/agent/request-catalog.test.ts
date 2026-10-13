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

type Reply = { text?: string; call?: { python: string; statements: string } };

/** Columns and rows each operator "executes" to; there is no engine in a unit test. */
const TABLES: Record<string, { columns: string[]; rows: number; cells?: Record<string, unknown> }> = {
  orders: { columns: ["order_id", "unit", "value"], rows: 40 },
  units: { columns: ["unit", "orders", "volume", "rate"], rows: 8 },
  n_units: { columns: ["n"], rows: 1 },
  scores: { columns: ["unit", "orders", "volume", "rate", "score"], rows: 8 },
  ranked: { columns: ["unit", "orders", "volume", "rate", "score"], rows: 8 },
  top: { columns: ["unit", "orders", "volume", "rate", "score"], rows: 3 },
  scores_rate70: { columns: ["unit", "orders", "volume", "rate", "score"], rows: 8 },
  answer_1: {
    columns: ["answer"],
    rows: 1,
    cells: { answer: '{"leaders":[{"unit":"u1","score":0.7033},{"unit":"u2","score":0.6817},{"unit":"u3","score":0.65}],"eligible_units":8,"note":"ties broken by unit"}' },
  },
};
const TYPES: Record<string, string> = {
  order_id: "int64",
  value: "float64",
  unit: "string",
  orders: "int64",
  answer: "string",
};

/** A native session whose model replies with the given calls and texts in order, across requests. */
function session(
  multiRequest: MultiRequestMode,
  replies: Reply[],
  catalog: { catalogSource?: CatalogSource; catalogRecent?: number; answerStatement?: boolean; focusTasks?: number } = {}
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
        result: [Object.fromEntries(table.columns.map(column => [column, table.cells?.[column] ?? 1]))],
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

test("operators updated only through a changed helper are named on one line; their own function's change keeps the block", async () => {
  const HELPERS = [
    "def clean(df):",
    '    """Rows with a unit."""',
    "    return df[df['unit'].notna()]",
    "",
    "def unit_counts(orders):",
    '    """Orders per unit."""',
    "    return clean(orders).groupby('unit', as_index=False).size()",
  ].join("\n");
  const { agent, prompts } = session("catalog", [
    {
      call: {
        python: HELPERS,
        statements:
          "set orders: scan(files='data/x/input/orders.csv')\nset per_unit: unit_counts(orders)\nshow result per_unit",
      },
    },
    { text: "Final Answer: 8" },
    {
      call: {
        python: HELPERS.replace("df['unit'].notna()]", "df['unit'].notna() & (df['value'] > 0)]"),
        statements: "set top: limit(per_unit, n=3)\nshow result top",
      },
    },
    { text: "Final Answer: u1" },
    { text: "Final Answer: done" },
  ]);
  for (const request of ["count units", "positive orders only", "anything else"]) await agent.sendMessage(request);
  const entries = prompts[prompts.length - 1]
    .filter(message => message.role === "assistant")
    .map(textOf)
    .filter(text => text.startsWith("## Task"));
  expect(entries[1]).toContain(
    "also updated, as definitions their functions use changed (results stale until executed, or unchanged): `per_unit`"
  );
  expect(entries[1]).not.toContain("- **per_unit**");
  expect(entries[1]).toContain("- **top** (limit, created)");
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

test("a ledger entry is one line per operator with its rows and columns, functions without source, and the answer by its operator", async () => {
  const { agent, prompts } = session(
    "catalog",
    [
      {
        call: {
          python: `${RULES}

def leaders_answer(top, units):
    """The leaders and the eligible count, in the requested shape."""
    return {'leaders': [{'unit': r.unit, 'score': round(r.score, 4)} for r in top.itertuples()], 'eligible_units': int(len(units))}

def raw_counts(orders):
    return orders.groupby('unit', as_index=False).size()`,
          statements: `set orders: scan(files='data/x/input/orders.csv')
set units: eligible_units(orders, min_orders=5)
set n_units: aggregate(units, outputs={'n': count()})
set scores: unit_scores(units, rate_weight=0.5)
set ranked: sort(scores, by=[('score', 'desc')])
set top: limit(ranked, n=3)
set answer_1: leaders_answer(top, units)
show result n_units
answer answer_1`,
        },
      },
      {
        call: {
          python: "",
          statements: "set units: eligible_units(orders, min_orders=10)\ndelete n_units\nshow result top",
        },
      },
      { text: "Final Answer: u1, u3, u4" },
      { call: { python: "", statements: "show result top" } },
      { text: "Final Answer: u1, u3, u4" },
    ],
    { catalogSource: "ledger", answerStatement: true }
  );
  await agent.sendMessage(FIRST);
  await agent.sendMessage(SECOND);
  await agent.sendMessage(THIRD);
  const entry = textOf(prompts[3][2]);
  expect(entry).toBe(`## Task 1 (answered)
functions:
- \`eligible_units(orders, *, min_orders=5)\` — Units with at least min_orders orders, with their share of orders and their volume.
- \`unit_scores(units, *, rate_weight=0.5)\` — Score per unit: rate_weight times the rate percentile plus the rest times the volume percentile.
- \`leaders_answer(top, units)\` — The leaders and the eligible count, in the requested shape.
- \`raw_counts(orders)\`
\`show function <name>\` reads a function's source.
operators:
- \`set orders: scan(files='data/x/input/orders.csv')\` → 40 rows × 3 columns; columns: order_id int64, unit str, value float64
- \`set units: eligible_units(orders, min_orders=5)\` → 8 rows × 4 columns; columns: unit str, orders int64, volume float64, rate float64
- \`set n_units: aggregate(units, outputs={'n': count()})\` → 1 row × 1 column; columns: n float64 note: one-row aggregate.
- \`set scores: unit_scores(units, rate_weight=0.5)\` → 8 rows × 5 columns; columns: same as \`units\`; plus score float64
- \`set ranked: sort(scores, by=[('score', 'desc')])\` → 8 rows × 5 columns; columns: same as \`scores\`
- \`set top: limit(ranked, n=3)\` → 3 rows × 5 columns; columns: same as \`ranked\` note: limited table; its input has 8 rows.
- \`set answer_1: leaders_answer(top, units)\` → 1 row × 1 column; columns: answer str
answer: \`answer_1\` = {"leaders": [3 items × {unit, score}], "eligible_units": 8, "note": "ties broken by unit"}`);
  // The second request's entry: an update, a deletion, and a reply as the answer.
  expect(textOf(prompts[3][4])).toBe(`## Task 2 (answered)
operators:
- \`set units: eligible_units(orders, min_orders=10)\` (updated: min_orders 5 → 10) → 8 rows × 4 columns; columns: unit str, orders int64, volume float64, rate float64
deleted: \`n_units\`
built on: task 1
answer: Final Answer: u1, u3, u4`);
  expect(agent.getSystemInfo().systemPrompt).toContain("one line per operator it set, with rows and columns; which earlier tasks it built on; and its answer");
});

test("the working set shows the previous task in full, a focus statement replaces it from the next call, and entries say what they built on", async () => {
  const { agent, prompts } = session(
    "catalog",
    [
      ...REPLIES.slice(0, 4),
      { call: { python: "", statements: "focus task 1\nshow result top" } },
      { text: "Final Answer: u3, u1, u4" },
    ],
    { catalogSource: "ledger", focusTasks: 2 }
  );
  await agent.sendMessage(FIRST);
  await agent.sendMessage(SECOND);
  await agent.sendMessage(THIRD);
  const working = (prompt: any[]) => prompt.map(textOf).find(text => text.startsWith("## Working set"));
  // Request 3, first call: the previous task alone.
  const before = working(prompts[4])!;
  expect(before).toStartWith("## Working set: task 2\n");
  expect(before).toContain("### Task 2\nrequest: From now on a unit needs ten orders. Which three units lead now?");
  expect(before).toContain("- `set units: eligible_units(orders, min_orders=10)`\n  reads: `orders` (task 1, 40 rows × 3 columns)\n  result: 8 rows × 4 columns; columns: unit str, orders int64, volume float64, rate float64");
  expect(before).toContain("answer: Final Answer: u1, u3, u4");
  expect(before).toContain("reads from earlier tasks: `orders` (task 1; focus task 1 for its rule)");
  // `scores` reads `units` but was set in task 1, so it is not a later reader.
  expect(before).not.toContain("read by later tasks");
  expect(before).toContain("  | unit | orders | volume | rate |");
  expect(before).not.toContain("### Task 1");
  // The focus receipt, and the next call's working set with both tasks.
  // Tool results are JSON in the prompt, so the receipt's newlines are escaped.
  expect(textOf(prompts[5][prompts[5].length - 1])).toContain("## focus task 1\\nworking set from your next call: task 1.");
  const after = working(prompts[5])!;
  expect(after).toStartWith("## Working set: task 1, task 2\n");
  expect(after).toContain("### Task 1\nrequest: " + FIRST);
  expect(after).toContain("def eligible_units(orders, *, min_orders=5):");
  expect(after).toContain("- `set units: eligible_units(orders, min_orders=5)` (set again in task 2: `set units: eligible_units(orders, min_orders=10)`)");
  expect(after).toContain("reads from earlier tasks: `orders` (task 1, above)");
  // Ledger entries name the tasks they built on.
  expect(textOf(prompts[4][4])).toContain("\nbuilt on: task 1\nanswer:");
});

test("an index entry is one short block per task: what it asked, what it set with shapes, its functions, what it built on, its answer", async () => {
  const { agent, prompts } = session("catalog", REPLIES, { catalogSource: "index", focusTasks: 5 });
  await agent.sendMessage(FIRST);
  await agent.sendMessage(SECOND);
  await agent.sendMessage(THIRD);
  const entries = prompts[prompts.length - 1]
    .filter(message => message.role === "assistant")
    .map(textOf)
    .filter(text => text.startsWith("## Task"));
  expect(entries[0]).toBe(`## Task 1
asked: ${FIRST}
set: \`orders\` (40 × 3), \`units\` (8 × 4), \`n_units\` (1 × 1), \`scores\` (8 × 5), \`ranked\` (8 × 5), \`top\` (3 × 5)
functions: \`eligible_units(orders, *, min_orders=5)\`, \`unit_scores(units, *, rate_weight=0.5)\`
answer: Final Answer: u1, u2, u3`);
  expect(entries[1]).toBe(`## Task 2
asked: ${SECOND}
set: \`units\` (8 × 4) (updated)
deleted: \`n_units\`
built on: task 1
answer: Final Answer: u1, u3, u4`);
  expect(agent.getSystemInfo().systemPrompt).toContain("The entries are an index");
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
