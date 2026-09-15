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

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { NativeOpView } from "./catalog";
import { compileNativeOp } from "./codegen";
import { formatNativeFlowEvidence } from "./flow-evidence";
import { buildScenario, makeWorkflow, makeInfo } from "../context/summarize/fixtures";
import { assembleContext } from "../util/context-utils";
import { AgentMode, ContextMode } from "../../types/agent";

const localPython = new URL("../../../../.venv/bin/python", import.meta.url).pathname;
const python = process.env.UDF_PYTHON_PATH ?? (existsSync(localPython) ? localPython : "python3");

function run(view: NativeOpView, frames: unknown[][], enabled = true) {
  const code = compileNativeOp(view, { flowEvidence: enabled }).code;
  const script = [
    "import json, pandas as pd",
    `exec(${JSON.stringify(code)})`,
    `frames = json.loads(${JSON.stringify(JSON.stringify(frames))})`,
    `result = process(*[pd.DataFrame(f) for f in frames])`,
    "print('\\nRESULT:' + result.to_json(orient='records'))",
    "print('ATTRS:' + json.dumps(result.attrs))",
  ].join("\n");
  const p = Bun.spawnSync([python, "-c", script]);
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  const lines = p.stdout.toString().trim().split("\n");
  const attrs = JSON.parse(lines.find(l => l.startsWith("ATTRS:"))!.slice(6));
  return {
    rows: JSON.parse(lines.find(l => l.startsWith("RESULT:"))!.slice(7)),
    attrs,
    stdout: lines.filter(l => !l.startsWith("RESULT:") && !l.startsWith("ATTRS:")),
    facts: attrs.__native_flow_evidence__?.facts ?? [],
  };
}

