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
 * The native program: parsing, argument normalization against the catalog,
 * the generated Python, and the prompt that teaches all of it.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ContextMode } from "../../types/agent";
import { buildNativeModeSystemPrompt } from "../prompts";
import type { WorkflowState } from "../workflow-state";
import { NATIVE_OPERATORS, nativeCatalogText } from "./catalog";
import { compileNativeOp } from "./codegen";
import { compileProgram, type ProgramStatement } from "./program";
import { nativeTestTools } from "./test-support";

const python = process.env.UDF_PYTHON_PATH ?? fileURLToPath(new URL("../../../../.venv/bin/python", import.meta.url));

async function views(program: string): Promise<Record<string, ProgramStatement>> {
  const compiled = await compileProgram(program);
  if (!compiled.ok) throw new Error(`syntax error line ${compiled.error.line}: ${compiled.error.message}`);
  return Object.fromEntries(compiled.statements.map(s => [s.id, s]));
}

/** Run every operator's generated code in dependency order; the answer table as records. */
function execute(state: WorkflowState, answer: string): any[] {
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
    { input: JSON.stringify(state.getAllOperators()), encoding: "utf8", timeout: 60_000 }
  );
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout);
}

describe("program → operator definitions", () => {
  test("every operator normalizes from its expression to the runtime properties", async () => {
    const v = await views(`
def rank_value(row):
    rank = row["Barrington Atlas Rank"]
    return None if rank is None else float(rank.split("or")[0])

raw = scan("data/x.csv", preview=8, skip_lines=3)
source = scan(["data/a.csv", "data/b.csv"], format="csv", header=False, names=["a", "b"], all_text=True, file_column="src", sheet=0, encoding="utf-8", delim=";", comment="#")
kept = project(source, keep=["a", "b"], rename={"a": "alpha"})
typed = cast(kept, alpha=float64, **{"Acres Burned": int64}, when=datetime(format="%Y-%m-%d", tz="UTC"), errors="null")
filled = fill_null(typed, alpha=0.0, **{"Acres Burned": 0})
greece = filter(source, lambda row: row["Country"] == "Greece", nulls="keep")
ranked = map(greece, numeric_rank=float64(rank_value), flag=bool(lambda row: row["x"] > 1))
totals = aggregate(ranked, by=["region"], total=sum("amount"), n=count(), names=count("name"), spread=stddev("amount"))
labeled = join(totals, names_table, on=[("region", "region_id")], how="left", nulls_equal=True, suffix="_r", validate="many_to_one")
pairs = join(totals, totals, how="cross")
both = union(totals, labeled, schema="align")
unique = distinct(both, columns=["region"], keep="last")
ordered = sort(unique, by=[("total", "desc"), "region"], nulls="first")
top = limit(ordered, 3, offset=1)
prior = window(ordered, partition_by=["region"], order_by=[("total", "desc")], previous=lag("total", 1), nxt=lead("total"), rk=dense_rank())
parts = split(source, "label", ["code", "description"], ":", keep_source=False)
items = explode(parts, "tags", empty="null_row")
long = unpivot(items, columns=["y1", "y2"], name="year", value="amount")
wide = pivot(long, index=["code"], columns="year", values="amount")

def correlate(t):
    import pandas as pd
    return pd.DataFrame({"r": [t["a"].corr(t["b"])]})

def load_positions():
    import pandas as pd
    return pd.DataFrame({"a": [1]})

corr = process(top, fn=correlate)
positions = process(fn=load_positions)
`);
    for (const [id, statement] of Object.entries(v)) expect(statement.error, id).toBeUndefined();
    expect(v.raw.view!.properties).toEqual({ files: "data/x.csv", preview: 8, skipLines: 3 });
    expect(v.source.view!.properties).toEqual({
      files: ["data/a.csv", "data/b.csv"],
      format: "csv",
      header: false,
      names: ["a", "b"],
      allText: true,
      fileColumn: "src",
      sheet: 0,
      encoding: "utf-8",
      delim: ";",
      comment: "#",
    });
    expect(v.kept.view!.properties).toEqual({ keep: ["a", "b"], rename: { a: "alpha" } });
    expect(v.typed.view!.properties).toEqual({
      columns: [
        { column: "alpha", dtype: "float64" },
        { column: "Acres Burned", dtype: "int64" },
        { column: "when", dtype: "datetime", format: "%Y-%m-%d", timezone: "UTC" },
      ],
      errors: "null",
    });
    expect(v.filled.view!.properties).toEqual({ values: { alpha: 0, "Acres Burned": 0 } });
    expect(v.greece.view!.properties).toEqual({
      func: 'def apply(row):\n    return row["Country"] == "Greece"',
      entry: "apply",
      nulls: "keep",
    });
    expect(v.greece.view!.inputs).toEqual(["source"]);
    const ranked = v.ranked.view!.properties.columns as any[];
    expect(ranked.map(c => [c.as, c.dtype, c.entry])).toEqual([
      ["numeric_rank", "float64", "rank_value"],
      ["flag", "bool", "apply"],
    ]);
    expect(ranked[0].func).toContain("def rank_value(row):");
    expect(v.ranked.view!.functions).toEqual({ rank_value: ranked[0].func });
    expect(v.totals.view!.properties).toEqual({
      groupBy: ["region"],
      aggregations: [
        { fn: "sum", as: "total", col: "amount" },
        { fn: "count", as: "n" },
        { fn: "count", as: "names", col: "name" },
        { fn: "stddev", as: "spread", col: "amount" },
      ],
    });
    expect(v.labeled.view!.inputs).toEqual(["totals", "names_table"]);
    expect(v.labeled.view!.properties).toEqual({
      on: [["region", "region_id"]],
      type: "left",
      nullsEqual: true,
      rightSuffix: "_r",
      validate: "many_to_one",
    });
    expect(v.pairs.view!.properties).toEqual({ type: "cross" });
    expect(v.both.view!.inputs).toEqual(["totals", "labeled"]);
    expect(v.both.view!.properties).toEqual({ schema: "align" });
    expect(v.unique.view!.properties).toEqual({ columns: ["region"], keep: "last" });
    expect(v.ordered.view!.properties).toEqual({
      by: [{ col: "total", desc: true }, { col: "region" }],
      nulls: "first",
    });
    expect(v.top.view!.properties).toEqual({ n: 3, offset: 1 });
    expect(v.prior.view!.properties).toEqual({
      partitionBy: ["region"],
      orderBy: [{ col: "total", desc: true }],
      columns: [
        { fn: "lag", as: "previous", col: "total", offset: 1 },
        { fn: "lead", as: "nxt", col: "total" },
        { fn: "dense_rank", as: "rk" },
      ],
    });
    expect(v.parts.view!.properties).toEqual({
      column: "label",
      into: ["code", "description"],
      separator: ":",
      keepSource: false,
    });
    expect(v.items.view!.properties).toEqual({ column: "tags", encoding: "json", empty: "null_row" });
    expect(v.long.view!.properties).toEqual({ columns: ["y1", "y2"], nameColumn: "year", valueColumn: "amount" });
    expect(v.wide.view!.properties).toEqual({ index: ["code"], columns: "year", values: "amount" });
    expect(v.corr.view!.type).toBe("Process");
    expect(v.corr.view!.inputs).toEqual(["top"]);
    expect(v.corr.view!.properties.entry).toBe("correlate");
    expect(v.positions.view!.inputs).toEqual([]);
    expect(v.positions.view!.properties.entry).toBe("load_positions");
    for (const statement of Object.values(v)) expect(statement.view!.revision).toMatch(/^[a-f0-9]{16}$/);
  });

  test("a lambda that calls a program def ships with that def", async () => {
    const v = await views(`
def parse_count(row, column):
    value = row[column]
    return None if value is None else float(value.replace(",", ""))

typed = map(source, fraud=float64(lambda row: parse_count(row, "Fraud")), other=float64(lambda row: parse_count(row, "Other")))
kept = filter(typed, lambda row: parse_count(row, "Fraud") is not None)
`);
    for (const column of v.typed.view!.properties.columns as any[]) {
      expect(column.func).toContain("def parse_count(row, column):");
      expect(column.func.indexOf("def parse_count(")).toBeLessThan(column.func.indexOf("def apply(row):"));
      expect(column.entry).toBe("apply");
    }
    expect(v.kept.view!.properties.func).toContain("def parse_count(");
    expect(v.typed.view!.functions).toHaveProperty("parse_count");
  });

  test("a def that calls another def ships with its helpers, dependencies first", async () => {
    const v = await views(`
def clean(text):
    return text.strip().replace(",", "")

def to_number(row):
    return float(clean(row["amount"]))

typed = map(source, amount=float64(to_number))
`);
    const func = (v.typed.view!.properties.columns as any[])[0].func as string;
    expect(func.indexOf("def clean(")).toBeLessThan(func.indexOf("def to_number("));
    expect((v.typed.view!.properties.columns as any[])[0].entry).toBe("to_number");
  });

  test("argument errors are per statement and name the field and the signature", async () => {
    const v = await views(`
source = scan()
a = filter(source, "x > 0")
b = map(source, x=lambda row: 1)
c = aggregate(source, total="sum")
d = join(source, source)
e = sort(source, by=[("x", "down")])
f = scan("data/x.csv", skipLines=3)
g = limit(source)
h = filter(5, lambda row: True)
i = process(source, fn=lambda a, b: a)
`);
    const message = (id: string) => v[id].error!.message;
    expect(message("source")).toContain("scan needs the file path");
    expect(message("a")).toContain("must be a lambda or the name of a function");
    expect(message("b")).toContain("x=<dtype>(function)");
    expect(message("c")).toContain("must be a reducer call");
    expect(message("d")).toContain("join needs on=");
    expect(message("e")).toContain('"asc", "desc"');
    expect(message("f")).toContain("does not take a keyword `skipLines`");
    expect(message("f")).toContain("skip_lines");
    expect(message("g")).toContain("limit needs n");
    expect(message("h")).toContain("takes the input table as its first positional argument");
    expect(message("i")).toContain("takes 2 parameter(s)");
    for (const id of Object.keys(v)) expect(message(id)).toContain("Signature: ");
    expect(v.a.attempted.type).toBe("Filter");
    expect(v.a.attempted.inputs).toEqual(["source"]);
  });

  // One row per common slip. The message must name the cause (the value or
  // keyword the model wrote) so the receipt alone is enough to repair it.
  const argumentSlips: Array<[string, string, string[]]> = [
    [
      "unknown keyword",
      'a = filter(t, lambda row: True, nullz="drop")',
      ["does not take a keyword `nullz`", "accepted keywords: fn, nulls"],
    ],
    [
      "enum out of range",
      'a = join(t, u, on="g", how="outer_left")',
      ['got "outer_left"', '"inner", "left", "right", "full", "cross"'],
    ],
    ["missing required", 'a = join(t, u, how="inner")', ["join needs on="]],
    ["wrong scalar type", 'a = limit(t, "5")', ['n must be an integer >= 1, got "5"']],
    ["too many tables", "a = filter(t, u, lambda row: True)", ["one predicate function"]],
    ["dtype is not a type", "a = cast(t, x=float)", ["must be a dtype", "got float"]],
    [
      "reducer as window function",
      'a = window(t, order_by=["x"], c=sum("x"))',
      ["must be a window function call", "lag, lead, row_number, rank, dense_rank"],
    ],
    [
      "unknown reducer",
      'a = aggregate(t, n=filter_count("x"))',
      ["must be a reducer call", "count, count_distinct, sum, mean"],
    ],
    ["lambda with two parameters", "a = map(t, k=int64(lambda row, i: 1))", ["takes exactly one parameter", "takes 2"]],
    ["map value without dtype", "a = map(t, k=lambda row: 1)", ["k=<dtype>(function)"]],
    ["undefined function", "a = filter(t, is_ok)", ["is_ok", "not a function defined in this program"]],
    ["invalid sort direction", 'a = sort(t, by=[("x", "down")])', ['got "down"']],
    ["invalid scan format", 'a = scan("d.csv", format="feather")', ['got "feather"']],
    ["invalid explode policy", 'a = explode(t, column="j", empty="skip")', ['got "skip"', '"drop", "null_row"']],
    ["invalid distinct keep", 'a = distinct(t, columns=["g"], keep="middle")', ['got "middle"']],
    ["invalid union schema", 'a = union(t, u, schema="loose")', ['got "loose"']],
    ["invalid cast policy", 'a = cast(t, x=int64, errors="skip")', ['got "skip"']],
    ["empty sort keys", "a = sort(t, by=[])", ["at least one key"]],
    ["negative offset", "a = limit(t, 5, offset=-1)", ["offset must be an integer >= 0", "-1"]],
    ["process without fn", "a = process(t)", ["process needs fn="]],
    [
      "pivot values list",
      'a = pivot(t, index=["g"], columns="k", values=["v", "w"])',
      ["values must be a nonempty string"],
    ],
    ["unknown operator", 'a = select(t, keep=["x"])', ["Unknown operator `select`", "Available: scan, project"]],
  ];
  test.each(argumentSlips)("argument slip: %s", async (_name, statement, fragments) => {
    const compiled = await compileProgram(statement);
    if (!compiled.ok) throw new Error(`unexpected syntax error: ${compiled.error.message}`);
    const [st] = compiled.statements;
    expect(st.error).toBeDefined();
    for (const fragment of fragments) expect(st.error!.message).toContain(fragment);
    if (!st.error!.message.startsWith("Unknown operator")) expect(st.error!.message).toContain("Signature: ");
  });

  test("syntax and structure errors fail the whole program with a line number", async () => {
    for (const [program, message] of [
      ["x = 5", "must be an operator call"],
      ["import pandas\nx = scan('a.csv')", "Top-level imports are not allowed"],
      ["print(1)", "Only `name = operator(...)` assignments and `def` functions"],
      ["a, b = scan('x.csv')", "exactly one plain name"],
      ["x = scan('a.csv'", "was never closed"],
      ["def f(row):\n    return 1\ndef f(row):\n    return 2", "defined twice"],
      ["x = filter(t, lambda row, y=1: True)", "plain positional parameters"],
      ["x = filter(t, *tables)", "Star arguments"],
      ["x = scan(**{1: 2})", "string literals"],
    ] as const) {
      const result = await compileProgram(program);
      expect(result.ok, program).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain(message);
        expect(result.error.line).toBeGreaterThan(0);
      }
    }
  });

  test("revisions ignore formatting but follow the definition", async () => {
    const a = (await views('x = filter(t, lambda row: row["v"] > 1, nulls="drop")')).x.view!.revision;
    const b = (await views('x = filter( t ,  nulls = "drop", fn = lambda row: row["v"] > 1 )')).x.view!.revision;
    const c = (await views('x = filter(t, lambda row: row["v"] > 2, nulls="drop")')).x.view!.revision;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("generated Python", () => {
  test("the compiler keeps the identifier and port guards", () => {
    for (const inputs of [[], ["source", "extra"], ["not-an-id"], ["x): pass #"]]) {
      expect(() => compileNativeOp({ type: "Project", inputs, properties: { keep: ["x"] } }, "answer")).toThrow();
    }
    expect(() =>
      compileNativeOp(
        { type: "Process", inputs: ["source", "source"], properties: { code: "def f(a):\n    return a", entry: "f" } },
        "answer"
      )
    ).toThrow(/distinct/);
  });

  test("a reversed relational chain lands, wires and runs through the generated entry points", async () => {
    const { state, tools } = nativeTestTools();
    const result = await tools.dataflow.execute({
      program: `
answer = limit(ordered, 1)
ordered = sort(totals, by=[("n", "desc")])
totals = aggregate(dedup, by=["g"], n=count())
dedup = distinct(combined)
combined = union(first, second)

def first_fn():
    import pandas as pd
    return pd.DataFrame({'g': ['a', 'b'], 'v': [1, 2]})

def second_fn():
    import pandas as pd
    return pd.DataFrame({'g': ['b', 'b'], 'v': [2, 3]})

first = process(fn=first_fn)
second = process(fn=second_fn)
`,
      observe: ["answer"],
    });
    expect(result.operators.map((op: any) => op.status)).toEqual(Array(7).fill("added"));
    expect(result.observe).toEqual(["answer"]);
    expect(execute(state, "answer")).toEqual([{ g: "b", n: 2 }]);
    for (const op of state.getAllOperators()) {
      expect(op.nativeOp?.revision).toMatch(/^[a-f0-9]{16}$/);
      expect(op.operatorProperties.code).not.toContain("import duckdb");
    }
  });

  test("filter, map and a self-join execute with measured predicate columns and dependencies", async () => {
    const { state, tools } = nativeTestTools();
    const result = await tools.dataflow.execute({
      program: `
def load():
    import pandas as pd
    return pd.DataFrame({'id': [1, 2, 3], 'x': ['1', '2', None], 'y': [10, 20, 30]})

source = process(fn=load)
typed = cast(source, x=int64)
positive = filter(typed, lambda row: row["x"] is not None and row["x"] > 1)
scored = map(positive, score=float64(lambda row: row["x"] * row["y"] / 2), label=str(lambda row: "big" if row["y"] > 15 else "small"))
pairs = join(scored, scored, on="id", validate="one_to_one", suffix="_b")
`,
      observe: ["pairs"],
    });
    expect(result.operators.every((op: any) => op.status === "added")).toBe(true);
    expect(state.getOperator("pairs")!.nativeOp?.inputs).toEqual(["scored", "scored"]);
    expect(state.getOperator("pairs")!.inputPorts).toHaveLength(1);
    expect(execute(state, "pairs")).toEqual([
      { id: 2, x: 2, y: 20, score: 20, label: "big", x_b: 2, y_b: 20, score_b: 20, label_b: "big" },
    ]);
    // The runtime records what the functions read, not what was declared.
    const attrs = spawnSync(
      python,
      [
        "-c",
        "import sys,json,pandas as pd\nns={}\nexec(sys.stdin.read(),ns)\nout=ns['process'](pd.DataFrame({'id':[1],'x':[5],'y':[2]}))\nprint(json.dumps(out.attrs['native_v2']['operations']))",
      ],
      { input: state.getOperator("scored")!.operatorProperties.code, encoding: "utf8", timeout: 30_000 }
    );
    expect(attrs.status).toBe(0);
    expect(JSON.parse(attrs.stdout)).toEqual({ columnDependencies: { score: ["x", "y"], label: ["y"] } });
    const predicate = spawnSync(
      python,
      [
        "-c",
        "import sys,json,pandas as pd\nns={}\nexec(sys.stdin.read(),ns)\nout=ns['process'](pd.DataFrame({'id':[1],'x':[5],'y':[2]}))\nprint(json.dumps(out.attrs['native_v2']['operations']))",
      ],
      { input: state.getOperator("positive")!.operatorProperties.code, encoding: "utf8", timeout: 30_000 }
    );
    expect(JSON.parse(predicate.stdout)).toEqual({
      keptRows: 1,
      rejectedRows: 0,
      nullPredicates: 0,
      predicateColumns: ["x"],
    });
  });

  test("shape operators run through split, explode, unpivot, window and pivot, and a source revision refreshes them", async () => {
    const { state, tools } = nativeTestTools();
    const shapes = `
parts = split(source, "label", ["code", "description"], ":")
items = explode(parts, "tags")
long = unpivot(items, columns=["y2024", "y2025"])
lagged = window(long, partition_by=["code", "tags"], order_by=["variable"], previous=lag("value", 1))
wide = pivot(lagged, index=["code", "tags"], columns="variable", values="previous")`;
    const source = (value: number) =>
      `def load():\n    import pandas as pd\n    return pd.DataFrame({'label': ['A:Alpha'], 'tags': ['[1,2]'], 'y2024': [${value}], 'y2025': [${value + 5}]})\nsource = process(fn=load)`;
    const first = await tools.dataflow.execute({ program: `${shapes}\n${source(10)}`, observe: ["wide"] });
    expect(first.operators.map((o: any) => o.status)).toEqual(Array(6).fill("added"));
    expect(execute(state, "wide")).toEqual([
      { code: "A", tags: 1, y2024: null, y2025: 10 },
      { code: "A", tags: 2, y2024: null, y2025: 10 },
    ]);
    const changed = await tools.dataflow.execute({
      program: `answer = project(wide, keep=["code", "tags", "y2025"])\n${source(20)}`,
      observe: ["answer"],
    });
    expect(changed.operators.map((o: any) => o.status)).toEqual(["added", "modified"]);
    expect(execute(state, "answer")).toEqual([
      { code: "A", tags: 1, y2025: 20 },
      { code: "A", tags: 2, y2025: 20 },
    ]);
    expect(state.getAllLinks()).toHaveLength(6);
  });

  test("invalid options fail before mutation, blocking only dependents", async () => {
    const { state, tools } = nativeTestTools();
    await tools.dataflow.execute({ program: 'source = scan("data/placeholder.csv")' });
    const result = await tools.dataflow.execute({
      program: `
bad = window(source, order_by=["label"], r=rank("x"))
blocked = project(bad, keep=["r"])
parts = split(source, "label", ["code", "description"], ":")
crossed = join(source, source, how="cross", validate="one_to_one")`,
      observe: [],
    });
    expect(result.operators.map((o: any) => o.status)).toEqual(["error", "blocked", "added", "error"]);
    expect(result.operators[0].message).toContain("rank() takes no arguments");
    expect(result.operators[3].diagnostic).toMatchObject({ code: "JOIN_KEYS", stage: "validate" });
    expect(state.getOperator("bad")).toBeUndefined();
    expect(state.getOperator("crossed")).toBeUndefined();
    expect(state.getOperator("parts")).toBeDefined();
  });
});

describe("native prompt", () => {
  test("the operator reference is generated from the catalog and every example program compiles", async () => {
    for (const mode of [ContextMode.DELTA, ContextMode.LATEST]) {
      for (const layout of [
        {},
        { recall: true },
        { session: true },
        { versioned: true },
        { messageLayout: "opBlock" as const },
      ]) {
        const prompt = buildNativeModeSystemPrompt(mode, layout);
        expect(prompt).not.toContain("{{");
        expect(prompt).not.toContain("DuckDB");
        expect(prompt).toContain(nativeCatalogText());
        for (const def of NATIVE_OPERATORS) expect(prompt).toContain(`= ${def.signature}`);
        expect(prompt).toContain("inspectError");
        expect(prompt).toContain("observe");
        expect(prompt.includes("recallState")).toBe("recall" in layout);
        if (mode === ContextMode.LATEST) expect(prompt).toContain("already executed outcomes");
        else expect(prompt).not.toContain("already executed outcomes");
        const examples = [...prompt.matchAll(/```python\n([\s\S]*?)\n```/g)].map(m => m[1]);
        expect(examples.length).toBeGreaterThanOrEqual(8);
        for (const example of examples) {
          const compiled = await compileProgram(example);
          expect(compiled.ok, example).toBe(true);
          if (compiled.ok) for (const s of compiled.statements) expect(s.error, s.source).toBeUndefined();
        }
      }
    }
  });

  test("the prompt's worked examples cover the custom operators and the reference lists each operator once", () => {
    const prompt = buildNativeModeSystemPrompt(ContextMode.DELTA);
    for (const needle of [
      "= filter(",
      "= map(",
      "= process(",
      "fn=correlate",
      "lambda row:",
      'dataflow("", observe=',
    ]) {
      expect(prompt).toContain(needle);
    }
    const catalog = nativeCatalogText();
    for (const def of NATIVE_OPERATORS) expect(catalog.split(`${def.name}(`).length).toBeGreaterThanOrEqual(2);
  });
});
