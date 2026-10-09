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
 * E2E driver for the runtime-error reporting format.
 *
 * Each spec in ERROR_WORKFLOW_SPECS is a workflow that crashes by design.
 * For every spec we assert that `info.error` of the failing operator
 * contains:
 *   - the expected exception type
 *   - the user-code line pointer the worker emits, `(line N) \`source\` - `,
 *     whose backticked source is the offending statement
 *
 * The worker no longer echoes the operator's code (the agent renderer appends
 * it from the DAG), so the pointer is the whole contract. Any spec where these
 * don't match means `data_processor.py:_report_exception` regressed.
 */

import {
  createComputingUnit,
  createWorkflow,
  deleteWorkflow,
  executeWorkflowSync,
  extractUserFromToken,
  login,
  terminateComputingUnit,
} from "../../src/api";
import type { LogicalLink, LogicalPlan } from "../../src/api/execution-api";
import type { WorkflowContent } from "../../src/types/workflow";
import type { OperatorInfo, SyncExecutionResult } from "../../src/types/execution";

import { ERROR_WORKFLOW_SPECS, type ErrorWorkflowSpec } from "./error-workflows";

const USERNAME = process.env.TEXERA_USERNAME ?? "texera";
const PASSWORD = process.env.TEXERA_PASSWORD ?? "texera";
const TIMEOUT_SECONDS = Number(process.env.TEXERA_E2E_TIMEOUT ?? "120");
const LOCAL_CU_URI =
  process.env.TEXERA_LOCAL_CU_URI ?? process.env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT ?? "http://localhost:8085";

const log = (...args: unknown[]) => console.log("[errors-e2e]", ...args);
const logErr = (...args: unknown[]) => console.error("[errors-e2e]", ...args);

function buildLogicalPlan(content: WorkflowContent): LogicalPlan {
  const operators = content.operators.filter(op => !op.isDisabled);
  const opIds = new Set(operators.map(op => op.operatorID));
  const links: LogicalLink[] = content.links
    .filter(l => opIds.has(l.source.operatorID) && opIds.has(l.target.operatorID))
    .map(link => {
      const src = operators.find(o => o.operatorID === link.source.operatorID)!;
      const tgt = operators.find(o => o.operatorID === link.target.operatorID)!;
      const fromIdx = src.outputPorts.findIndex(p => p.portID === link.source.portID);
      const toIdx = tgt.inputPorts.findIndex(p => p.portID === link.target.portID);
      return {
        fromOpId: link.source.operatorID,
        fromPortId: { id: fromIdx >= 0 ? fromIdx : 0, internal: false },
        toOpId: link.target.operatorID,
        toPortId: { id: toIdx >= 0 ? toIdx : 0, internal: false },
      };
    });
  // Submit every operator as a sink so the runtime always returns a row for
  // it — even if it crashes — so we can read `info.error`.
  const opsToViewResult = operators.map(op => op.operatorID);
  const logicalOps = operators.map(op => ({
    operatorID: op.operatorID,
    operatorType: op.operatorType,
    ...(op.operatorProperties as Record<string, any>),
    inputPorts: op.inputPorts,
    outputPorts: op.outputPorts,
  }));
  return { operators: logicalOps, links, opsToViewResult, opsToReuseResult: [] };
}

interface CheckResult {
  passed: boolean;
  notes: string[];
}

