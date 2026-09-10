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
 * Direct (no-LLM) execution of native-mode generated code against the running
 * backends: a 22-file Scan of the KramaBench water data followed by a DuckDB
 * Filter. Used to reproduce and fix the worker-side hang seen in the pilot
 * (`The source did not signal an event for 240 seconds`).
 *
 *   cd agent-service && bun run benchmark/e2e/native-hang-e2e.ts [variant...]
 *   variants: current | threads1 | arrow   (default: all three)
 */
import {
  createComputingUnit,
  createWorkflow,
  deleteWorkflow,
  executeWorkflowSync,
  login,
  terminateComputingUnit,
} from "../../src/api";
import type { LogicalLink, LogicalPlan } from "../../src/api/execution-api";
import type { OperatorLink, OperatorPredicate, PortDescription, WorkflowContent } from "../../src/types/workflow";
import { compileNativeOp } from "../../src/agent/native/codegen";

const USERNAME = process.env.TEXERA_USERNAME ?? "texera";
const PASSWORD = process.env.TEXERA_PASSWORD ?? "texera";
const TIMEOUT_SECONDS = Number(process.env.TEXERA_E2E_TIMEOUT ?? "300");
const LOCAL_CU_URI =
  process.env.TEXERA_LOCAL_CU_URI ?? process.env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT ?? "http://localhost:8085";
const FILES = process.env.NATIVE_E2E_FILES ?? "data/environment/input/water-body-testing-*.csv";
const log = (...a: unknown[]) => console.log("[native-hang-e2e]", ...a);

function port(idx: number, input: boolean): PortDescription {
  return input
    ? { portID: `input-${idx}`, displayName: "", disallowMultiInputs: true, isDynamicPort: idx > 0, dependencies: [] }
    : { portID: `output-${idx}`, displayName: "", disallowMultiInputs: false, isDynamicPort: false };
}

function op(id: string, type: "DataLoading" | "DataProcessing", code: string, nIn: number): OperatorPredicate {
  return {
    operatorID: id,
    operatorType: type,
    operatorVersion: "N/A",
    operatorProperties: { code },
    inputPorts: Array.from({ length: nIn }, (_, i) => port(i, true)),
    outputPorts: [port(0, false)],
    showAdvanced: false,
    isDisabled: false,
    customDisplayName: id,
    dynamicInputPorts: nIn > 1,
    dynamicOutputPorts: false,
    viewResult: true,
  };
}

function link(from: string, to: string, idx: number): OperatorLink {
  return { linkID: `${from}-->${to}`, source: { operatorID: from, portID: "output-0" }, target: { operatorID: to, portID: `input-${idx}` } };
}

function plan(content: WorkflowContent): LogicalPlan {
  const links: LogicalLink[] = content.links.map(l => ({
    fromOpId: l.source.operatorID,
    fromPortId: { id: 0, internal: false },
    toOpId: l.target.operatorID,
    toPortId: { id: Number(l.target.portID.split("-")[1]), internal: false },
  }));
  return {
    operators: content.operators.map(o => ({
      operatorID: o.operatorID,
      operatorType: o.operatorType,
      ...(o.operatorProperties as Record<string, any>),
      inputPorts: o.inputPorts,
      outputPorts: o.outputPorts,
    })),
    links,
    opsToViewResult: content.operators.map(o => o.operatorID),
    opsToReuseResult: [],
  };
}

const scan = compileNativeOp({ type: "Scan", inputs: [], properties: { files: FILES, header: true, allText: true } });
const filter = compileNativeOp({ type: "Filter", inputs: ["water"], properties: { predicate: `"Beach Type Description" = 'Marine'` } });

const VARIANTS: Record<string, string> = {
  // no filter operator at all: measures scan + materialization of the 320k rows
  scanonly: "",
  // plain pandas filter — what a code-mode UDF would do; isolates DuckDB's share
  pandas: "def process(water):\n    return water[water['Beach Type Description'] == 'Marine']",
  current: filter.code,
  threads1: filter.code.replace("duckdb.connect()", "duckdb.connect(config={'threads': 1})"),
  arrow: filter.code.replace(
    "_con.register('t', t)",
    "import pyarrow as pa\n    _con.register('t', pa.Table.from_pandas(t, preserve_index=False))"
  ),
};

async function main(): Promise<void> {
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(VARIANTS);
  const token = await login(USERNAME, PASSWORD);
  const cu = await createComputingUnit(token, `native-hang-cu-${Date.now()}`, { unitType: "local", uri: LOCAL_CU_URI });
  const cuid = cu.computingUnit.cuid;
  try {
    for (const v of wanted) {
      if (!(v in VARIANTS)) {
        log(`unknown variant ${v}`);
        continue;
      }
      const code = VARIANTS[v];
      const content: WorkflowContent = {
        operators: code
          ? [op("water", scan.operatorType, scan.code, 0), op("marine", "DataProcessing", code, 1)]
          : [op("water", scan.operatorType, scan.code, 0)],
        operatorPositions: { water: { x: 0, y: 0 }, marine: { x: 200, y: 0 } },
        links: code ? [link("water", "marine", 0)] : [],
        commentBoxes: [],
        settings: { dataTransferBatchSize: 400 },
      };
      const wid = await createWorkflow(token, `[native-hang] ${v} ${Date.now()}`, content, v);
      const t0 = Date.now();
      try {
        const result = await executeWorkflowSync(token, wid, plan(content), {
          computingUnitId: cuid,
          timeoutSeconds: TIMEOUT_SECONDS,
          executionName: `native-hang:${v}`,
        });
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        log(`${v}: success=${result.success} state=${result.state} in ${secs}s`);
        for (const [id, info] of Object.entries(result.operators ?? {})) {
          log(`   ${id}: state=${info.state} rows=${info.totalRowCount ?? info.outputTuples}${info.error ? " err=" + info.error.split("\n").slice(0, 3).join(" | ") : ""}`);
        }
        if (result.errors) for (const e of result.errors) log(`   error: ${e}`);
      } catch (err) {
        log(`${v}: threw after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        try {
          await deleteWorkflow(token, wid);
        } catch {}
      }
    }
  } finally {
    try {
      await terminateComputingUnit(token, cuid);
    } catch {}
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
