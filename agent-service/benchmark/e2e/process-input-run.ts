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

/** No model calls: exercise registered Python inputs through the live engine
 * transport (nullable and extreme integers, reshaped tables, empty tables).
 * PROCESS_INPUT_EXPECT_FAILURE=1 reproduces the pandas nullable-integer
 * failure on a runtime without the fix. */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, deleteAgent, getReActSteps } from "../../src/api/agent-service-api";
import { createComputingUnit, createWorkflow, deleteWorkflow, login, terminateComputingUnit } from "../../src/api";
import { env } from "../../src/config/env";
import { WorkflowState } from "../../src/agent/workflow-state";
import { asDataflowActionsResult, renderDataflowActionsResult } from "../../src/agent/tools/dataflow-actions";
import { assertNativeCleanupSafe } from "./native-cleanup";
import { dataflowDebugInput } from "./native-debug-input";

const base = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? "http://localhost:3001";
const directory = process.env.PROCESS_INPUT_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), "process-input-live-"));
mkdirSync(directory, { recursive: true });
const expectedFailure = process.env.PROCESS_INPUT_EXPECT_FAILURE === "1";
const save = (name: string, value: unknown) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2));
const checks: string[] = [];
let token = "",
  agentId = "",
  wid: number | undefined,
  cuid: number | undefined,
  sequence = 0;

