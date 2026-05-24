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
 * Real-agent strict e2e specs.
 *
 * Each spec drives an actual agent (talking to the LLM gateway) with a
 * directive prompt that tells the model exactly which operators to create,
 * with which `operatorId`s, and with which code body. After the agent's
 * `complete` frame fires, the runner fetches the head snapshot and the
 * spec's validator asserts the workflow shape (operator IDs, types, port
 * arity, link wiring) AND each operator's executed result data — proving
 * the agent both built the right DAG and that the DAG actually computed
 * what we asked for.
 *
 * To keep these reliable across model swaps and minor wording drift,
 * prompts are imperative ("you MUST use these EXACT operatorIds and this
 * EXACT code") and validators allow:
 *   - extra operators beyond the required set (assert presence, not absence)
 *   - any reasonable final answer text (we never assert on the LLM's prose)
 * Validators do NOT relax on:
 *   - the required operatorIds being present with the right type
 *   - the link wiring between the required operators
 *   - the per-operator executed result data (rows, columns, values)
 */

import type {
  CommentBox,
  OperatorLink,
  OperatorPredicate,
  WorkflowContent,
} from "../../src/types/workflow";
import type { AgentSnapshot, AgentTurnResult } from "../../src/api/agent-service-api";

/**
 * Wire shape of one operator's executed result as exposed by the agent
 * service's `/agents/:id/snapshots/:stepId` endpoint. Mirrors the
 * server-side `OperatorResultSummaryWs` in `agent-service/src/server.ts`
 * — note that the row payload lives under `sampleRecords` here (not
 * `result`, which is the internal `OperatorInfo` field name).
 */
interface OperatorResultSummary {
  state: string;
  inputTuples: number;
  outputTuples: number;
  outputColumns?: number;
  error?: string;
  warnings?: string[];
  totalRowCount?: number;
  sampleRecords?: Record<string, unknown>[];
  columnStats?: Record<string, string>;
}

export class SpecAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecAssertionError";
  }
}

export interface AgentDrivenSpec {
  name: string;
  description: string;
  /** Directive prompt sent as the user's first (only) message to the agent. */
  prompt: string;
  /**
   * Optional pre-run hook for materializing on-disk fixtures (e.g. a
   * Windows-1252 CSV the agent will be asked to load). The runner awaits
   * this before creating the agent. Use it sparingly — most specs should
   * be self-contained via the directive prompt.
   */
  setup?: () => Promise<void> | void;
  /**
   * Validate the agent's terminal snapshot + the full turn trace. Throw
   * SpecAssertionError (or any Error) on failure — the runner counts the
   * spec as a failure and continues to the next.
   */
  validate: (snapshot: AgentSnapshot, turn: AgentTurnResult) => void;
}

/* ============================================================================
 *  Shared assertion helpers
 * ========================================================================= */

function assertEqual<T>(actual: T, expected: T, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new SpecAssertionError(`${what}: expected ${e}, got ${a}`);
}

function requireWorkflow(snapshot: AgentSnapshot): WorkflowContent {
  if (!snapshot.workflow) {
    throw new SpecAssertionError("snapshot.workflow is null — agent did not produce any dataflow state");
  }
  return snapshot.workflow;
}

function requireOperator(workflow: WorkflowContent, opId: string): OperatorPredicate {
  const op = workflow.operators.find(o => o.operatorID === opId);
  if (!op) {
    const seen = workflow.operators.map(o => o.operatorID).join(", ") || "(none)";
    throw new SpecAssertionError(`operator '${opId}' missing from workflow. Saw operators: [${seen}]`);
  }
  return op;
}

function requireResult(snapshot: AgentSnapshot, opId: string): OperatorResultSummary {
  const info = (snapshot.results as Record<string, OperatorResultSummary>)[opId];
  if (!info) throw new SpecAssertionError(`operator '${opId}' has no execution result in the head snapshot`);
  if (info.error) {
    throw new SpecAssertionError(`operator '${opId}' executed with error: ${info.error.split("\n")[0]}`);
  }
  if (!info.sampleRecords || info.sampleRecords.length === 0) {
    throw new SpecAssertionError(
      `operator '${opId}' executed but emitted no rows (totalRowCount=${info.totalRowCount ?? 0})`
    );
  }
  return info;
}

function rowsOf(info: OperatorResultSummary): Record<string, unknown>[] {
  return info.sampleRecords ?? [];
}

function columnsOf(info: OperatorResultSummary): string[] {
  if (!info.sampleRecords || info.sampleRecords.length === 0) return [];
  return Object.keys(info.sampleRecords[0]).filter(k => k !== "__row_index__");
}

function requireLink(
  workflow: WorkflowContent,
  fromOpId: string,
  toOpId: string,
  toPortIdx: number
): OperatorLink {
  const link = workflow.links.find(
    l => l.source.operatorID === fromOpId && l.target.operatorID === toOpId && l.target.portID === `input-${toPortIdx}`
  );
  if (!link) {
    const seen = workflow.links
      .map(l => `${l.source.operatorID}→${l.target.operatorID}(${l.target.portID})`)
      .join(", ");
    throw new SpecAssertionError(
      `expected link ${fromOpId} → ${toOpId}#input-${toPortIdx} not found. Saw: [${seen || "(no links)"}]`
    );
  }
  return link;
}

/* ============================================================================
 *  T1 — single DataLoading operator
 *
 *  Asks the agent to create exactly one DataLoading op with a precisely
 *  specified code body, then end. Validator asserts the workflow has the
 *  named op, that it's typed DataLoading, that it has 1 output port and
 *  0 input ports, AND that the executed result is byte-equal to the
 *  expected 5-row DataFrame.
 * ========================================================================= */

const T1_OP_ID = "rangeLoader";
const T1_EXPECTED_ROWS: Record<string, number>[] = [
  { id: 0, value: 10 },
  { id: 1, value: 20 },
  { id: 2, value: 30 },
  { id: 3, value: 40 },
  { id: 4, value: 50 },
];
const T1_EXPECTED_COLUMNS = ["id", "value"];

const T1_PROMPT = `Build a workflow with EXACTLY ONE operator. Do not add any other operators. Do not delete or modify any operators after the first creation. After the operator is created, end the task with the final answer "done".

The operator MUST use these arguments to createOrModifyOperator (use the EXACT operatorId given — do not rename it):
- operatorId: "${T1_OP_ID}"
- summary: "Load a 5-row synthetic DataFrame with columns id and value."
- code (use this code character-for-character — do NOT change column names, values, or row counts):
\`\`\`python
def load() -> pd.DataFrame:
    import pandas as pd
    return pd.DataFrame({
        "id": [0, 1, 2, 3, 4],
        "value": [10, 20, 30, 40, 50],
    })
\`\`\``;

function validateT1(snapshot: AgentSnapshot, _turn: AgentTurnResult): void {
  const wf = requireWorkflow(snapshot);
  const op = requireOperator(wf, T1_OP_ID);
  assertEqual(op.operatorType, "DataLoading", `T1: ${T1_OP_ID} operator type`);
  assertEqual(op.inputPorts.length, 0, `T1: ${T1_OP_ID} input port count`);
  assertEqual(op.outputPorts.length, 1, `T1: ${T1_OP_ID} output port count`);

  const info = requireResult(snapshot, T1_OP_ID);
  const rows = rowsOf(info).map(r => ({ id: Number(r.id), value: Number(r.value) }));
  assertEqual(rows.length, T1_EXPECTED_ROWS.length, `T1: ${T1_OP_ID} row count`);
  assertEqual(columnsOf(info).sort(), [...T1_EXPECTED_COLUMNS].sort(), `T1: ${T1_OP_ID} column set`);
  for (const want of T1_EXPECTED_ROWS) {
    const found = rows.find(r => r.id === want.id);
    if (!found) throw new SpecAssertionError(`T1: missing row with id=${want.id}`);
    assertEqual(found.value, want.value, `T1: row id=${want.id} value`);
  }
}

/* ============================================================================
 *  T2 — DataLoading → DataProcessing chain
 *
 *  Asks the agent to create one DataLoading + one 1-input DataProcessing and
 *  wire them. Validator asserts: both operators exist with right types,
 *  the link is present, and the processor's executed result matches the
 *  expected per-row arithmetic.
 * ========================================================================= */

const T2_LOAD_ID = "numbersLoader";
const T2_PROCESS_ID = "addDoubled";
const T2_EXPECTED_ROWS: Record<string, number>[] = [
  { x: 1, y: 2 },
  { x: 2, y: 4 },
  { x: 3, y: 6 },
];

const T2_PROMPT = `Build a workflow with EXACTLY TWO operators. Do not add any other operators.

After both operators are created, end the task with the final answer "done".

Operator 1 — DataLoading:
- operatorId: "${T2_LOAD_ID}"
- summary: "Load a 3-row DataFrame with one integer column 'x'."
- code (verbatim):
\`\`\`python
def load() -> pd.DataFrame:
    import pandas as pd
    return pd.DataFrame({"x": [1, 2, 3]})
\`\`\`

Operator 2 — DataProcessing taking 1 input from "${T2_LOAD_ID}":
- operatorId: "${T2_PROCESS_ID}"
- summary: "Take the upstream table and add a column y = 2 * x."
- code (verbatim — the single parameter name MUST be exactly "${T2_LOAD_ID}" so the platform wires the upstream link automatically):
\`\`\`python
def process(${T2_LOAD_ID}) -> pd.DataFrame:
    out = ${T2_LOAD_ID}.copy()
    out["y"] = out["x"] * 2
    return out
\`\`\``;