function assertErrorShape(spec: ErrorWorkflowSpec, info: OperatorInfo | undefined): CheckResult {
  const notes: string[] = [];
  if (!info) {
    notes.push(`no info returned for failing operator "${spec.failingOperatorId}"`);
    return { passed: false, notes };
  }
  const error = info.error ?? "";
  if (!error) {
    notes.push("info.error is empty");
    return { passed: false, notes };
  }

  const checks: { label: string; ok: boolean }[] = [
    {
      label: `contains exception type "${spec.expectedExceptionType}"`,
      ok: error.includes(spec.expectedExceptionType),
    },
    {
      label: "contains a `(line N) `source` - ` pointer",
      ok: /\(line \d+\) `[^`]*` - /.test(error),
    },
    {
      label: `the pointer carries the offending source: "${spec.expectedLineSubstring}"`,
      ok: pointerCarriesSubstring(error, spec.expectedLineSubstring),
    },
    {
      label: "does not echo the operator code (the agent renderer appends it)",
      ok: !error.includes("Operator code:"),
    },
  ];

  let passed = true;
  for (const c of checks) {
    notes.push(`${c.ok ? "✓" : "✗"} ${c.label}`);
    if (!c.ok) passed = false;
  }
  return { passed, notes };
}

/**
 * Confirm that the backticked source inside the `(line N) \`…\` - ` pointer
 * carries `substring`, not just some other part of the message. Catches the
 * regression where the pointer names the wrong line.
 */
function pointerCarriesSubstring(error: string, substring: string): boolean {
  const pointer = /\(line \d+\) `([^`]*)` - /.exec(error);
  return pointer !== null && pointer[1].includes(substring);
}

async function runOne(
  token: string,
  cuid: number,
  spec: ErrorWorkflowSpec,
  runId: string
): Promise<{ wid: number; passed: boolean }> {
  const persistedName = `${spec.name} [errors-e2e ${runId}]`;
  log(`---- ${spec.name} ----`);
  log(`creating workflow "${persistedName}"`);
  const wid = await createWorkflow(token, persistedName, spec.build(), spec.description);
  log(`  wid=${wid}, cuid=${cuid}, executing...`);

  const plan = buildLogicalPlan(spec.build());
  const result: SyncExecutionResult = await executeWorkflowSync(token, wid, plan, {
    computingUnitId: cuid,
    timeoutSeconds: TIMEOUT_SECONDS,
    executionName: `errors-e2e:${spec.name}`,
  });

  log(`  result.success=${result.success} state=${result.state}`);
  if (result.errors && result.errors.length > 0) log(`  result.errors=${JSON.stringify(result.errors)}`);
  log(`  operator ids returned: [${Object.keys(result.operators).join(", ") || "(none)"}]`);

  // We *want* the workflow to fail. A success here means the broken code
  // didn't actually crash, which is itself a regression on the test.
  if (result.success) {
    logErr(`  ✗ workflow unexpectedly succeeded — broken code didn't raise`);
    return { wid, passed: false };
  }

  const failingInfo = result.operators[spec.failingOperatorId];
  log(`  failing operator: ${spec.failingOperatorId}`);
  log(`  --- info.error ---`);
  if (failingInfo?.error) {
    for (const line of failingInfo.error.split(/\r?\n/)) log(`  | ${line}`);
  } else {
    log(`  (no info.error)`);
  }
  log(`  ------------------`);

  const check = assertErrorShape(spec, failingInfo);
  for (const note of check.notes) log(`  ${note}`);
  log(`  ${check.passed ? "✓ PASS" : "✗ FAIL"}`);
  return { wid, passed: check.passed };
}

async function main(): Promise<void> {
  const runId = String(Date.now());
  log(`run id ${runId}`);

  log(`logging in as ${USERNAME}`);
  const token = await login(USERNAME, PASSWORD);
  const user = extractUserFromToken(token);
  log(`logged in: uid=${user.uid} name=${user.name} email=${user.email || "(empty)"}`);

  let cuid: number | null = null;
  const createdWids: number[] = [];
  let allPassed = true;

  try {
    log(`provisioning local computing unit at uri=${LOCAL_CU_URI}`);
    const cu = await createComputingUnit(token, `errors-e2e-cu-${runId}`, {
      unitType: "local",
      uri: LOCAL_CU_URI,
    });
    cuid = cu.computingUnit.cuid;
    log(`  cuid=${cuid}`);

    for (const spec of ERROR_WORKFLOW_SPECS) {
      try {
        const { wid, passed } = await runOne(token, cuid, spec, runId);
        createdWids.push(wid);
        if (!passed) allPassed = false;
      } catch (err) {
        logErr(`✗ ${spec.name} threw: ${err instanceof Error ? err.message : String(err)}`);
        allPassed = false;
      }
    }
  } finally {
    log(`cleanup: deleting ${createdWids.length} workflow(s), ${cuid ? 1 : 0} cu`);
    for (const wid of createdWids) {
      try {
        await deleteWorkflow(token, wid);
      } catch (err) {
        logErr(`  failed to delete workflow ${wid}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (cuid != null) {
      try {
        await terminateComputingUnit(token, cuid);
      } catch (err) {
        logErr(`  failed to terminate cu ${cuid}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (!allPassed) {
    logErr("error-format e2e finished with failures.");
    process.exit(1);
  }
  log("all error-format checks passed.");
}

main().catch(err => {
  logErr("fatal:", err);
  process.exit(1);
});
