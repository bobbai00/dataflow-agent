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
 * Focused E2E sweep for the runtime schema-inference + Table.as_tuples
 * dedup changes:
 *
 *   S1 — object column with nulls (int + None) and pandas nullable Int64
 *        survive end-to-end. Validates that the inference helper ports
 *        infer_dtype / nullable-extension dtypes correctly: counts and
 *        cell values arrive intact at the sink.
 *
 *   S2 — duplicate column names ("x", "x") do NOT silently collapse to a
 *        single field. Validates the deduplicate_columns step inside
 *        Table.as_tuples (without it, `dict(zip(["x","x"], row))` would
 *        drop one value per row).
 *
 *   S3 — DataLoading -> DataProcessing -> sink with mixed dtypes (object
 *        ints, nullable Int64, strings, bools). Exercises schema inference
 *        across two engine hops to catch any contract drift between the
 *        loader's first-yield rewrite and the processor's same step on the
 *        downstream port.
 *
 * Multi-yield-with-same-schema is intentionally NOT covered here: the
 * generated DataLoading/DataProcessing wrappers (DataLoadingOpDesc /
 * DataProcessingOpDesc) both emit a single `yield load()/process()`, so a
 * multi-yield workflow isn't expressible through the agent-emitted code
 * surface. That code path is covered directly by the
 * `TestMaybeApplyRuntimeSchema::test_second_yield_does_not_reinfer_or_raise_on_drift`
 * unit test in amber/src/test/python/core/runnables/test_data_processor.py.
 *
 * Prereqs (assumed running):
 *   - texera backend          on 8080
 *   - texera CU service       on 8888 (HTTP)
 *   - workflow exec endpoint  on 8085 (WORKFLOW_EXECUTION_SERVICE_ENDPOINT)
 *   - agent service           on 3001 (not used by this driver)
 *
 * Invoke:
 *   cd agent-service && bun run benchmark/e2e/runtime-schema-e2e.ts
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
import type {
  CommentBox,
  OperatorLink,
  OperatorPredicate,
  Point,
  PortDescription,
  WorkflowContent,
} from "../../src/types/workflow";
import type { OperatorInfo, SyncExecutionResult } from "../../src/types/execution";

const USERNAME = process.env.TEXERA_USERNAME ?? "texera";
const PASSWORD = process.env.TEXERA_PASSWORD ?? "texera";
const TIMEOUT_SECONDS = Number(process.env.TEXERA_E2E_TIMEOUT ?? "120");
const LOCAL_CU_URI =
  process.env.TEXERA_LOCAL_CU_URI ??
  process.env.WORKFLOW_EXECUTION_SERVICE_ENDPOINT ??
  "http://localhost:8085";

const log = (...args: unknown[]) => console.log("[rt-schema-e2e]", ...args);
const logErr = (...args: unknown[]) => console.error("[rt-schema-e2e]", ...args);

/* ============================================================================
 *  Tiny assertion + operator-builder helpers (mirrored from code-mode-workflows.ts;
 *  duplicated to keep this driver self-contained.)
 * ========================================================================= */

class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

const DEFAULT_SETTINGS = { dataTransferBatchSize: 400 };

function pos(x: number, y: number): Point {
  return { x, y };
}

function inputPort(idx: number): PortDescription {
  return {
    portID: `input-${idx}`,
    displayName: "",
    disallowMultiInputs: true,
    isDynamicPort: idx > 0,
    dependencies: [],
  };
}

function outputPort(idx: number): PortDescription {
  return {
    portID: `output-${idx}`,
    displayName: "",
    disallowMultiInputs: false,
    isDynamicPort: false,
  };
}