function validateT2(snapshot: AgentSnapshot, _turn: AgentTurnResult): void {
  const wf = requireWorkflow(snapshot);

  const load = requireOperator(wf, T2_LOAD_ID);
  assertEqual(load.operatorType, "DataLoading", `T2: ${T2_LOAD_ID} type`);
  assertEqual(load.inputPorts.length, 0, `T2: ${T2_LOAD_ID} input count`);

  const proc = requireOperator(wf, T2_PROCESS_ID);
  assertEqual(proc.operatorType, "DataProcessing", `T2: ${T2_PROCESS_ID} type`);
  assertEqual(proc.inputPorts.length, 1, `T2: ${T2_PROCESS_ID} input count`);

  requireLink(wf, T2_LOAD_ID, T2_PROCESS_ID, 0);

  const info = requireResult(snapshot, T2_PROCESS_ID);
  const rows = rowsOf(info).map(r => ({ x: Number(r.x), y: Number(r.y) }));
  assertEqual(rows.length, T2_EXPECTED_ROWS.length, `T2: ${T2_PROCESS_ID} row count`);
  assertEqual(columnsOf(info).sort(), ["x", "y"], `T2: ${T2_PROCESS_ID} columns`);
  for (const want of T2_EXPECTED_ROWS) {
    const found = rows.find(r => r.x === want.x);
    if (!found) throw new SpecAssertionError(`T2: missing row with x=${want.x}`);
    assertEqual(found.y, want.y, `T2: row x=${want.x} y`);
  }
}

/* ============================================================================
 *  T3 — three DataLoading sources + 3-input DataProcessing merge
 *
 *  Strictest of the three. We use the platform's auto-wire convention for
 *  DataProcessing: the i-th parameter name MUST equal the upstream
 *  operator's `operatorId` — the platform parses the function signature
 *  and creates the link automatically. So loaders are named alphaSrc /
 *  betaSrc / gammaSrc and the 3-input processor's signature is
 *  `def process(alphaSrc, betaSrc, gammaSrc)`. The validator asserts:
 *    - all four operators exist with the right types and arities
 *    - the three links match the expected (alphaSrc → port 0, betaSrc →
 *      port 1, gammaSrc → port 2) wiring (i.e. the auto-link did the
 *      thing the contract advertises)
 *    - the merger's output proves the port→param mapping: each output
 *      row's `observed_sentinel` matches the sentinel the loader for
 *      that port actually emitted.
 * ========================================================================= */

const T3_ALPHA_ID = "alphaSrc";
const T3_BETA_ID = "betaSrc";
const T3_GAMMA_ID = "gammaSrc";
const T3_MERGE_ID = "tripleMerge";

const T3_PROMPT = `Build a workflow with EXACTLY FOUR operators. Do not add any other operators.

After all four operators are created and wired, end the task with the final answer "done".

Operator 1 — DataLoading:
- operatorId: "${T3_ALPHA_ID}"
- summary: "Loader emitting a 2-row DataFrame with sentinel='ALPHA'."
- code (verbatim):
\`\`\`python
def load() -> pd.DataFrame:
    import pandas as pd
    return pd.DataFrame({"sentinel": ["ALPHA", "ALPHA"], "i": [0, 1]})
\`\`\`

Operator 2 — DataLoading:
- operatorId: "${T3_BETA_ID}"
- summary: "Loader emitting a 3-row DataFrame with sentinel='BETA'."
- code (verbatim):
\`\`\`python
def load() -> pd.DataFrame:
    import pandas as pd
    return pd.DataFrame({"sentinel": ["BETA", "BETA", "BETA"], "i": [0, 1, 2]})
\`\`\`

Operator 3 — DataLoading:
- operatorId: "${T3_GAMMA_ID}"
- summary: "Loader emitting a 5-row DataFrame with sentinel='GAMMA'."
- code (verbatim):
\`\`\`python
def load() -> pd.DataFrame:
    import pandas as pd
    return pd.DataFrame({"sentinel": ["GAMMA"] * 5, "i": list(range(5))})
\`\`\`

Operator 4 — DataProcessing taking 3 inputs:
- operatorId: "${T3_MERGE_ID}"
- summary: "3-input merge that records the sentinel observed at each of its three input ports."
- code (verbatim — the parameter names MUST be exactly "${T3_ALPHA_ID}", "${T3_BETA_ID}", "${T3_GAMMA_ID}" in that order. The DataProcessing platform parses the function signature and auto-wires each parameter to the upstream operator whose operatorId matches the parameter name, so parameter "${T3_ALPHA_ID}" binds to port 0 fed by the ${T3_ALPHA_ID} loader, parameter "${T3_BETA_ID}" binds to port 1 fed by ${T3_BETA_ID}, and parameter "${T3_GAMMA_ID}" binds to port 2 fed by ${T3_GAMMA_ID}):
\`\`\`python
def process(${T3_ALPHA_ID}, ${T3_BETA_ID}, ${T3_GAMMA_ID}) -> pd.DataFrame:
    import pandas as pd
    rows = [
        {"port_index": 0, "param_name": "${T3_ALPHA_ID}",
         "expected_sentinel": "ALPHA",
         "observed_sentinel": ${T3_ALPHA_ID}["sentinel"].iloc[0] if len(${T3_ALPHA_ID}) else "<empty>",
         "observed_rows": len(${T3_ALPHA_ID})},
        {"port_index": 1, "param_name": "${T3_BETA_ID}",
         "expected_sentinel": "BETA",
         "observed_sentinel": ${T3_BETA_ID}["sentinel"].iloc[0] if len(${T3_BETA_ID}) else "<empty>",
         "observed_rows": len(${T3_BETA_ID})},
        {"port_index": 2, "param_name": "${T3_GAMMA_ID}",
         "expected_sentinel": "GAMMA",
         "observed_sentinel": ${T3_GAMMA_ID}["sentinel"].iloc[0] if len(${T3_GAMMA_ID}) else "<empty>",
         "observed_rows": len(${T3_GAMMA_ID})},
    ]
    return pd.DataFrame(rows)
\`\`\`

CRITICAL: do not change the parameter order — the i-th parameter binds to input port i. Also do not rename a parameter to anything other than its upstream loader's operatorId, since that's the auto-link key.`;

function validateT3(snapshot: AgentSnapshot, _turn: AgentTurnResult): void {
  const wf = requireWorkflow(snapshot);

  // Operators exist with the right types and arities.
  for (const id of [T3_ALPHA_ID, T3_BETA_ID, T3_GAMMA_ID]) {
    const op = requireOperator(wf, id);
    assertEqual(op.operatorType, "DataLoading", `T3: ${id} type`);
  }
  const merge = requireOperator(wf, T3_MERGE_ID);
  assertEqual(merge.operatorType, "DataProcessing", `T3: ${T3_MERGE_ID} type`);
  assertEqual(merge.inputPorts.length, 3, `T3: ${T3_MERGE_ID} input port count`);

  // Wiring: alpha → port 0, beta → port 1, gamma → port 2.
  requireLink(wf, T3_ALPHA_ID, T3_MERGE_ID, 0);
  requireLink(wf, T3_BETA_ID, T3_MERGE_ID, 1);
  requireLink(wf, T3_GAMMA_ID, T3_MERGE_ID, 2);

  // Each loader executed and emitted its sentinel + the right row count.
  const expectedSrc: Array<{ id: string; sentinel: string; rows: number }> = [
    { id: T3_ALPHA_ID, sentinel: "ALPHA", rows: 2 },
    { id: T3_BETA_ID, sentinel: "BETA", rows: 3 },
    { id: T3_GAMMA_ID, sentinel: "GAMMA", rows: 5 },
  ];
  for (const e of expectedSrc) {
    const info = requireResult(snapshot, e.id);
    const rows = rowsOf(info);
    assertEqual(rows.length, e.rows, `T3: ${e.id} loader emitted ${rows.length} rows`);
    for (const r of rows) assertEqual(r.sentinel, e.sentinel, `T3: ${e.id} sentinel value`);
  }

  // The merger output proves port→param mapping. With the auto-wire
  // convention, the i-th parameter is named the same as its upstream
  // operatorId, so port 0's param_name is alphaSrc, port 1's is betaSrc,
  // port 2's is gammaSrc. The validator asserts on those names AND on
  // the per-port observed sentinel (the harder claim — that data
  // actually flowed from the matching loader to the matching port).
  const info = requireResult(snapshot, T3_MERGE_ID);
  const rows = rowsOf(info);
  assertEqual(rows.length, 3, `T3: ${T3_MERGE_ID} row count`);
  for (const e of [
    { port: 0, param: T3_ALPHA_ID, sentinel: "ALPHA", rows: 2 },
    { port: 1, param: T3_BETA_ID, sentinel: "BETA", rows: 3 },
    { port: 2, param: T3_GAMMA_ID, sentinel: "GAMMA", rows: 5 },
  ]) {
    const row = rows.find(r => Number(r.port_index) === e.port);
    if (!row) throw new SpecAssertionError(`T3: merger missing row for port_index=${e.port}`);
    assertEqual(row.param_name, e.param, `T3: port ${e.port} param_name`);
    assertEqual(row.expected_sentinel, e.sentinel, `T3: port ${e.port} expected_sentinel`);
    assertEqual(
      row.observed_sentinel,
      e.sentinel,
      `T3: port ${e.port}: parameter ${e.param} must receive ${e.sentinel} (port→param mapping)`
    );
    assertEqual(Number(row.observed_rows), e.rows, `T3: port ${e.port} observed_rows`);
  }
}

