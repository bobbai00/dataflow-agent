/**
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { expect, test } from "bun:test";
import Ajv from "ajv";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { NATIVE_OPERATOR_NAMES } from "./catalog";
import { compileNativeOp, nativePython, nativeRevision, validateNativeOperators } from "./codegen";
import { normalizeStructuredOperator, structuredSetSchemas } from "./structured-operators";

const scanDefaults = {
  format: "auto",
  skip_lines: 0,
  header: true,
  names: [],
  all_text: false,
  delim: null,
  comment: "",
  widths: [],
  sheet: null,
  encoding: "",
  file_column: "",
  preview: 0,
};

test("strict set schemas expose every operator and concrete defaults without dynamic maps", () => {
  const schemas = structuredSetSchemas();
  expect(schemas.map(schema => schema.properties.operator.const)).toEqual([...NATIVE_OPERATOR_NAMES]);
  const visit = (value: any) => {
    if (!value || typeof value !== "object") return;
    expect(value.oneOf).toBeUndefined();
    if (value.type === "object") {
      expect(value.additionalProperties).toBe(false);
      expect(value.required).toEqual(Object.keys(value.properties));
    }
    Object.values(value).forEach(visit);
  };
  schemas.forEach(visit);
  const scan = schemas[0];
  const params = { ...scanDefaults, files: ["data/file.xlsx"], format: "excel" };
  const validate = new Ajv({ strict: false }).compile(scan);
  expect(validate({ type: "set", id: "source", operator: "scan", inputs: [], params })).toBe(true);
  expect(
    validate({ type: "set", id: "source", operator: "scan", inputs: [], params: { ...params, format: "xlsx" } })
  ).toBe(false);
  expect(validate({ type: "set", id: "source", operator: "scan", inputs: ["other"], params })).toBe(false);
});

test("provider schemas expose aggregate, join and window conditional contracts", () => {
  const validate = (operator: string, params: Record<string, unknown>) =>
    new Ajv({ strict: false }).compile(
      structuredSetSchemas().find(schema => schema.properties.operator.const === operator)!
    )({ type: "set", id: "output", operator, inputs: operator === "join" ? ["left", "right"] : ["source"], params });
  expect(validate("aggregate", { by: [], aggregations: [{ fn: "count", col: null, as: "n" }] })).toBe(true);
  expect(validate("aggregate", { by: [], aggregations: [{ fn: "mean", col: null, as: "n" }] })).toBe(false);
  const joinParams = { on: null, how: "cross", nulls_equal: false, suffix: "_right", validate: "many_to_many" };
  expect(validate("join", joinParams)).toBe(true);
  expect(validate("join", { ...joinParams, on: [{ left: "id", right: "id" }] })).toBe(false);
  expect(validate("join", { ...joinParams, how: "left" })).toBe(false);
  const windowParams = {
    partition_by: [],
    order_by: [{ col: "date", direction: "asc" }],
    columns: [{ fn: "row_number", col: null, as: "n", offset: null }],
  };
  expect(validate("window", windowParams)).toBe(true);
  expect(validate("window", { ...windowParams, columns: [{ fn: "lag", col: null, as: "n", offset: null }] })).toBe(
    false
  );
  expect(validate("window", { ...windowParams, columns: [{ fn: "rank", col: "price", as: "n", offset: null }] })).toBe(
    false
  );
});

const cases: Array<[string, string[], Record<string, unknown>, Record<string, unknown>]> = [
  [
    "scan",
    [],
    { files: ["data/file.xlsx"], format: "excel", header: false, names: ["id"], all_text: true },
    { files: ["data/file.xlsx"], format: "excel", header: false, names: ["id"], allText: true },
  ],
  [
    "project",
    ["source"],
    { keep: ["Unit Price"], rename: [{ from: "Unit Price", to: "price" }] },
    { keep: ["Unit Price"], rename: { "Unit Price": "price" } },
  ],
  [
    "cast",
    ["source"],
    {
      columns: [
        { column: "Unit Price", dtype: "float64" },
        { column: "when", dtype: "datetime", timezone: "UTC" },
      ],
      errors: "null",
    },
    {
      columns: [
        { column: "Unit Price", dtype: "float64" },
        { column: "when", dtype: "datetime", timezone: "UTC" },
      ],
      errors: "null",
    },
  ],
  [
    "aggregate",
    ["source"],
    {
      by: [],
      aggregations: [
        { fn: "count", col: null, as: "n" },
        { fn: "mean", col: "price", as: "mean" },
      ],
    },
    {
      aggregations: [
        { fn: "count", as: "n" },
        { fn: "mean", col: "price", as: "mean" },
      ],
    },
  ],
  [
    "join",
    ["left", "right"],
    { on: [{ left: "id", right: "key" }], how: "left", validate: "many_to_one" },
    { on: [["id", "key"]], type: "left", validate: "many_to_one" },
  ],
  ["union", ["left", "right", "left"], { schema: "align" }, { schema: "align" }],
  ["distinct", ["source"], { columns: ["id"], keep: "last" }, { columns: ["id"], keep: "last" }],
  [
    "sort",
    ["source"],
    { by: [{ col: "price", direction: "desc" }], nulls: "last" },
    { by: [{ col: "price", desc: true }] },
  ],
  ["limit", ["source"], { n: 3, offset: 0 }, { n: 3 }],
  [
    "window",
    ["source"],
    {
      partition_by: ["group"],
      order_by: [{ col: "when", direction: "asc" }],
      columns: [
        { fn: "lag", col: "price", as: "previous", offset: 2 },
        { fn: "row_number", col: null, as: "n", offset: null },
      ],
    },
    {
      partitionBy: ["group"],
      orderBy: [{ col: "when" }],
      columns: [
        { fn: "lag", col: "price", as: "previous", offset: 2 },
        { fn: "row_number", as: "n" },
      ],
    },
  ],
  [
    "unpivot",
    ["source"],
    { columns: ["Jan", "Feb"], name: "month", value: "amount" },
    { columns: ["Jan", "Feb"], nameColumn: "month", valueColumn: "amount" },
  ],
  [
    "pivot",
    ["source"],
    { index: [], columns: "month", values: "amount" },
    { index: [], columns: "month", values: "amount" },
  ],
];
for (const [operator, inputs, params, properties] of cases) {
  test(`structured ${operator} reaches existing runtime properties directly`, async () => {
    const view = await normalizeStructuredOperator({ id: "output", operator, inputs, params });
    expect(view.properties).toEqual(properties);
    expect(view.inputs).toEqual(inputs);
    expect(view.graph?.inputPorts).toHaveLength(inputs.length);
    expect(view.jsonDefinition?.operator).toBe(operator);
    expect((await validateNativeOperators([{ id: "output", view }]))[0]).toBeUndefined();
  });
}

for (const operator of ["filter", "map", "process"]) {
  test(`structured ${operator} accepts normal functions, imports and helper definitions without layout rules`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "structured-python-"));
    const marker = join(dir, "must-not-exist");
    const code = `from pathlib import Path\nPath(${JSON.stringify(marker)}).touch()\ndef helper(value):\n    return value\ndef transform(frame, option=True):\n    return helper(frame)\n`;
    try {
      const view = await normalizeStructuredOperator({
        id: "output",
        operator,
        inputs: ["source"],
        params: { code, entry: "transform", doc: "Transform the input." },
      });
      expect(view.properties[operator === "process" ? "code" : "func"]).toBe(code);
      expect(view.properties.entry).toBe("transform");
      expect(view.functionValidation).toBe("callable");
      expect((await validateNativeOperators([{ id: "output", view }]))[0]).toBeUndefined();
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("entry selection supports a sole function or lambda, with explicit ambiguity errors", async () => {
  const make = (code: string, entry = "") =>
    normalizeStructuredOperator({
      id: "kept",
      operator: "filter",
      inputs: ["source"],
      params: { code, entry, doc: "Keep positive values." },
    });
  expect((await make("def keep(record):\n    return record['x'] > 0")).properties.entry).toBe("keep");
  expect((await make("def 处理(记录):\n    return 记录['x'] > 0", "处理")).properties.entry).toBe("处理");
  const lambda = await make("lambda record: record['x'] > 0");
  expect(lambda.properties.func).toContain("def apply(record):");
  await expect(make("def helper(x):\n    return x\ndef keep(x):\n    return helper(x)")).rejects.toThrow("entry");
  await expect(make("async def keep(x):\n    return True", "keep")).rejects.toThrow("synchronous");
  await expect(make("def keep(x)\n    return True")).rejects.toThrow("syntax");
});

test("empty callback metadata selects inference and an internal description", async () => {
  const view = await normalizeStructuredOperator({
    id: "kept",
    operator: "filter",
    inputs: ["source"],
    params: { code: "lambda record: True", entry: "", doc: "" },
  });
  expect(view.properties.doc).toBe("User-defined filter");
  expect(view.jsonDefinition!.params.doc).toBe("");
});

test("compiled typed operators execute ordinary module callbacks and repeated ordered ports", async () => {
  const definitions = [
    {
      id: "source",
      operator: "process",
      inputs: [],
      params: {
        code: "import pandas as pd\ndef helper():\n    return pd.DataFrame({'id': [1, 2], 'x': [1, 2]})\ndef loader():\n    return helper()",
        entry: "loader",
        doc: "",
      },
    },
    { id: "joined", operator: "join", inputs: ["source", "source"], params: { on: [{ left: "id", right: "id" }] } },
    { id: "combined", operator: "union", inputs: ["joined", "source", "joined"], params: { schema: "align" } },
    {
      id: "kept",
      operator: "filter",
      inputs: ["combined"],
      params: { code: "def keep(record, minimum=0):\n    return record['x'] > minimum", entry: "", doc: "" },
    },
    {
      id: "answer",
      operator: "aggregate",
      inputs: ["kept"],
      params: { by: [], aggregations: [{ fn: "sum", col: "x", as: "total" }] },
    },
  ];
  const operators = await Promise.all(
    definitions.map(async definition => {
      const view = await normalizeStructuredOperator(definition);
      return { id: definition.id, view, compiled: compileNativeOp(view, definition.id) };
    })
  );
  const execution = spawnSync(
    nativePython(),
    [
      "-c",
      "import json,sys\nresults={}\nfor operator in json.load(sys.stdin):\n    scope={}\n    exec(operator['compiled']['code'],scope)\n    inputs=operator['view']['inputs']\n    results[operator['id']]=scope['process'](*[results[id] for id in inputs]) if inputs else scope['load']()\nprint(results['answer'].to_json(orient='records'))",
    ],
    { input: JSON.stringify(operators), encoding: "utf8", timeout: 60_000 }
  );
  expect(execution.status).toBe(0);
  expect(execution.stderr).toBe("");
  expect(JSON.parse(execution.stdout)).toEqual([{ total: 9 }]);
});

test("invalid structured fields and semantic combinations fail before a graph change", async () => {
  for (const [operator, inputs, params] of [
    ["scan", [], { files: ["a.csv"], format: "xlsx" }],
    ["scan", [], { files: ["a.csv"], profileCollection: true }],
    ["project", ["a"], { keep: ["x"], drop: ["y"] }],
    [
      "project",
      ["a"],
      {
        rename: [
          { from: "x", to: "a" },
          { from: "x", to: "b" },
        ],
      },
    ],
    ["aggregate", ["a"], { aggregations: [{ fn: "mean", col: null, as: "x" }] }],
    ["join", ["a", "b"], { how: "cross", on: [{ left: "id", right: "id" }] }],
    ["filter", ["a"], { code: "def keep(x,y):\n    return True", entry: "", doc: "Keep rows." }],
  ] as Array<[string, string[], Record<string, unknown>]>) {
    await expect(
      normalizeStructuredOperator({ id: "output", operator, inputs, params }).then(async view => {
        const errors = await validateNativeOperators([{ id: "output", view }]);
        if (errors[0]) throw new Error(errors[0].message);
      })
    ).rejects.toThrow();
  }
  await expect(
    normalizeStructuredOperator({
      id: "source",
      operator: "scan",
      inputs: [],
      params: JSON.parse('{"files":["a.csv"],"__proto__":{"format":"csv"}}'),
    })
  ).rejects.toThrow("additional properties");
});

test("concrete defaults canonicalize, profile settings stay internal and validation policy affects identity", async () => {
  const definition = { id: "source", operator: "scan", inputs: [], params: { files: ["a.csv"] } };
  const a = await normalizeStructuredOperator(definition);
  const b = await normalizeStructuredOperator(
    { ...definition, params: { ...definition.params, ...scanDefaults } },
    { profileCollection: true, profileScope: "full" }
  );
  expect(a.revision).toBe(b.revision);
  expect(b.profileCollection).toBe(true);
  expect(b.profileScope).toBe("full");
  const callback = await normalizeStructuredOperator({
    id: "kept",
    operator: "filter",
    inputs: ["source"],
    params: { code: "def keep(x):\n    return True", entry: "", doc: "Keep rows." },
  });
  expect(nativeRevision(callback)).not.toBe(nativeRevision({ ...callback, functionValidation: undefined }));
  const aggregate = { id: "total", operator: "aggregate", inputs: ["source"] };
  const first = await normalizeStructuredOperator({
    ...aggregate,
    params: { aggregations: [{ fn: "mean", col: "x", as: "average" }], by: [] },
  });
  const reordered = await normalizeStructuredOperator({
    ...aggregate,
    params: { by: [], aggregations: [{ as: "average", col: "x", fn: "mean" }] },
  });
  expect(first).toEqual(reordered);
});

test("operator unions fit the provider budget while genuine nullable calendar and parser choices remain", () => {
  const unions = (node: any): number => {
    if (!node || typeof node !== "object") return 0;
    const count = Object.values(node.properties ?? {}).filter(
      (child: any) => child.anyOf || Array.isArray(child.type)
    ).length;
    return count + Object.values(node).reduce<number>((sum, child) => sum + unions(child), 0);
  };
  expect(unions(structuredSetSchemas())).toBe(6);
  const scan = structuredSetSchemas().find(schema => schema.properties.operator.const === "scan")!.properties.params
    .properties;
  expect(scan.sheet.anyOf.some((choice: any) => choice.type === "null")).toBe(true);
  expect(scan.delim.anyOf.some((choice: any) => choice.type === "null")).toBe(true);
  const cast = structuredSetSchemas().find(schema => schema.properties.operator.const === "cast")!.properties.params
    .properties.columns.items.properties;
  expect(cast.timezone.anyOf.some((choice: any) => choice.type === "null")).toBe(true);
  expect(cast.format.anyOf.some((choice: any) => choice.type === "null")).toBe(true);
});

test("neutral scan defaults never become format-incompatible runtime options or distinct cache revisions", async () => {
  for (const format of ["json", "parquet", "excel", "lines"]) {
    const definition = {
      id: "source",
      operator: "scan",
      inputs: [],
      params: { files: [`data/file.${format}`], format },
    };
    const implicit = await normalizeStructuredOperator(definition);
    const explicit = await normalizeStructuredOperator({
      ...definition,
      params: { ...scanDefaults, ...definition.params },
    });
    expect(explicit.properties).toEqual({ files: definition.params.files, format });
    expect(explicit.revision).toBe(implicit.revision);
    expect(explicit.jsonDefinition).toEqual(implicit.jsonDefinition);
    expect((await validateNativeOperators([{ id: "source", view: explicit }]))[0]).toBeUndefined();
  }
  const callback = await normalizeStructuredOperator({
    id: "mapped",
    operator: "map",
    inputs: ["source"],
    params: { code: "lambda row: row" },
  });
  const explicit = await normalizeStructuredOperator({
    id: "mapped",
    operator: "map",
    inputs: ["source"],
    params: { code: "lambda row: row", entry: "", doc: "" },
  });
  expect(explicit).toEqual(callback);
  const date = await normalizeStructuredOperator({
    id: "date",
    operator: "cast",
    inputs: ["source"],
    params: { columns: [{ column: "when", dtype: "datetime", format: null, timezone: null }], errors: "raise" },
  });
  expect(date.properties).toEqual({ columns: [{ column: "when", dtype: "datetime" }] });
  expect(date.datetimePolicy).toBe("preserve");
  const window = await normalizeStructuredOperator({
    id: "window",
    operator: "window",
    inputs: ["source"],
    params: {
      order_by: [{ col: "when", direction: "asc" }],
      columns: [{ fn: "lag", col: "value", as: "previous", offset: 1 }],
    },
  });
  expect(window.properties).toEqual({
    orderBy: [{ col: "when" }],
    columns: [{ fn: "lag", col: "value", as: "previous" }],
  });
});