function dataLoadingOp(opId: string, displayName: string, code: string, viewResult: boolean): OperatorPredicate {
  return {
    operatorID: opId,
    operatorType: "DataLoading",
    operatorVersion: "N/A",
    operatorProperties: { code },
    inputPorts: [],
    outputPorts: [outputPort(0)],
    showAdvanced: false,
    isDisabled: false,
    customDisplayName: displayName,
    dynamicInputPorts: false,
    dynamicOutputPorts: false,
    viewResult,
  };
}

function dataProcessingOp(
  opId: string,
  displayName: string,
  code: string,
  numInputs: number,
  viewResult: boolean
): OperatorPredicate {
  const inputPorts: PortDescription[] = [];
  for (let i = 0; i < numInputs; i++) inputPorts.push(inputPort(i));
  return {
    operatorID: opId,
    operatorType: "DataProcessing",
    operatorVersion: "N/A",
    operatorProperties: { code },
    inputPorts,
    outputPorts: [outputPort(0)],
    showAdvanced: false,
    isDisabled: false,
    customDisplayName: displayName,
    dynamicInputPorts: numInputs > 1,
    dynamicOutputPorts: false,
    viewResult,
  };
}

function buildLink(linkID: string, fromOp: string, toOp: string, toPortIdx: number): OperatorLink {
  return {
    linkID,
    source: { operatorID: fromOp, portID: "output-0" },
    target: { operatorID: toOp, portID: `input-${toPortIdx}` },
  };
}

