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
 * Test-only fixtures for the summarize() refactor.
 *
 * `buildRichScenario()` constructs a deterministic, render-path-complete agent
 * trajectory used by the characterization (golden) tests: every serializer
 * branch the LATEST / DELTA assemblers can take is exercised at least once —
 * Properties lines, code-op stripping, error blocks with `Operator code:`,
 * column stats (incl. reserved diagnostic keys), print output, multi-call
 * events, deletes, rejected/no-op edits, blocked downstream operators, a
 * second user task, and a thought-only terminal step.
 *
 * The scenario is frozen: any change to it invalidates the golden snapshots,
 * so extend by ADDING scenarios, not editing this one.
 */

import { WorkflowSnapshotStorage } from "../../workflow-snapshot-storage";
import { WorkflowState } from "../../workflow-state";
import type { ReActStep } from "../../../types/agent";
import type { OperatorInfo } from "../../../types/execution";
import type { OperatorPredicate, PortDescription, WorkflowContent } from "../../../types/workflow";

export interface OpSpec {
  id: string;
  type?: string;
  properties?: Record<string, any>;
  numInputPorts?: number;
  displayName?: string;
}

export function makeOp(spec: OpSpec): OperatorPredicate {
  const numIn = spec.numInputPorts ?? 0;
  const inputPorts: PortDescription[] = Array.from({ length: numIn }, (_, i) => ({
    portID: `input-${i}`,
    displayName: `Input ${i}`,
    disallowMultiInputs: true,
    isDynamicPort: i > 0,
  }));
  return {
    operatorID: spec.id,
    operatorType: spec.type ?? "TestOp",
    operatorVersion: "1",
    operatorProperties: spec.properties ?? {},
    inputPorts,
    outputPorts: [{ portID: "output-0", displayName: "Output" }],
    showAdvanced: false,
    isDisabled: false,
    customDisplayName: spec.displayName ?? spec.id,
  } as OperatorPredicate;
}

export function makeWorkflow(ops: OpSpec[], links: Array<[string, string, number?]> = []): WorkflowContent {
  return {
    operators: ops.map(makeOp),
    operatorPositions: {},
    links: links.map(([s, t, port]) => ({
      linkID: `${s}-->${t}`,
      source: { operatorID: s, portID: "output-0" },
      target: { operatorID: t, portID: `input-${port ?? 0}` },
    })),
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  };
}

export function makeStep(overrides: Partial<ReActStep> & Pick<ReActStep, "id" | "stepId" | "role">): ReActStep {
  return {
    messageId: "msg-default",
    parentId: undefined,
    timestamp: 1,
    content: "",
    isBegin: true,
    isEnd: true,
    ...overrides,
  };
}

export interface Scenario {
  steps: ReActStep[];
  storage: WorkflowSnapshotStorage;
  workflowState: WorkflowState;
}

/** Mirror of TexeraAgent.getAncestorPath over the fixture's step list. */
export function buildScenario(
  stepsInput: Array<Partial<ReActStep> & Pick<ReActStep, "id" | "stepId" | "role">>
): Scenario {
  const steps = stepsInput.map(s => makeStep(s));
  const byId = new Map(steps.map(s => [s.id, s]));
  const storage = new WorkflowSnapshotStorage(stepId => {
    const chain: string[] = [];
    let cur: string | undefined = stepId;
    while (cur) {
      chain.unshift(cur);
      cur = byId.get(cur)?.parentId;
    }
    return chain;
  });
  return { steps, storage, workflowState: new WorkflowState() };
}

/* ============================================================================
 *  The rich scenario
 * ========================================================================= */

const CODE_INSPECT = "def load():\n    return pd.read_csv('data/sales.csv', dtype=str, header=None, nrows=30)";
const CODE_SALES = "def load():\n    return pd.read_csv('data/sales.csv', skiprows=2)";
const CODE_ORPHAN = "def load():\n    return pd.read_csv('data/regions_lookup.csv')";
export const CODE_BY_REGION_V1 =
  "def process(sales):\n    return sales.groupby('region')['amount'].sum().reset_index()";
export const CODE_BY_REGION_V2 = "def process(sales)\n    return sales.groupby('region')['amount'].sum().reset_index()";
export const CODE_BY_REGION_V3 =
  "def process(sales):\n    df = sales.copy()\n    return df.groupby('region')['amount'].sum().reset_index()";
