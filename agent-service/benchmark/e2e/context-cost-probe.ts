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

/**
 * DELTA vs LATEST under the native V2 catalog: token volume AND cache-aware
 * cost, measured offline.
 *
 * Renders one realistic incremental dataflow-build trajectory at every step in
 * several (contextMode, messageLayout) framings, then models the provider
 * prefix cache the way this repo documents it: gpt-5.6-* credits a run of
 * LEADING messages that are byte-identical to some earlier request from the
 * same session (see context/summarize/native-frames.ts).
 *
 * No LLM call, no backend, no paid run. It answers "how many tokens does each
 * framing send, and how many of them are cache reads" — not "which framing
 * scores better", which needs the real campaign.
 *
 *   bun run benchmark/e2e/context-cost-probe.ts
 */

import { AgentMode, ContextMode, type ReActStep } from "../../src/types/agent";
import type { OperatorInfo } from "../../src/types/execution";
import { assembleContext, estimateTokens } from "../../src/agent/util/context-utils";
import { WorkflowSystemMetadata } from "../../src/agent/util/workflow-system-metadata";
import { WorkflowSnapshotStorage } from "../../src/agent/workflow-snapshot-storage";
import { WorkflowState } from "../../src/agent/workflow-state";
import { createNativeBatchTools } from "../../src/agent/tools/native-batch-tools";
import { prepareStructuredExecutionResult } from "../../src/agent/native/execution-transport";
import { workflowExecutionPlan } from "../../src/agent/native/result-versions";
import { buildNativeModeSystemPrompt } from "../../src/agent/prompts";
import type { ModelMessage } from "ai";

/** Frozen campaign rates (USD per million tokens), per the 2026-09-16 report. */
const RATE = { uncached: 2 / 1e6, cached: 0.2 / 1e6, output: 12 / 1e6 };
/** Output tokens per step, calibrated to the campaign: the Data+flow arm spent
 * 141,677 output tokens over 103 dispatched tasks = 1,376 per task. Identical
 * across framings, so it never moves a delta — but its MAGNITUDE decides how
 * much of the bill any input-side optimisation can possibly reach. */
const OUTPUT_TOKENS_PER_STEP = 125;

type Table = { rows: number; columns: string[] };