describe("native flow evidence measured in generated code", () => {
  test("default compilation remains uninstrumented", () => {
    const view = {
      type: "Compute",
      inputs: ["source"],
      properties: { columns: { pass: "CASE WHEN reading < 100 THEN 1 ELSE 0 END" } },
    };
    const baseline = run(view, [[{ reading: 10 }, { reading: null }]], false);
    const measured = run(view, [[{ reading: 10 }, { reading: null }]]);
    expect(baseline.stdout).toEqual([]);
    expect(baseline.attrs.__native_flow_evidence__).toBeUndefined();
    expect(measured.attrs.__native_flow_evidence__.facts).toEqual(measured.facts);
    expect(measured.rows).toEqual(baseline.rows);
    expect(measured.facts.join("\n")).toContain('"reading" null → "pass" non-null: 1 row');
    expect(measured.facts.join("\n")).toContain('"pass":0');
    expect(measured.stdout).toEqual([]);
  });

  test("compute witnesses retain the input value when a column is replaced", () => {
    const view = {
      type: "Compute",
      inputs: ["source"],
      properties: { columns: { value: "TRY_CAST(value AS DOUBLE)" } },
    };
    const measured = run(view, [[{ value: "12" }, { value: "unknown" }, { value: null }]]);
    expect(measured.rows).toEqual(run(view, [[{ value: "12" }, { value: "unknown" }, { value: null }]], false).rows);
    expect(measured.facts.join("\n")).toContain('"value" non-null → "value" null: 1 row');
    expect(measured.facts.join("\n")).toContain("unknown");
    expect(Object.keys(measured.rows[0])).toEqual(["value"]);
  });

  test("private capture names cannot overwrite user columns or misalign windowed expressions", () => {
    const rows = [
      { raw: null, __native_flow_source_0: "keep" },
      { raw: 3, __native_flow_source_0: "also" },
    ];
    const view = {
      type: "Compute",
      inputs: ["source"],
      properties: { columns: { ordinal: "row_number() OVER (ORDER BY raw DESC)" } },
    };
    const measured = run(view, [rows]);
    expect(measured.rows.map((r: any) => r.__native_flow_source_0).sort()).toEqual(["also", "keep"]);
    expect(measured.facts.join("\n")).toContain('"input":{"raw":null},"output":{"ordinal":2}');
    expect(Object.keys(measured.rows[0]).sort()).toEqual(["__native_flow_source_0", "ordinal", "raw"]);
  });

  test("join measures matched input rows despite output fanout and null keys", () => {
    const view = { type: "Join", inputs: ["left", "right"], properties: { on: ["day"], type: "left" } };
    const frames = [
      [
        { day: "a", identity: "x" },
        { day: "a", identity: "y" },
        { day: "b", identity: "z" },
        { day: null, identity: "n" },
      ],
      [
        { day: "a", identity: "x" },
        { day: "a", identity: "w" },
        { day: null, identity: "m" },
      ],
    ];
    const measured = run(view, frames);
    expect(measured.rows).toEqual(run(view, frames, false).rows);
    expect(measured.rows).toHaveLength(6);
    expect(measured.facts.join("\n")).toContain("matched input rows: left 3/4, right 3/3");
    expect(measured.facts.join("\n")).toContain('"identity" disagrees');
  });

  test("aggregate discovers a rare joint-key collision invisible in marginal counts", () => {
    const frames = [
      [
        { label: "shared", community: 1, value: 2 },
        { label: "shared", community: 2, value: 3 },
        { label: "unique", community: 1, value: 4 },
      ],
    ];
    const view = {
      type: "Aggregate",
      inputs: ["source"],
      properties: { groupBy: ["label"], aggregations: [{ fn: "sum", col: "value", as: "total" }] },
    };
    const measured = run(view, frames);
    // GROUP BY does not promise output order across DuckDB connections.
    const ordered = (rows: any[]) => rows.toSorted((a, b) => a.label.localeCompare(b.label));
    expect(ordered(measured.rows)).toEqual(ordered(run(view, frames, false).rows));
    expect(measured.facts.join("\n")).toContain('multiple "community" values in 1/2 groups');
    expect(measured.facts.join("\n")).toContain("shared");
  });

  test("aggregate reports rare population partitions without prescribing an exclusion", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ age: 60 + i, excluded: "No" }));
    rows.push({ age: 63, excluded: "Yes" });
    const measured = run(
      { type: "Aggregate", inputs: ["source"], properties: { aggregations: [{ fn: "avg", col: "age" }] } },
      [rows]
    );
    expect(measured.facts.join("\n")).toContain("13 input rows");
    expect(measured.facts.join("\n")).toContain('"excluded"');
    expect(measured.facts.join("\n")).toContain('"Yes":1');
  });

  test("null grouping keys remain an explicit group in measured collisions", () => {
    const frames = [
      [
        { label: null, code: 1, amount: 2 },
        { label: null, code: 2, amount: 3 },
      ],
    ];
    const measured = run(
      {
        type: "Aggregate",
        inputs: ["source"],
        properties: { groupBy: ["label"], aggregations: [{ fn: "sum", col: "amount" }] },
      },
      frames
    );
    expect(measured.facts.join("\n")).toContain('multiple "code" values in 1/1 groups');
    expect(measured.facts.join("\n")).toContain('"key":{"label":null}');
  });
});