const CODE_REPORT = "def process(by_region):\n    return by_region.sort_values('amount', ascending=False)";

function salesResultRows(): Record<string, any>[] {
  const mk = (i: number, region: string, amount: number, price: string, date: string) => ({
    __row_index__: i,
    region,
    amount,
    price_display: price,
    date,
  });
  return [
    mk(0, "West", 12.5, "$12.50", "2023-01-04"),
    mk(1, "East", 99.0, "$99.00", "2023-01-05"),
    mk(2, "North", 5.25, "$5.25", "2023-01-05"),
    mk(997, "South", 42.0, "$42.00", "2023-12-27"),
    mk(998, "West", 7.75, "$7.75", "2023-12-28"),
    mk(999, "East", 130.4, "$130.40", "2023-12-28"),
  ];
}

const SALES_COLUMN_STATS: Record<string, string> = {
  region: "(str): null=0, distinct=4, top_5={West=300, East=280, North=250, South=170}",
  amount: "(numeric): null=12, mean=52.3, min=0.5, max=999.9",
  price_display: "(str): null=0, distinct=890, format=currency",
  date: "(datetime): null=0, min=2023-01-04, max=2023-12-28",
  __table_hints__:
    "grain: one row per (order_id) || partition candidates: region (4 values) || dirty-load: 2 duplicate rows",
  __coercion_telemetry__:
    "to_numeric(errors='coerce') on `amount` NULLed 12/1000 values — sample: ['N/A', 'n.a.', '—']",
  __join_telemetry__:
    "Join check ⚠: 0.2% of `sales` keys matched `lookup` — near-zero key overlap; check join key columns and dtypes",
};

const BY_REGION_ERROR =
  "KeyError: 'region' at line 2 of your code\nTraceback (most recent call last):\n  File \"udf\", line 2, in process";

export function makeInfo(
  rows: number,
  extra: Partial<OperatorInfo> & { sampleRows?: Record<string, any>[] } = {}
): OperatorInfo {
  const { sampleRows, ...rest } = extra;
  return {
    state: rest.error ? "Failed" : "Completed",
    inputTuples: 0,
    outputTuples: rows,
    resultMode: "table",
    totalRowCount: rows,
    result: rest.error
      ? undefined
      : (sampleRows ?? Array.from({ length: Math.min(rows, 3) }, (_, i) => ({ id: i + 1, value: `v${i}` }))),
    ...rest,
  } as OperatorInfo;
}

/**
 * Trajectory (event indices after init exclusion):
 *   init — baseline: legacy_data (CSVFileScan, 5 rows)
 *   u1  (ev 1) user task
 *   a1  (ev 2) create inspect_sales (DataLoading)  → 30 rows + print output
 *   a2  (ev 3) create sales + orphan_load          → sales 1000 rows w/ stats; orphan 0 rows
 *   a3  (ev 4) create by_region + delete inspect_sales → by_region EXEC ERROR
 *   a4  (ev 5) modify by_region — REJECTED ([ERROR] tool result, no state change)
 *   a5  (ev 6) modify by_region (still exec error) + create report (blocked, no info)
 *   u2  (ev 7) second user message
 *   a6  (ev 8) thought-only terminal reply (isEnd)
 */
