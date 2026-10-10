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

/** Deterministic 2×2 data-statistics/flow-evidence probe. No LLM calls.
 * Start services with bin/local-dev.sh, then from agent-service run:
 * bun benchmark/e2e/registered-evidence-matrix.ts
 * Each cell owns an agent and workflow; all share one owned local CU.
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { asSchema } from "ai";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent, deleteAgent, getReActSteps, getSnapshot } from "../../src/api/agent-service-api";
import { createComputingUnit, createWorkflow, deleteWorkflow, login, terminateComputingUnit } from "../../src/api";
import { env } from "../../src/config/env";
import { ContextMode, type RetrievalView } from "../../src/types/agent";
import { buildRegisteredNativeSystemPrompt } from "../../src/agent/prompts";
import { WorkflowState } from "../../src/agent/workflow-state";
import { renderDataflowActionsResult, type DataflowActionsResult } from "../../src/agent/tools/dataflow-actions";
import { createDataflowTool } from "../../src/agent/tools/turn-tool";
import { assertNativeCleanupSafe } from "./native-cleanup";
import { dataflowActionTypes, dataflowDebugInput, shownResult } from "./native-debug-input";

const baseUrl = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3001";
const directory = mkdtempSync(join(tmpdir(), "registered-evidence-matrix-"));
const save = (name: string, value: unknown) =>
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + "\n");
const log = (message: string) => console.log(`[evidence-matrix] ${message}`);
const checks: Array<Record<string, unknown>> = [];
let token: string;
let cuid: number | undefined;
let resource: { agentId: string; wid: number; cuid: number } | undefined;
let retainedResource = false;
let views: RetrievalView[] = [];

async function json(url: string, authenticated = false): Promise<any> {
  const response = await fetch(url, authenticated ? { headers: { Authorization: `Bearer ${token}` } } : {});
  assert.equal(response.status, 200, `HTTP ${response.status} at ${new URL(url).pathname}`);
  return response.json();
}
const history = () => json(`${env.TEXERA_DASHBOARD_SERVICE_ENDPOINT}/api/executions/${resource!.wid}`, true);

async function debug(python: string, statements: string): Promise<string> {
  const content = dataflowDebugInput(python, statements, views);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/agents/${resource!.agentId}/react`);
    let sent = false,
      completed = false,
      settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail("Debug actions timed out; verify terminal state before cleanup."), 240_000);
    ws.onmessage = event => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "init" && !sent) {
        sent = true;
        ws.send(JSON.stringify({ type: "debug", content }));
      } else if (frame.type === "complete" || frame.type === "error") completed = true;
      else if (frame.type === "nextContext" && completed) {
        settled = true;
        clearTimeout(timer);
        ws.close();
        resolve(frame.content);
      }
    };
    ws.onerror = () => fail("Debug WebSocket failed.");
    ws.onclose = () => {
      if (!settled) fail("Debug WebSocket closed before final context.");
    };
  });
}

/** One call whose every action must succeed. Showing a result asks the
 * engine even when all of it is cached. */
async function run(cell: string, label: string, python: string, statements: string, computes: boolean) {
  const expected = dataflowActionTypes(python, statements, views).map(() => "ok");
  const before = await history();
  const started = performance.now();
  const context = await debug(python, statements);
  const actionDurationMs = performance.now() - started;
  const trace = await getReActSteps(resource!.agentId, baseUrl);
  const result = trace.steps.flatMap(step => step.toolResults ?? []).at(-1)?.output as DataflowActionsResult;
  const snapshot = await getSnapshot(resource!.agentId, "head", baseUrl);
  const after = await history();
  const executions = after.length - before.length;
  const text = renderDataflowActionsResult(result);
  save(`${cell}-${label}.json`, { result, snapshot, executions, actionDurationMs });
  writeFileSync(join(directory, `${cell}-${label}.md`), text);
  writeFileSync(join(directory, `${cell}-${label}-context.txt`), context);
  assert.equal(result.protocol, "registered-python-v1");
  assert.deepEqual(
    result.actions.map(action => action.status),
    expected,
    `${cell}/${label}: ${text}`
  );
  assert.ok(computes ? executions > 0 : executions === 0, `${cell}/${label}: unexpected executions ${executions}`);
  return { result, snapshot, text, executions, actionDurationMs };
}