describe("flow evidence through context assembly", () => {
  function render(mode: ContextMode, enabled: boolean, join = false, metadata = true) {
    const s = buildScenario([
      {
        id: "init",
        stepId: 0,
        role: "agent",
        toolCalls: [{ toolName: "initialize", toolCallId: "init", input: {} }],
        toolResults: [{ toolCallId: "init", output: "ok" }],
      },
      { id: "user", parentId: "init", stepId: 0, role: "user", content: "analyze" },
      {
        id: "a1",
        parentId: "user",
        stepId: 1,
        role: "agent",
        toolCalls: [
          {
            toolName: "aggregate",
            toolCallId: "a",
            input: { id: "total", input: "source", aggregations: [{ fn: "count" }] },
          },
        ],
        toolResults: [{ toolCallId: "a", output: "added aggregate operator `total`" }],
      },
    ]);
    const baseWorkflow = makeWorkflow(
      [
        { id: "left", type: "DataLoading" },
        { id: "right", type: "DataLoading" },
        { id: "total", type: "DataProcessing", numInputPorts: 2 },
      ],
      [
        ["left", "total", 0],
        ["right", "total", 1],
      ]
    );
    const wf = {
      ...baseWorkflow,
      operators: baseWorkflow.operators.map(op => ({
        ...op,
        nativeOp: join
          ? { type: "Join", inputs: ["left", "right"], properties: { on: ["key"] } }
          : { type: "Aggregate", inputs: ["source"], properties: { aggregations: [{ fn: "count" }] } },
      })),
    };
    s.storage.createSnapshot("a1", wf);
    s.storage.setOperatorResult(
      "a1",
      "total",
      makeInfo(1, {
        sampleRows: [{ count: 13 }],
        inputPortShapes: [
          { portIndex: 0, rows: 3, columns: 1 },
          { portIndex: 1, rows: 3, columns: 1 },
        ],
        columnStats: {
          ...(metadata
            ? {
                __native_flow_evidence__: JSON.stringify({
                  version: 1,
                  facts: [
                    join
                      ? "Join keys; matched input rows: left 1/3, right 1/3; output 1 rows"
                      : "13 input rows; rare partition yes=1",
                  ],
                }),
              }
            : {}),
        },
      })
    );
    s.workflowState.setWorkflowContent(wf);
    return assembleContext(s.steps, s.workflowState, s.storage, mode, {
      agentMode: AgentMode.NATIVE,
      nativeFlowEvidence: enabled,
      dataLevel: 1,
      columnStats: false,
      resultSelection: "all",
    })
      .map(m => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
  }

  for (const mode of [ContextMode.LATEST, ContextMode.DELTA]) {
    test(`${mode}: only measured joins replace the unsupported legacy retention inference`, () => {
      expect(render(mode, true, true)).toContain("matched input rows");
      expect(render(mode, true, true)).not.toContain("Join retention:");
      expect(render(mode, false, true)).toContain("Join retention:");
      expect(render(mode, true, true, false)).toContain("Join retention:");
    });
    test(`${mode}: independently gated, rendered once, never a raw print envelope`, () => {
      const on = render(mode, true);
      const off = render(mode, false);
      expect(on.match(/rare partition yes=1/g)).toHaveLength(1);
      expect(on).toContain("Flow evidence (measured):");
      expect(on).not.toContain("__native_flow_evidence__");
      expect(on).not.toContain("Column Schema and stats");
      expect(off).not.toContain("rare partition");
      expect(off).not.toContain("__native_flow_evidence__");
    });
  }
});

describe("bounded telemetry rendering", () => {
  test("uses reserved result metadata when console logs are unavailable", () => {
    const info = {
      columnStats: { __native_flow_evidence__: JSON.stringify({ version: 1, facts: ["exact measured fact"] }) },
    } as any;
    expect(formatNativeFlowEvidence(info)).toContain("exact measured fact");
  });
  test("bounds the whole block and ignores malformed payloads", () => {
    const info = {
      columnStats: { __native_flow_evidence__: JSON.stringify({ version: 1, facts: ["new fact", "x".repeat(2000)] }) },
    } as any;
    const text = formatNativeFlowEvidence(info, 300)!;
    expect(text).toContain("new fact");
    expect(text.length).toBeLessThanOrEqual(300);
    expect(formatNativeFlowEvidence({ columnStats: { __native_flow_evidence__: "broken" } } as any)).toBeUndefined();
    expect(
      formatNativeFlowEvidence({ columnStats: { __native_flow_evidence__: "x".repeat(16001) } } as any)
    ).toBeUndefined();
  });
});
