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
 * End-to-end tests for the code-mode operators the agent emits via
 * `createOrModifyOperator`:
 *   - `DataLoading`   (Python `def load() -> pd.DataFrame`, source)
 *   - `DataProcessing` (Python `def process(p1, p2, ...) -> pd.DataFrame`, N-to-1)
 *
 * These tests are strict: each spec ships with a `validate(result)` that
 * walks the SyncExecutionResult and asserts (a) the sink emitted rows,
 * (b) the column names match exactly, (c) the values prove the operator
 * received the right upstream data on the right port. The point is to
 * catch port-mapping regressions (port 0 → first parameter, port 1 →
 * second, …) and broken upstream wiring, NOT just to check "executed
 * without error".
 *
 * Each spec generates its data synthetically inside the loader so the
 * tests are fully self-contained (no Iris.csv / TMDb_updated.csv
 * dependency, fully reproducible row-by-row).
 */

import type {
  CommentBox,
  OperatorLink,
  OperatorPredicate,
  Point,
  PortDescription,
  WorkflowContent,
} from "../../src/types/workflow";
import type { OperatorInfo, SyncExecutionResult } from "../../src/types/execution";

/* ============================================================================
 *  Operator-predicate builders (matching the agent's createOrModifyOperator)
 * ========================================================================= */

const DEFAULT_SETTINGS = { dataTransferBatchSize: 400 };

function pos(x: number, y: number): Point {
  return { x, y };
}

function inputPort(idx: number): PortDescription {
  // DataProcessing operators allow dynamic input ports; the agent calls
  // updateOperatorInputPorts to grow the array, but every port has the same
  // shape. `disallowMultiInputs: true` mirrors the per-port partition
  // requirement (one upstream per port).
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

/** Build a DataLoading operator (zero-input, one-output Python source). */
function dataLoadingOp(opId: string, displayName: string, code: string): OperatorPredicate {
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
    viewResult: false,
  };
}

/**
 * Build a DataProcessing operator with the given input arity (one output).
 * The agent's `code` field carries a `def process(p1, p2, …)` whose parameter
 * count must match `numInputs`; the backend's DataProcessingOpDesc parses the
 * function signature to wire each parameter to the same-index input port.
 */
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

/* ============================================================================
 *  Assertion helpers — used by the per-spec validators
 * ========================================================================= */

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssertionError";
  }
}

function rowsOf(result: SyncExecutionResult, opId: string): Record<string, unknown>[] {
  const info = result.operators[opId] as OperatorInfo | undefined;
  if (!info) throw new AssertionError(`operator ${opId} produced no info in result`);
  if (info.error) throw new AssertionError(`operator ${opId} errored: ${info.error.split("\n")[0]}`);
  if (!info.result || info.result.length === 0) {
    throw new AssertionError(`operator ${opId} produced empty result (rows=${info.totalRowCount ?? 0})`);
  }
  return info.result as Record<string, unknown>[];
}

function assertEqual<T>(actual: T, expected: T, what: string): void {
  // Deep-equal via JSON stringify for the simple primitive/array/object cases
  // these tests deal with.
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new AssertionError(`${what}: expected ${e}, got ${a}`);
}

function assertColumns(rows: Record<string, unknown>[], expected: string[], what: string): void {
  const visible = Object.keys(rows[0]).filter(k => k !== "__row_index__");
  const got = [...visible].sort();
  const want = [...expected].sort();
  assertEqual(got, want, `${what}: column set`);
}

/* ============================================================================
 *  Spec type
 * ========================================================================= */

export interface CodeModeWorkflowSpec {
  name: string;
  description: string;
  /**
   * Build the WorkflowContent. The tests are self-contained (synthetic data
   * inside loaders) — they do not consume the `dataDir` argument, but it's
   * passed in to keep the signature uniform with the other workflow specs.
   */
  build: (dataDir: string) => WorkflowContent;
  /**
   * STRICT post-execution validation. Throw `AssertionError` (or any Error)
   * on failure; the e2e runner counts a thrown validator as a workflow
   * failure even if `printExecutionResult` reported success.
   *
   * The validator's job is to prove:
   *   - the operator under test received its upstream data
   *   - when multi-input, port-to-parameter mapping is the documented one
   *     (port i → i-th `process(...)` parameter)
   *   - the operator computed and emitted the expected output
   */
  validate: (result: SyncExecutionResult) => void;
}

