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
 * No-LLM end-to-end check of ERROR REPORTING in native mode against a running
 * stack: every layer of the error taxonomy is triggered through the real
 * `dataflow` tool and the real engine, and the observation the model would
 * read is asserted to carry the code, the stage, the offending argument, the
 * cause (column / value / option) and a repair hint. Run from agent-service:
 *
 *   bun run benchmark/e2e/native-errors-run.ts
 *
 * Environment: TEXERA_AGENT_SERVICE_ENDPOINT (default :3001), TEXERA_LOCAL_CU_URI
 * (default :8085), TEXERA_USERNAME/TEXERA_PASSWORD (default texera/texera).
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgent,
  createComputingUnit,
  createWorkflow,
  deleteAgent,
  deleteWorkflow,
  getReActSteps,
  getSnapshot,
  login,
  terminateComputingUnit,
} from "../../src/api";
import { WorkflowState } from "../../src/agent/workflow-state";
import { WorkflowSnapshotStorage } from "../../src/agent/workflow-snapshot-storage";
import { assembleContext } from "../../src/agent/util/context-utils";
import { AgentMode, ContextMode, type ReActStep } from "../../src/types/agent";
import type { OperatorInfo } from "../../src/types/execution";

const baseUrl = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3001";
const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
const stamp = Date.now();
const cu = await createComputingUnit(token, `errors-smoke-${stamp}`, {
  unitType: "local",
  uri: process.env.TEXERA_LOCAL_CU_URI ?? "http://localhost:8085",
});
const cuid = cu.computingUnit.cuid;
let wid: number | undefined;
let agentId: string | undefined;
let fixtureDir: string | undefined;
const mirroredSteps: ReActStep[] = [];
const mirroredState = new WorkflowState();
const mirroredStorage = new WorkflowSnapshotStorage(id =>
  mirroredSteps.slice(0, mirroredSteps.findIndex(s => s.id === id) + 1).map(s => s.id)
);
let priorResults: Record<string, any> = {};

async function observationFromService(): Promise<string> {
  const trace = await getReActSteps(agentId!, baseUrl);
  mirroredSteps.splice(0, mirroredSteps.length, ...trace.steps);
  const step = mirroredSteps.at(-1)!;
  const snap = await getSnapshot(agentId!, "head", baseUrl);
  assert.ok(snap.workflow);
  mirroredState.setWorkflowContent(snap.workflow);
  mirroredStorage.createSnapshot(step.id, snap.workflow);
  const edited = new Set(
    (step.toolResults?.[0]?.output?.operators ?? [])
      .filter((op: any) => op.status === "added" || op.status === "modified")
      .map((op: any) => op.id)
  );
  for (const [id, summary] of Object.entries(snap.results)) {
    if (!edited.has(id) && JSON.stringify(priorResults[id]) === JSON.stringify(summary)) continue;
    const entry = summary as any;
    mirroredStorage.setOperatorResult(step.id, id, {
      ...entry,
      operatorID: id,
      result: entry.sampleRecords,
    } as OperatorInfo);
  }
  priorResults = snap.results;
  return assembleContext(mirroredSteps, mirroredState, mirroredStorage, ContextMode.DELTA, {
    agentMode: AgentMode.NATIVE,
    resultSelection: "all",
    flowEvidence: true,
    dataEvidence: true,
  })
    .map(m => m.content)
    .join("\n");
}