/* ============================================================================
 *  T4 — parallel independent ops with one failing
 *
 *  Asks the agent to add TWO disjoint DataLoading operators in a single
 *  batch — `goodLoader` (returns a valid 4-row DataFrame) and `badLoader`
 *  (intentionally reads from a path that does not exist, so the backend
 *  will error). With agent-service-level subDAG partitioning, the two
 *  ops form independent groups and the good loader's result is preserved
 *  even though the bad loader failed in its own group.
 *
 *  Validator asserts:
 *   - Both operators exist with the correct types and port shapes.
 *   - `goodLoader` has a non-empty result of exactly the 4 rows asked for.
 *   - `badLoader` has an error message (the agent's [ERROR] block).
 *   - The agent emitted both `createOrModifyOperator` calls inside a
 *     SINGLE assistant step (parallel tool-calls), proving we actually
 *     exercised the multi-op batched-execution code path that the
 *     partition module is supposed to split apart.
 * ========================================================================= */

const T4_GOOD_OP_ID = "goodLoader";
const T4_BAD_OP_ID = "badLoader";
const T4_EXPECTED_GOOD_ROWS: Record<string, number>[] = [
  { id: 1, value: 100 },
  { id: 2, value: 200 },
  { id: 3, value: 300 },
  { id: 4, value: 400 },
];
const T4_EXPECTED_GOOD_COLUMNS = ["id", "value"];

const T4_PROMPT = `Build a workflow with EXACTLY TWO operators by emitting BOTH \`createOrModifyOperator\` tool calls in the SAME assistant message (parallel tool calls in one batch). Do not split them across two turns. After both are created, end with the final answer "done".

The two operators are INDEPENDENT — neither reads from the other. Use these EXACT operatorIds:

(1) operatorId: "${T4_GOOD_OP_ID}"
    summary: "Load a 4-row synthetic DataFrame with columns id and value."
    code (use this code character-for-character):
\`\`\`python
def load() -> pd.DataFrame:
    import pandas as pd
    return pd.DataFrame({
        "id": [1, 2, 3, 4],
        "value": [100, 200, 300, 400],
    })
\`\`\`

(2) operatorId: "${T4_BAD_OP_ID}"
    summary: "Load a CSV from a path that intentionally does not exist (will error)."
    code (use this code character-for-character — the file path is intentionally invalid and the load is expected to fail):
\`\`\`python
def load() -> pd.DataFrame:
    import pandas as pd
    return pd.read_csv('/tmp/this-file-does-not-exist-${T4_BAD_OP_ID}.csv')
\`\`\`

Both operators MUST be emitted as parallel tool calls in the same assistant turn. Do not chain them. After both tool results come back, output the final answer "done".

CRITICAL — do NOT retry, modify, or "fix" \`${T4_BAD_OP_ID}\` after its load fails. The FileNotFoundError on \`${T4_BAD_OP_ID}\` is the entire point of this exercise: we are verifying that a failed sibling operator does not contaminate the successful one's result. As soon as you have one assistant step that issued both \`createOrModifyOperator\` calls in parallel and seen their tool results, immediately output the final answer "done" — do not call any further tools. Resubmitting the same code for \`${T4_BAD_OP_ID}\` (even with cosmetic edits) is a test failure, not a recovery.`;

function validateT4(snapshot: AgentSnapshot, turn: AgentTurnResult): void {
  const wf = requireWorkflow(snapshot);

  // (a) Both ops exist with the right type and shape.
  for (const opId of [T4_GOOD_OP_ID, T4_BAD_OP_ID]) {
    const op = requireOperator(wf, opId);
    assertEqual(op.operatorType, "DataLoading", `T4: ${opId} operator type`);
    assertEqual(op.inputPorts.length, 0, `T4: ${opId} input port count`);
    assertEqual(op.outputPorts.length, 1, `T4: ${opId} output port count`);
  }

  // (b) goodLoader has the correct rows.
  const goodInfo = requireResult(snapshot, T4_GOOD_OP_ID);
  const rows = rowsOf(goodInfo).map(r => ({ id: Number(r.id), value: Number(r.value) }));
  assertEqual(rows.length, T4_EXPECTED_GOOD_ROWS.length, `T4: ${T4_GOOD_OP_ID} row count`);
  assertEqual(columnsOf(goodInfo).sort(), [...T4_EXPECTED_GOOD_COLUMNS].sort(), `T4: ${T4_GOOD_OP_ID} column set`);
  for (const want of T4_EXPECTED_GOOD_ROWS) {
    const found = rows.find(r => r.id === want.id);
    if (!found || found.value !== want.value) {
      throw new SpecAssertionError(
        `T4: ${T4_GOOD_OP_ID} row id=${want.id} expected value=${want.value}, got ${JSON.stringify(found)}`
      );
    }
  }

  // (c) badLoader has an error recorded. Without partitioning, Amber's
  //     AllForOneStrategy would stop ALL workers when badLoader failed,
  //     leaving goodLoader with no info at all — so this assertion is
  //     load-bearing: a bad-loader error AND a good-loader success in
  //     the SAME terminal snapshot can only happen when the partition
  //     module sent them as separate sync requests.
  const badInfo = (snapshot.results as Record<string, OperatorResultSummary>)[T4_BAD_OP_ID];
  if (!badInfo) {
    throw new SpecAssertionError(`T4: ${T4_BAD_OP_ID} has no execution result entry in the head snapshot`);
  }
  if (!badInfo.error) {
    throw new SpecAssertionError(
      `T4: ${T4_BAD_OP_ID} was expected to fail (non-existent CSV path) but reported no error. ` +
        `Backend state=${badInfo.state}, totalRowCount=${badInfo.totalRowCount ?? 0}`
    );
  }

  // (d) Both operators were created from a SINGLE assistant step's
  //     parallel tool-call array — confirms we actually exercised the
  //     batched-execution path that partitioning is designed to split.
  //     We look for any one agent step whose toolCalls list contains
  //     both createOrModifyOperator entries for goodLoader and
  //     badLoader.
  const stepWithBothCalls = turn.steps.find(s => {
    if (s.role !== "agent" || !s.toolCalls) return false;
    const createIds = s.toolCalls
      .filter(c => c.toolName === "createOrModifyOperator")
      .map(c => (c.input as { operatorId?: string })?.operatorId);
    return createIds.includes(T4_GOOD_OP_ID) && createIds.includes(T4_BAD_OP_ID);
  });
  if (!stepWithBothCalls) {
    const summary = turn.steps
      .filter(s => s.role === "agent" && s.toolCalls?.length)
      .map(
        s =>
          `step ${s.stepId}: ${s.toolCalls!
            .map(c => `${c.toolName}(${(c.input as { operatorId?: string })?.operatorId ?? "?"})`)
            .join(", ")}`
      )
      .join(" | ");
    throw new SpecAssertionError(
      `T4: agent did not emit both ${T4_GOOD_OP_ID} and ${T4_BAD_OP_ID} as parallel tool calls in the same step. ` +
        `Saw: [${summary}]`
    );
  }
}

/* ============================================================================
 *  T5 — Windows-1252-encoded CSV; agent MUST fall back from UTF-8.
 *
 *  This spec is load-bearing for the "CSV encoding fallback" principle in
 *  the code-mode system prompt. We materialize a small CSV whose bytes
 *  include the four offenders the BF error analysis flagged: `0x92`
 *  (Win-1252 right single quote), `0x93`/`0x94` (smart double quotes),
 *  and `0xa0` (Latin-1 non-breaking space). A plain `pd.read_csv(path)`
 *  raises `UnicodeDecodeError` on those bytes; the agent only succeeds
 *  if it retries with `encoding='latin-1'` (or `'cp1252'`).
 *
 *  We deliberately do NOT tell the agent the encoding — that would be
 *  testing whether it follows a literal instruction, not whether the
 *  prompt teaches the fallback pattern. We only describe the *symptom*
 *  ("`UnicodeDecodeError` on UTF-8") so the agent's behavior under the
 *  prompt's guidance is what's being measured.
 * ========================================================================= */

const T5_OP_ID = "cp1252Loader";
const T5_FIXTURE_PATH = "/tmp/agent-e2e-fixtures/T5_cp1252.csv";
const T5_EXPECTED_ROW_COUNT = 4;
const T5_EXPECTED_COLUMNS = ["id", "note"];

/**
 * Write the cp1252 fixture file. Idempotent: overwrites on every call.
 * The four data rows each carry one of the four offending bytes the
 * BF analysis identified as the most common UTF-8 boundary violators:
 *   0x92 → Win-1252 right single quote (')
 *   0x93 → Win-1252 left double quote (")
 *   0x96 → Win-1252 en-dash (–)
 *   0xa0 → Latin-1 non-breaking space ( )
 * Each is a single byte ≥ 0x80, which is invalid as UTF-8 lead — a plain
 * pd.read_csv(path) will raise UnicodeDecodeError on the first one.
 */