/* ============================================================================
 *  W1 — single-input chain (DataLoading → DataProcessing → DataProcessing)
 *
 *  Proves: a 1-input DataProcessing operator receives its single upstream
 *  DataFrame and emits a derived DataFrame; a second 1-input
 *  DataProcessing operator can then chain off the first one's output.
 * ========================================================================= */

const W1_LOADER_ID = "w1Loader";
const W1_DOUBLER_ID = "w1Doubler";
const W1_SUMMER_ID = "w1Summer";

function buildW1(): WorkflowContent {
  const loaderCode = [
    "def load() -> pd.DataFrame:",
    "    return pd.DataFrame({",
    "        'id': list(range(10)),",
    "        'value': [i * 2 for i in range(10)],",
    "    })",
  ].join("\n");

  // process() takes ONE parameter — wired to input port 0. Adds `double_value`.
  const doublerCode = [
    "def process(loaderTable) -> pd.DataFrame:",
    "    out = loaderTable.copy()",
    "    out['double_value'] = out['value'] * 2",
    "    return out",
  ].join("\n");

  // Chain off the previous DataProcessing's output. Adds a `sum` column.
  const summerCode = [
    "def process(doublerTable) -> pd.DataFrame:",
    "    out = doublerTable.copy()",
    "    out['sum'] = out['value'] + out['double_value']",
    "    return out",
  ].join("\n");

  const loader = dataLoadingOp(W1_LOADER_ID, "W1 Loader", loaderCode);
  const doubler = dataProcessingOp(W1_DOUBLER_ID, "W1 Doubler", doublerCode, 1, false);
  const summer = dataProcessingOp(W1_SUMMER_ID, "W1 Summer", summerCode, 1, true);

  return {
    operators: [loader, doubler, summer],
    operatorPositions: {
      [loader.operatorID]: pos(120, 200),
      [doubler.operatorID]: pos(420, 200),
      [summer.operatorID]: pos(720, 200),
    },
    links: [
      buildLink("link-w1-1", loader.operatorID, doubler.operatorID, 0),
      buildLink("link-w1-2", doubler.operatorID, summer.operatorID, 0),
    ],
    commentBoxes: [] as CommentBox[],
    settings: DEFAULT_SETTINGS,
  };
}

function validateW1(result: SyncExecutionResult): void {
  const rows = rowsOf(result, W1_SUMMER_ID);
  assertEqual(rows.length, 10, "W1 summer row count");
  assertColumns(rows, ["id", "value", "double_value", "sum"], "W1 summer");
  // The original loader produced id=i, value=2*i. doubler then sets
  // double_value=4*i; summer adds sum=value+double_value=6*i. Verify the
  // entire chain for every row, by id.
  for (let i = 0; i < 10; i++) {
    const row = rows.find(r => Number(r.id) === i);
    if (!row) throw new AssertionError(`W1: missing row with id=${i}`);
    assertEqual(Number(row.value), 2 * i, `W1 row id=${i} value`);
    assertEqual(Number(row.double_value), 4 * i, `W1 row id=${i} double_value`);
    assertEqual(Number(row.sum), 6 * i, `W1 row id=${i} sum`);
  }
}

/* ============================================================================
 *  W2 — three-input merge (3 DataLoading → DataProcessing[3-input])
 *
 *  Proves: the i-th process() parameter receives the upstream connected to
 *  input port i. Each loader emits a unique sentinel; the processor emits
 *  one row per input port labelling which sentinel it observed at that
 *  port. The validator asserts port 0 → ALPHA, 1 → BETA, 2 → GAMMA — if
 *  the runtime swaps ports, the assertion catches it immediately.
 * ========================================================================= */