function buildLogicalPlanFromContent(content: WorkflowContent): LogicalPlan {
  // Slim mirror of run.ts:buildLogicalPlanFromContent. Tests don't disable
  // operators, so the filter / sentinel paths are not strictly needed here,
  // but keeping the same shape avoids subtle differences from the main
  // harness when this driver is debugged side-by-side with run.ts.
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

function rowsOf(result: SyncExecutionResult, opId: string): Record<string, unknown>[] {
  const info = result.operators[opId] as OperatorInfo | undefined;
  if (!info) throw new AssertionError(`operator ${opId}: no info in result`);
  if (info.error) throw new AssertionError(`operator ${opId} errored: ${info.error.split("\n")[0]}`);
  if (!info.result || info.result.length === 0) {
    throw new AssertionError(`operator ${opId}: empty result (rows=${info.totalRowCount ?? 0})`);
  }
  return info.result as Record<string, unknown>[];
}

function columnsOf(rows: Record<string, unknown>[]): string[] {
  // `__row_index__` is appended by the result-rendering layer and is not part
  // of the operator's actual output schema.
  return Object.keys(rows[0]).filter(k => k !== "__row_index__");
}

function assertEqual<T>(actual: T, expected: T, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new AssertionError(`${what}: expected ${e}, got ${a}`);
}

function assertColumnSet(rows: Record<string, unknown>[], expected: string[], what: string): void {
  const got = [...columnsOf(rows)].sort();
  const want = [...expected].sort();
  assertEqual(got, want, `${what}: column set`);
}

function isNullish(v: unknown): boolean {
  // Result renderer may stringify nulls as the literal "NULL" or null; treat
  // either as "this cell is null". Empty string also counts so a no-cell render
  // doesn't slip past — there's no legitimate empty-string value in any
  // test input.
  return v === null || v === undefined || v === "NULL" || v === "" || (typeof v === "number" && Number.isNaN(v));
}

/* ============================================================================
 *  S1 — object column with nulls + pandas nullable Int64
 * ========================================================================= */

const S1_LOADER_ID = "s1Loader";

function buildS1(): WorkflowContent {
  // Loader emits 5 rows with three columns the new inference helpers must
  // type correctly:
  //   - obj_int    : object dtype with int + None -> LONG (via infer_dtype)
  //   - nullable_i64: pandas Int64 with pd.NA      -> LONG (extension dtype)
  //   - plain_str  : plain strings                 -> STRING
  // Validator asserts every row's non-null payload survives intact and that
  // the null rows are observed as null (not silently dropped).
  const loaderCode = [
    "def load() -> pd.DataFrame:",
    "    return pd.DataFrame({",
    "        'obj_int': pd.Series([10, None, 20, None, 30], dtype='object'),",
    "        'nullable_i64': pd.Series([1, pd.NA, 3, pd.NA, 5], dtype='Int64'),",
    "        'plain_str': ['a', 'b', 'c', 'd', 'e'],",
    "    })",
  ].join("\n");

  const loader = dataLoadingOp(S1_LOADER_ID, "S1 Loader (object+Int64+nulls)", loaderCode, true);
  return {
    operators: [loader],
    operatorPositions: { [loader.operatorID]: pos(120, 200) },
    links: [],
    commentBoxes: [] as CommentBox[],
    settings: DEFAULT_SETTINGS,
  };
}

function validateS1(result: SyncExecutionResult): void {
  const rows = rowsOf(result, S1_LOADER_ID);
  assertEqual(rows.length, 5, "S1 row count");
  assertColumnSet(rows, ["obj_int", "nullable_i64", "plain_str"], "S1");
  // Row 0: (10, 1, 'a')
  assertEqual(Number(rows[0].obj_int), 10, "S1 row0 obj_int");
  assertEqual(Number(rows[0].nullable_i64), 1, "S1 row0 nullable_i64");
  assertEqual(rows[0].plain_str, "a", "S1 row0 plain_str");
  // Row 1: (None, NA, 'b')
  if (!isNullish(rows[1].obj_int)) {
    throw new AssertionError(`S1 row1 obj_int: expected null, got ${JSON.stringify(rows[1].obj_int)}`);
  }
  if (!isNullish(rows[1].nullable_i64)) {
    throw new AssertionError(`S1 row1 nullable_i64: expected null, got ${JSON.stringify(rows[1].nullable_i64)}`);
  }
  assertEqual(rows[1].plain_str, "b", "S1 row1 plain_str");
  // Row 2: (20, 3, 'c')
  assertEqual(Number(rows[2].obj_int), 20, "S1 row2 obj_int");
  assertEqual(Number(rows[2].nullable_i64), 3, "S1 row2 nullable_i64");
  // Row 4: (30, 5, 'e') — last row, ensures we received the full series
  assertEqual(Number(rows[4].obj_int), 30, "S1 row4 obj_int");
  assertEqual(Number(rows[4].nullable_i64), 5, "S1 row4 nullable_i64");
  assertEqual(rows[4].plain_str, "e", "S1 row4 plain_str");
}

/* ============================================================================
 *  S2 — duplicate column names (the deduplicate_columns case)
 * ========================================================================= */

const S2_LOADER_ID = "s2Loader";

function buildS2(): WorkflowContent {
  // Construct a DataFrame whose two physical columns share the name "x".
  // Without dedup, `dict(zip(["x","x"], row))` collapses to {"x": <last value>}
  // and the first cell of every row is silently lost. With dedup, we get
  // "x" + "x.1" and BOTH cells are observable downstream.
  const loaderCode = [
    "def load() -> pd.DataFrame:",
    "    import numpy as np",
    "    return pd.DataFrame(",
    "        data=np.array([[1, 100], [2, 200], [3, 300]]),",
    "        columns=['x', 'x'],",
    "    )",
  ].join("\n");

  const loader = dataLoadingOp(S2_LOADER_ID, "S2 Loader (duplicate cols)", loaderCode, true);
  return {
    operators: [loader],
    operatorPositions: { [loader.operatorID]: pos(120, 200) },
    links: [],
    commentBoxes: [] as CommentBox[],
    settings: DEFAULT_SETTINGS,
  };
}

function validateS2(result: SyncExecutionResult): void {
  const rows = rowsOf(result, S2_LOADER_ID);
  assertEqual(rows.length, 3, "S2 row count");
  // Crucial assertion: BOTH columns survived to the sink. Without
  // deduplicate_columns this fails as a single-column result with the
  // "second" value in each row.
  assertColumnSet(rows, ["x", "x.1"], "S2");
  // Verify the value pairing was preserved row-by-row.
  assertEqual(Number(rows[0]["x"]), 1, "S2 row0 x");
  assertEqual(Number(rows[0]["x.1"]), 100, "S2 row0 x.1");
  assertEqual(Number(rows[1]["x"]), 2, "S2 row1 x");
  assertEqual(Number(rows[1]["x.1"]), 200, "S2 row1 x.1");
  assertEqual(Number(rows[2]["x"]), 3, "S2 row2 x");
  assertEqual(Number(rows[2]["x.1"]), 300, "S2 row2 x.1");
}

/* ============================================================================
 *  S3 — DataLoading -> DataProcessing -> sink, mixed dtypes survive the hop
 * ========================================================================= */

const S3_LOADER_ID = "s3Loader";
const S3_PROCESSOR_ID = "s3Processor";

function buildS3(): WorkflowContent {
  // Loader emits mixed dtypes. Processor takes them in, projects to a known
  // shape that proves the dtype information flowed across the engine hop:
  //   - has_obj_int : every input row had a non-null obj_int (LONG)
  //   - has_int64ext: every input row had a non-null nullable_i64 (LONG)
  //   - n           : count of rows received (LONG)
  // Sink validates the single output row.
  const loaderCode = [
    "def load() -> pd.DataFrame:",
    "    return pd.DataFrame({",
    "        'obj_int': pd.Series([10, 20, 30], dtype='object'),",
    "        'nullable_i64': pd.Series([1, 2, 3], dtype='Int64'),",
    "        'flag': pd.Series([True, False, True], dtype='bool'),",
    "        'label': ['x', 'y', 'z'],",
    "    })",
  ].join("\n");

  const processorCode = [
    "def process(t) -> pd.DataFrame:",
    "    # Coerce nullable Int64 to plain int for the count; if the engine",
    "    # mistyped the column on inference the .sum() would either error",
    "    # (e.g. mixed strings) or return a wrong value.",
    "    return pd.DataFrame([{",
    "        'rows_seen': int(len(t)),",
    "        'obj_int_sum': int(t['obj_int'].sum()),",
    "        'i64_sum': int(t['nullable_i64'].sum()),",
    "        'true_count': int(t['flag'].sum()),",
    "        'distinct_labels': int(t['label'].nunique()),",
    "    }])",
  ].join("\n");

  const loader = dataLoadingOp(S3_LOADER_ID, "S3 Loader (mixed)", loaderCode, false);
  const processor = dataProcessingOp(S3_PROCESSOR_ID, "S3 Processor", processorCode, 1, true);
  return {
    operators: [loader, processor],
    operatorPositions: {
      [loader.operatorID]: pos(120, 200),
      [processor.operatorID]: pos(420, 200),
    },
    links: [buildLink("link-s3-1", loader.operatorID, processor.operatorID, 0)],
    commentBoxes: [] as CommentBox[],
    settings: DEFAULT_SETTINGS,
  };
}

function validateS3(result: SyncExecutionResult): void {
  const rows = rowsOf(result, S3_PROCESSOR_ID);
  assertEqual(rows.length, 1, "S3 row count");
  assertColumnSet(
    rows,
    ["rows_seen", "obj_int_sum", "i64_sum", "true_count", "distinct_labels"],
    "S3"
  );
  // Loader: 3 rows; obj_int sum = 60; i64 sum = 6; bools true=2; distinct labels=3.
  assertEqual(Number(rows[0].rows_seen), 3, "S3 rows_seen");
  assertEqual(Number(rows[0].obj_int_sum), 60, "S3 obj_int_sum");
  assertEqual(Number(rows[0].i64_sum), 6, "S3 i64_sum");
  assertEqual(Number(rows[0].true_count), 2, "S3 true_count");
  assertEqual(Number(rows[0].distinct_labels), 3, "S3 distinct_labels");
}

/* ============================================================================
 *  Driver — login -> CU -> run each spec -> cleanup
 * ========================================================================= */

interface Spec {
  name: string;
  build: () => WorkflowContent;
  validate: (result: SyncExecutionResult) => void;
}

const SPECS: Spec[] = [
  { name: "S1 object-with-nulls + nullable Int64", build: buildS1, validate: validateS1 },
  { name: "S2 duplicate column names", build: buildS2, validate: validateS2 },
  { name: "S3 DataLoading -> DataProcessing mixed dtypes", build: buildS3, validate: validateS3 },
];

async function runOne(token: string, cuid: number, spec: Spec, runId: string): Promise<boolean> {
  const name = `[RuntimeSchema] ${spec.name} [${runId}]`;
  const content = spec.build();
  const plan = buildLogicalPlanFromContent(content);
  log(`-- ${spec.name}`);
  log(`   creating workflow "${name}"`);
  const wid = await createWorkflow(token, name, content, spec.name);
  let ok = false;
  try {
    log(`   executing wid=${wid} on cuid=${cuid}`);
    const result = await executeWorkflowSync(token, wid, plan, {
      computingUnitId: cuid,
      timeoutSeconds: TIMEOUT_SECONDS,
      executionName: `rt-schema-e2e:${spec.name}`,
    });
    if (!result.success) {
      logErr(`   ✗ workflow not Completed (state=${result.state})`);
      if (result.errors) for (const e of result.errors) logErr(`     error: ${e}`);
      if (result.compilationErrors) {
        for (const [k, v] of Object.entries(result.compilationErrors)) {
          logErr(`     compilation[${k}]: ${v}`);
        }
      }
      // Dump every operator's error / state so we can see what's blocking
      // — top-level result.errors may be empty if the failure is per-op.
      for (const [opId, info] of Object.entries(result.operators ?? {})) {
        logErr(`     op ${opId}: state=${info.state} err=${info.error ? info.error : "(none)"}`);
      }
      return false;
    }
    for (const [opId, info] of Object.entries(result.operators)) {
      const rows = info.totalRowCount ?? info.outputTuples ?? 0;
      log(`   op ${opId}: state=${info.state} rows=${rows}${info.error ? " err=" + info.error.split("\n")[0] : ""}`);
    }
    try {
      spec.validate(result);
      log(`   ✓ validator passed`);
      ok = true;
    } catch (err) {
      logErr(`   ✗ validator failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    try {
      await deleteWorkflow(token, wid);
    } catch (err) {
      logErr(`   cleanup: failed to delete wid=${wid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return ok;
}

async function main(): Promise<void> {
  const runId = String(Date.now());
  log(`run id ${runId}, login as ${USERNAME}, local cu uri=${LOCAL_CU_URI}`);
  const token = await login(USERNAME, PASSWORD);

  log(`provisioning local computing unit`);
  const cu = await createComputingUnit(token, `rt-schema-cu-${runId}`, {
    unitType: "local",
    uri: LOCAL_CU_URI,
  });
  const cuid = cu.computingUnit.cuid;
  log(`  cuid=${cuid}`);

  let allOk = true;
  try {
    for (const spec of SPECS) {
      const ok = await runOne(token, cuid, spec, runId);
      if (!ok) allOk = false;
    }
  } finally {
    log(`tearing down cu ${cuid}`);
    try {
      await terminateComputingUnit(token, cuid);
    } catch (err) {
      logErr(`failed to terminate cu ${cuid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!allOk) {
    logErr(`runtime-schema E2E: FAILED`);
    process.exit(1);
  }
  log(`runtime-schema E2E: PASSED (${SPECS.length} specs)`);
}

main().catch(err => {
  logErr(`fatal: ${err instanceof Error ? err.stack || err.message : String(err)}`);
  process.exit(1);
});