async function setupT5(): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  await fs.mkdir(path.dirname(T5_FIXTURE_PATH), { recursive: true });
  const ascii = (s: string): Buffer => Buffer.from(s, "ascii");
  const byte = (b: number): Buffer => Buffer.from([b]);
  const payload = Buffer.concat([
    ascii("id,note\n"),
    ascii("1,it"), byte(0x92), ascii("s ok\n"),         // 0x92 right single quote
    ascii("2,quoted "), byte(0x93), ascii("hello\n"),    // 0x93 left double quote
    ascii("3,en"), byte(0x96), ascii("dash\n"),          // 0x96 en-dash
    ascii("4,nbsp"), byte(0xa0), ascii("here\n"),        // 0xa0 NBSP
  ]);
  await fs.writeFile(T5_FIXTURE_PATH, payload);
}

const T5_PROMPT = `Build a workflow with EXACTLY ONE DataLoading operator that loads the CSV at the absolute path \`${T5_FIXTURE_PATH}\`. The file is plain CSV with header row \`id,note\` and ${T5_EXPECTED_ROW_COUNT} data rows, but the bytes are NOT valid UTF-8 — a naive \`pd.read_csv(path)\` will raise \`UnicodeDecodeError\`. Your loader must succeed and return all ${T5_EXPECTED_ROW_COUNT} rows.

Use operatorId "${T5_OP_ID}". After the operator loads cleanly, end with the final answer "done". Do not create any other operators.`;

function validateT5(snapshot: AgentSnapshot, _turn: AgentTurnResult): void {
  const wf = requireWorkflow(snapshot);
  const op = requireOperator(wf, T5_OP_ID);
  assertEqual(op.operatorType, "DataLoading", `T5: ${T5_OP_ID} operator type`);
  assertEqual(op.inputPorts.length, 0, `T5: ${T5_OP_ID} input port count`);

  const info = requireResult(snapshot, T5_OP_ID);
  assertEqual(rowsOf(info).length, T5_EXPECTED_ROW_COUNT, `T5: ${T5_OP_ID} row count`);
  assertEqual(columnsOf(info).sort(), [...T5_EXPECTED_COLUMNS].sort(), `T5: ${T5_OP_ID} column set`);
}

/* ============================================================================
 *  T6 — datetime.date column must be coerced before return.
 *
 *  Exercises the "Dates → Timestamps" half of the marshaller-safe-types
 *  principle. The Texera marshaller rejects raw `datetime.date` cells
 *  with `Unmatched type for field ..., expected AttributeType.TIMESTAMP,
 *  got ... (<class 'datetime.date'>)`. The agent must convert to
 *  `pd.Timestamp` (via `pd.to_datetime(...)`) before returning. The
 *  prompt names the offending Python type explicitly but does NOT
 *  spell out the fix — the prompt's principle is what carries it.
 * ========================================================================= */

const T6_OP_ID = "dateMarshalling";
const T6_EXPECTED_ROW_COUNT = 3;
const T6_EXPECTED_COLUMNS = ["event_date", "label"];

const T6_PROMPT = `Build a workflow with EXACTLY ONE DataLoading operator (operatorId: "${T6_OP_ID}") that returns a ${T6_EXPECTED_ROW_COUNT}-row DataFrame derived from these three Python values:

\`\`\`python
import datetime
EVENTS = [
    (datetime.date(2024, 1, 15), "alpha"),
    (datetime.date(2024, 2, 16), "beta"),
    (datetime.date(2024, 3, 17), "gamma"),
]
\`\`\`

The output DataFrame must have columns \`event_date\` and \`label\` and ${T6_EXPECTED_ROW_COUNT} rows derived from \`EVENTS\`. End the task with the final answer "done".`;

function validateT6(snapshot: AgentSnapshot, _turn: AgentTurnResult): void {
  const wf = requireWorkflow(snapshot);
  const op = requireOperator(wf, T6_OP_ID);
  assertEqual(op.operatorType, "DataLoading", `T6: ${T6_OP_ID} operator type`);

  const info = requireResult(snapshot, T6_OP_ID);
  assertEqual(rowsOf(info).length, T6_EXPECTED_ROW_COUNT, `T6: ${T6_OP_ID} row count`);
  assertEqual(columnsOf(info).sort(), [...T6_EXPECTED_COLUMNS].sort(), `T6: ${T6_OP_ID} column set`);
}

/* ============================================================================
 *  T7 — list-valued column must be exploded / split / stringified.
 *
 *  Exercises the "No list / array / dict / set cells" half of the
 *  marshaller-safe-types principle. The Texera marshaller crashes
 *  outside user code with `KeyError: <AttributeType.LIST: 9>` if a
 *  column's values are Python `list`. The agent must either explode
 *  the list column into rows, split it into multiple scalar columns,
 *  or stringify it. The prompt explicitly mentions the source data is
 *  list-valued but does NOT prescribe which workaround to use.
 * ========================================================================= */

const T7_OP_ID = "listMarshalling";

const T7_PROMPT = `Build a workflow with EXACTLY ONE DataLoading operator (operatorId: "${T7_OP_ID}") that materializes the following dictionary into a Texera-safe DataFrame:

\`\`\`python
RAW = {
    "group_id": ["g1", "g2", "g3"],
    "tags":     [["red", "blue"], ["green"], ["yellow", "purple", "orange"]],
}
\`\`\`

The platform's column marshaller cannot serialize Python \`list\` cells (it raises \`KeyError: <AttributeType.LIST: 9>\` outside user code). You may choose any sound transformation — explode the list into rows, split it into multiple scalar columns, or stringify it — but the returned DataFrame MUST contain no list cells and MUST preserve enough information that every original tag value is recoverable from the result. End the task with "done".`;

function validateT7(snapshot: AgentSnapshot, _turn: AgentTurnResult): void {
  const wf = requireWorkflow(snapshot);
  const op = requireOperator(wf, T7_OP_ID);
  assertEqual(op.operatorType, "DataLoading", `T7: ${T7_OP_ID} operator type`);

  const info = requireResult(snapshot, T7_OP_ID);
  const rows = rowsOf(info);
  if (rows.length === 0) {
    throw new SpecAssertionError(`T7: ${T7_OP_ID} returned zero rows`);
  }

  // No cell may be a list / array / dict — the whole point of T7 is
  // that the agent already eliminated those before return. We check
  // the wire shape (JSON-decoded cells from the snapshot) to confirm.
  for (const row of rows) {
    for (const [col, val] of Object.entries(row)) {
      if (Array.isArray(val) || (val !== null && typeof val === "object")) {
        throw new SpecAssertionError(
          `T7: ${T7_OP_ID} row column ${col} still contains a non-scalar value (${JSON.stringify(val)}). ` +
            `The agent did not explode / split / stringify the list-valued column.`
        );
      }
    }
  }

  // Recoverability check: the six original tag values
  // (red/blue/green/yellow/purple/orange) must each appear somewhere
  // in the row payload as a substring. This admits all three valid
  // workarounds (explode → 6 rows of scalars, split → multiple cols,
  // stringify → "['red', 'blue']" containing the substrings).
  const haystack = rows
    .flatMap(r => Object.values(r))
    .map(v => (v === null || v === undefined ? "" : String(v)))
    .join(" ")
    .toLowerCase();
  for (const tag of ["red", "blue", "green", "yellow", "purple", "orange"]) {
    if (!haystack.includes(tag)) {
      throw new SpecAssertionError(`T7: ${T7_OP_ID} output is missing tag "${tag}" — workaround dropped data.`);
    }
  }
}

/* ============================================================================
 *  T8 — tz-naive → tz-aware conversion via `.tz_localize`, not `.astype`.
 *
 *  Exercises the first bullet of the "common library pitfalls"
 *  principle. The agent must build a tz-naive timestamp column and
 *  then attach a timezone. Using `.astype('datetime64[ns, UTC]')` on
 *  a naive column raises `TypeError: Cannot use .astype to convert
 *  from timezone-naive dtype to timezone-aware dtype`. The fix is
 *  `series.dt.tz_localize('UTC')`. We don't tell the agent which fix
 *  to use — only that the result must be tz-aware.
 * ========================================================================= */

const T8_OP_ID = "tzLocalize";
const T8_EXPECTED_ROW_COUNT = 3;

const T8_PROMPT = `Build a workflow with EXACTLY ONE DataLoading operator (operatorId: "${T8_OP_ID}") whose output is a ${T8_EXPECTED_ROW_COUNT}-row DataFrame with a single column \`ts\`.

Construction requirements:
1. First build \`ts\` as a tz-NAIVE pandas datetime column with the values \`2024-01-01\`, \`2024-01-02\`, \`2024-01-03\` (use \`pd.to_datetime([...])\` or equivalent — make sure it has no timezone attached yet).
2. Then attach the \`UTC\` timezone to that same column so the final result is tz-AWARE.

Return the resulting DataFrame. The naive→aware step is the load-bearing part: a casual \`.astype('datetime64[ns, UTC]')\` on a naive column raises \`TypeError: Cannot use .astype to convert from timezone-naive dtype to timezone-aware dtype\`. End the task with "done".`;

