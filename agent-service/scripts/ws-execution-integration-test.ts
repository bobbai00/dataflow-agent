/**
 * Phase 3 integration test: drive a real workflow execution through the
 * ExecutionWsClient + ExecutionWatcher end-to-end against a live engine.
 *
 * Skips the agent class — directly exercises the WS+Watcher pipeline so we
 * isolate transport/watcher correctness from agent loop concerns.
 *
 * Steps:
 *   1. Mint a JWT against localhost:8080.
 *   2. Fetch workflow 1's content and build a LogicalPlanPojo.
 *   3. Open a WS, attach an ExecutionWatcher.
 *   4. Send WorkflowExecuteRequest.
 *   5. Loop on watcher.await(...) until terminal state.
 *   6. For each operator, request paginated results and print a few rows.
 *   7. Assert success or print failure details.
 *
 * Requires:
 *   - Engine at localhost:8085, webapp at localhost:8080.
 *   - Workflow id 1 exists and is runnable for user "texera".
 *
 * Run: bun run scripts/ws-execution-integration-test.ts
 */

import { ExecutionWsClient } from "../src/api/execution-ws-client";
import { ExecutionWatcher } from "../src/agent/execution-watcher";

const WEBAPP = "http://localhost:8080";
const WS_URL = "ws://localhost:8085/wsapi/workflow-websocket";
const WORKFLOW_ID = 1;
const COMPUTING_UNIT_ID = 1;
const USERNAME = "texera";
const PASSWORD = "texera";

async function getDevToken(): Promise<string> {
  const res = await fetch(`${WEBAPP}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

async function fetchWorkflow(token: string, wid: number): Promise<any> {
  const res = await fetch(`${WEBAPP}/api/workflow/${wid}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`fetch workflow failed: ${res.status}`);
  return res.json();
}

async function main() {
  console.log("[phase3] minting JWT...");
  const token = await getDevToken();

  console.log(`[phase3] fetching workflow ${WORKFLOW_ID}...`);
  const wf = await fetchWorkflow(token, WORKFLOW_ID);
  let content = wf.content;
  if (typeof content === "string") content = JSON.parse(content);
  console.log(`[phase3] workflow has ${content.operators?.length ?? 0} operators, ${content.links?.length ?? 0} links`);

  if (!content.operators || content.operators.length === 0) {
    console.error("[phase3] FAIL: workflow is empty");
    process.exit(1);
  }

  // Build a LogicalPlanPojo. The engine's WorkflowExecuteRequest expects
  // operators with type-discriminated polymorphic shape (operatorType field).
  // Workflow content already has these as `operatorType` + `operatorProperties`.
  // We need to flatten properties into the operator object as the engine deserializer
  // expects, mirroring buildLogicalPlan in execution-tools.ts.
  const operators = content.operators.map((op: any) => ({
    ...op.operatorProperties,
    operatorID: op.operatorID,
    operatorType: op.operatorType,
    inputPorts: op.inputPorts,
    outputPorts: op.outputPorts,
    customDisplayName: op.customDisplayName,
  }));

  const links = (content.links ?? []).map((link: any) => {
    // Backend expects fromOpId/fromPortId/toOpId/toPortId integer port indices.
    const sourceOp = content.operators.find((o: any) => o.operatorID === link.source.operatorID);
    const targetOp = content.operators.find((o: any) => o.operatorID === link.target.operatorID);
    const fromPortIdx = sourceOp?.outputPorts?.findIndex((p: any) => p.portID === link.source.portID) ?? 0;
    const toPortIdx = targetOp?.inputPorts?.findIndex((p: any) => p.portID === link.target.portID) ?? 0;
    return {
      fromOpId: link.source.operatorID,
      fromPortId: { id: fromPortIdx >= 0 ? fromPortIdx : 0, internal: false },
      toOpId: link.target.operatorID,
      toPortId: { id: toPortIdx >= 0 ? toPortIdx : 0, internal: false },
    };
  });

  console.log("[phase3] connecting WS...");
  const client = new ExecutionWsClient({
    url: WS_URL,
    token,
    workflowId: WORKFLOW_ID,
    computingUnitId: COMPUTING_UNIT_ID,
    heartbeatIntervalMs: 0,
  });

  const watcher = new ExecutionWatcher(client, "phase3-test");
  watcher.start();

  client.onClose((code, reason) => console.log(`[phase3] ws closed: ${code} ${reason}`));
  client.onError(err => console.error(`[phase3] ws error:`, err.message));

  await client.connect();
  console.log("[phase3] WS connected, sending execute...");

  client.sendExecuteRequest({
    executionName: "phase3-test",
    engineVersion: "1.0",
    logicalPlan: {
      operators,
      links,
      opsToViewResult: [],
      opsToReuseResult: [],
    },
    replayFromExecution: null,
    workflowSettings: { dataTransferBatchSize: 400 },
    emailNotificationEnabled: false,
    computingUnitId: COMPUTING_UNIT_ID,
  });

  // Loop on watcher.await until terminal
  console.log("[phase3] awaiting...");
  let lastReason = "";
  for (let i = 0; i < 20; i++) {
    const result = await watcher.await(5000);
    console.log(
      `[phase3] tick ${i}: reason=${result.reason} state=${result.snapshot.currentState} elapsed=${Math.floor(result.elapsedSinceStartMs / 1000)}s ops=${Object.keys(result.snapshot.perOperatorState).length}`,
    );
    lastReason = result.reason;
    if (result.snapshot.isTerminal) break;
  }

  const final = watcher.getSnapshot();
  console.log(`[phase3] final state: ${final.currentState}`);
  console.log(`[phase3] operators:`);
  for (const [opId, st] of Object.entries(final.perOperatorState)) {
    console.log(`  ${opId}: ${st.state} in=${st.inputTupleCount} out=${st.outputTupleCount}`);
  }

  if (final.fatalErrors.length > 0) {
    console.log(`[phase3] fatal errors:`);
    for (const err of final.fatalErrors) {
      console.log(`  - ${err.type}: ${err.message}`);
    }
  }

  // Try to fetch results for one operator that completed
  const completedOp = Object.entries(final.perOperatorState).find(
    ([, st]) => st.state === "Completed" && st.outputTupleCount > 0,
  );
  if (completedOp) {
    const [opId] = completedOp;
    console.log(`[phase3] fetching paginated result for ${opId}...`);
    try {
      const evt = await watcher.requestPaginatedResult(opId, 0, 5);
      console.log(`[phase3] got ${evt.table.length} rows, schema: ${JSON.stringify(evt.schema)}`);
      for (const row of evt.table.slice(0, 3)) {
        console.log(`  ${JSON.stringify(row).slice(0, 200)}`);
      }
    } catch (e: any) {
      console.warn(`[phase3] pagination request failed: ${e.message}`);
    }
  }

  watcher.dispose();
  client.close();

  if (final.currentState === "Completed") {
    console.log("[phase3] PASS");
    process.exit(0);
  } else {
    console.error(`[phase3] FAIL: final state was ${final.currentState}, last reason=${lastReason}`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error("[phase3] fatal:", e);
  process.exit(1);
});
