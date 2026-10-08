/**
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/** Deterministic workbook and input-isolation preflight; never calls a model. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  createAgent,
  deleteAgent,
  getReActSteps,
  getSnapshot,
} from "../../agent-service/src/api/agent-service-api";
import {
  createComputingUnit,
  createWorkflow,
  deleteWorkflow,
  login,
  terminateComputingUnit,
} from "../../agent-service/src/api";
import { WorkflowState } from "../../agent-service/src/agent/workflow-state";
import { assertNativeCleanupSafe } from "../../agent-service/benchmark/e2e/native-cleanup";
import { nativeDebugInput } from "../../agent-service/benchmark/e2e/native-debug-input";
import {
  asDataflowActionsResult,
  type DataflowAction,
} from "../../agent-service/src/agent/tools/dataflow-actions";
import type { AgentSettingsApi } from "../../agent-service/src/types/agent";

const root = resolve(import.meta.dir, "../..");
const pilot = resolve(
  process.env.DSBENCH_PREPARED_ROOT ?? "/var/tmp/texera-dsbench-pilot-20261008",
);
const directory = resolve(
  process.env.DSBENCH_PREFLIGHT_ARTIFACT_DIR ?? join(pilot, "preflight"),
);
const allText = process.env.DSBENCH_PREFLIGHT_ALL_TEXT === "true";
const base =
  process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3082";
const dashboard =
  process.env.TEXERA_DASHBOARD_SERVICE_ENDPOINT ?? "http://localhost:22080";
const workspaceRoot =
  process.env.NATIVE_WORKSPACE ??
  "/var/tmp/texera-single-task-final/native-workspaces";
const sourceData =
  process.env.NATIVE_SOURCE_DATA ?? join(root, "benchmark/Kramabench/data");
const manifest = JSON.parse(readFileSync(join(pilot, "manifest.json"), "utf8"));
const expectedRows: Record<string, number> = {
  "00000034": 5060,
  "00000032": 8760,
  "00000006": 1000,
  "00000010": 380,
};
const settings: AgentSettingsApi = {
  agentMode: "native",
  contextMode: "delta",
  nativeProfileCollection: true,
  dataEvidence: true,
  flowEvidence: true,
  retrievalViews: ["sample_stats", "full"],
  maxSteps: 25,
  maxOperatorResultCharLimit: 2000,
  fullResultCharLimit: 5000,
  maxResultRows: 5,
  dataEvidenceCharLimit: 2000,
  flowEvidenceCharLimit: 2000,
};
const save = (dir: string, name: string, value: unknown) =>
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + "\n");
const digest = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");
assert(!existsSync(directory), "Refusing to overwrite a preflight attempt");
mkdirSync(directory);
save(directory, "config.json", {
  no_model_calls: true,
  settings,
  all_text: allText,
  manifest_sha256: digest(readFileSync(join(pilot, "manifest.json"))),
  expected_rows: expectedRows,
});
const token = await login(
  process.env.TEXERA_USERNAME ?? "texera",
  process.env.TEXERA_PASSWORD ?? "texera",
);
async function get(url: string, authenticated = false): Promise<any> {
  const response = await fetch(
    url,
    authenticated ? { headers: { Authorization: `Bearer ${token}` } } : {},
  );
  assert(response.ok, `HTTP ${response.status}: ${new URL(url).pathname}`);
  return response.json();
}

async function debug(agentId: string, actions: DataflowAction[]) {
  return new Promise<void>((done, reject) => {
    const socket = new WebSocket(
      `${base.replace(/^http/, "ws")}/api/agents/${agentId}/react`,
    );
    let sent = false,
      complete = false,
      settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else done();
    };
    const timer = setTimeout(
      () => finish(new Error("DSBench engine preflight timed out")),
      240_000,
    );
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "init" && !sent) {
        sent = true;
        socket.send(
          JSON.stringify({
            type: "debug",
            content: nativeDebugInput("dataflow", {
              reasoning:
                "Verify original DSBench workbook loading, statistics retrieval, and task input isolation.",
              actions,
            }),
          }),
        );
      } else if (frame.type === "complete") complete = true;
      else if (frame.type === "error")
        finish(new Error(String(frame.content ?? frame.error)));
      else if (frame.type === "nextContext" && complete) finish();
    };
    socket.onerror = () => finish(new Error("DSBench preflight socket failed"));
    socket.onclose = () => {
      if (!settled)
        finish(new Error("DSBench preflight socket closed before completion"));
    };
  });
}

const summaries: any[] = [];
for (const challengeId of Object.keys(expectedRows)) {
  const task = manifest.tasks.find(
    (row: any) => row.challenge_id === challengeId,
  );
  assert(task, `Missing challenge ${challengeId}`);
  const dir = join(directory, challengeId);
  mkdirSync(dir);
  const relative = `dsbench/${task.task_id}`;
  const inputDirectory = join(sourceData, relative);
  assert.deepEqual(
    readdirSync(inputDirectory).sort(),
    [...task.allowed_files].sort(),
    "Task input allowlist differs",
  );
  for (const file of task.files)
    assert.equal(
      digest(readFileSync(join(inputDirectory, file.name))),
      file.sha256,
      "Mounted input differs from source",
    );
  let agentId = "",
    wid: number | undefined,
    cuid: number | undefined;
  let passed = false,
    cleaned = false,
    failure: unknown;
  try {
    cuid = (
      await createComputingUnit(
        token,
        `dsbench-preflight-${challengeId}-${Date.now()}`,
        {
          unitType: "local",
          uri: process.env.TEXERA_LOCAL_CU_URI ?? "http://localhost:22085",
        },
      )
    ).computingUnit.cuid;
    wid = await createWorkflow(
      token,
      `dsbench-preflight-${challengeId}-${Date.now()}`,
      new WorkflowState().getWorkflowContent(),
    );
    const workspace = join(workspaceRoot, String(wid));
    mkdirSync(workspace, { recursive: true });
    save(workspace, "task-inputs.json", { relative_path: relative });
    save(dir, "task-inputs.json", { relative_path: relative });
    const agent = await createAgent({
      baseUrl: base,
      userToken: token,
      modelType: "gpt-5.6-luna",
      workflowId: wid,
      computingUnitId: cuid,
      settings,
    });
    agentId = agent.id;
    const resource = { agentId, wid, cuid };
    save(dir, "resource.json", resource);
    const actualSettings = await get(`${base}/api/agents/${agentId}/settings`);
    save(dir, "settings.json", actualSettings);
    for (const [key, value] of Object.entries(settings))
      assert.deepEqual(actualSettings[key], value, `Setting drift: ${key}`);
    save(
      dir,
      "system-info.json",
      await get(`${base}/api/agents/${agentId}/system-info`),
    );
    const sibling = manifest.tasks.find(
      (row: any) => row.task_id !== task.task_id,
    ).task_id;
    const filepath = `data/${relative}/${task.workbook_file}`;
    const changes = [
      `source = scan(${JSON.stringify(filepath)}, sheet=${JSON.stringify(task.layout.selected_sheet)}, header=${task.layout.header ? "True" : "False"}, skip_lines=${task.layout.skip_lines}${allText ? ", all_text=True" : ""})`,
      'isolation = process(source, fn=probe_inputs, doc="Check allowed task files and absence of sibling inputs and grading files")',
      "    def probe_inputs(df):",
      "        import os",
      "        import json",
      `        return pd.DataFrame({"rows": [len(df)], "visible_files": [json.dumps(sorted(os.listdir(${JSON.stringify(`data/${relative}`)})))], "gold_visible": [os.path.exists(${JSON.stringify(join(pilot, "evaluation/gold.json"))})], "sibling_visible": [os.path.exists(${JSON.stringify(`data/dsbench/${sibling}`)})], "notebook_visible": [os.path.exists(${JSON.stringify(`data/${relative}/get_results.ipynb`)})]})`,
    ].join("\n");
    writeFileSync(join(dir, "program.py"), changes + "\n");
    const actions: DataflowAction[] = [
      { type: "edit", changes },
      { type: "execute" },
      { type: "retrieve", operator_id: "source", view: "sample_stats" },
      { type: "retrieve", operator_id: "isolation", view: "full" },
    ];
    save(dir, "actions.json", actions);
    await debug(agentId, actions);
    const trace = await getReActSteps(agentId, base);
    save(dir, "react_steps.json", trace.steps);
    assert(
      trace.steps.every((step) => !step.usage),
      "Preflight unexpectedly called a model",
    );
    const receipts = trace.steps
      .flatMap((step) => step.toolResults ?? [])
      .map((item) => asDataflowActionsResult(item.output))
      .filter(Boolean);
    save(dir, "receipts.json", receipts);
    const receipt = receipts.at(-1)!;
    assert(receipt, "Missing debug action receipt");
    assert.equal(receipt.actions.length, actions.length);
    assert(
      receipt.actions.every((action) => action.status === "ok"),
      "An engine preflight action failed",
    );
    const snapshot = await getSnapshot(agentId, "head", base);
    save(dir, "snapshot.json", snapshot);
    const source: any = snapshot.results.source;
    save(dir, "source-profile.json", source?.tableProfile);
    assert.equal(
      source.totalRowCount,
      expectedRows[challengeId],
      "Workbook rows changed during scan",
    );
    assert(source.tableProfile, "Profile collection missing");
    assert.equal(
      source.tableProfile.coverage.rowsProcessed,
      expectedRows[challengeId],
      "Profile coverage incomplete",
    );
    const probe: any = snapshot.results.isolation;
    const row = probe.sampleRecords[0];
    assert.equal(row.rows, expectedRows[challengeId]);
    assert.deepEqual(
      JSON.parse(row.visible_files),
      [...task.allowed_files].sort(),
    );
    assert.equal(
      row.gold_visible,
      false,
      "Gold file is visible inside the worker",
    );
    assert.equal(
      row.sibling_visible,
      false,
      "Sibling task input is visible inside the worker",
    );
    assert.equal(
      row.notebook_visible,
      false,
      "Cached solution notebook is visible inside the worker",
    );
    passed = true;
    save(dir, "result.json", {
      passed,
      no_model_calls: true,
      rows: source.totalRowCount,
      profile: source.tableProfile.coverage,
      isolation: row,
    });
  } catch (error) {
    failure = error;
    save(dir, "error.json", { error: String(error) });
    if (agentId)
      save(dir, "react_steps.json", (await getReActSteps(agentId, base)).steps);
  } finally {
    if (agentId && wid !== undefined && cuid !== undefined) {
      try {
        const agent = await get(`${base}/api/agents/${agentId}`);
        const executions = await get(
          `${dashboard}/api/executions/${wid}`,
          true,
        );
        save(dir, "execution-history.json", executions);
        assertNativeCleanupSafe(agent, executions, { agentId, wid, cuid });
        await deleteAgent(agentId, base);
        await deleteWorkflow(token, wid);
        await terminateComputingUnit(token, cuid);
        cleaned = true;
        save(dir, "cleanup.json", { removed: true });
      } catch (error) {
        save(dir, "cleanup.json", { removed: false, error: String(error) });
        failure ??= error;
      }
    }
    summaries.push({
      challenge_id: challengeId,
      passed,
      cleaned,
      error: failure ? String(failure) : null,
    });
    save(directory, "summary.json", {
      passed:
        summaries.length === 4 &&
        summaries.every((row) => row.passed && row.cleaned),
      no_model_calls: true,
      workbooks: summaries,
    });
  }
  console.log(
    `PREFLIGHT ${challengeId}: rows=${expectedRows[challengeId]} passed=${passed} cleaned=${cleaned}`,
  );
  if (failure) throw failure;
}