export function fixture() {
  const state = new WorkflowState();
  const metadata = new WorkflowSystemMetadata();
  metadata.seedCodeModeDefaults();
  const tools = createNativeBatchTools(
    state,
    { metadataStore: metadata, settings: { nativeProfileCollection: true } } as any,
    "v2"
  );
  const steps: ReActStep[] = [
    {
      id: "U0",
      messageId: "m",
      stepId: 0,
      timestamp: 0,
      role: "user",
      content:
        "Which Boston neighborhood has the highest mean assessed value per square foot in FY2026? Use the assessment extract and the zip-to-neighborhood lookup.",
      isBegin: true,
      isEnd: false,
    },
  ];
  const storage = new WorkflowSnapshotStorage(
    id => steps.slice(0, steps.findIndex(s => s.id === id) + 1).map(s => s.id),
    () => 17
  );

  const record = async (
    id: string,
    thought: string,
    operators: Record<string, unknown>[],
    observe: string[],
    rejected = false
  ) => {
    const input = { operators, observe };
    const output = await tools.dataflow.execute(input);
    steps.push({
      id,
      parentId: steps.at(-1)?.id,
      messageId: "m",
      stepId: steps.length + 1,
      timestamp: 1,
      role: "agent",
      content: thought,
      isBegin: false,
      isEnd: false,
      toolCalls: [{ toolName: "dataflow", toolCallId: id, input }],
      toolResults: [{ toolCallId: id, output }],
    });
    const bad = (output as any).operators?.filter((o: any) => o.status === "error");
    if (!!bad?.length !== rejected) throw new Error(`step ${id}: unexpected ${JSON.stringify(bad ?? [])}`);
    storage.createSnapshot(id, state.getWorkflowContent());
    return output;
  };

  /** Synthesize a version-bound worker profile so real evidence is selected. */
  const persist = (step: string, tables: Record<string, Table>, execution: string) => {
    const workflow = state.getWorkflowContent();
    const raw: Record<string, OperatorInfo> = {};
    for (const [id, table] of Object.entries(tables)) {
      const op = workflow.operators.find(o => o.operatorID === id)!;
      const v = op.nativeOp!;
      const inputs = v.inputs.map(
        up => tables[up]?.rows ?? storage.getOperatorResult(step, up)?.totalRowCount ?? 0
      );
      const scalar = (n: number) => ({ type: "int64", value: String(n) });
      const columns = Object.fromEntries(
        table.columns.map((name, i) => {
          const nulls = i % 3 === 1 ? Math.floor(table.rows / 20) : 0;
          const nonnull = table.rows - nulls;
          // Above the 256 bounded-dictionary limit the real accumulator
          // abandons exact distinct/frequency data. Model that, don't fake it.
          const cardinality = Math.max(1, Math.floor(table.rows / (i + 2)));
          const bounded = cardinality <= 256 && cardinality <= nonnull;
          const base = bounded ? Math.floor(nonnull / cardinality) : 0;
          const extra = bounded ? nonnull - base * cardinality : 0;
          const dictionary = bounded
            ? Array.from({ length: cardinality }, (_, k) => ({
                value: scalar(k * 7),
                count: base + (k < extra ? 1 : 0),
              }))
            : null;
          const top = dictionary?.slice(0, 8) ?? [];
          return [
            name,
            {
              type: "int64",
              rowsProcessed: table.rows,
              nullCount: nulls,
              nonnullCount: nonnull,
              nullRatio: table.rows ? nulls / table.rows : null,
              distinctCount: dictionary ? cardinality : null,
              uniquenessRatio: dictionary && nonnull ? cardinality / nonnull : null,
              min: nonnull ? scalar(0) : null,
              max: nonnull ? scalar(bounded ? (cardinality - 1) * 7 : cardinality * 7) : null,
              frequencies: dictionary
                ? {
                    values: top,
                    otherCount: nonnull - top.reduce((s, v) => s + v.count, 0),
                    truncated: cardinality > 8,
                  }
                : null,
              mergeValues: dictionary,
              omissions: [],
            },
          ];
        })
      );
      const profile = {
        protocol: "texera.table-profile",
        version: 1,
        workerId: "w",
        producerId: "a".repeat(32),
        operatorId: id,
        operatorRevision: v.revision,
        status: "available",
        coverage: { scope: "worker", complete: true, rowsProcessed: table.rows, yields: 1 },
        rowCount: table.rows,
        columnCount: table.columns.length,
        schema: table.columns.map(name => ({ name, type: "int64", dtype: "Int64" })),
        schemaComplete: true,
        columns,
        structure: { duplicateRows: 0, allNullRows: 0, allNullColumns: [] },
        native: {
          operatorType: v.type,
          inputOperators: v.inputs,
          inputRows: inputs,
          outputRows: table.rows,
          operations:
            v.type === "Filter"
              ? { keptRows: table.rows, rejectedRows: Math.max(0, inputs[0] - table.rows), nullPredicates: 0 }
              : v.type === "Aggregate"
                ? { groups: table.rows, minGroupSize: 1, maxGroupSize: Math.max(1, Math.ceil(inputs[0] / table.rows)) }
                : {},
        },
        algorithm: { name: "bounded-exact-v1", rowSelection: "prefix", distinctLimit: 256, rowDistinctLimit: 4096, topK: 8 },
        omissions: [],
        cost: { collectionMs: 0, cellsProcessed: table.rows * table.columns.length, payloadBytes: 0 },
      };
      raw[id] = {
        state: "Completed",
        inputTuples: inputs.reduce((a, b) => a + b, 0),
        outputTuples: table.rows,
        resultMode: "table",
        result: Array.from({ length: Math.min(3, table.rows) }, (_, r) =>
          Object.fromEntries(table.columns.map((c, i) => [c, r * 7 + i]))
        ),
        totalRowCount: table.rows,
        truncated: table.rows > 3,
        numWorkers: 1,
        resultSchema: table.columns.map(name => ({ name, type: "int64", encoding: "number-or-decimal-string" })),
        materialization: { outputPort: 0, executionId: execution, cached: false },
        resultMetadata: { w: JSON.stringify(profile) },
      };
    }
    const response = prepareStructuredExecutionResult(
      {
        success: true,
        state: "Completed",
        operators: raw,
        executionId: execution,
        capabilities: ["typed-scalar-v1", "schema-fields-only-v1"],
        inputMaterializations: Object.fromEntries(
          workflow.operators.map(op => [
            op.operatorID,
            raw[op.operatorID]?.materialization ?? storage.getOperatorResult(step, op.operatorID)?.materialization!,
          ])
        ),
      },
      17,
      workflowExecutionPlan(workflow)
    );
    for (const [id, info] of Object.entries(response.operators)) storage.setOperatorResult(step, id, info);
  };

  return { state, steps, storage, record, persist };
}