export function buildRichScenario(): Scenario {
  const sc = buildScenario([
    {
      id: "init",
      stepId: 0,
      role: "agent",
      messageId: "m-init",
      timestamp: 1000,
      content: "Initialization: loaded workflow and recorded a baseline of each operator's current result.",
      toolCalls: [{ toolName: "initialize", toolCallId: "tc-init", input: { workflowId: 7 } }],
      toolResults: [
        { toolCallId: "tc-init", output: "Initialization: state=Completed, operators=1, errors=0.", isError: false },
      ],
    },
    {
      id: "u1",
      stepId: 0,
      role: "user",
      messageId: "m1",
      parentId: "init",
      timestamp: 2000,
      content: "Load data/sales.csv and compute total revenue per region.",
    },
    {
      id: "a1",
      stepId: 1,
      role: "agent",
      messageId: "m1",
      parentId: "u1",
      timestamp: 3000,
      isBegin: true,
      isEnd: false,
      content: "Inspect the raw file first to find the real header row.",
      toolCalls: [
        {
          toolName: "createOrModifyOperator",
          toolCallId: "tc-a1",
          input: { operatorId: "inspect_sales", code: CODE_INSPECT, summary: "Inspect first 30 raw rows of sales.csv" },
        },
      ],
      toolResults: [
        {
          toolCallId: "tc-a1",
          output: "Added operator inspect_sales with 0 input port(s), 1 output port(s)",
          isError: false,
        },
      ],
    },
    {
      id: "a2",
      stepId: 2,
      role: "agent",
      messageId: "m1",
      parentId: "a1",
      timestamp: 4000,
      isBegin: false,
      isEnd: false,
      content: "Header is at row 2 — write the real loader; also stage the regions lookup.",
      toolCalls: [
        {
          toolName: "createOrModifyOperator",
          toolCallId: "tc-a2a",
          input: { operatorId: "sales", code: CODE_SALES, summary: "Load sales.csv skipping 2 preamble rows" },
        },
        {
          toolName: "createOrModifyOperator",
          toolCallId: "tc-a2b",
          input: { operatorId: "orphan_load", code: CODE_ORPHAN, summary: "Load regions_lookup.csv" },
        },
      ],
      toolResults: [
        { toolCallId: "tc-a2a", output: "Added operator sales with 0 input port(s), 1 output port(s)", isError: false },
        {
          toolCallId: "tc-a2b",
          output: "Added operator orphan_load with 0 input port(s), 1 output port(s)",
          isError: false,
        },
      ],
    },
    {
      id: "a3",
      stepId: 3,
      role: "agent",
      messageId: "m1",
      parentId: "a2",
      timestamp: 5000,
      isBegin: false,
      isEnd: false,
      content: "Aggregate revenue by region and drop the inspection scaffold.",
      toolCalls: [
        {
          toolName: "createOrModifyOperator",
          toolCallId: "tc-a3a",
          input: {
            operatorId: "by_region",
            code: CODE_BY_REGION_V1,
            summary: "From `sales`, sum `amount` by `region`",
          },
        },
        { toolName: "deleteOperator", toolCallId: "tc-a3b", input: { operatorId: "inspect_sales" } },
      ],
      toolResults: [
        {
          toolCallId: "tc-a3a",
          output: "Added operator by_region with 1 input port(s), 1 output port(s). Link created: sales-->by_region",
          isError: false,
        },
        { toolCallId: "tc-a3b", output: "Operator inspect_sales deleted", isError: false },
      ],
    },
    {
      id: "a4",
      stepId: 4,
      role: "agent",
      messageId: "m1",
      parentId: "a3",
      timestamp: 6000,
      isBegin: false,
      isEnd: false,
      content: "The groupby failed — fix the aggregation code.",
      toolCalls: [
        {
          toolName: "createOrModifyOperator",
          toolCallId: "tc-a4",
          input: {
            operatorId: "by_region",
            code: CODE_BY_REGION_V2,
            summary: "From `sales`, sum `amount` by `region`",
          },
        },
      ],
      toolResults: [
        { toolCallId: "tc-a4", output: "[ERROR] Python syntax error: Line 1: invalid syntax", isError: true },
      ],
    },
    {
      id: "a5",
      stepId: 5,
      role: "agent",
      messageId: "m1",
      parentId: "a4",
      timestamp: 7000,
      isBegin: false,
      isEnd: false,
      content: "Fix the syntax and add the sorted report downstream.",
      toolCalls: [
        {
          toolName: "createOrModifyOperator",
          toolCallId: "tc-a5a",
          input: {
            operatorId: "by_region",
            code: CODE_BY_REGION_V3,
            summary: "From `sales`, sum `amount` by `region`",
          },
        },
        {
          toolName: "createOrModifyOperator",
          toolCallId: "tc-a5b",
          input: { operatorId: "report", code: CODE_REPORT, summary: "From `by_region`, sort by `amount` desc" },
        },
      ],
      toolResults: [
        { toolCallId: "tc-a5a", output: "Operator by_region modified", isError: false },
        {
          toolCallId: "tc-a5b",
          output: "Added operator report with 1 input port(s), 1 output port(s). Link created: by_region-->report",
          isError: false,
        },
      ],
    },
    {
      id: "u2",
      stepId: 0,
      role: "user",
      messageId: "m2",
      parentId: "a5",
      timestamp: 8000,
      content: "Also, which region has the max revenue?",
    },
    {
      id: "a6",
      stepId: 1,
      role: "agent",
      messageId: "m2",
      parentId: "u2",
      timestamp: 9000,
      isBegin: true,
      isEnd: true,
      content: "by_region is still failing on the 'region' column — I need to fix that before answering.",
    },
  ]);

  const { storage, workflowState } = sc;

  // ── snapshots ─────────────────────────────────────────────────────────
  const legacy: OpSpec = {
    id: "legacy_data",
    type: "CSVFileScan",
    properties: { fileName: "legacy.csv", limit: 100 },
    displayName: "Scan legacy.csv",
  };
  const inspect: OpSpec = {
    id: "inspect_sales",
    type: "DataLoading",
    properties: { code: CODE_INSPECT },
    displayName: "Inspect first 30 raw rows of sales.csv",
  };
  const sales: OpSpec = {
    id: "sales",
    type: "DataLoading",
    properties: { code: CODE_SALES },
    displayName: "Load sales.csv skipping 2 preamble rows",
  };
  const orphan: OpSpec = {
    id: "orphan_load",
    type: "DataLoading",
    properties: { code: CODE_ORPHAN },
    displayName: "Load regions_lookup.csv",
  };
  const byRegion = (code: string): OpSpec => ({
    id: "by_region",
    type: "DataProcessing",
    properties: { code },
    numInputPorts: 1,
    displayName: "From `sales`, sum `amount` by `region`",
  });
  const report: OpSpec = {
    id: "report",
    type: "DataProcessing",
    properties: { code: CODE_REPORT },
    numInputPorts: 1,
    displayName: "From `by_region`, sort by `amount` desc",
  };

  storage.createSnapshot("init", makeWorkflow([legacy]));
  storage.setOperatorResult(
    "init",
    "legacy_data",
    makeInfo(5, {
      sampleRows: [
        { __row_index__: 0, id: 1, value: "alpha" },
        { __row_index__: 1, id: 2, value: "beta" },
        { __row_index__: 2, id: 3, value: "gamma" },
      ],
    })
  );

  storage.createSnapshot("a1", makeWorkflow([legacy, inspect]));
  storage.setOperatorResult(
    "a1",
    "inspect_sales",
    makeInfo(30, {
      sampleRows: [
        { __row_index__: 0, "0": "Sales Report FY2023", "1": "" },
        { __row_index__: 1, "0": "generated 2024-01-02", "1": "" },
        { __row_index__: 2, "0": "region", "1": "amount" },
      ],
      consoleLogs: [{ msgType: "PRINT", title: "header row at index 2", message: "" }],
    })
  );

  storage.createSnapshot("a2", makeWorkflow([legacy, inspect, sales, orphan]));
  storage.setOperatorResult(
    "a2",
    "sales",
    makeInfo(1000, { sampleRows: salesResultRows(), columnStats: SALES_COLUMN_STATS })
  );
  storage.setOperatorResult("a2", "orphan_load", makeInfo(0, { sampleRows: [] }));

  storage.createSnapshot(
    "a3",
    makeWorkflow([legacy, sales, orphan, byRegion(CODE_BY_REGION_V1)], [["sales", "by_region"]])
  );
  storage.setOperatorResult("a3", "by_region", makeInfo(0, { error: BY_REGION_ERROR }));

  // a4's edit was REJECTED (tool error) — the snapshot is identical to a3's
  // (createSnapshot still fires because the step is action-bearing).
  storage.createSnapshot(
    "a4",
    makeWorkflow([legacy, sales, orphan, byRegion(CODE_BY_REGION_V1)], [["sales", "by_region"]])
  );

  const leafWorkflow = makeWorkflow(
    [legacy, sales, orphan, byRegion(CODE_BY_REGION_V3), report],
    [
      ["sales", "by_region"],
      ["by_region", "report"],
    ]
  );
  storage.createSnapshot("a5", leafWorkflow);
  storage.setOperatorResult("a5", "by_region", makeInfo(0, { error: BY_REGION_ERROR }));
  // report: intentionally NO result — blocked by by_region's error.

  // The live buffer mirrors HEAD's workflow (as TexeraAgent maintains it).
  workflowState.setWorkflowContent(leafWorkflow);

  return sc;
}

export function contentOf(messages: Array<{ content: unknown }>): string {
  const first = messages[0];
  if (!first) return "";
  return typeof first.content === "string" ? first.content : JSON.stringify(first.content);
}
