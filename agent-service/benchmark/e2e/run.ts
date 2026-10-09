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

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createComputingUnit,
  createDataset,
  createDatasetVersion,
  createWorkflow,
  deleteDataset,
  deleteWorkflow,
  executeWorkflowSync,
  extractUserFromToken,
  login,
  terminateComputingUnit,
  uploadFileToDataset,
} from "../../src/api";
import type { LogicalLink, LogicalPlan } from "../../src/api/execution-api";
import type { OperatorPredicate, WorkflowContent } from "../../src/types/workflow";
import type { OperatorInfo, SyncExecutionResult } from "../../src/types/execution";

import { CODE_MODE_WORKFLOW_SPECS } from "./code-mode-workflows";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = path.resolve(__dirname, "data");
const WORKFLOWS_DIR = path.resolve(__dirname, "workflows");

const USERNAME = process.env.TEXERA_USERNAME ?? "texera";
const PASSWORD = process.env.TEXERA_PASSWORD ?? "texera";
const TIMEOUT_SECONDS = Number(process.env.TEXERA_E2E_TIMEOUT ?? "300");
// URI advertised on the local CU. The execution path uses
// WORKFLOW_EXECUTION_SERVICE_ENDPOINT directly; the URI here only satisfies
// the FK + URI-required validation in computing-unit-managing-service.
const LOCAL_CU_URI =
  process.env.TEXERA_LOCAL_CU_URI ?? process.env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT ?? "http://localhost:8085";

interface WorkflowJob {
  label: string; // e.g. "[CodeMode] W1 single-input chain"
  name: string; // unique persisted name for this run
  description: string;
  content: WorkflowContent;
  /**
   * Optional STRICT post-execution validator. When set, this runs after the
   * standard "all sinks produced rows" check and may throw to fail the job
   * even if the workflow technically reached `Completed`. The code-mode
   * specs use it to assert port→parameter mapping, exact column sets, and
   * expected row values.
   */
  validate?: (result: SyncExecutionResult) => void;
}

interface DatasetUsage {
  /** Original owner segment in the workflow file path (e.g. "texera"). */
  originalOwner: string;
  /** Files referenced in the workflow under this dataset (relative paths). */
  files: Set<string>;
  /** Original version segment (e.g. "v1"). */
  originalVersion: string;
}

/* ---------------- helpers ---------------- */

const log = (...args: unknown[]) => console.log("[e2e]", ...args);
const logErr = (...args: unknown[]) => console.error("[e2e]", ...args);

async function loadGeneralWorkflows(): Promise<WorkflowJob[]> {
  const entries = await fs.readdir(WORKFLOWS_DIR);
  const jobs: WorkflowJob[] = [];
  for (const file of entries.sort()) {
    if (!file.endsWith(".json")) continue;
    const full = path.join(WORKFLOWS_DIR, file);
    const raw = await fs.readFile(full, "utf-8");
    const content = JSON.parse(raw) as WorkflowContent;
    const baseName = path.basename(file, ".json");
    jobs.push({
      label: baseName,
      name: baseName,
      description: `E2E general workflow loaded from ${file}.`,
      content,
    });
  }
  return jobs;
}

function buildCodeModeWorkflows(): WorkflowJob[] {
  return CODE_MODE_WORKFLOW_SPECS.map(spec => ({
    label: spec.name,
    name: spec.name,
    description: spec.description,
    content: spec.build(DATA_DIR),
    validate: spec.validate,
  }));
}

const FILE_PATH_RE = /^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/;

/**
 * Walk every operator in `content` and call `fn(operator, fileName)` for every
 * property that looks like a Texera dataset URI ("/owner/dataset/version/...").
 * The callback returns the rewritten value (or undefined to leave alone).
 */