/* ---------------------------------------------------------------------------
 * One realistic KramaBench-shaped trajectory: build a join+aggregate answer
 * incrementally, with one mid-run repair. Ten dataflow steps.
 * ------------------------------------------------------------------------ */

export const TRAJECTORY: Array<{
  id: string;
  thought: string;
  operators: Record<string, unknown>[];
  observe: string[];
  tables: Record<string, Table>;
  /** A deliberately rejected edit: the DAG is unchanged and a diagnostic lands. */
  rejected?: boolean;
}> = [
  {
    id: "S1",
    thought: "Load the assessment extract and look at its shape before filtering.",
    operators: [{ op: "scan", id: "assess", files: "data/boston/fy2026-assessment.csv" }],
    observe: ["assess"],
    tables: { assess: { rows: 182_341, columns: ["pid", "year", "value", "land", "area", "zip"] } },
  },
  {
    id: "S2",
    thought: "Keep residential parcels with a positive assessed value.",
    operators: [
      {
        op: "filter",
        id: "residential",
        input: "assess",
        columns: ["value"],
        func: "def apply(row):\n    return row['value'] is not None and row['value'] > 0",
      },
    ],
    observe: ["residential"],
    tables: { residential: { rows: 171_004, columns: ["pid", "year", "value", "land", "area", "zip"] } },
  },
  {
    id: "S3",
    thought: "Derive a per-square-foot value so the comparison is area-normalized.",
    operators: [
      {
        op: "derive",
        id: "normalized",
        input: "residential",
        columns: [
          {
            as: "per_sqft",
            inputs: ["value", "area"],
            dtype: "float64",
            func: "def apply(row):\n    area = row['area']\n    if not area:\n        return None\n    return row['value'] / area",
          },
        ],
      },
    ],
    observe: ["normalized"],
    tables: { normalized: { rows: 171_004, columns: ["pid", "year", "value", "land", "area", "zip", "per_sqft"] } },
  },
  {
    id: "S4",
    thought: "Aggregate to one row per zip so I can rank neighborhoods.",
    operators: [
      {
        op: "aggregate",
        id: "by_zip",
        input: "normalized",
        groupBy: ["zip"],
        aggregations: [
          { fn: "mean", col: "per_sqft", as: "mean_per_sqft" },
          { fn: "count", as: "parcels" },
        ],
      },
    ],
    observe: ["by_zip"],
    tables: { by_zip: { rows: 34, columns: ["zip", "mean_per_sqft", "parcels"] } },
  },
  {
    id: "S5",
    thought: "Bring in the neighborhood lookup so the answer names districts, not zips.",
    operators: [{ op: "scan", id: "lookup", files: "data/boston/zip-neighborhood.csv" }],
    observe: ["lookup"],
    tables: { lookup: { rows: 41, columns: ["zip", "neighborhood"] } },
  },
  {
    id: "S6",
    thought: "Join the aggregate against the lookup on zip.",
    operators: [{ op: "join", id: "named", left: "by_zip", right: "lookup", type: "inner", on: ["zip"] }],
    observe: ["named"],
    tables: { named: { rows: 34, columns: ["zip", "mean_per_sqft", "parcels", "neighborhood"] } },
  },
  {
    id: "S7a",
    thought: "Drop tiny zips; they distort the ranking.",
    operators: [
      {
        op: "filter",
        id: "material",
        input: "named",
        columns: ["parcels"],
        // Missing colon: rejected at validation, so the DAG is unchanged.
        func: "def apply(row)\n    return row['parcels'] >= 50",
      },
    ],
    observe: [],
    tables: {},
    rejected: true,
  },
  {
    id: "S7",
    thought: "Repair the predicate syntax and resubmit.",
    operators: [
      {
        op: "filter",
        id: "material",
        input: "named",
        columns: ["parcels"],
        func: "def apply(row):\n    return row['parcels'] >= 50",
      },
    ],
    observe: ["material"],
    tables: { material: { rows: 29, columns: ["zip", "mean_per_sqft", "parcels", "neighborhood"] } },
  },
  {
    id: "S8",
    thought: "The earlier filter kept null-valued rows. Repair the predicate and re-run.",
    operators: [
      {
        op: "filter",
        id: "residential",
        input: "assess",
        columns: ["value", "land"],
        func: "def apply(row):\n    if row['value'] is None or row['land'] is None:\n        return False\n    return row['value'] > 0 and row['land'] > 0",
      },
    ],
    observe: ["residential"],
    tables: {
      residential: { rows: 168_220, columns: ["pid", "year", "value", "land", "area", "zip"] },
      normalized: { rows: 168_220, columns: ["pid", "year", "value", "land", "area", "zip", "per_sqft"] },
      by_zip: { rows: 34, columns: ["zip", "mean_per_sqft", "parcels"] },
      named: { rows: 34, columns: ["zip", "mean_per_sqft", "parcels", "neighborhood"] },
      material: { rows: 29, columns: ["zip", "mean_per_sqft", "parcels", "neighborhood"] },
    },
  },
  {
    id: "S9",
    thought: "Sort descending so the top neighborhood is first.",
    operators: [{ op: "sort", id: "ranked", input: "material", by: [{ col: "mean_per_sqft", desc: true }] }],
    observe: ["ranked"],
    tables: { ranked: { rows: 29, columns: ["zip", "mean_per_sqft", "parcels", "neighborhood"] } },
  },
  {
    id: "S10",
    thought: "Take the single top row as the answer.",
    operators: [{ op: "limit", id: "answer", input: "ranked", n: 1 }],
    observe: ["answer"],
    tables: { answer: { rows: 1, columns: ["zip", "mean_per_sqft", "parcels", "neighborhood"] } },
  },
];

