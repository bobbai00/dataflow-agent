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

import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createNativeBatchTools, nativeBatchSchema } from "../tools/native-batch-tools";
import { WorkflowState } from "../workflow-state";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { buildNativeModeSystemPrompt } from "../prompts";
import { ContextMode } from "../../types/agent";
import { parseFunctionCall } from "../debug-parser";
import { nativeDebugInput } from "../../../benchmark/e2e/native-debug-input";

function batch() {
  const state = new WorkflowState();
  const metadata = new WorkflowSystemMetadata();
  metadata.seedCodeModeDefaults();
  return { state, dataflow: createNativeBatchTools(state, { metadataStore: metadata }, "v2").dataflow };
}

describe("V2 focused core", () => {
  test("worker smoke encodes Python debug literals without rewriting source strings", () => {
    const args = {
      operators: [{ op: "sort", id: "s", by: [{ col: "v", desc: true }] }],
      nullable: null,
      falseValue: false,
      source: "def apply(row):\n    return 'true null False'",
    };
    expect(parseFunctionCall(nativeDebugInput("dataflow", args))).toEqual({ name: "dataflow", arguments: args });
  });
  test("core prompt teaches discovery, denominators, null joins and longer batches", () => {
    const prompt = buildNativeModeSystemPrompt(ContextMode.DELTA, false, "all", {
      batch: true,
      nativeCatalogVersion: "v2",
    });
    expect(prompt).toContain("count without col counts rows");
    expect(prompt).toContain("nullsEqual: true");
    expect(prompt).toContain("Do not assume a preview describes the full source");
    expect([...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].length).toBeGreaterThanOrEqual(8);
  });
  test("core schemas accept structured arguments and reject ambiguous or legacy forms", () => {
    const validate = new Ajv({ strict: false }).compile(nativeBatchSchema("v2"));
    for (const operator of [
      { op: "scan", id: "s", files: "data/example.csv", allText: true },
      { op: "scan", id: "s", files: "data/example.xlsx", format: "excel", sheet: "Data" },
      { op: "aggregate", id: "a", input: "s", aggregations: [{ fn: "count", as: "n" }] },
      { op: "join", id: "j", left: "a", right: "b", on: [["id", "key"]], validate: "many_to_one" },
      { op: "union", id: "u", inputs: ["a", "b"], schema: "align" },
      { op: "distinct", id: "d", input: "s", columns: ["id"], keep: "last" },
      { op: "sort", id: "s", input: "d", by: [{ col: "id", desc: true }], nulls: "first" },
      { op: "limit", id: "l", input: "s", n: 3, offset: 2 },
    ])
      expect(validate({ operators: [operator] })).toBe(true);
    for (const operator of [
      { op: "aggregate", id: "a", input: "s", aggregations: { total: "SUM(value)" } },
      { op: "aggregate", id: "a", input: "s", aggregations: [{ fn: "quantile", col: "x", as: "x" }] },
      { op: "join", id: "j", left: "a", right: "b", on: [["id", "key", "extra"]] },
      { op: "union", id: "u", inputs: ["a"], schema: "guess" },
      { op: "sort", id: "s", input: "d", by: [] },
      { op: "limit", id: "l", input: "s", n: 0 },
    ])
      expect(validate({ operators: [operator] })).toBe(false);
  });

  test("reversed core chain compiles and runs through the same generated Python entry points", async () => {
    const { state, dataflow } = batch();
    const result = await dataflow.execute({
      operators: [
        { op: "limit", id: "answer", input: "ordered", n: 1 },
        { op: "sort", id: "ordered", input: "totals", by: [{ col: "n", desc: true }] },
        { op: "aggregate", id: "totals", input: "dedup", groupBy: ["g"], aggregations: [{ fn: "count", as: "n" }] },
        { op: "distinct", id: "dedup", input: "combined" },
        { op: "union", id: "combined", inputs: ["first", "second"] },
        {
          op: "udf",
          id: "first",
          code: "def load():\n    import pandas as pd\n    return pd.DataFrame({'g':['a','b'], 'v':[1,2]})",
        },
        {
          op: "udf",
          id: "second",
          code: "def load():\n    import pandas as pd\n    return pd.DataFrame({'g':['b','b'], 'v':[2,3]})",
        },
      ],
      observe: ["answer"],
    });
    expect(result.operators.map((op: any) => op.status)).toEqual(Array(7).fill("added"));
    const order = ["first", "second", "combined", "dedup", "totals", "ordered", "answer"];
    const specs = order.map(id => state.getOperator(id)!);
    const python =
      process.env.UDF_PYTHON_PATH ?? fileURLToPath(new URL("../../../../.venv/bin/python", import.meta.url));
    const program =
      "import sys,json\nresults={}\nfor op in json.load(sys.stdin):\n ns={}\n exec(op['operatorProperties']['code'],ns)\n inputs=op['nativeOp']['inputs']\n results[op['operatorID']]=ns['process'](*[results[x] for x in dict.fromkeys(inputs)]) if inputs else ns['load']()\nprint(results['answer'].to_json(orient='records'))";
    const executed = spawnSync(python, ["-c", program], {
      input: JSON.stringify(specs),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(executed.status).toBe(0);
    expect(JSON.parse(executed.stdout)).toEqual([{ g: "b", n: 2 }]);
    for (const op of specs) expect(op.operatorProperties.code).not.toContain("import duckdb");
  });

  test("V2 self-join keeps left/right references while wiring one distinct upstream", async () => {
    const { state, dataflow } = batch();
    const result = await dataflow.execute({
      operators: [
        { op: "join", id: "joined", left: "source", right: "source", on: "id" },
        { op: "scan", id: "source", files: "data/placeholder.csv" },
      ],
      observe: [],
    });
    expect(result.operators.map((op: any) => op.status)).toEqual(["added", "added"]);
    const joined = state.getOperator("joined")!;
    expect(joined.nativeOp?.inputs).toEqual(["source", "source"]);
    expect(joined.inputPorts).toHaveLength(1);
    expect(state.getAllLinks()).toHaveLength(1);
    expect(joined.operatorProperties.code).toContain("def process(source):");
    expect(joined.operatorProperties.code).toContain("[source, source]");
  });
});