const W2_ALPHA_ID = "w2Alpha";
const W2_BETA_ID = "w2Beta";
const W2_GAMMA_ID = "w2Gamma";
const W2_MERGE_ID = "w2Merge";

function buildW2(): WorkflowContent {
  const mkLoader = (sentinel: string, count: number): string =>
    [
      "def load() -> pd.DataFrame:",
      "    return pd.DataFrame({",
      `        'sentinel': [${JSON.stringify(sentinel)}] * ${count},`,
      `        'i': list(range(${count})),`,
      "    })",
    ].join("\n");

  // Parameter order matches port order — `alphaIn` → port 0, `betaIn` → port 1,
  // `gammaIn` → port 2. The merge body emits one row per parameter, recording
  // both the port index it represents AND the sentinel value it received. If
  // the runtime swapped the data between ports, the sentinel <-> port_index
  // pairing in the output would be wrong.
  const mergeCode = [
    "def process(alphaIn, betaIn, gammaIn) -> pd.DataFrame:",
    "    rows = [",
    "        {'port_index': 0, 'param_name': 'alphaIn', 'expected_sentinel': 'ALPHA',",
    "         'observed_sentinel': alphaIn['sentinel'].iloc[0] if len(alphaIn) else '<empty>',",
    "         'observed_rows': len(alphaIn)},",
    "        {'port_index': 1, 'param_name': 'betaIn', 'expected_sentinel': 'BETA',",
    "         'observed_sentinel': betaIn['sentinel'].iloc[0] if len(betaIn) else '<empty>',",
    "         'observed_rows': len(betaIn)},",
    "        {'port_index': 2, 'param_name': 'gammaIn', 'expected_sentinel': 'GAMMA',",
    "         'observed_sentinel': gammaIn['sentinel'].iloc[0] if len(gammaIn) else '<empty>',",
    "         'observed_rows': len(gammaIn)},",
    "    ]",
    "    return pd.DataFrame(rows)",
  ].join("\n");

  const alpha = dataLoadingOp(W2_ALPHA_ID, "W2 Alpha (port 0, 4 rows)", mkLoader("ALPHA", 4));
  const beta = dataLoadingOp(W2_BETA_ID, "W2 Beta (port 1, 7 rows)", mkLoader("BETA", 7));
  const gamma = dataLoadingOp(W2_GAMMA_ID, "W2 Gamma (port 2, 11 rows)", mkLoader("GAMMA", 11));
  const merge = dataProcessingOp(W2_MERGE_ID, "W2 3-input merge", mergeCode, 3, true);

  return {
    operators: [alpha, beta, gamma, merge],
    operatorPositions: {
      [alpha.operatorID]: pos(120, 120),
      [beta.operatorID]: pos(120, 280),
      [gamma.operatorID]: pos(120, 440),
      [merge.operatorID]: pos(520, 280),
    },
    links: [
      buildLink("link-w2-1", alpha.operatorID, merge.operatorID, 0),
      buildLink("link-w2-2", beta.operatorID, merge.operatorID, 1),
      buildLink("link-w2-3", gamma.operatorID, merge.operatorID, 2),
    ],
    commentBoxes: [],
    settings: DEFAULT_SETTINGS,
  };
}

function validateW2(result: SyncExecutionResult): void {
  const rows = rowsOf(result, W2_MERGE_ID);
  assertEqual(rows.length, 3, "W2 merge row count");
  assertColumns(
    rows,
    ["port_index", "param_name", "expected_sentinel", "observed_sentinel", "observed_rows"],
    "W2 merge"
  );
  const expected: Array<{ port: number; param: string; sentinel: string; rows: number }> = [
    { port: 0, param: "alphaIn", sentinel: "ALPHA", rows: 4 },
    { port: 1, param: "betaIn", sentinel: "BETA", rows: 7 },
    { port: 2, param: "gammaIn", sentinel: "GAMMA", rows: 11 },
  ];
  for (const e of expected) {
    const row = rows.find(r => Number(r.port_index) === e.port);
    if (!row) throw new AssertionError(`W2: missing row for port ${e.port}`);
    assertEqual(row.param_name, e.param, `W2 port ${e.port} param_name`);
    assertEqual(row.expected_sentinel, e.sentinel, `W2 port ${e.port} expected_sentinel`);
    assertEqual(
      row.observed_sentinel,
      e.sentinel,
      `W2 port ${e.port}: ${e.param} should receive ${e.sentinel} (port→param mapping)`
    );
    assertEqual(Number(row.observed_rows), e.rows, `W2 port ${e.port} observed_rows`);
  }
}