async function debug(python: string, statements: string) {
  const content = dataflowDebugInput(python, statements, ["full"]);
  const before = (await getReActSteps(agentId, base)).steps.length;
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/agents/${agentId}/react`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Live process check timed out"));
    }, 240_000);
    let sent = false,
      finished = false;
    ws.onmessage = event => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "init" && !sent) {
        sent = true;
        ws.send(JSON.stringify({ type: "debug", content }));
      } else if (frame.type === "complete") finished = true;
      else if (frame.type === "error") {
        clearTimeout(timer);
        ws.close();
        reject(new Error(String(frame.content)));
      } else if (frame.type === "nextContext" && finished) {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error("Live process socket failed"));
    };
  });
  const { steps } = await getReActSteps(agentId, base);
  save("react-steps.json", steps);
  const result = steps
    .slice(before)
    .flatMap(step => (step.toolResults ?? []).map(item => asDataflowActionsResult(item.output)))
    .filter(Boolean)
    .at(-1)!;
  assert(result, "The debug call produced no receipt");
  save(`receipt-${++sequence}.json`, result);
  const text = renderDataflowActionsResult(result);
  writeFileSync(join(directory, `receipt-${sequence}.md`), text);
  return { result, text };
}

const reshape = (name: string, method: "pivot" | "unstack") => `def ${name}(r):
    """Reshape ratings to one column per user with ${method}."""
    r = r.copy()
    for column in ["book_id", "user_id", "rating"]:
        r[column] = pd.to_numeric(r[column], errors="coerce")
    wide = ${
      method === "pivot"
        ? 'r.pivot_table(index="book_id", columns="user_id", values="rating", aggfunc="first", fill_value=0.0)'
        : 'r.set_index(["book_id", "user_id"])["rating"].unstack(fill_value=0.0).fillna(0.0)'
    }
    wide.columns = ["user_" + str(value) for value in wide.columns]
    assert wide.values.tolist() == [[5, 4, 0], [0, 3, 2]]
    return wide.reset_index()`;

const integerFunctions = `def exact_source():
    """Integers beyond float precision, including the int64 bounds."""
    return pd.DataFrame({"id": pd.Series([2**53 + 1, -(2**63), 2**63 - 1], dtype="Int64")})
def exact_check(t):
    """Fail unless the integers arrive exactly, as int64."""
    assert str(t.id.dtype) == "int64", str(t.id.dtype)
    assert t.id.tolist() == [2**53 + 1, -(2**63), 2**63 - 1]
    return t
def masked_source():
    """Nullable integers with missing values."""
    return pd.DataFrame({"id": pd.Series([2**53 + 1, None, 2**63 - 1], dtype="Int64"), "missing": pd.Series([None, None, None], dtype="Int64")})
def masked_check(t):
    """Fail unless the nullable integers and their missing values arrive intact."""
    assert str(t.id.dtype) == "Int64" and str(t.missing.dtype) == "Int64"
    assert int(t.id.iloc[0]) == 2**53 + 1 and int(t.id.iloc[2]) == 2**63 - 1
    assert t.id.isna().tolist() == [False, True, False] and t.missing.isna().all()
    return t
def empty_source():
    """An empty nullable-integer table."""
    return pd.DataFrame({"id": pd.Series([], dtype="Int64")})`;

try {
  token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
  cuid = (
    await createComputingUnit(token, `process-input-${Date.now()}`, {
      unitType: "local",
      uri: env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
    })
  ).computingUnit.cuid;
  wid = await createWorkflow(token, `process-input-${Date.now()}`, new WorkflowState().getWorkflowContent());
  agentId = (
    await createAgent({
      baseUrl: base,
      userToken: token,
      workflowId: wid,
      computingUnitId: cuid,
      modelType: "gpt-5.6-luna",
      settings: {
        agentMode: "native",
        retrievalViews: ["full"],
        nativeProfileCollection: false,
        executionTimeoutMinutes: 1,
        toolTimeoutSeconds: 90,
      },
    })
  ).id;
  save("resources.json", { agentId, wid, cuid, base, model_calls: 0, expectedFailure });
  const csv = join(directory, "ratings.csv");
  writeFileSync(csv, "book_id,user_id,rating\n1,1,5\n1,2,4\n2,2,3\n2,3,2\n");
  const python = [
    "import pandas as pd",
    reshape("pivot_ratings", "pivot"),
    reshape("unstack_ratings", "unstack"),
    ...(expectedFailure ? [] : [integerFunctions]),
  ].join("\n\n");
  const statements = [
    `set ratings: scan(files=${JSON.stringify(csv)})`,
    "set pivoted: pivot_ratings(ratings)",
    "set unstacked: unstack_ratings(ratings)",
    ...(expectedFailure
      ? []
      : [
          "set exact_values: exact_source()",
          "set exact: exact_check(exact_values)",
          "set masked_values: masked_source()",
          "set masked: masked_check(masked_values)",
          "set empty: empty_source()",
        ]),
    "execute",
  ].join("\n");
  const built = await debug(python, statements);
  if (expectedFailure) {
    assert.equal(built.result.status, "error", built.text);
    assert(built.text.includes("KeyError") && built.text.includes("float64"), built.text);
    checks.push("original runtime reproduces pandas nullable-integer failure in the live engine");
  } else {
    assert.equal(built.result.status, "completed", built.text);
    for (const id of ["pivoted", "unstacked", "exact", "masked", "empty"]) {
      const read = await debug("", `show result ${id} full`);
      assert.equal(read.result.status, "completed", read.text);
      if (id === "exact" || id === "masked")
        assert(read.text.includes("9007199254740993") && read.text.includes("9223372036854775807"), read.text);
      if (id === "exact") assert(read.text.includes("-9223372036854775808"), read.text);
      if (id === "empty") assert(read.text.includes("0 rows") && read.text.includes("id"), read.text);
      checks.push(`live process input: ${id}`);
    }
  }
  save("report.json", { status: "passed", checks, model_calls: 0 });
  console.log(JSON.stringify({ directory, checks, model_calls: 0 }));
} catch (error) {
  save("report.json", { status: "failed", checks, error: String(error), model_calls: 0 });
  throw error;
} finally {
  if (agentId && wid !== undefined && cuid !== undefined) {
    const [agentResponse, historyResponse] = await Promise.all([
      fetch(`${base}/api/agents/${agentId}`),
      fetch(`${env.TEXERA_DASHBOARD_SERVICE_ENDPOINT}/api/executions/${wid}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);
    assert(agentResponse.ok && historyResponse.ok, "Cleanup state unavailable; retaining owned resources");
    assertNativeCleanupSafe(await agentResponse.json(), await historyResponse.json(), { agentId, wid, cuid });
    await deleteAgent(agentId, base);
    await deleteWorkflow(token, wid);
    await terminateComputingUnit(token, cuid);
    save("cleanup.json", { status: "completed", agentId, wid, cuid });
  }
}
