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
import type { OperatorInfo } from "../../src/types/execution";
import type { AgentSnapshot, AgentTurnResult } from "../../src/api/agent-service-api";

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

function requireResult(snapshot: AgentSnapshot, opId: string): OperatorInfo {
  const info = (snapshot.results as Record<string, OperatorInfo>)[opId];
  if (!info) throw new SpecAssertionError(`operator '${opId}' has no execution result in the head snapshot`);
  if (info.error) {
    throw new SpecAssertionError(`operator '${opId}' executed with error: ${info.error.split("\n")[0]}`);
  }
  if (!info.result || info.result.length === 0) {
    throw new SpecAssertionError(
      `operator '${opId}' executed but emitted no rows (totalRowCount=${info.totalRowCount ?? 0})`
    );
  }
  return info;
}

function rowsOf(info: OperatorInfo): Record<string, unknown>[] {
  return (info.result ?? []) as Record<string, unknown>[];
}

function columnsOf(info: OperatorInfo): string[] {
  if (!info.result || info.result.length === 0) return [];
  return Object.keys(info.result[0]).filter(k => k !== "__row_index__");
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

Both operators MUST be emitted as parallel tool calls in the same assistant turn. Do not chain them. After both tool results come back, output the final answer "done".`;

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
  const badInfo = (snapshot.results as Record<string, OperatorInfo>)[T4_BAD_OP_ID];
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
];