function visitDatasetFileNames(
  content: WorkflowContent,
  fn: (op: OperatorPredicate, value: string) => string | undefined
): void {
  for (const op of content.operators) {
    const props = op.operatorProperties as Record<string, any>;
    for (const key of Object.keys(props)) {
      const v = props[key];
      if (typeof v === "string" && FILE_PATH_RE.test(v)) {
        const replaced = fn(op, v);
        if (replaced !== undefined) {
          // operatorProperties is readonly per the type but the JSON we own is mutable.
          (props as any)[key] = replaced;
        }
      }
    }
  }
}

function collectDatasetUsage(workflows: WorkflowJob[]): Map<string, DatasetUsage> {
  const usage = new Map<string, DatasetUsage>();
  for (const wf of workflows) {
    visitDatasetFileNames(wf.content, (_, value) => {
      const m = FILE_PATH_RE.exec(value);
      if (!m) return undefined;
      const [, owner, dataset, version, rel] = m;
      const entry = usage.get(dataset) ?? {
        originalOwner: owner,
        originalVersion: version,
        files: new Set<string>(),
      };
      entry.files.add(rel);
      usage.set(dataset, entry);
      return undefined;
    });
  }
  return usage;
}

function rewriteDatasetPaths(
  workflows: WorkflowJob[],
  usage: Map<string, { newOwner: string; newDataset: string; newVersion: string; originalDataset: string }>
): void {
  const byOriginal = new Map<string, { newOwner: string; newDataset: string; newVersion: string }>();
  for (const u of usage.values()) {
    byOriginal.set(u.originalDataset, {
      newOwner: u.newOwner,
      newDataset: u.newDataset,
      newVersion: u.newVersion,
    });
  }
  for (const wf of workflows) {
    visitDatasetFileNames(wf.content, (_, value) => {
      const m = FILE_PATH_RE.exec(value);
      if (!m) return undefined;
      const [, , dataset, , rel] = m;
      const target = byOriginal.get(dataset);
      if (!target) return undefined;
      return `/${target.newOwner}/${target.newDataset}/${target.newVersion}/${rel}`;
    });
  }
}

function buildLogicalPlanFromContent(content: WorkflowContent): LogicalPlan {
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

  // The sync execution endpoint only persists results for ops in targetOperatorIds.
  // Mirror the agent's heuristic: every operator with no outgoing enabled link is a sink.
  const linkSources = new Set(links.map(l => l.fromOpId));
  const sinks = operators.filter(op => !linkSources.has(op.operatorID)).map(op => op.operatorID);

  const logicalOps = operators.map(op => ({
    operatorID: op.operatorID,
    operatorType: op.operatorType,
    ...(op.operatorProperties as Record<string, any>),
    inputPorts: op.inputPorts,
    outputPorts: op.outputPorts,
  }));

  return {
    operators: logicalOps,
    links,
    opsToViewResult: sinks,
    opsToReuseResult: [],
  };
}

function summarizeOperatorInfo(opId: string, info: OperatorInfo): string {
  if (info.error) return `  ✗ ${opId}: ${info.error.split("\n")[0]}`;
  const rows = info.totalRowCount ?? info.outputTuples ?? 0;
  const cols =
    info.result && info.result.length > 0 ? Object.keys(info.result[0]).filter(k => k !== "__row_index__").length : "?";
  return `  ✓ ${opId}: rows=${rows} cols=${cols} state=${info.state}`;
}

const SAMPLE_ROW_LIMIT = 5;
const SAMPLE_CELL_WIDTH = 80;

function truncate(value: unknown): string {
  let s: string;
  if (value === null || value === undefined) s = "";
  else if (typeof value === "string") s = value;
  else s = JSON.stringify(value);
  if (s.length > SAMPLE_CELL_WIDTH) s = s.slice(0, SAMPLE_CELL_WIDTH - 1) + "…";
  return s.replace(/\n/g, "\\n");
}

function printSampleRows(opId: string, info: OperatorInfo): void {
  const rows = info.result;
  if (!rows || rows.length === 0) return;
  const headers = Object.keys(rows[0]).filter(k => k !== "__row_index__");
  log(`    [${opId}] columns: ${headers.join(", ")}`);
  for (let i = 0; i < Math.min(rows.length, SAMPLE_ROW_LIMIT); i++) {
    const row = rows[i];
    const cells = headers.map(h => `${h}=${truncate(row[h])}`).join("  ");
    log(`    row[${i}]: ${cells}`);
  }
}