function validateT8(snapshot: AgentSnapshot, _turn: AgentTurnResult): void {
  const wf = requireWorkflow(snapshot);
  const op = requireOperator(wf, T8_OP_ID);
  assertEqual(op.operatorType, "DataLoading", `T8: ${T8_OP_ID} operator type`);

  const info = requireResult(snapshot, T8_OP_ID);
  assertEqual(rowsOf(info).length, T8_EXPECTED_ROW_COUNT, `T8: ${T8_OP_ID} row count`);
  assertEqual(columnsOf(info).sort(), ["ts"], `T8: ${T8_OP_ID} column set`);
  // Note: we cannot directly inspect the dtype over the wire — the
  // sampleRecords just carry stringified timestamps. Reaching this
  // point means the operator returned successfully, which is itself
  // proof the agent did not crash on `.astype(...)`. The column-stats
  // block (when present) would surface as a `datetime` type entry.
}

/* ============================================================================
 *  T9 — numpy.ndarray boundary cell must be converted before return.
 *
 *  Exercises the array-cell half of the marshaller-safe-types principle.
 *  A column whose cells are `numpy.ndarray` instances cannot be marshalled
 *  — the boundary error is `TypeError: unhashable type: 'numpy.ndarray'`
 *  which surfaces outside user code (no user-line marker). The agent must
 *  convert each ndarray to a scalar/list, then explode/split/stringify
 *  per the principle.
 * ========================================================================= */

const T9_OP_ID = "ndarrayMarshalling";

const T9_PROMPT = `Build a workflow with EXACTLY ONE DataLoading operator (operatorId: "${T9_OP_ID}") that materializes the following NumPy data into a Texera-safe DataFrame:

\`\`\`python
import numpy as np
ARRAYS = {
    "row_id": [1, 2, 3],
    "vec":    [np.array([0.1, 0.2]), np.array([0.3, 0.4, 0.5]), np.array([0.6])],
}
\`\`\`

The marshaller crashes on \`numpy.ndarray\` cells with \`TypeError: unhashable type: 'numpy.ndarray'\` outside user code. You may pick any sound transformation — explode the per-row vector into one row per element, split fixed-position elements into multiple scalar columns, or stringify the array — but the returned DataFrame MUST contain no \`numpy.ndarray\` cells and MUST preserve every original element value in the result. End the task with "done".`;

function validateT9(snapshot: AgentSnapshot, _turn: AgentTurnResult): void {
  const wf = requireWorkflow(snapshot);
  const op = requireOperator(wf, T9_OP_ID);
  assertEqual(op.operatorType, "DataLoading", `T9: ${T9_OP_ID} operator type`);

  const info = requireResult(snapshot, T9_OP_ID);
  const rows = rowsOf(info);
  if (rows.length === 0) {
    throw new SpecAssertionError(`T9: ${T9_OP_ID} returned zero rows`);
  }
  for (const row of rows) {
    for (const [col, val] of Object.entries(row)) {
      if (Array.isArray(val) || (val !== null && typeof val === "object")) {
        throw new SpecAssertionError(
          `T9: ${T9_OP_ID} row column ${col} still contains a non-scalar value (${JSON.stringify(val)}). ` +
            `The agent did not convert the ndarray-valued column to scalar cells.`
        );
      }
    }
  }
  // Recoverability: each of the six original float values must show up
  // as a numeric substring in the row payload. (Stringified arrays carry
  // them too, e.g. "[0.1, 0.2]".) We use a tolerant substring check so
  // the spec admits all three valid workarounds.
  const haystack = rows
    .flatMap(r => Object.values(r))
    .map(v => (v === null || v === undefined ? "" : String(v)))
    .join(" ");
  for (const needle of ["0.1", "0.2", "0.3", "0.4", "0.5", "0.6"]) {
    if (!haystack.includes(needle)) {
      throw new SpecAssertionError(`T9: ${T9_OP_ID} output is missing element "${needle}" — workaround dropped data.`);
    }
  }
}

/* ============================================================================
 *  T10 — pd.NA truthiness must be checked with isna(), not `if value:`.
 *
 *  Exercises the "boolean value of NA is ambiguous" pitfall from the
 *  pandas-pitfalls principle. Naive `if value: ...` on a cell drawn from
 *  a `pd.NA`-containing column raises `TypeError: boolean value of NA is
 *  ambiguous`. The agent must use `pd.isna(...)` (or `.isna()` / `.notna()`
 *  on whole columns). The spec succeeds if the operator returns rows
 *  without crashing.
 * ========================================================================= */

const T10_OP_ID = "naTruthiness";
const T10_EXPECTED_ROW_COUNT = 4;

const T10_PROMPT = `Build a workflow with EXACTLY ONE DataLoading operator (operatorId: "${T10_OP_ID}") that builds and returns this DataFrame derived from a mixed pd.NA / scalar source:

\`\`\`python
import pandas as pd
SRC = pd.DataFrame({
    "id":    [1, 2, 3, 4],
    "score": pd.array([10, pd.NA, 30, pd.NA], dtype="Int64"),
})
\`\`\`

Add a column \`status\` to \`SRC\` derived from \`score\` as follows: \`status == "missing"\` when the score is \`pd.NA\`, otherwise \`status == "present"\`. Return the resulting ${T10_EXPECTED_ROW_COUNT}-row DataFrame with columns \`id\`, \`score\`, \`status\`.

WARNING: a naive \`if row['score']: ...\` per-row check, or any \`bool(score)\` / \`score and X\` expression, raises \`TypeError: boolean value of NA is ambiguous\` because pd.NA is neither truthy nor falsy. The check must go through \`pd.isna(...)\` (or \`.isna()\` / \`.notna()\` on the whole column). End with "done".`;

function validateT10(snapshot: AgentSnapshot, _turn: AgentTurnResult): void {
  const wf = requireWorkflow(snapshot);
  const op = requireOperator(wf, T10_OP_ID);
  assertEqual(op.operatorType, "DataLoading", `T10: ${T10_OP_ID} operator type`);

  const info = requireResult(snapshot, T10_OP_ID);
  const rows = rowsOf(info);
  assertEqual(rows.length, T10_EXPECTED_ROW_COUNT, `T10: ${T10_OP_ID} row count`);
  assertEqual(columnsOf(info).sort(), ["id", "score", "status"], `T10: ${T10_OP_ID} column set`);

  // Verify the status column actually carries "missing" twice and
  // "present" twice — the source has exactly two NAs and two non-NAs.
  const counts = { missing: 0, present: 0, other: 0 };
  for (const r of rows) {
    const s = String(r.status ?? "").toLowerCase();
    if (s === "missing") counts.missing++;
    else if (s === "present") counts.present++;
    else counts.other++;
  }
  if (counts.missing !== 2 || counts.present !== 2) {
    throw new SpecAssertionError(
      `T10: status distribution wrong — expected 2 "missing" + 2 "present", got ${JSON.stringify(counts)}`
    );
  }
}

/* ============================================================================
 *  T11 — lossy int cast on a column with NaN must use nullable Int64.
 *
 *  Exercises the IntCastingNaNError pitfall from the pandas-pitfalls
 *  principle. `df['x'].astype(int)` on a float64 column containing NaN
 *  raises `IntCastingNaNError: Cannot convert non-finite values (NA or
 *  inf) to integer`. The fix is either `.astype('Int64')` (pandas'
 *  nullable integer dtype) or a fillna() before the cast. The spec
 *  succeeds if the operator returns rows.
 * ========================================================================= */

const T11_OP_ID = "intCastNaN";
const T11_EXPECTED_ROW_COUNT = 5;

const T11_PROMPT = `Build a workflow with EXACTLY ONE DataLoading operator (operatorId: "${T11_OP_ID}") that returns the following DataFrame with one float column converted to an integer-typed column:

\`\`\`python
import pandas as pd
import numpy as np
SRC = pd.DataFrame({
    "label":      ["a", "b", "c", "d", "e"],
    "raw_score":  [10.0, np.nan, 30.0, np.nan, 50.0],
})
\`\`\`

Produce an output column \`score_int\` derived from \`raw_score\` that is integer-typed. Return all ${T11_EXPECTED_ROW_COUNT} rows with columns \`label\`, \`raw_score\`, \`score_int\` (the original \`raw_score\` column is kept as-is alongside the new \`score_int\`).

WARNING: a naive \`SRC["raw_score"].astype(int)\` raises \`IntCastingNaNError: Cannot convert non-finite values (NA or inf) to integer\` because the float64 column contains \`NaN\`. Either use pandas' nullable integer dtype (\`.astype("Int64")\`) — which preserves the NaN positions as \`pd.NA\` — or replace NaN with a sentinel before casting (\`fillna(0).astype(int)\`). End with "done".`;