/* ------------------------------------------------------------------------ */

const serialize = (m: ModelMessage): string =>
  typeof m.content === "string" ? `${m.role}:${m.content}` : `${m.role}:${JSON.stringify(m.content)}`;

/**
 * Longest run of leading messages byte-identical to SOME earlier request.
 * This is the documented gpt-5.6-* whole-message model, evaluated against
 * every prior step (a revert can re-hit an older entry), not just step k-1.
 */
function cachedPrefixTokens(current: ModelMessage[], history: string[][]): number {
  let best = 0;
  for (const prior of history) {
    let tokens = 0;
    for (let i = 0; i < current.length && i < prior.length; i++) {
      const text = serialize(current[i]);
      if (text !== prior[i]) break;
      tokens += estimateTokens(text);
    }
    best = Math.max(best, tokens);
  }
  return best;
}

interface Framing {
  label: string;
  mode: ContextMode;
  layout: "native" | "opSplit" | "opBlock" | "block";
  data: boolean;
  flow: boolean;
  /** LATEST-only `# Reasoning` re-injection. DEFAULT_AGENT_SETTINGS has it on. */
  thoughtReplay: boolean;
}

const FRAMINGS: Framing[] = [
  { label: "DELTA  / native  / none",           mode: ContextMode.DELTA,  layout: "native",  data: false, flow: false, thoughtReplay: false },
  { label: "DELTA  / native  / data",           mode: ContextMode.DELTA,  layout: "native",  data: true,  flow: false, thoughtReplay: false },
  { label: "DELTA  / native  / data+flow",      mode: ContextMode.DELTA,  layout: "native",  data: true,  flow: true,  thoughtReplay: false },
  { label: "LATEST / block   / data+flow",      mode: ContextMode.LATEST, layout: "block",   data: true,  flow: true,  thoughtReplay: false },
  { label: "LATEST / opSplit / none",           mode: ContextMode.LATEST, layout: "opSplit", data: false, flow: false, thoughtReplay: false },
  { label: "LATEST / opSplit / data",           mode: ContextMode.LATEST, layout: "opSplit", data: true,  flow: false, thoughtReplay: false },
  { label: "LATEST / opSplit / data+flow",      mode: ContextMode.LATEST, layout: "opSplit", data: true,  flow: true,  thoughtReplay: false },
  { label: "LATEST / opSplit / data+flow +TR",  mode: ContextMode.LATEST, layout: "opSplit", data: true,  flow: true,  thoughtReplay: true  },
  { label: "LATEST / opBlock / none",           mode: ContextMode.LATEST, layout: "opBlock", data: false, flow: false, thoughtReplay: false },
  { label: "LATEST / opBlock / data",           mode: ContextMode.LATEST, layout: "opBlock", data: true,  flow: false, thoughtReplay: false },
  { label: "LATEST / opBlock / data+flow",      mode: ContextMode.LATEST, layout: "opBlock", data: true,  flow: true,  thoughtReplay: false },
  { label: "LATEST / opBlock / data+flow +TR",  mode: ContextMode.LATEST, layout: "opBlock", data: true,  flow: true,  thoughtReplay: true  },
];

