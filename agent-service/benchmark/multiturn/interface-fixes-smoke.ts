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
/** Scripted model actions through the production agent loop and real engine,
 * covering the four interface defects that cost model calls in the state
 * milestone: UDF parameter naming, cascaded observe errors, an omitted return
 * column, and a catalog whose cards changed on every task. No paid calls. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ModelMessage } from "ai";
import { TexeraAgent } from "../../src/agent/texera-agent";
import { AgentMode } from "../../src/types/agent";
import { WorkflowState } from "../../src/agent/workflow-state";
import {
  createComputingUnit,
  createWorkflow,
  deleteWorkflow,
  getBackendConfig,
  login,
  terminateComputingUnit,
} from "../../src/api";
import { assertNativeCleanupSafe } from "../e2e/native-cleanup";

const out = resolve(process.argv[2] ?? "/tmp/texera-task-history/interface-fixes-smoke");
mkdirSync(out, { recursive: true });
const file = out + "/orders.csv";
writeFileSync(file, "region,units\nEast,3\nWest,4\nEast,5\n");

const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
const name = `interface-fixes-${Date.now()}`;
const cuid = (await createComputingUnit(token, name, { unitType: "local", uri: process.env.TEXERA_LOCAL_CU_URI }))
  .computingUnit.cuid;
const wid = await createWorkflow(token, name, new WorkflowState().getWorkflowContent());

let nextBatch: any;
let directAnswer: string | undefined;
let batchResult: any;
let contextMessages: ModelMessage[] = [];
const agent = new TexeraAgent({
  agentId: name,
  modelType: "scripted-fault-injection",
  // Unused: nativeTaskContext routes rendering through assembleTaskContext.
  contextAssembler: () => [],
  driver: {
    runTurn: async input => {
      // The real assembler renders the catalog here, before any model request.
      contextMessages = (await input.prepareStep({ stepNumber: 0, messages: input.initialMessages })).messages;
      batchResult = await (agent as any).tools.dataflow.execute(nextBatch);
      await input.onStepFinish({
        text: "",
        toolCalls: [{ toolName: "dataflow", toolCallId: "call", input: nextBatch }],
        toolResults: [{ toolCallId: "call", output: batchResult }],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      });
      directAnswer = input.getFinalAnswer?.();
      return {
        text: directAnswer ?? "Direct completion was refused.",
        messages: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    },
  },
});
await agent.initialize({ userToken: token, workflowId: wid, computingUnitId: cuid });
agent.updateSettings({
  agentMode: AgentMode.NATIVE,
  nativeToolMode: "batch",
  nativeCatalogVersion: "v2",
  nativeTaskHistory: true,
  nativeDirectReturn: true,
  nativeTaskContext: true,
  nativeCompactPrompt: true,
  nativeTaskReuse: true,
  nativeTaskReceipts: true,
  nativeCompactIndex: true,
  nativeDemandExecution: true,
});

let request = 0;
const catalogs: string[] = [];
const run = async (batch: any) => {
  nextBatch = batch;
  const result = await agent.sendMessage(`Interface regression task ${++request}`);
  assert.equal(result.error, undefined);
  const catalog = contextMessages
    .map(message => String(message.content))
    .find(text => text.startsWith("# Current operator catalog"));
  catalogs.push(catalog ?? "");
  await Bun.write(`${out}/${request}.json`, JSON.stringify({ batch, batchResult, catalog, directAnswer }, null, 2));
};

/** The operator lines of the catalog block: everything between its heading
 * and the first blank line, in either the card or the compact-index form. */
const cards = (catalog: string) => {
  const lines = catalog.split("\n").slice(1);
  const end = lines.indexOf("");
  return (end === -1 ? lines : lines.slice(0, end)).filter(line => line && !line.startsWith("#"));
};