/* ============================================================================
 *  W3 — five-input aggregator (5 DataLoading → DataProcessing[5-input])
 *
 *  Same idea as W2 but at higher fan-in. Validates that the per-port-index
 *  → per-parameter mapping holds for arities beyond 3 (where the agent's
 *  `updateOperatorInputPorts` and the backend's port-by-port collect-then-
 *  dispatch both have to scale).
 * ========================================================================= */

const W3_LOADERS = [
  { id: "w3Port0", sentinel: "ONE", rows: 1 },
  { id: "w3Port1", sentinel: "TWO", rows: 2 },
  { id: "w3Port2", sentinel: "THREE", rows: 3 },
  { id: "w3Port3", sentinel: "FOUR", rows: 4 },
  { id: "w3Port4", sentinel: "FIVE", rows: 5 },
];
const W3_AGG_ID = "w3Aggregator";

function buildW3(): WorkflowContent {
  const mkLoader = (sentinel: string, count: number): string =>
    [
      "def load() -> pd.DataFrame:",
      `    return pd.DataFrame({'sentinel': [${JSON.stringify(sentinel)}] * ${count}, 'i': list(range(${count}))})`,
    ].join("\n");

  // Five named parameters bound to ports 0..4 in order.
  const aggCode = [
    "def process(p0, p1, p2, p3, p4) -> pd.DataFrame:",
    "    inputs = [p0, p1, p2, p3, p4]",
    "    names = ['p0', 'p1', 'p2', 'p3', 'p4']",
    "    expected = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE']",
    "    rows = []",
    "    for i, (df, name, want) in enumerate(zip(inputs, names, expected)):",
    "        rows.append({",
    "            'port_index': i,",
    "            'param_name': name,",
    "            'expected_sentinel': want,",
    "            'observed_sentinel': df['sentinel'].iloc[0] if len(df) else '<empty>',",
    "            'observed_rows': len(df),",
    "        })",
    "    return pd.DataFrame(rows)",
  ].join("\n");

  const loaders = W3_LOADERS.map((l, i) =>
    dataLoadingOp(l.id, `W3 ${l.sentinel} (port ${i}, ${l.rows} rows)`, mkLoader(l.sentinel, l.rows))
  );
  const agg = dataProcessingOp(W3_AGG_ID, "W3 5-input aggregator", aggCode, 5, true);

  const operatorPositions: Record<string, Point> = {};
  loaders.forEach((op, i) => {
    operatorPositions[op.operatorID] = pos(120, 80 + i * 120);
  });
  operatorPositions[agg.operatorID] = pos(560, 80 + ((W3_LOADERS.length - 1) * 120) / 2);

  return {
    operators: [...loaders, agg],
    operatorPositions,
    links: loaders.map((op, i) => buildLink(`link-w3-${i}`, op.operatorID, agg.operatorID, i)),
    commentBoxes: [],
    settings: DEFAULT_SETTINGS,
  };
}