function debug(name: string, args: Record<string, unknown>): Promise<{ context: string; tool: any; error?: string }> {
  // Expand expression fixtures into the public ordered-action protocol.
  // An empty edit is a cached retrieval; deletion alone does not execute.
  if (name === "dataflow" && !("actions" in args)) {
    const expressions = String(args.edits ?? "");
    const remove = (args.delete ?? []) as string[];
    args = {
      reasoning: "Check the edits and their execution results.",
      actions: [
        ...(expressions || remove.length ? [{ type: "edit", expressions, delete: remove }] : []),
        ...(expressions ? [{ type: "execute" }] : []),
        ...((args.observe ?? []) as string[]).map(operator_id => ({ type: "retrieve", operator_id })),
      ],
    };
  }
  return new Promise<{ raw: string; tool: any; error?: string }>((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/agents/${agentId}/react`);
    let sent = false;
    let completed = false;
    let toolError: string | undefined;
    const finish = (error?: Error, raw = "") => {
      clearTimeout(timeout);
      ws.close();
      if (error) reject(error);
      else resolve({ raw, tool: undefined, error: toolError });
    };
    const timeout = setTimeout(() => finish(new Error(`Timeout waiting for ${name}`)), 180_000);
    ws.onmessage = event => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "init" && !sent) {
        sent = true;
        ws.send(
          JSON.stringify({
            type: "debug",
            content: `Function(name=${JSON.stringify(name)}, arguments=${JSON.stringify(JSON.stringify(args))})`,
          })
        );
      } else if (frame.type === "error") toolError = String(frame.error);
      else if (frame.type === "complete") completed = true;
      else if (frame.type === "nextContext" && (completed || toolError)) finish(undefined, frame.content);
    };
    ws.onerror = () => finish(new Error("WebSocket error"));
  }).then(async frame => {
    const context = await observationFromService();
    const tool = mirroredSteps.at(-1)?.toolResults?.[0]?.output;
    return { context, tool, error: frame.error };
  });
}

const lastObservation = (context: string) => context.slice(context.lastIndexOf("Observation:"));
const report: string[] = [];
function check(label: string, text: string, fragments: string[]) {
  const missing = fragments.filter(f => !text.includes(f));
  report.push(
    `${missing.length ? "FAIL" : "ok  "} ${label}${missing.length ? `  missing: ${JSON.stringify(missing)}` : ""}`
  );
  assert.deepEqual(missing, [], `${label}\n--- observation ---\n${text.slice(0, 2500)}`);
}

try {
  fixtureDir = mkdtempSync(join(tmpdir(), "native-errors-"));
  writeFileSync(join(fixtureDir, "sales.csv"), "region,amount,label\nwest,10,a\nwest,x,b\neast,30,c\n");
  writeFileSync(join(fixtureDir, "names.csv"), "region,name\nwest,West\nwest,West again\n");
  writeFileSync(join(fixtureDir, "dup.csv"), "a,b,a\n1,2,3\n");
  wid = await createWorkflow(token, `errors-smoke-${stamp}`, new WorkflowState().getWorkflowContent());
  const agent = await createAgent({
    baseUrl,
    userToken: token,
    modelType: "gpt-5.6-luna",
    workflowId: wid,
    computingUnitId: cuid,
    settings: {
      agentMode: "native",
      resultSelection: "all",
      contextMode: "delta",
      flowEvidence: true,
      dataEvidence: true,
    },
  });
  agentId = agent.id;

  // 1. Program syntax: the unparseable statement fails at its line; the other
  //    statement lands; the execute action is skipped.
  const syntax = await debug("dataflow", {
    edits: 'sales_probe = scan("x.csv"\nnames_probe = scan("y.csv")',
    observe: [],
  });
  check("an unparseable statement fails alone at its line", lastObservation(syntax.context), [
    "[PROGRAM_SYNTAX; validate;",
    "line 1",
    "was never closed",
    "other statements landed",
    "added scan operator `names_probe`",
  ]);
  await debug("dataflow", { edits: "", delete: ["names_probe"] });

  // 2. Argument layer (TypeScript): the value the model wrote, the accepted set and the signature.
  const args = await debug("dataflow", {
    edits: [
      `sales = scan("${fixtureDir}/sales.csv")`,
      `names = scan("${fixtureDir}/names.csv")`,
      'bad_join = join(sales, names, on="region", how="outer_left")',
      'running = window(sales, order_by=["amount"], total=sum("amount"))',
      "top = limit(bad_join, 1)",
    ].join("\n"),
    observe: [],
  });
  const argsText = lastObservation(args.context);
  check("argument enum names value, choices and signature", argsText, [
    'got "outer_left"',
    '"inner", "left", "right", "full", "cross"',
    "Signature: join(",
  ]);
  check("window aggregate is refused with the accepted functions", argsText, [
    "must be a window function call",
    "lag, lead, row_number, rank, dense_rank",
  ]);
  check("dependents of a rejected statement are blocked, not silently dropped", argsText, [
    "UPSTREAM_FAILED",
    "`bad_join`",
  ]);
  check("independent statements still land", argsText, ["added scan operator `sales`", "added scan operator `names`"]);

  // 3. Execute layer (Python, with data): cast failure names column and value; blocked consumer names the root.
  const cast = await debug("dataflow", {
    edits: ["typed = cast(sales, amount=float64)", 'total = aggregate(typed, s=sum("amount"))'].join("\n"),
    observe: ["total"],
  });
  const castText = lastObservation(cast.context);
  check("cast failure carries code, stage, revision, column, value, field and hint", castText, [
    "[CAST_INVALID_VALUE; execute; revision ",
    "Cannot cast 'amount' to float64",
    "'x'",
    "Field: columns[0]",
    'Hint: Normalize the input or explicitly choose errors="null"',
    "Diagnostic: diag_",
  ]);
  check("the consumer of a failed operator names the root failure", castText, [
    "`total` not executed; upstream `typed` failed (CAST_INVALID_VALUE)",
  ]);

  // 4. Custom code: the failing line of the submitted function and the missing column by name.
  const callback = await debug("dataflow", {
    edits: [
      "def scaled(row):",
      '    return {**row, "twice": row["Amount"] * 2.0}',
      'typed = cast(sales, amount=float64, errors="null")',
      'doubled = map(typed, scaled, doc="Adds twice = 2 * Amount")',
    ].join("\n"),
    observe: ["doubled"],
  });
  const callbackText = lastObservation(callback.context);
  check("a function reading a missing column reports the column and the line", callbackText, [
    "[MISSING_COLUMN; execute; revision ",
    "read column 'Amount', which the input table does not have",
    "scaled line 2",
    "Hint: Observe the current input schema",
  ]);

  await debug("dataflow", { edits: "", delete: ["doubled"] });

  // 5. Relational contracts. The engine aborts the run at the first failure,
  // so an unrelated statement in the same execution must be told exactly that
  // (not blamed on an operator it never reads), while a real consumer names its
  // upstream root.
  const cardinality = await debug("dataflow", {
    edits: [
      'labeled = join(typed, names, on="region", how="left", validate="many_to_one")',
      "label_count = aggregate(labeled, n=count())",
      "typed_count = aggregate(typed, n=count())",
    ].join("\n"),
    observe: ["labeled", "label_count", "typed_count"],
  });
  const cardinalityText = lastObservation(cardinality.context);
  check("join cardinality names the duplicate key", cardinalityText, [
    "[JOIN_CARDINALITY; contract; revision ",
    "many_to_one",
    "duplicate ('west',)",
    "Field: validate",
    "Hint: Inspect key uniqueness",
  ]);
  check("a consumer of the failed operator names its upstream root", cardinalityText, [
    "`label_count` not executed; upstream `labeled` failed (JOIN_CARDINALITY)",
  ]);
  // Whether a bystander finishes before the engine aborts the run is timing
  // dependent. Either it produced its result, or it was told the run stopped
  // elsewhere; it is never blamed for an operator it does not read.
  const outcomes = cardinality.tool.actions.find((a: any) => a.action.type === "execute").output.operators;
  const bystander = outcomes.find((op: any) => op.id === "typed_count");
  assert.ok(bystander, "execution must report the independent branch");
  const bystanderText = bystander.message ?? "";
  assert.ok(bystander.status === "ok" || bystanderText.includes("does not read from `labeled`"));
  assert.ok(!bystanderText.includes("upstream `labeled` failed"));
  report.push("ok  bystander attribution");
  // Remove the failing join and its consumer so the next execution is clean.
  const refused = await debug("dataflow", { edits: "", delete: ["labeled"] });
  check("a delete is refused while a consumer still reads the operator", lastObservation(refused.context), [
    "`labeled` still feeds `label_count`",
  ]);
  const removed = await debug("dataflow", { edits: "", delete: ["label_count", "labeled"] });
  check("deleting the consumer and its producer together succeeds", lastObservation(removed.context), [
    "deleted operator `label_count`",
    "deleted operator `labeled`",
  ]);
  const unionErr = await debug("dataflow", {
    edits: 'both = union(typed, names, schema="strict")',
    observe: ["both"],
  });
  check("union schema names the columns that differ", lastObservation(unionErr.context), [
    "[UNION_SCHEMA; execute; revision ",
    "input 2 lacks ['amount', 'label']",
    "input 2 adds ['name']",
    'schema="align"',
    "Field: schema",
  ]);
  await debug("dataflow", { edits: "", delete: ["both"] });

  // 6. Process contract: wrong return type; and a scan header problem.
  const processErr = await debug("dataflow", {
    edits: [
      "def summarize(t):",
      "    return [len(t)]",
      'summary = process(typed, fn=summarize, doc="Counts the rows")',
      `dup = scan("${fixtureDir}/dup.csv")`,
    ].join("\n"),
    observe: ["summary", "dup"],
  });
  const processText = lastObservation(processErr.context);
  check("process returning a non-DataFrame is a contract error with a hint", processText, [
    "[PROCESS_RETURN_TYPE; contract; revision ",
    "got list",
    "Hint: Return one pandas DataFrame",
  ]);
  check("duplicate headers are a scan error with the repair path", processText, [
    "[SCAN_HEADER; execute; revision ",
    "Duplicate header names",
    "header=False",
  ]);

  await debug("dataflow", { edits: "", delete: ["summary", "dup"] });

  // 7. A row-to-row map that returns different keys per row is a schema error naming both rows.
  const mapErr = await debug("dataflow", {
    edits:
      'uneven = map(typed, lambda row: {**row, "flag": 1} if row["amount"] is None else {"only": 1}, doc="Returns different keys depending on amount")',
    observe: ["uneven"],
  });
  check("a map returning different keys per row is a schema error", lastObservation(mapErr.context), [
    "[MAP_SCHEMA; contract; revision ",
    "every row must return the same keys",
    "Hint: Return the same keys from every row",
  ]);

  console.log(report.join("\n"));
  console.log(JSON.stringify({ passed: true, checks: report.length, steps: mirroredSteps.length }));
} finally {
  if (agentId) await deleteAgent(agentId, baseUrl).catch(() => {});
  if (wid) await deleteWorkflow(token, wid).catch(() => {});
  await terminateComputingUnit(token, cuid).catch(() => {});
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
}