async function cleanup() {
  if (!resource) return;
  const owned = resource;
  if (owned.agentId) {
    assertNativeCleanupSafe(await json(`${baseUrl}/api/agents/${owned.agentId}`), await history(), owned);
    await deleteAgent(owned.agentId, baseUrl);
  }
  await deleteWorkflow(token, owned.wid);
  resource = undefined;
}

try {
  log(`Artifacts: ${directory}`);
  token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
  const unit = await createComputingUnit(token, `evidence-matrix-${Date.now()}`, {
    unitType: "local",
    uri: process.env.TEXERA_LOCAL_CU_URI ?? env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
  });
  cuid = unit.computingUnit.cuid;
  const sourcePath = join(directory, "records.csv");
  writeFileSync(
    sourcePath,
    "id,value,category\n" +
      Array.from({ length: 24 }, (_, index) => {
        const value = index + 1;
        return `${value},${value % 6 ? value : "invalid"},${value === 24 ? "excluded" : "accepted"}`;
      }).join("\n") +
      "\n"
  );
  const lookupPath = join(directory, "lookup.csv");
  writeFileSync(
    lookupPath,
    "id,label\n" +
      [...Array.from({ length: 20 }, (_, i) => i + 1), 1, 99].map(id => `${id},group-${id % 2}`).join("\n") +
      "\n"
  );
  const workbookPath = join(directory, "discovery.xlsx");
  const columnNames = Array.from({ length: 179 }, (_, i) => (i === 178 ? "last value " : `column_${i + 1}`));
  const fixture = spawnSync(
    process.env.UDF_PYTHON_PATH ?? fileURLToPath(new URL("../../../.venv/bin/python", import.meta.url)),
    [
      "-c",
      `import json, sys
import pandas as pd
spec = json.load(sys.stdin)
with pd.ExcelWriter(spec['path'], engine='openpyxl') as writer:
    pd.DataFrame([list(range(179)), list(range(1,180))], columns=spec['columns']).to_excel(writer, sheet_name='Measurements', index=False)
    pd.DataFrame({'key':['a'], 'description':['example']}).to_excel(writer, sheet_name='Lookup', index=False)
    pd.DataFrame().to_excel(writer, sheet_name='Empty', index=False)
`,
    ],
    { input: JSON.stringify({ path: workbookPath, columns: columnNames }), encoding: "utf8", timeout: 30_000 }
  );
  assert.equal(fixture.status, 0, fixture.error?.message ?? fixture.stderr);

  for (const data of [false, true])
    for (const flow of [false, true]) {
      const cell = `data${Number(data)}-flow${Number(flow)}`;
      const retrievalViews: RetrievalView[] = data ? ["sample_stats", "full"] : ["sample", "full"];
      views = retrievalViews;
      const settings = {
        agentMode: "native" as const,
        contextMode: "delta" as const,
        messageLayout: "native" as const,
        retrievalViews,
        nativeProfileCollection: true,
        nativeProfileScope: "full" as const,
        dataEvidence: data,
        flowEvidence: flow,
        fullResultCharLimit: 5000,
        maxOperatorResultCharLimit: 2000,
        maxResultRows: 2,
        dataEvidenceCharLimit: 2000,
        flowEvidenceCharLimit: 2000,
        maxSteps: 4,
      };
      const wid = await createWorkflow(
        token,
        `evidence-${cell}-${Date.now()}`,
        new WorkflowState().getWorkflowContent()
      );
      resource = { agentId: "", wid, cuid };
      const agent = await createAgent({
        baseUrl,
        userToken: token,
        modelType: process.env.TEXERA_AGENT_MODEL ?? "gpt-5.6-luna",
        workflowId: wid,
        computingUnitId: cuid,
        settings,
      });
      resource.agentId = agent.id;
      save(`${cell}-resource.json`, resource);
      const info = await json(`${baseUrl}/api/agents/${agent.id}/system-info`);
      save(`${cell}-system-info.json`, info);
      assert.equal(info.systemPrompt, buildRegisteredNativeSystemPrompt(ContextMode.DELTA, settings));
      assert.equal(info.systemPrompt.includes("Column statistics in `sample_stats`"), data);
      assert.equal(info.systemPrompt.includes("Flow statistics report measured effects"), flow);
      assert.equal(info.systemPrompt.includes("sample_stats"), data);
      assert.deepEqual(
        info.tools.find((tool: any) => tool.name === "dataflow").inputSchema,
        asSchema(createDataflowTool(retrievalViews).inputSchema).jsonSchema
      );

      const first = await run(
        cell,
        "execute",
        'def select_record(row, *, category):\n    """Retain records matching the requested category."""\n    return row[\'category\'] == category\n',
        [
          `set source: scan(files=${JSON.stringify(sourcePath)}, all_text=True)`,
          "set converted: cast(source, columns={'value': float64}, errors='null')",
          "set selected: filter(converted, predicate='select_record', settings={'category': 'accepted'})",
          `set lookup: scan(files=${JSON.stringify(lookupPath)}, all_text=True)`,
          "set joined: join(selected, lookup, on='id', how='inner')",
          "set summary: aggregate(joined, outputs={'total': sum('value'), 'measured': count('value'), 'rows': count()})",
          "execute summary",
          `show result joined, summary ${retrievalViews[0]}`,
        ].join("\n"),
        true
      );
      const joined = shownResult(first.result, "joined");
      const summary = shownResult(first.result, "summary");
      assert.equal(joined.text.includes("statistics:"), data, `${cell}: joined statistics mismatch`);
      assert.equal(summary.table.complete, true);
      assert.equal(summary.text.includes("statistics: not shown; the complete records above show every value"), data);
      assert.equal(
        summary.evidence.some((id: string) => id.startsWith("data.column.")),
        false,
        `${cell}: redundant small-table statistics`
      );
      assert.equal(
        joined.evidence.some((id: string) => id.startsWith("data.")),
        data
      );
      assert.equal(first.text.includes("- flow:"), flow, `${cell}: flow display mismatch`);
      // The `execute summary` statement alone; the edit is the call's first action.
      const executeText = renderDataflowActionsResult({ ...first.result, actions: [first.result.actions[1]] });
      assert.equal(executeText.includes("- flow:"), flow, `${cell}: execution flow mismatch`);
      // Only downstream tables were retrieved. Measured ancestor losses
      // remain visible, while stored retrievals remain self-contained even
      // when the current receipt references facts printed during execution.
      if (flow) {
        const frozenSummary = first.snapshot.nativeObservations!.summary.text;
        assert.match(frozenSummary, /- flow \(converted\):.*conversion failures=4\/24/);
        assert.match(frozenSummary, /- flow \(joined\):.*unmatched rows=3/);
        assert.match(frozenSummary, /max eligible multiplicity=2/);
        assert.match(executeText, /Filter kept=23\/24.*rejected=1/);
        assert.match(executeText, /Filter "category" among 1 rejected rows/);
        assert.match(frozenSummary, /- flow \(selected\):.*Filter kept=23\/24/);
        assert.match(first.text, /see `(?:selected|converted|joined)` above/);
      }
      const filterProfile = (first.snapshot.results.selected as any).tableProfile;
      assert.equal(filterProfile.native.operations.rejectedRows, 1);
      assert.deepEqual(filterProfile.native.operations.predicateColumns, ["category"]);
      assert.equal(filterProfile.native.operations.filterRejectedValues.columns.category.examples[0].count, 1);
      assert.ok(filterProfile.native.operations.timing.operatorBodyMs >= 0);
      assert.ok(filterProfile.native.operations.timing.filterRejectedValuesMs >= 0);
      assert.ok(filterProfile.cost.snapshotMs >= 0);
      const rows = (first.snapshot.results.summary as any).sampleRecords;
      assert.deepEqual(rows, [{ total: 175, measured: 18, rows: 21 }]);
      const version = (first.snapshot.results.summary as any).resultVersion.id;

      const second = await run(cell, "cache-and-full", "", "execute summary\nshow result joined, summary full", true);
      assert.match(second.text, /cached/);
      // Explicit execution still dispatches an engine request when all of its
      // operators resolve from cache. Result identities prove cache reuse.
      assert.ok(
        (second.result.actions[0].output as any).operators.every((operator: any) => operator.state === "cached")
      );
      assert.equal((second.snapshot.results.summary as any).resultVersion.id, version);
      for (const id of ["source", "selected", "converted", "lookup", "joined", "summary"]) {
        assert.equal((second.snapshot.results[id] as any).materialization.cached, true);
        assert.equal(
          (second.snapshot.results[id] as any).resultVersion.id,
          (first.snapshot.results[id] as any).resultVersion.id
        );
      }
      for (const entry of [shownResult(second.result, "joined"), shownResult(second.result, "summary")]) {
        assert.equal(entry.text.includes("statistics:"), false, `${cell}: full view must not add column statistics`);
        assert.equal(
          entry.evidence.some((id: string) => id.startsWith("flow.")),
          flow
        );
      }
      const shown = await run(cell, "show-cached", "", `show result joined, summary ${retrievalViews[0]}`, true);
      assert.equal((shown.snapshot.results.summary as any).resultVersion.id, version);
      assert.ok(
        (shown.result.actions[0].output as any).operators.every((operator: any) => operator.state === "cached")
      );
      const discovery = await run(
        cell,
        "schema-and-sheets",
        "",
        [
          `set workbook_preview: scan(files=${JSON.stringify(workbookPath)}, preview=1)`,
          `set wide: scan(files=${JSON.stringify(workbookPath)}, sheet='Measurements')`,
          "execute workbook_preview, wide",
          "show schema wide",
          "show schema wide from 170",
          "show builtin filter",
        ].join("\n"),
        true
      );
      // Actions: edit, execute, then execute + schema twice, then the builtin contract.
      const scanned = discovery.result.actions[1].output as any;
      const wideBlock = scanned.operator_blocks.find((block: any) => block.id === "wide");
      assert.ok(
        (wideBlock?.scope ?? []).some((line: string) =>
          line.startsWith('workbook sheets of "wide": "Measurements", "Lookup", "Empty"')
        ),
        JSON.stringify(wideBlock)
      );
      const schema = discovery.result.actions[3].output as any;
      assert.equal(schema.total_columns, 179);
      assert.equal(schema.complete, true);
      assert.deepEqual(
        schema.columns.map((column: any) => column.name),
        columnNames
      );
      const page = discovery.result.actions[5].output as any;
      assert.equal(page.next_offset, null);
      assert.deepEqual(
        page.columns.map((column: any) => column.name),
        columnNames.slice(170)
      );
      assert.match((discovery.result.actions[6].output as any).text, /filter\(t, predicate="name", settings=\{\}\)/);
      const trace = (await getReActSteps(agent.id, baseUrl)).steps;
      assert.ok(
        trace.every(step => !step.usage),
        "Deterministic probe unexpectedly recorded model usage"
      );
      save(`${cell}-trace.json`, trace);
      checks.push({
        cell,
        passed: true,
        executions: first.executions,
        cachedExecutionRequests: second.executions,
        showCachedExecutionRequests: shown.executions,
        initialActionDurationMs: first.actionDurationMs,
        cachedActionDurationMs: second.actionDurationMs,
        showCachedActionDurationMs: shown.actionDurationMs,
        cachedExecutionTelemetry: (second.result.actions[0].output as any).execution_runs,
        initialExecutionTelemetry: (first.result.actions[1].output as any).execution_runs,
        profiles: Object.fromEntries(
          Object.entries(first.snapshot.results).map(([id, value]: [string, any]) => [
            id,
            { cost: value.tableProfile?.cost, timing: value.tableProfile?.native?.operations?.timing },
          ])
        ),
        discovery: {
          sheets: wideBlock.scope,
          columns: schema.total_columns,
          executions: discovery.executions,
          actionDurationMs: discovery.actionDurationMs,
        },
        promptCharacters: info.systemPrompt.length,
        executionCharacters: executeText.length,
        retrievalCharacters: joined.text.length + summary.text.length,
        answer: rows[0],
      });
      log(`PASS ${cell}: answer=175, data=${data}, flow=${flow}, cache reused`);
      await cleanup();
    }
  save("summary.json", { passed: true, checks });
  log(`All four cells passed. Artifacts: ${directory}`);
} catch (error) {
  save("summary.json", { passed: false, checks, error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  try {
    await cleanup();
  } catch (error) {
    retainedResource = true;
    save("cleanup-error.json", { error: String(error), resource });
    log(`Retained resources; inspect ${join(directory, "cleanup-error.json")}`);
  }
  if (cuid !== undefined && !retainedResource) await terminateComputingUnit(token!, cuid);
  save("cleanup.json", {
    retainedResource,
    resource,
    computingUnitTerminated: cuid !== undefined && !retainedResource,
  });
}