function validateW3(result: SyncExecutionResult): void {
  const rows = rowsOf(result, W3_AGG_ID);
  assertEqual(rows.length, 5, "W3 aggregator row count");
  assertColumns(
    rows,
    ["port_index", "param_name", "expected_sentinel", "observed_sentinel", "observed_rows"],
    "W3 aggregator"
  );
  for (let i = 0; i < W3_LOADERS.length; i++) {
    const row = rows.find(r => Number(r.port_index) === i);
    if (!row) throw new AssertionError(`W3: missing row for port ${i}`);
    assertEqual(row.param_name, `p${i}`, `W3 port ${i} param_name`);
    assertEqual(row.expected_sentinel, W3_LOADERS[i].sentinel, `W3 port ${i} expected_sentinel`);
    assertEqual(
      row.observed_sentinel,
      W3_LOADERS[i].sentinel,
      `W3 port ${i}: param p${i} must receive ${W3_LOADERS[i].sentinel} (port→param mapping at arity 5)`
    );
    assertEqual(Number(row.observed_rows), W3_LOADERS[i].rows, `W3 port ${i} observed_rows`);
  }
}

/* ============================================================================
 *  W4 — DAG: load → 2 chained processors → 2-input merge
 *
 *  Proves three things at once:
 *    1. A single DataLoading can fan out to multiple DataProcessing
 *       consumers (each gets the full upstream table).
 *    2. A DataProcessing operator's output can feed ANOTHER
 *       DataProcessing operator (chained processing).
 *    3. A 2-input merge sees the correct upstream on each port (port 0
 *       gets branchA's output, port 1 gets branchB's output).
 * ========================================================================= */

const W4_LOADER_ID = "w4Loader";
const W4_BRANCH_A_ID = "w4BranchA";
const W4_BRANCH_B_ID = "w4BranchB";
const W4_MERGE_ID = "w4Merge";

function buildW4(): WorkflowContent {
  const loaderCode = [
    "def load() -> pd.DataFrame:",
    "    return pd.DataFrame({'id': list(range(5)), 'value': [10, 20, 30, 40, 50]})",
  ].join("\n");

  // branchA stamps a tag column proving the row went through this branch.
  const branchACode = [
    "def process(src) -> pd.DataFrame:",
    "    out = src.copy()",
    "    out['from_branch'] = 'A'",
    "    out['value_a'] = out['value'] + 1",
    "    return out[['id', 'from_branch', 'value_a']]",
  ].join("\n");

  // branchB stamps a different tag and a different derived column.
  const branchBCode = [
    "def process(src) -> pd.DataFrame:",
    "    out = src.copy()",
    "    out['from_branch'] = 'B'",
    "    out['value_b'] = out['value'] * 10",
    "    return out[['id', 'from_branch', 'value_b']]",
  ].join("\n");

  // Merge takes (branchA, branchB) — the first param must receive the rows
  // tagged 'A' (port 0), the second must receive rows tagged 'B' (port 1).
  // The validator below asserts both branches were observed AND were tagged
  // consistently with their declared parameter.
  const mergeCode = [
    "def process(branchA, branchB) -> pd.DataFrame:",
    "    a_tags = sorted(set(branchA['from_branch'].astype(str)))",
    "    b_tags = sorted(set(branchB['from_branch'].astype(str)))",
    "    rows = [",
    "        {'port_index': 0, 'param_name': 'branchA',",
    "         'expected_tag': 'A', 'observed_tags': ','.join(a_tags),",
    "         'observed_rows': len(branchA),",
    "         'has_value_a': 'value_a' in branchA.columns,",
    "         'has_value_b': 'value_b' in branchA.columns},",
    "        {'port_index': 1, 'param_name': 'branchB',",
    "         'expected_tag': 'B', 'observed_tags': ','.join(b_tags),",
    "         'observed_rows': len(branchB),",
    "         'has_value_a': 'value_a' in branchB.columns,",
    "         'has_value_b': 'value_b' in branchB.columns},",
    "    ]",
    "    return pd.DataFrame(rows)",
  ].join("\n");

  const loader = dataLoadingOp(W4_LOADER_ID, "W4 Loader", loaderCode);
  const a = dataProcessingOp(W4_BRANCH_A_ID, "W4 Branch A", branchACode, 1, false);
  const b = dataProcessingOp(W4_BRANCH_B_ID, "W4 Branch B", branchBCode, 1, false);
  const merge = dataProcessingOp(W4_MERGE_ID, "W4 2-input merge", mergeCode, 2, true);

  return {
    operators: [loader, a, b, merge],
    operatorPositions: {
      [loader.operatorID]: pos(120, 280),
      [a.operatorID]: pos(420, 140),
      [b.operatorID]: pos(420, 420),
      [merge.operatorID]: pos(720, 280),
    },
    links: [
      buildLink("link-w4-1", loader.operatorID, a.operatorID, 0),
      buildLink("link-w4-2", loader.operatorID, b.operatorID, 0),
      buildLink("link-w4-3", a.operatorID, merge.operatorID, 0),
      buildLink("link-w4-4", b.operatorID, merge.operatorID, 1),
    ],
    commentBoxes: [],
    settings: DEFAULT_SETTINGS,
  };
}