/**
 * @param sinkIds operators that were submitted as `targetOperatorIds`. We
 *                require each one to come back with a non-empty `result` array;
 *                otherwise the workflow technically reached `Completed` but
 *                produced nothing — which is what we're guarding against.
 */
function printExecutionResult(label: string, result: SyncExecutionResult, sinkIds: string[]): boolean {
  if (result.success) {
    log(`✓ ${label} reached state=${result.state}`);
  } else {
    logErr(`✗ ${label} failed (state=${result.state})`);
    if (result.errors) for (const e of result.errors) logErr(`    error: ${e}`);
    if (result.compilationErrors) {
      for (const [k, v] of Object.entries(result.compilationErrors)) {
        logErr(`    compilation[${k}]: ${v}`);
      }
    }
  }
  for (const [opId, info] of Object.entries(result.operators)) {
    log(summarizeOperatorInfo(opId, info));
  }

  // Verify every sink actually returned data — not just an empty Completed.
  const missing: string[] = [];
  for (const sinkId of sinkIds) {
    const info = result.operators[sinkId];
    if (!info) {
      missing.push(`${sinkId} (no info returned)`);
      continue;
    }
    if (info.error) continue; // already surfaced above
    if (!info.result || info.result.length === 0) {
      missing.push(`${sinkId} (no result rows)`);
      continue;
    }
    printSampleRows(sinkId, info);
  }

  if (missing.length > 0) {
    logErr(`✗ ${label}: sinks missing result data: ${missing.join("; ")}`);
    return false;
  }
  return result.success;
}

/* ---------------- main ---------------- */

interface ProvisionedDataset {
  did: number;
  newOwner: string;
  newDataset: string;
  newVersion: string;
  originalDataset: string;
}

async function provisionDatasets(
  token: string,
  ownerEmail: string,
  runId: string,
  usage: Map<string, DatasetUsage>
): Promise<ProvisionedDataset[]> {
  const provisioned: ProvisionedDataset[] = [];
  for (const [originalDataset, info] of usage) {
    const newDataset = `${originalDataset}-e2e-${runId}`;
    log(`creating dataset ${newDataset}`);
    const ds = await createDataset(token, newDataset, "E2E benchmark dataset", false, true);

    for (const rel of info.files) {
      const localFile = path.join(DATA_DIR, rel);
      try {
        await fs.access(localFile);
      } catch {
        throw new Error(
          `Workflow references ${rel} in dataset ${originalDataset}, but ${localFile} is missing on disk.`
        );
      }
      const bytes = await fs.readFile(localFile);
      log(`  upload ${rel} (${bytes.byteLength} bytes) -> dataset ${ds.dataset.did}`);
      await uploadFileToDataset(token, ds.dataset.did, rel, bytes, "e2e initial upload");
    }

    log(`  commit version on dataset ${ds.dataset.did}`);
    const versionRes = await createDatasetVersion(token, ds.dataset.did, "");
    const newVersion = versionRes.datasetVersion.name; // expected "v1"

    provisioned.push({
      did: ds.dataset.did,
      newOwner: ownerEmail,
      newDataset,
      newVersion,
      originalDataset,
    });
  }
  return provisioned;
}