function validateT11(snapshot: AgentSnapshot, _turn: AgentTurnResult): void {
  const wf = requireWorkflow(snapshot);
  const op = requireOperator(wf, T11_OP_ID);
  assertEqual(op.operatorType, "DataLoading", `T11: ${T11_OP_ID} operator type`);

  const info = requireResult(snapshot, T11_OP_ID);
  const rows = rowsOf(info);
  assertEqual(rows.length, T11_EXPECTED_ROW_COUNT, `T11: ${T11_OP_ID} row count`);
  const cols = columnsOf(info);
  for (const required of ["label", "raw_score", "score_int"]) {
    if (!cols.includes(required)) {
      throw new SpecAssertionError(`T11: missing required column ${required}. Saw: [${cols.join(", ")}]`);
    }
  }
  // The non-null rows (a, c, e) must carry their integer-typed scores.
  // Whichever workaround was used, the final cell values for those rows
  // should still be the integers 10 / 30 / 50.
  const byLabel = new Map(rows.map(r => [String(r.label), r] as const));
  for (const [label, want] of [["a", 10], ["c", 30], ["e", 50]] as const) {
    const got = byLabel.get(label);
    if (!got) throw new SpecAssertionError(`T11: missing row with label="${label}"`);
    const intVal = Number(got.score_int);
    if (!Number.isFinite(intVal) || intVal !== want) {
      throw new SpecAssertionError(`T11: row label="${label}" score_int expected ${want}, got ${JSON.stringify(got.score_int)}`);
    }
  }
}

/* ============================================================================
 *  T12 — engine-side fix verification: raw datetime.date cells must survive.
 *
 *  T6 succeeds because the agent's prompt teaches "cast date →
 *  pd.Timestamp before return", so the test never actually exercises
 *  the Amber marshaller's tolerance for `datetime.date`. T12 instead
 *  hands the agent a code body verbatim — `[datetime.date(...), ...]`
 *  with NO `pd.to_datetime(...)` conversion — and asks it to ship that
 *  exact code. The only way this spec turns green is if
 *  `coerce_value_to_type`'s TIMESTAMP branch (in
 *  `amber/.../attribute_type.py`) promotes the raw date cells to
 *  `datetime.datetime` during cast_to_schema. If a future change
 *  regresses the marshaller, T12 fails even when T6 still passes —
 *  exactly what we want from a redundant safety net.
 * ========================================================================= */

const T12_OP_ID = "rawDateMarshallerFix";
const T12_EXPECTED_ROW_COUNT = 3;

const T12_PROMPT = `Build a workflow with EXACTLY ONE DataLoading operator (operatorId: "${T12_OP_ID}").

Use this code body CHARACTER-FOR-CHARACTER — do not normalize, refactor, or "improve" it. Do not insert any \`pd.to_datetime(...)\` conversion. The point of the test is precisely that the raw datetime.date cells survive end-to-end through the engine without user-side coercion:

\`\`\`python
def load() -> pd.DataFrame:
    import datetime
    import pandas as pd
    return pd.DataFrame({
        "event_date": [
            datetime.date(2024, 1, 15),
            datetime.date(2024, 2, 16),
            datetime.date(2024, 3, 17),
        ],
        "label": ["alpha", "beta", "gamma"],
    })
\`\`\`

After the operator is created, end the task with the final answer "done". Do not modify the operator after the first creation.`;

function validateT12(snapshot: AgentSnapshot, _turn: AgentTurnResult): void {
  const wf = requireWorkflow(snapshot);
  const op = requireOperator(wf, T12_OP_ID);
  assertEqual(op.operatorType, "DataLoading", `T12: ${T12_OP_ID} operator type`);

  const info = requireResult(snapshot, T12_OP_ID);
  assertEqual(rowsOf(info).length, T12_EXPECTED_ROW_COUNT, `T12: ${T12_OP_ID} row count`);
  assertEqual(columnsOf(info).sort(), ["event_date", "label"], `T12: ${T12_OP_ID} column set`);
}

/* ============================================================================
 *  T13 — ndarray cells survive the column-stats publish path.
 *
 *  Exercises a SECOND engine bug observed in a real agent trace:
 *  ``_compute_column_stats`` in ``data_processor.py`` crashed with
 *  ``TypeError: unhashable type: 'numpy.ndarray'`` because the str-branch
 *  did ``int(non_null.nunique())`` without try/except. The crash fired
 *  OUTSIDE user code (in the engine's stats-publishing chain) and torpedoed
 *  the entire executor session — the operator would appear to "complete"
 *  on the engine side but no result rows would surface.
 *
 *  The fix stringifies before counting so unhashable cells (ndarray, list,
 *  dict) don't blow up. T13 ships a UDF returning raw ndarray cells in an
 *  object-dtype column verbatim — no agent-side conversion — so the only
 *  way the spec turns green is if the engine fix is in place. Companion to
 *  T12 (the datetime.date engine-side regression).
 * ========================================================================= */

const T13_OP_ID = "ndarrayColumnStats";
const T13_EXPECTED_ROW_COUNT = 3;

const T13_PROMPT = `Build a workflow with EXACTLY ONE DataLoading operator (operatorId: "${T13_OP_ID}").

Use this code body CHARACTER-FOR-CHARACTER — do not normalize, refactor, or "improve" it. Do not convert the ndarray cells into lists, strings, or anything else. The point of the test is precisely that raw ndarray cells survive end-to-end through the engine's column-stats publishing path:

\`\`\`python
def load() -> pd.DataFrame:
    import pandas as pd
    import numpy as np
    return pd.DataFrame({
        "strategy": ["alpha", "beta", "gamma"],
        "uniques": [
            np.array(["Full Suppression", "Other"], dtype=object),
            np.array(["Full Suppression", "Other"], dtype=object),
            np.array(["Other"], dtype=object),
        ],
    })
\`\`\`

After the operator is created, end the task with the final answer "done". Do not modify the operator after the first creation.`;

function validateT13(snapshot: AgentSnapshot, _turn: AgentTurnResult): void {
  const wf = requireWorkflow(snapshot);
  const op = requireOperator(wf, T13_OP_ID);
  assertEqual(op.operatorType, "DataLoading", `T13: ${T13_OP_ID} operator type`);

  const info = requireResult(snapshot, T13_OP_ID);
  assertEqual(rowsOf(info).length, T13_EXPECTED_ROW_COUNT, `T13: ${T13_OP_ID} row count`);
  const cols = columnsOf(info).sort();
  assertEqual(cols, ["strategy", "uniques"], `T13: ${T13_OP_ID} column set`);
}

/* ============================================================================
 *  T14 — LIST column survives the iceberg storage write path.
 *
 *  Exercises the third engine-side bug observed in a real agent trace:
 *  ``amber_schema_to_iceberg_schema`` crashed with
 *  ``KeyError: <AttributeType.LIST: 9>`` because
 *  ``_AMBER_TO_ICEBERG_TYPE_MAPPING`` had no entry for LIST (or STRUCT).
 *  The crash fired OUTSIDE user code in OutputManager's
 *  ``recreate_port_storage_writer``, so the operator looked like it
 *  completed but no rows reached the downstream port-storage writer.
 *
 *  The fix adds LIST/STRUCT → StringType() to the mapping (consistent
 *  with TO_ARROW_MAPPING which already collapses both to ``pa.string()``
 *  for the network transport), and JSON-encodes container cells in
 *  ``amber_tuples_to_arrow_table`` so they survive the now-StringType
 *  iceberg column without an ArrowTypeError on write.
 *
 *  This spec ships a UDF returning raw list cells verbatim — no
 *  agent-side conversion. Only the engine fix can carry it.
 * ========================================================================= */

const T14_OP_ID = "listIcebergWrite";
const T14_EXPECTED_ROW_COUNT = 3;

const T14_PROMPT = `Build a workflow with EXACTLY ONE DataLoading operator (operatorId: "${T14_OP_ID}").

Use this code body CHARACTER-FOR-CHARACTER — do not normalize, refactor, or "improve" it. Do not stringify, explode, or convert the list cells. The point of the test is precisely that raw Python list cells survive end-to-end through the engine's iceberg-storage write path:

\`\`\`python
def load() -> pd.DataFrame:
    import pandas as pd
    return pd.DataFrame({
        "strategy": ["alpha", "beta", "gamma"],
        "uniques": [
            ["Full Suppression", "Other"],
            ["Other"],
            ["Full Suppression", "Other"],
        ],
    })
\`\`\`

After the operator is created, end the task with the final answer "done". Do not modify the operator after the first creation.`;

function validateT14(snapshot: AgentSnapshot, _turn: AgentTurnResult): void {
  const wf = requireWorkflow(snapshot);
  const op = requireOperator(wf, T14_OP_ID);
  assertEqual(op.operatorType, "DataLoading", `T14: ${T14_OP_ID} operator type`);

  const info = requireResult(snapshot, T14_OP_ID);
  assertEqual(rowsOf(info).length, T14_EXPECTED_ROW_COUNT, `T14: ${T14_OP_ID} row count`);
  const cols = columnsOf(info).sort();
  assertEqual(cols, ["strategy", "uniques"], `T14: ${T14_OP_ID} column set`);
}

/* ============================================================================
 *  T15 — STRUCT column survives the full engine pipeline.
 *
 *  Companion to T14 (LIST column). Schema inference must type a dict-cell
 *  column as AttributeType.STRUCT; the iceberg storage mapping must carry
 *  STRUCT → StringType (added in the same fix as LIST); the per-cell
 *  encoder in `amber_tuples_to_arrow_table` must JSON-encode dict cells;
 *  `_compute_column_stats` must type the column as ``(struct)`` and emit
 *  ONLY `null=N` — no items_min/max/mean (those exist for LIST only),
 *  no top_N, no distinct.
 *
 *  This is the third "engine-side" spec (T12 datetime.date, T13 ndarray
 *  stats, T14 list iceberg) — the agent's code is verbatim with raw dict
 *  cells, no Python-side conversion, so the engine fixes alone carry it.
 * ========================================================================= */