async function measure(framing: Framing) {
  const f = fixture();
  const history: string[][] = [];
  // The system prompt is constant within a run, so it is a cache READ on every
  // step after the first. Its size differs per mode (different layout section),
  // which is why it is measured rather than assumed equal.
  const system = estimateTokens(
    buildNativeModeSystemPrompt(framing.mode, false, "all", {
      batch: true,
      nativeCatalogVersion: "v2",
      messageLayout: framing.layout,
    })
  );
  let totalPrompt = 0;
  let totalCached = 0;
  const perStep: Array<{ prompt: number; cached: number; firstChanged: number; reason: string }> = [];

  for (const [i, step] of TRAJECTORY.entries()) {
    await f.record(step.id, step.thought, step.operators, step.observe, step.rejected);
    f.persist(step.id, step.tables, String(100 + i));
    f.storage.captureNativeObservations(step.id, step.observe, {
      data: framing.data,
      flow: framing.flow,
      maxChars: 2000,
    });
    const messages = assembleContext(f.steps, f.state, f.storage, framing.mode, {
      agentMode: AgentMode.NATIVE,
      messageLayout: framing.layout,
      dataEvidence: framing.data,
      flowEvidence: framing.flow,
      maxOperatorResultCharLimit: 2000,
      thoughtReplay: framing.thoughtReplay,
      thoughtReplayK: 10,
    });
    const rendered = messages.map(serialize);
    const prompt = system + rendered.reduce((n, text) => n + estimateTokens(text), 0);
    const cached = (history.length ? system : 0) + cachedPrefixTokens(messages, history);
    // Attribute the invalidation: which message first differs from last step,
    // and what that message is about. This is what a fix has to target.
    const prior = history.at(-1) ?? [];
    let firstChanged = 0;
    while (firstChanged < rendered.length && rendered[firstChanged] === prior[firstChanged]) firstChanged++;
    const changed = rendered[firstChanged] ?? "";
    const id = changed.match(/### \w+ operator `([^`]+)`/)?.[1];
    const reason = !prior.length
      ? "first step"
      : firstChanged >= prior.length
        ? "append only"
        : !id
          ? changed.slice(5, 40).split("\n")[0] || "head"
          : `${id}: ${
              /result not requested/.test(changed) !== /result not requested/.test(prior[firstChanged] ?? "")
                ? "observe churn"
                : "redefined"
            }`;
    history.push(rendered);
    totalPrompt += prompt;
    totalCached += cached;
    perStep.push({ prompt, cached, firstChanged, reason });
  }

  const uncached = totalPrompt - totalCached;
  const cost =
    uncached * RATE.uncached +
    totalCached * RATE.cached +
    OUTPUT_TOKENS_PER_STEP * TRAJECTORY.length * RATE.output;
  return { framing, totalPrompt, totalCached, uncached, cost, perStep };
}

export async function main() {
  const results = [];
  for (const framing of FRAMINGS) results.push(await measure(framing));

  console.log(`\nTrajectory: ${TRAJECTORY.length} steps, ${TRAJECTORY.at(-1)!.id} ends with 9 operators.`);
  console.log("Prompt tokens are the assembled context only (system prompt + tool schemas are a");
  console.log("shared constant across framings and always cached after step 1).\n");

  const pad = (s: string, n: number) => s.padEnd(n);
  const num = (n: number, w = 9) => n.toLocaleString("en-US").padStart(w);
  console.log(
    `${pad("Framing", 36)} ${pad("prompt tok", 11)} ${pad("cached", 10)} ${pad("uncached", 10)} ${pad("hit%", 7)} ${pad("cost", 10)}`
  );
  console.log("-".repeat(90));
  for (const r of results) {
    const hit = r.totalPrompt ? ((r.totalCached / r.totalPrompt) * 100).toFixed(1) + "%" : "-";
    console.log(
      `${pad(r.framing.label, 36)} ${num(r.totalPrompt, 11)} ${num(r.totalCached, 10)} ${num(r.uncached, 10)} ${pad(hit, 7)} ${("$" + r.cost.toFixed(6)).padStart(10)}`
    );
  }

  console.log("\nPer-step prompt tokens (context only):");
  console.log(`${pad("Framing", 36)} ${TRAJECTORY.map((_, i) => String(i + 1).padStart(6)).join("")}`);
  console.log("-".repeat(96));
  for (const r of results) {
    console.log(`${pad(r.framing.label, 36)} ${r.perStep.map(s => String(s.prompt).padStart(6)).join("")}`);
  }

  console.log("\nWhat invalidated the cache each step (first message that changed vs the step before):");
  console.log(`${pad("Framing", 32)} ${TRAJECTORY.map((_, i) => String(i + 1).padStart(16)).join("")}`);
  console.log("-".repeat(180));
  for (const r of results) {
    console.log(`${pad(r.framing.label, 32)} ${r.perStep.map(s => (s.reason.slice(0, 15)).padStart(16)).join("")}`);
  }

  console.log("\nPer-step CACHE-MISS tokens (what you actually pay $2/M for):");
  console.log(`${pad("Framing", 36)} ${TRAJECTORY.map((_, i) => String(i + 1).padStart(6)).join("")}`);
  console.log("-".repeat(96));
  for (const r of results) {
    console.log(
      `${pad(r.framing.label, 36)} ${r.perStep.map(s => String(s.prompt - s.cached).padStart(6)).join("")}`
    );
  }
  console.log();
}

if (import.meta.main) await main();