function validateW4(result: SyncExecutionResult): void {
  const rows = rowsOf(result, W4_MERGE_ID);
  assertEqual(rows.length, 2, "W4 merge row count");
  assertColumns(
    rows,
    ["port_index", "param_name", "expected_tag", "observed_tags", "observed_rows", "has_value_a", "has_value_b"],
    "W4 merge"
  );

  const portA = rows.find(r => Number(r.port_index) === 0);
  if (!portA) throw new AssertionError("W4: missing row for port 0");
  assertEqual(portA.param_name, "branchA", "W4 port 0 param_name");
  assertEqual(portA.expected_tag, "A", "W4 port 0 expected_tag");
  assertEqual(portA.observed_tags, "A", "W4 port 0: branchA must receive rows tagged A (not B)");
  assertEqual(Number(portA.observed_rows), 5, "W4 port 0 observed_rows");
  assertEqual(portA.has_value_a, true, "W4 port 0 has branchA's derived column value_a");
  assertEqual(portA.has_value_b, false, "W4 port 0 must NOT see branchB's column value_b");

  const portB = rows.find(r => Number(r.port_index) === 1);
  if (!portB) throw new AssertionError("W4: missing row for port 1");
  assertEqual(portB.param_name, "branchB", "W4 port 1 param_name");
  assertEqual(portB.expected_tag, "B", "W4 port 1 expected_tag");
  assertEqual(portB.observed_tags, "B", "W4 port 1: branchB must receive rows tagged B (not A)");
  assertEqual(Number(portB.observed_rows), 5, "W4 port 1 observed_rows");
  assertEqual(portB.has_value_b, true, "W4 port 1 has branchB's derived column value_b");
  assertEqual(portB.has_value_a, false, "W4 port 1 must NOT see branchA's column value_a");
}

/* ============================================================================
 *  Spec list — picked up by run.ts
 * ========================================================================= */

export const CODE_MODE_WORKFLOW_SPECS: CodeModeWorkflowSpec[] = [
  {
    name: "[CodeMode] W1 single-input chain",
    description:
      "DataLoading → DataProcessing(1-in) → DataProcessing(1-in). Validates that a single-input " +
      "processor reads its upstream and that one processor can feed another.",
    build: buildW1,
    validate: validateW1,
  },
  {
    name: "[CodeMode] W2 three-input port mapping",
    description:
      "3 DataLoading sources → DataProcessing(3-in). Each source emits a unique sentinel; the " +
      "merge processor's per-parameter sentinel reading proves port i → i-th parameter mapping.",
    build: buildW2,
    validate: validateW2,
  },
  {
    name: "[CodeMode] W3 five-input port mapping",
    description:
      "5 DataLoading sources → DataProcessing(5-in). Same port-to-param assertion as W2 but at " +
      "fan-in 5 — guards the dynamic-port path beyond the common-case arities.",
    build: buildW3,
    validate: validateW3,
  },
  {
    name: "[CodeMode] W4 DAG with two-input merge",
    description:
      "1 DataLoading fans out to 2 DataProcessing branches that each stamp a distinct tag, then " +
      "a DataProcessing(2-in) merge asserts port 0 sees branchA-tagged rows and port 1 sees " +
      "branchB-tagged rows. Catches both fan-out and per-port chaining regressions.",
    build: buildW4,
    validate: validateW4,
  },
];