const T15_OP_ID = "structIcebergWrite";
const T15_EXPECTED_ROW_COUNT = 3;

const T15_PROMPT = `Build a workflow with EXACTLY ONE DataLoading operator (operatorId: "${T15_OP_ID}").

Use this code body CHARACTER-FOR-CHARACTER — do not normalize, refactor, or "improve" it. Do not stringify, explode, normalize, or convert the dict cells. The point of the test is precisely that raw Python dict cells survive end-to-end through the engine's iceberg-storage write path and the column-stats publish path:

\`\`\`python
def load() -> pd.DataFrame:
    import pandas as pd
    return pd.DataFrame({
        "label": ["alpha", "beta", "gamma"],
        "meta":  [
            {"k": 1, "v": "x"},
            {"k": 2, "v": "y", "extra": True},
            {"k": 3},
        ],
    })
\`\`\`

After the operator is created, end the task with the final answer "done". Do not modify the operator after the first creation.`;

function validateT15(snapshot: AgentSnapshot, _turn: AgentTurnResult): void {
  const wf = requireWorkflow(snapshot);
  const op = requireOperator(wf, T15_OP_ID);
  assertEqual(op.operatorType, "DataLoading", `T15: ${T15_OP_ID} operator type`);

  const info = requireResult(snapshot, T15_OP_ID);
  assertEqual(rowsOf(info).length, T15_EXPECTED_ROW_COUNT, `T15: ${T15_OP_ID} row count`);
  const cols = columnsOf(info).sort();
  assertEqual(cols, ["label", "meta"], `T15: ${T15_OP_ID} column set`);

  // Cell shape: STRUCT cells must render to the wire as JSON object
  // literals (e.g. `{"k": 1, "v": "x"}`). We verify by JSON-parsing the
  // cell back and confirming the structure round-trips — this catches
  // both a missing JSON encode (would be `"{'k': 1, ...}"` from str())
  // and a transport regression that loses the JSON-string form.
  const rows = rowsOf(info);
  for (const row of rows) {
    const cell = row.meta;
    if (typeof cell !== "string") {
      throw new SpecAssertionError(
        `T15: meta cell expected string (JSON-encoded), got ${typeof cell}: ${JSON.stringify(cell)}`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(cell);
    } catch (err) {
      throw new SpecAssertionError(`T15: meta cell is not valid JSON: ${cell} (${err})`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SpecAssertionError(
        `T15: meta cell decoded to non-object: ${JSON.stringify(parsed)}`
      );
    }
    const obj = parsed as Record<string, unknown>;
    if (!("k" in obj)) {
      throw new SpecAssertionError(`T15: meta cell missing 'k' key: ${JSON.stringify(obj)}`);
    }
  }

  // Column-stats shape: STRUCT column must report `(struct):` with ONLY
  // `null=N`. Crucially: no items_min/max/mean (those live in the LIST
  // branch), no top_N, no distinct. This is the load-bearing assertion
  // for the "STRUCT stats are minimal" contract the engine just adopted.
  const stats = info.columnStats ?? {};
  const metaStats = stats.meta;
  if (!metaStats) {
    throw new SpecAssertionError(`T15: meta column has no columnStats entry. Saw: ${JSON.stringify(stats)}`);
  }
  if (!metaStats.startsWith("(struct):")) {
    throw new SpecAssertionError(
      `T15: meta columnStats expected to start with "(struct):", got: ${metaStats}`
    );
  }
  if (!metaStats.includes("null=0")) {
    throw new SpecAssertionError(`T15: meta columnStats missing null=0: ${metaStats}`);
  }
  for (const forbidden of ["items_min=", "items_max=", "items_mean=", "top_5={", "top_10={", "distinct="]) {
    if (metaStats.includes(forbidden)) {
      throw new SpecAssertionError(
        `T15: meta columnStats unexpectedly carries '${forbidden}' — STRUCT stats must be minimal. Got: ${metaStats}`
      );
    }
  }
}

/* ============================================================================
 *  T16 — shapely.Polygon column surfaces the Python type, not engine bytes.
 *
 *  Pins the agent-facing rendering for a BINARY column whose cells are
 *  pickled Python objects:
 *    cell:    <shapely.geometry.polygon.Polygon, size = N bytes>
 *    stats:   (binary): null=0, type=shapely.geometry.polygon.Polygon,
 *             size_min=…, size_max=…, size_mean=…
 *
 *  Both ends are engine-side: the Python side embeds the class name in
 *  the bytes payload (`pyobj@1\n` marker), and the Scala renderer reads
 *  that header back. The agent never sees "pickle" terminology — that's
 *  internal engine plumbing.
 *
 *  Verbatim code so the agent doesn't paper over the engine path.
 * ========================================================================= */

const T16_OP_ID = "polygonBinaryCol";
const T16_EXPECTED_ROW_COUNT = 3;

const T16_PROMPT = `Build a workflow with EXACTLY ONE DataLoading operator (operatorId: "${T16_OP_ID}").

Use this code body CHARACTER-FOR-CHARACTER — do not normalize, refactor, simplify, or replace shapely with anything else. The point of the test is precisely that real shapely Polygon objects survive end-to-end and surface to the user as their Python type:

\`\`\`python
def load() -> pd.DataFrame:
    import pandas as pd
    import geopandas as gpd
    from shapely.geometry import Polygon
    gdf = gpd.GeoDataFrame(
        {"state": ["AL", "AK", "AZ"]},
        geometry=[
            Polygon([(0, 0), (1, 0), (1, 1), (0, 1)]),
            Polygon([(0, 0), (2, 0), (2, 2), (0, 2)]),
            Polygon([(0, 0), (3, 0), (3, 3), (0, 3)]),
        ],
        crs="EPSG:4326",
    )
    return pd.DataFrame(gdf)
\`\`\`

After the operator is created, end with "done". Do not modify it after creation.`;

function validateT16(snapshot: AgentSnapshot, _turn: AgentTurnResult): void {
  const wf = requireWorkflow(snapshot);
  const op = requireOperator(wf, T16_OP_ID);
  assertEqual(op.operatorType, "DataLoading", `T16: ${T16_OP_ID} operator type`);

  const info = requireResult(snapshot, T16_OP_ID);
  assertEqual(rowsOf(info).length, T16_EXPECTED_ROW_COUNT, `T16: ${T16_OP_ID} row count`);
  const cols = columnsOf(info).sort();
  assertEqual(cols, ["geometry", "state"], `T16: ${T16_OP_ID} column set`);

  // Per-cell shape: every `geometry` cell renders as
  // ``<shapely.geometry.polygon.Polygon, size = N bytes>``. This pins
  // the new Scala renderer's pyobj@1 path AND confirms no "pickle"
  // terminology leaks to the agent.
  const rows = rowsOf(info);
  const classNameNeedle = "shapely.geometry.polygon.Polygon";
  for (const row of rows) {
    const cell = String(row.geometry ?? "");
    if (!cell.startsWith(`<${classNameNeedle}, size = `)) {
      throw new SpecAssertionError(
        `T16: geometry cell expected to start with "<${classNameNeedle}, size = ", got: ${cell}`
      );
    }
    if (!cell.endsWith(" bytes>")) {
      throw new SpecAssertionError(`T16: geometry cell expected to end with " bytes>", got: ${cell}`);
    }
    if (cell.toLowerCase().includes("pickle") || cell.toLowerCase().includes("pyobj")) {
      throw new SpecAssertionError(
        `T16: agent-facing cell rendering must not contain engine-internal terms; got: ${cell}`
      );
    }
  }

  // Column-stats shape: `(binary): null=0, type=shapely…`.
  //
  // Stats run on the raw DataFrame BEFORE cast_to_schema turns the
  // Polygon cells into pickled bytes, so the size_min/max/mean fields
  // (which the bytes-branch emits) are intentionally absent here — we
  // don't pickle every cell just for stats (too expensive on wide
  // columns), and the per-cell rendering already carries the size.
  // What we DO assert: the type label is (binary), the Python class is
  // surfaced, and no engine-internal terminology leaks through.
  const stats = info.columnStats ?? {};
  const geomStats = stats.geometry;
  if (!geomStats) {
    throw new SpecAssertionError(`T16: geometry has no columnStats entry. Saw: ${JSON.stringify(stats)}`);
  }
  if (!geomStats.startsWith("(binary):")) {
    throw new SpecAssertionError(`T16: geometry stats must start with "(binary):", got: ${geomStats}`);
  }
  if (!geomStats.includes(`type=${classNameNeedle}`)) {
    throw new SpecAssertionError(`T16: geometry stats missing "type=${classNameNeedle}": ${geomStats}`);
  }
  if (!geomStats.includes("null=0")) {
    throw new SpecAssertionError(`T16: geometry stats missing null=0: ${geomStats}`);
  }
  // Decorations from the str/list branches must not leak into binary.
  for (const forbidden of ["top_5=", "top_10=", "distinct=", "items_min=", "items_max=", "items_mean="]) {
    if (geomStats.includes(forbidden)) {
      throw new SpecAssertionError(`T16: geometry stats unexpectedly carries '${forbidden}': ${geomStats}`);
    }
  }
  if (geomStats.toLowerCase().includes("pickle") || geomStats.toLowerCase().includes("pyobj")) {
    throw new SpecAssertionError(`T16: stats must not contain engine-internal terms; got: ${geomStats}`);
  }
}

/* ============================================================================
 *  An empty workflow to start each spec from. Each spec gets its own fresh
 *  workflow via createWorkflow so the agent starts with a clean slate.
 * ========================================================================= */

export const EMPTY_WORKFLOW: WorkflowContent = {
  operators: [],
  operatorPositions: {},
  links: [],
  commentBoxes: [] as CommentBox[],
  settings: { dataTransferBatchSize: 400 },
};

export const AGENT_DRIVEN_SPECS: AgentDrivenSpec[] = [
  {
    name: "[AgentDriven] T1 single DataLoading",
    description:
      "Agent creates a single DataLoading operator from a directive prompt. Validator asserts " +
      "the op exists, has 0/1 ports, and emits the exact 5-row DataFrame requested.",
    prompt: T1_PROMPT,
    validate: validateT1,
  },
  {
    name: "[AgentDriven] T2 single-input chain",
    description:
      "Agent creates one DataLoading + one DataProcessing(1-in) wired in a chain. Validator " +
      "asserts both ops, the link, and that the processor's output is the per-row x*2 derivation.",
    prompt: T2_PROMPT,
    validate: validateT2,
  },
  {
    name: "[AgentDriven] T3 three-input merge with port mapping",
    description:
      "Agent creates 3 DataLoading sources and one DataProcessing(3-in) merge. Validator asserts " +
      "the link wiring (alphaSrc→port0, betaSrc→port1, gammaSrc→port2) AND that the merger's per-port " +
      "sentinel readings prove the documented port→parameter mapping.",
    prompt: T3_PROMPT,
    validate: validateT3,
  },
  {
    name: "[AgentDriven] T4 parallel independent ops, one failing → subDAG partition",
    description:
      "Agent emits two independent DataLoading ops as parallel tool calls in one batch; one of them " +
      "intentionally reads a non-existent file. Validator asserts the good op's result is preserved " +
      "alongside the bad op's [ERROR] block — which can only happen when agent-service-level " +
      "subDAG partitioning splits the batch into separate sync executions (without it, Amber's " +
      "AllForOneStrategy supervisor would kill the good op's worker too).",
    prompt: T4_PROMPT,
    validate: validateT4,
  },
  {
    name: "[AgentDriven] T5 Windows-1252 CSV — encoding fallback principle",
    description:
      "Agent loads a CSV whose bytes are cp1252 / Latin-1 (smart quotes, en-dash, non-breaking space). " +
      "Plain pd.read_csv(path) raises UnicodeDecodeError; the load only succeeds if the agent retries " +
      "with encoding='latin-1' (or 'cp1252') per the prompt's encoding-fallback principle. The fixture " +
      "is written to /tmp by the spec's setup hook before the agent runs.",
    prompt: T5_PROMPT,
    setup: setupT5,
    validate: validateT5,
  },
  {
    name: "[AgentDriven] T6 datetime.date column — marshaller boundary",
    description:
      "Agent builds a DataFrame whose source column is Python datetime.date. The Texera marshaller " +
      "rejects raw datetime.date with `Unmatched type for field ..., expected AttributeType.TIMESTAMP`. " +
      "Spec succeeds only if the agent converts to pd.Timestamp via pd.to_datetime(...) before return, " +
      "per the prompt's marshaller-safe-types principle.",
    prompt: T6_PROMPT,
    validate: validateT6,
  },
  {
    name: "[AgentDriven] T7 list-valued column — marshaller boundary",
    description:
      "Agent receives source data with one column whose cells are Python lists. The marshaller " +
      "crashes with `KeyError: <AttributeType.LIST: 9>` if list cells reach the wire. Validator " +
      "checks every cell is scalar AND that all original tag values are recoverable — admits explode " +
      "/ split / stringify workarounds equally.",
    prompt: T7_PROMPT,
    validate: validateT7,
  },
  {
    name: "[AgentDriven] T8 tz-naive → tz-aware — pandas pitfalls",
    description:
      "Agent builds a tz-naive datetime column and must then attach UTC. Using `.astype('datetime64[ns, UTC]')` " +
      "on a naive column raises TypeError; the right path is `.dt.tz_localize('UTC')`. Spec passes when the " +
      "operator returns a non-empty result (proves the agent did not crash on the wrong API).",
    prompt: T8_PROMPT,
    validate: validateT8,
  },
  {
    name: "[AgentDriven] T9 numpy.ndarray cell — marshaller boundary",
    description:
      "Agent receives source data with one column whose cells are numpy.ndarray. The marshaller " +
      "crashes with `TypeError: unhashable type: 'numpy.ndarray'` outside user code if ndarray cells " +
      "reach the wire. Validator checks every cell is scalar AND that all original float values are " +
      "recoverable — admits explode / split / stringify workarounds equally.",
    prompt: T9_PROMPT,
    validate: validateT9,
  },
  {
    name: "[AgentDriven] T10 pd.NA truthiness — pandas pitfalls",
    description:
      "Agent must derive a status column from a pd.NA-bearing Int64 source. A naive `if value: ...` " +
      "or `bool(value)` per-row check raises `TypeError: boolean value of NA is ambiguous`. The fix is " +
      "to route the check through pd.isna(...) / .isna() / .notna(). Spec passes when the operator " +
      "completes and the status distribution is 2 missing + 2 present.",
    prompt: T10_PROMPT,
    validate: validateT10,
  },
  {
    name: "[AgentDriven] T11 lossy int cast with NaN — pandas pitfalls",
    description:
      "Agent must cast a float64 column containing NaN to an integer-typed column. A naive `.astype(int)` " +
      "raises IntCastingNaNError. The fix is either pandas' nullable `Int64` dtype or a fillna()-then-cast. " +
      "Validator checks the operator returned all 5 rows AND that the non-null integer values are 10/30/50.",
    prompt: T11_PROMPT,
    validate: validateT11,
  },
  {
    name: "[AgentDriven] T12 raw datetime.date survives marshaller — engine-side fix",
    description:
      "Agent ships a code body verbatim that returns datetime.date cells without pd.to_datetime " +
      "conversion. T6 is prompt-driven (agent converts) — T12 is engine-driven (marshaller " +
      "coerces date → datetime in coerce_value_to_type). If a future change regresses the marshaller, " +
      "this fails even when T6 still passes.",
    prompt: T12_PROMPT,
    validate: validateT12,
  },
  {
    name: "[AgentDriven] T13 ndarray cells survive column-stats publish — engine-side fix",
    description:
      "Agent ships a code body verbatim that returns numpy.ndarray cells in an object column. " +
      "Pre-fix this crashed _compute_column_stats with `TypeError: unhashable type: 'numpy.ndarray'` " +
      "outside user code, torpedoing the entire stats-publishing chain. After the fix, the str-branch " +
      "of _compute_column_stats stringifies before nunique() so unhashable cells render usable stats.",
    prompt: T13_PROMPT,
    validate: validateT13,
  },
  {
    name: "[AgentDriven] T14 LIST column survives iceberg storage write — engine-side fix",
    description:
      "Agent ships a code body verbatim returning raw Python list cells. Pre-fix this crashed " +
      "amber_schema_to_iceberg_schema with `KeyError: <AttributeType.LIST: 9>` outside user code " +
      "in the OutputManager's port-storage-writer path. After the fix, _AMBER_TO_ICEBERG_TYPE_MAPPING " +
      "maps LIST and STRUCT to StringType and the per-cell encoder JSON-serializes container cells.",
    prompt: T14_PROMPT,
    validate: validateT14,
  },
  {
    name: "[AgentDriven] T15 STRUCT column survives engine — type label + stats + cell shape",
    description:
      "Agent ships a code body verbatim returning raw Python dict cells. Engine-side this exercises: " +
      "(a) AttributeType.STRUCT schema-inference for dict-cell object columns; (b) STRUCT → StringType " +
      "iceberg mapping; (c) per-cell JSON encoder for dict cells; (d) `(struct):` column-stats branch " +
      "emitting ONLY `null=N` (no items_*, no top_N, no distinct). Validator asserts cell JSON-decodes " +
      "to an object AND that the stats line carries none of the LIST/str-branch decorations.",
    prompt: T15_PROMPT,
    validate: validateT15,
  },
  {
    name: "[AgentDriven] T16 shapely Polygon column — Python type surfaces to agent",
    description:
      "Agent ships a real geopandas GeoDataFrame with shapely Polygon cells. Engine-side: cast_to_schema " +
      "writes `pyobj@1\\n<class>\\n<pickle>` bytes (new format); Scala renderer reads the class header " +
      "and renders `<shapely.geometry.polygon.Polygon, size = N bytes>`; _compute_column_stats reports " +
      "`(binary): null=0, type=…, size_min/max/mean=…`. Validator asserts both shapes AND that no " +
      "engine-internal terminology (pickle, pyobj) leaks to the agent-facing strings.",
    prompt: T16_PROMPT,
    validate: validateT16,
  },
];