try {
  // 1. A UDF names its own parameters. Inputs bind positionally, so this is
  //    correct code; the runtime used to reject it and cost a repair call.
  await run({
    operators: [
      { op: "scan", id: "orders", files: file },
      { op: "cast", id: "orders_typed", input: "orders", columns: [{ column: "units", dtype: "int64" }] },
      {
        op: "udf",
        id: "totals",
        inputs: ["orders_typed"],
        code:
          "import json\nimport pandas as pd\n\n" +
          "def process(anything):\n" +
          "    return pd.DataFrame({'answer': [json.dumps({'units': int(anything['units'].sum())})]})",
      },
    ],
    // 3. Single-column result: the only possible column need not be named.
    return: { operator: "totals", format: "json" },
  });
  assert.deepEqual(
    batchResult.operators.map((o: any) => o.status),
    ["added", "added", "added"]
  );
  assert.deepEqual(batchResult.observationErrors, []);
  assert.deepEqual(JSON.parse(directAnswer!), { units: 12 });

  // 2. A genuinely wrong arity still fails, but reports only its own cause.
  //    An unrelated absent id must still be reported as absent.
  await run({
    operators: [
      {
        op: "udf",
        id: "broken",
        inputs: ["orders_typed"],
        code: "import pandas as pd\n\ndef process(a, b):\n    return a",
      },
    ],
    observe: ["broken", "never_created"],
  });
  assert.equal(batchResult.operators[0].status, "error");
  assert.match(batchResult.operators[0].message, /CALLBACK_SIGNATURE/);
  assert.match(batchResult.operators[0].message, /names are yours/);
  assert.deepEqual(batchResult.observationErrors, ["Cannot observe 'never_created': operator does not exist."]);

  // 4. The saved-task range advances every task. Kept inside the cards it
  //    rewrote every card each request, including operators nobody touched.
  await run({ operators: [], observe: ["totals"] });
  const [first, last] = [catalogs.at(-2)!, catalogs.at(-1)!];
  assert.ok(cards(first).length >= 3, "catalog should describe the built operators");
  assert.deepEqual(cards(last), cards(first));
  assert.doesNotMatch(cards(last).join("\n"), /saved tasks/);
  assert.match(last, /# Saved task outputs/);
  assert.notEqual(last, first, "the saved range itself must still advance");
  const diverges = [...last].findIndex((character, i) => character !== first[i]);
  assert.ok(
    diverges > cards(last).join("\n").length,
    `catalog cards must precede the first changed byte (diverged at ${diverges})`
  );

  // 5. Complete return: an answer cell far beyond the 2,000-character display
  //    budget is delivered whole from the retained copy, not refused.
  const bigAnswer = JSON.stringify({ rows: Array.from({ length: 150 }, (_, i) => ({ team: `T${i}`, score: i / 7 })) });
  assert.ok(bigAnswer.length > 2000);
  await run({
    operators: [
      {
        op: "udf",
        id: "big_answer",
        inputs: [],
        code: `import json\nimport pandas as pd\n\ndef load():\n    return pd.DataFrame({'answer': [${JSON.stringify(bigAnswer)}]})`,
      },
    ],
    return: { operator: "big_answer", format: "json" },
  });
  assert.deepEqual(batchResult.observationErrors, []);
  assert.equal(directAnswer, bigAnswer);

  // 6. Receipts: the next task's context carries the runtime's account of the
  //    previous task, as cacheable history after its answer.
  await run({ operators: [], observe: ["totals"] });
  const receipt = contextMessages.map(m => String(m.content)).find(t => t.startsWith(`# Task ${request - 1} receipt`));
  assert.ok(receipt, "the previous task's receipt must be rendered");
  assert.match(receipt!, /Edited: big_answer/);
  assert.match(receipt!, /Returned: big_answer \(json\)/);
  assert.match(receipt!, /Retained outputs: [1-9]/);

  // 7. Demand-driven execution: editing an upstream operator invalidates both
  //    descendants; only the observed one runs, the other reads "not executed"
  //    in the compact index and in the receipt, and a later observe runs it.
  await run({
    operators: [
      {
        op: "filter",
        id: "kept",
        input: "orders_typed",
        columns: ["units"],
        func: "def apply(row):\n    return row['units'] > 0",
      },
      {
        op: "filter",
        id: "east",
        input: "kept",
        columns: ["region"],
        func: "def apply(row):\n    return row['region'] == 'East'",
      },
      {
        op: "filter",
        id: "west",
        input: "kept",
        columns: ["region"],
        func: "def apply(row):\n    return row['region'] == 'West'",
      },
    ],
    observe: ["east", "west"],
  });
  assert.deepEqual(
    batchResult.operators.map((o: any) => o.status),
    ["added", "added", "added"]
  );
  await run({
    operators: [
      {
        op: "filter",
        id: "kept",
        input: "orders_typed",
        columns: ["units"],
        func: "def apply(row):\n    return row['units'] > 3",
      },
    ],
    observe: ["east"],
  });
  assert.deepEqual(
    batchResult.operators.map((o: any) => o.status),
    ["modified"]
  );
  await run({ operators: [], observe: ["west"] });
  const index = contextMessages.map(m => String(m.content)).find(t => t.startsWith("# Current operator catalog"))!;
  assert.match(index, /^west = filter\(region\) <- kept; schema=[^;]*; not executed/m);
  assert.match(index, /^east = filter\(region\) <- kept; schema=[^;]*; Completed/m);
  const modifyReceipt = contextMessages
    .map(m => String(m.content))
    .find(t => t.startsWith(`# Task ${request - 1} receipt`))!;
  assert.match(modifyReceipt, /Edited: kept/);
  assert.match(modifyReceipt, /Executed: east, kept/);
  assert.match(modifyReceipt, /Not re-executed \(inputs changed\): west/);
  // The observe of `west` in this task demanded it, so it executed now.
  assert.deepEqual(batchResult.observationErrors, []);
  const westResult = (agent as any).snapshotStorage.getOperatorResult((agent as any).head, "west");
  assert.equal(westResult?.state, "Completed");
  assert.equal(westResult?.totalRowCount, 1);

  const summary = {
    passed: true,
    real_engine: getBackendConfig().executionEndpoint,
    model_calls: 0,
    checks: [
      "a UDF chooses its own parameter names and executes",
      "a wrong arity still fails, without a cascaded does-not-exist message",
      "an absent operator is still reported as absent",
      "a single-column result returns without naming the column",
      "operator cards are byte-identical while the saved task range advances",
      "an answer cell beyond the display budget is returned whole from the retained copy",
      "the previous task's receipt is rendered as history",
      "an undemanded descendant of an edit stays not executed until observed, then runs",
    ],
  };
  await Bun.write(`${out}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} finally {
  const response = await fetch(`${getBackendConfig().apiEndpoint}/api/executions/${wid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.ok(response.ok);
  assertNativeCleanupSafe(
    { id: name, state: agent.getState(), delegate: { workflowId: wid, computingUnitId: cuid } },
    await response.json(),
    { agentId: name, wid, cuid }
  );
  await deleteWorkflow(token, wid);
  await terminateComputingUnit(token, cuid);
}
