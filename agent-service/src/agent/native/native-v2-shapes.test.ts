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

import { expect, test } from "bun:test";
import Ajv from "ajv";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createNativeBatchTools, nativeBatchSchema } from "../tools/native-batch-tools";
import { WorkflowState } from "../workflow-state";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { buildNativeModeSystemPrompt } from "../prompts";
import { ContextMode } from "../../types/agent";

function batch() {
  const state = new WorkflowState();
  const metadata = new WorkflowSystemMetadata();
  metadata.seedCodeModeDefaults();
  return { state, dataflow: createNativeBatchTools(state, { metadataStore: metadata }, "v2").dataflow };
}

const shapes = [
  { op: "pivot", id: "wide", input: "lagged", index: ["code", "tags"], columns: "variable", values: "previous" },
  {
    op: "window",
    id: "lagged",
    input: "long",
    partitionBy: ["code", "tags"],
    orderBy: [{ col: "variable" }],
    columns: [{ fn: "lag", col: "value", as: "previous" }],
  },
  { op: "unpivot", id: "long", input: "items", columns: ["y2024", "y2025"] },
  { op: "explode", id: "items", input: "parts", column: "tags", encoding: "json" },
  { op: "split", id: "parts", input: "source", column: "label", into: ["code", "description"], separator: ":" },
];
const source = (value: number) => ({
  op: "udf",
  id: "source",
  code: `def load():\n    import pandas as pd\n    return pd.DataFrame({'label': ['A:Alpha'], 'tags': ['[1,2]'], 'y2024': [${value}], 'y2025': [${value + 5}]})`,
});

function execute(state: WorkflowState, answer: string): any[] {
  const python = process.env.UDF_PYTHON_PATH ?? fileURLToPath(new URL("../../../../.venv/bin/python", import.meta.url));
  const run = spawnSync(
    python,
    [
      "-c",
      `
import json, sys
operators = json.load(sys.stdin)
pending = {op['operatorID']: op for op in operators}
results = {}
while pending:
    ready = [op for op in pending.values() if all(id in results for id in op['nativeOp']['inputs'])]
    assert ready, 'cycle or missing input'
    for op in ready:
        scope = {}
        exec(op['operatorProperties']['code'], scope)
        inputs = list(dict.fromkeys(op['nativeOp']['inputs']))
        results[op['operatorID']] = scope['process'](*[results[id] for id in inputs]) if inputs else scope['load']()
        del pending[op['operatorID']]
print(results[sys.argv[1]].to_json(orient='records'))
`,
      answer,
    ],
    { input: JSON.stringify(state.getAllOperators()), encoding: "utf8", timeout: 30_000 }
  );
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout);
}

test("shape schemas expose structured Python-free parameters and reject ambiguous forms", () => {
  const validate = new Ajv({ strict: false }).compile(nativeBatchSchema("v2"));
  for (const operator of shapes) expect(validate({ operators: [operator], observe: [] })).toBe(true);
  for (const operator of [
    { ...shapes[0], aggregate: "sum" },
    { ...shapes[0], index: ["code", "code"] },
    { ...shapes[1], orderBy: [] },
    { ...shapes[1], columns: [{ fn: "rolling_mean", col: "value", as: "mean" }] },
    { ...shapes[1], columns: [{ fn: "lag", col: "value", as: "prev", offset: 0 }] },
    { ...shapes[2], columns: [] },
    { ...shapes[3], encoding: "python" },
    { ...shapes[3], empty: "guess" },
    { ...shapes[4], separator: "" },
    { ...shapes[4], into: ["code"] },
    { ...shapes[4], into: ["code", "code"] },
    { ...shapes[4], regex: true },
  ])
    expect(validate({ operators: [operator] })).toBe(false);
});

test("all shape operators share batching, forward references and existing DAG revisions", async () => {
  const { state, dataflow } = batch();
  const first = await dataflow.execute({ operators: [...shapes, source(10)], observe: ["wide"] });
  expect(first.operators.map((o: any) => o.status)).toEqual(Array(6).fill("added"));
  expect(first.observe).toEqual(["wide"]);
  expect(execute(state, "wide")).toEqual([
    { code: "A", tags: 1, y2024: null, y2025: 10 },
    { code: "A", tags: 2, y2024: null, y2025: 10 },
  ]);
  const changed = await dataflow.execute({
    operators: [{ op: "project", id: "answer", input: "wide", keep: ["code", "tags", "y2025"] }, source(20)],
    observe: ["answer"],
  });
  expect(changed.operators.map((o: any) => o.status)).toEqual(["added", "modified"]);
  expect(execute(state, "answer")).toEqual([
    { code: "A", tags: 1, y2025: 20 },
    { code: "A", tags: 2, y2025: 20 },
  ]);
  expect(state.getAllLinks()).toHaveLength(6);
  for (const op of state.getAllOperators()) expect(op.operatorProperties.code).not.toContain("import duckdb");
});

test("invalid shape options fail before mutation, blocking only dependents with observe empty", async () => {
  const { state, dataflow } = batch();
  await dataflow.execute({ operators: [source(10)], observe: [] });
  const result = await dataflow.execute({
    operators: [
      {
        op: "window",
        id: "bad",
        input: "source",
        orderBy: [{ col: "label" }],
        columns: [{ fn: "rank", as: "r", offset: 1 }],
      },
      { op: "project", id: "blocked", input: "bad", keep: ["r"] },
      shapes[4],
    ],
    observe: [],
  });
  expect(result.operators.map((o: any) => o.status)).toEqual(["error", "blocked", "added"]);
  expect(result.operators[0].diagnostic).toMatchObject({
    code: "WINDOW_ARGUMENT",
    stage: "validate",
    field: "columns[0]",
  });
  expect(state.getOperator("bad")).toBeUndefined();
  expect(state.getOperator("parts")).toBeDefined();
});

test("shape prompt has validated batched examples and teaches their non-inferred semantics", () => {
  const prompt = buildNativeModeSystemPrompt(ContextMode.DELTA, false, "all", {
    batch: true,
    nativeCatalogVersion: "v2",
  });
  expect(prompt).toContain("restore input row order");
  expect(prompt).toContain("Aggregate first");
  expect(prompt).toContain("JSON-array strings");
  const validate = new Ajv({ strict: false }).compile(nativeBatchSchema("v2"));
  const kinds = new Set<string>();
  for (const block of prompt.matchAll(/```json\n([\s\S]*?)\n```/g)) {
    const args = JSON.parse(block[1]);
    expect(validate(args)).toBe(true);
    for (const operator of args.operators) kinds.add(operator.op);
  }
  for (const operator of shapes) expect(kinds.has(operator.op)).toBe(true);
});

test("both new prompt examples execute as written through generated Python", async () => {
  const prompt = buildNativeModeSystemPrompt(ContextMode.LATEST, false, "all", {
    batch: true,
    nativeCatalogVersion: "v2",
  });
  const examples = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map(block => JSON.parse(block[1])).slice(-2);
  const expected = [
    [
      { entity: "A", year: "2024", amount: 10, previous: null, change: null },
      { entity: "A", year: "2025", amount: 15, previous: 10, change: 5 },
    ],
    [{ entity: "A", x: 5, y: 4 }],
  ];
  for (const [i, example] of examples.entries()) {
    const { state, dataflow } = batch();
    const result = await dataflow.execute(example);
    expect(result.operators.every((op: any) => op.status === "added")).toBe(true);
    expect(execute(state, example.observe[0])).toEqual(expected[i]);
  }
});