async function runWorkflow(
  token: string,
  job: WorkflowJob,
  runId: string,
  cuid: number
): Promise<{ wid: number; ok: boolean }> {
  const persistedName = `${job.name} [e2e ${runId}]`;
  log(`creating workflow "${persistedName}"`);
  const wid = await createWorkflow(token, persistedName, job.content, job.description);
  log(`  wid=${wid}, executing on cuid=${cuid}...`);

  const plan = buildLogicalPlanFromContent(job.content);
  const sinks = plan.opsToViewResult ?? [];
  const result = await executeWorkflowSync(token, wid, plan, {
    computingUnitId: cuid,
    timeoutSeconds: TIMEOUT_SECONDS,
    executionName: `e2e:${job.label}`,
  });
  let ok = printExecutionResult(job.label, result, sinks);

  // Apply strict per-spec validators when present. These run AFTER the
  // generic "sinks emitted rows" check so we still get the surface
  // diagnostics if execution itself failed; a thrown validator demotes
  // the job to a failure even when the runtime reached Completed.
  if (ok && job.validate) {
    try {
      job.validate(result);
      log(`✓ ${job.label}: strict validators all passed`);
    } catch (err) {
      logErr(`✗ ${job.label}: validator failed: ${err instanceof Error ? err.message : String(err)}`);
      ok = false;
    }
  }
  return { wid, ok };
}

async function main(): Promise<void> {
  const runId = String(Date.now());
  log(`run id ${runId}, data dir ${DATA_DIR}`);

  log(`logging in as ${USERNAME}`);
  const token = await login(USERNAME, PASSWORD);
  const user = extractUserFromToken(token);
  log(`logged in: uid=${user.uid} name=${user.name} email=${user.email || "(empty)"}`);

  // Texera resolves dataset paths by USER.EMAIL. Default admin has email == name.
  const ownerEmail = user.email || user.name;

  const generalWorkflows = await loadGeneralWorkflows();
  // Code mode emits DataLoading / DataProcessing operators; the legacy
  // PythonUDFV2 specs were retired with the operator the agent no longer writes.
  const codeModeWorkflows = buildCodeModeWorkflows();
  log(`loaded ${generalWorkflows.length} general + ${codeModeWorkflows.length} code-mode workflows`);

  const usage = collectDatasetUsage(generalWorkflows);
  log(`general workflows reference ${usage.size} dataset(s): ${[...usage.keys()].join(", ") || "(none)"}`);

  let provisioned: ProvisionedDataset[] = [];
  let cuid: number | null = null;
  const createdWids: number[] = [];
  let allOk = true;

  try {
    log(`provisioning local computing unit at uri=${LOCAL_CU_URI}`);
    const cu = await createComputingUnit(token, `e2e-cu-${runId}`, {
      unitType: "local",
      uri: LOCAL_CU_URI,
    });
    cuid = cu.computingUnit.cuid;
    log(`  cuid=${cuid}`);

    if (usage.size > 0) {
      provisioned = await provisionDatasets(token, ownerEmail, runId, usage);
      const remap = new Map(
        provisioned.map(p => [
          p.originalDataset,
          {
            newOwner: p.newOwner,
            newDataset: p.newDataset,
            newVersion: p.newVersion,
            originalDataset: p.originalDataset,
          },
        ])
      );
      rewriteDatasetPaths(generalWorkflows, remap);
    }

    const allJobs = [...generalWorkflows, ...codeModeWorkflows];
    for (const job of allJobs) {
      try {
        const { wid, ok } = await runWorkflow(token, job, runId, cuid);
        createdWids.push(wid);
        if (!ok) allOk = false;
      } catch (err) {
        logErr(`✗ ${job.label} threw: ${err instanceof Error ? err.message : String(err)}`);
        allOk = false;
      }
    }
  } finally {
    log(`cleanup: deleting ${createdWids.length} workflow(s), ${provisioned.length} dataset(s), ${cuid ? 1 : 0} cu`);
    for (const wid of createdWids) {
      try {
        await deleteWorkflow(token, wid);
      } catch (err) {
        logErr(`  failed to delete workflow ${wid}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const p of provisioned) {
      try {
        await deleteDataset(token, p.did);
      } catch (err) {
        logErr(`  failed to delete dataset ${p.did}: ${err instanceof Error ? err.message : String(err)}`);
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

  if (!allOk) {
    logErr("E2E pipeline finished with failures.");
    process.exit(1);
  }
  log("E2E pipeline finished successfully.");
}

main().catch(err => {
  logErr("fatal:", err);
  process.exit(1);
});
