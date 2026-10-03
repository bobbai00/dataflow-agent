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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ContextMode } from "../../types/agent";
import { buildNativeModeSystemPrompt, nativeRetrievalExamples } from "../prompts";
import type { WorkflowState } from "../workflow-state";
import { NATIVE_OPERATORS, nativeCatalogText, graphCatalogText } from "./catalog";
import { compileNativeOp } from "./codegen";
import { compileProgram, type ProgramStatement } from "./program";
import { nativeTestTools } from "./test-support";
import { missingGraphInputs, planGraphEdit } from "../tools/graph-edits";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";

const python = process.env.UDF_PYTHON_PATH ?? fileURLToPath(new URL("../../../../.venv/bin/python", import.meta.url));

async function views(program: string): Promise<Record<string, ProgramStatement>> {
  const compiled = await compileProgram(program);
  if (compiled.errors.length)
    throw new Error(`syntax error line ${compiled.errors[0].line}: ${compiled.errors[0].message}`);
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

describe("membership joins", () => {
  test("values is not an operator: request constants stay in the definition that uses them", async () => {
    const v = await views(`excluded = values(country=["Canada", "Mexico"])`);
    expect(v.excluded.error?.message).toMatch(/values/);
    expect(graphCatalogText()).not.toContain("values(column");
  });

  test("semi and anti joins are join types that need keys", async () => {
    const v = await views(`
kept = join(orders, review_units, on="unit", how="semi")
rest = join(orders, review_units, on=[("unit", "key")], how="anti")
bare = join(orders, review_units, how="semi")`);
    expect(v.kept.view!.properties).toEqual({ on: "unit", type: "semi" });
    expect(v.rest.view!.properties).toEqual({ on: [["unit", "key"]], type: "anti" });
    expect(v.bare.error?.message).toContain("join needs on=");
    expect(graphCatalogText()).toContain("semi keeps the left rows with a match");
  });
});

describe("cross joins for scalar benchmarks", () => {
  test("explicit empty keys are equivalent to omitted keys only for cross joins", async () => {
    const v = await views(`
a = join(left_table, right_table, how="cross")
b = join(left_table, right_table, on=[], how="cross")
c = join(left_table, right_table, on=None, how="cross")
d = join(left_table, right_table, on=[], how="inner")
e = join(left_table, right_table, on="id", how="cross")`);
    for (const name of ["a", "b", "c"]) {
      expect(v[name].error).toBeUndefined();
      expect(v[name].view!.properties).toEqual({ type: "cross" });
    }
    expect(v.d.error).toBeDefined();
    expect(v.e.error).toBeDefined();
  });

  test("an explicit empty-key cross join attaches a scalar without lookup-key operators", async () => {
    const { state, tools } = nativeTestTools();
    const result = await tools.dataflow.execute({
      edits: `
def load_values():
    import pandas as pd
    return pd.DataFrame({"value": [2, 4]})
def load_threshold():
    import pandas as pd
    return pd.DataFrame({"threshold": [3]})
values = process(fn=load_values, doc="Test values")
threshold = process(fn=load_threshold, doc="Test scalar benchmark")
attached = join(values, threshold, on=[], how="cross")`,
    });
    expect(result.operators.every((op: any) => op.status === "added")).toBe(true);
    expect(execute(state, "attached")).toEqual([
      { value: 2, threshold: 3 },
      { value: 4, threshold: 3 },
    ]);
  });
});

describe("program → operator definitions", () => {
  test("scan accepts the None defaults advertised in its signature", async () => {
    const v = await views(`
source = scan("data/a.csv", names=None, delim=None, comment=None, widths=None, sheet=None, encoding=None, file_column=None, preview=None)
bad_header = scan("data/a.csv", header=None)
bad_skip = scan("data/a.csv", skip_lines=None)
`);
    expect(v.source.error).toBeUndefined();
    // Omit disabled options so the runtime cannot add a column named null.
    expect(v.source.view!.properties).toEqual({ files: "data/a.csv" });
    expect(v.bad_header.error).toBeDefined();
    expect(v.bad_skip.error).toBeDefined();
  });

  test("every operator normalizes from its expression to the runtime properties", async () => {
    const v = await views(`
def rank_value(row):
    rating = row["rating"]
    return {**row, "numeric_rank": None if rating is None else float(rating.split("or")[0]), "flag": row["x"] > 1}

raw = scan("data/x.csv", preview=8, skip_lines=3)
source = scan(["data/a.csv", "data/b.csv"], format="csv", header=False, names=["a", "b"], all_text=True, file_column="src", sheet=0, encoding="utf-8", delim=";", comment="#")
kept = project(source, keep=["a", "b"], rename={"a": "alpha"})
typed = cast(kept, alpha=float64, **{"Unit Price": int64}, when=datetime(format="%Y-%m-%d", tz="UTC"), errors="null")
greece = filter(source, lambda row: row["Country"] == "Greece", doc="Keeps the rows whose Country is Greece")
ranked = map(greece, rank_value, doc="Adds numeric_rank parsed from rating and a flag for x above 1")
totals = aggregate(ranked, by=["region"], total=sum("amount"), n=count(), names=count("name"), spread=stddev("amount"))
labeled = join(totals, names_table, on=[("region", "region_id")], how="left", nulls_equal=True, suffix="_r", validate="many_to_one")
pairs = join(totals, totals, how="cross")
both = union(totals, labeled, schema="align")
unique = distinct(both, columns=["region"], keep="last")
ordered = sort(unique, by=[("total", "desc"), "region"], nulls="first")
top = limit(ordered, 3, offset=1)
prior = window(ordered, partition_by=["region"], order_by=[("total", "desc")], previous=lag("total", 1), nxt=lead("total"), rk=dense_rank())
long = unpivot(source, columns=["y1", "y2"], name="year", value="amount")
wide = pivot(long, index=["code"], columns="year", values="amount")

def correlate(t):
    import pandas as pd
    return pd.DataFrame({"r": [t["a"].corr(t["b"])]})

def load_positions():
    import pandas as pd
    return pd.DataFrame({"a": [1]})

corr = process(top, fn=correlate, doc="Correlation between a and b")
positions = process(fn=load_positions, doc="Loads one row")
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
        { column: "Unit Price", dtype: "int64" },
        { column: "when", dtype: "datetime", format: "%Y-%m-%d", timezone: "UTC" },
      ],
      errors: "null",
    });
    expect(v.greece.view!.properties).toEqual({
      func: 'def apply(row):\n    return row["Country"] == "Greece"',
      entry: "apply",
      doc: "Keeps the rows whose Country is Greece",
    });
    expect(v.greece.view!.inputs).toEqual(["source"]);
    expect(v.ranked.view!.properties.entry).toBe("rank_value");
    expect(v.ranked.view!.properties.doc).toBe("Adds numeric_rank parsed from rating and a flag for x above 1");
    expect(v.ranked.view!.properties.func).toContain("def rank_value(row):");
    expect(v.ranked.view!.functions).toEqual({ rank_value: String(v.ranked.view!.properties.func) });
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
    expect(v.long.view!.properties).toEqual({ columns: ["y1", "y2"], nameColumn: "year", valueColumn: "amount" });
    expect(v.wide.view!.properties).toEqual({ index: ["code"], columns: "year", values: "amount" });
    expect(v.corr.view!.type).toBe("Process");
    expect(v.corr.view!.inputs).toEqual(["top"]);
    expect(v.corr.view!.properties.entry).toBe("correlate");
    expect(v.corr.view!.properties.doc).toBe("Correlation between a and b");
    expect(v.positions.view!.inputs).toEqual([]);
    expect(v.positions.view!.properties.entry).toBe("load_positions");
    for (const statement of Object.values(v)) expect(statement.view!.revision).toMatch(/^[a-f0-9]{16}$/);
  });

  test("a lambda that calls a program def ships with that def", async () => {
    const v = await views(`
def parse_count(row, column):
    value = row[column]
    return None if value is None else float(value.replace(",", ""))

typed = map(source, lambda row: {**row, "fraud": parse_count(row, "Fraud"), "other": parse_count(row, "Other")}, doc="Adds fraud and other as numbers parsed from the text columns")
kept = filter(typed, lambda row: parse_count(row, "Fraud") is not None, doc="Keeps rows with a parseable Fraud value")
`);
    const shipped = v.typed.view!.properties.func as string;
    expect(shipped).toContain("def parse_count(row, column):");
    expect(shipped.indexOf("def parse_count(")).toBeLessThan(shipped.indexOf("def apply(row):"));
    expect(v.typed.view!.properties.entry).toBe("apply");
    expect(v.kept.view!.properties.func).toContain("def parse_count(");
    expect(v.typed.view!.functions).toHaveProperty("parse_count");
  });

  test("a def that calls another def ships with its helpers, dependencies first", async () => {
    const v = await views(`
def clean(text):
    return text.strip().replace(",", "")

def to_number(row):
    return float(clean(row["amount"]))

typed = map(source, to_number, doc="Adds the numeric amount")
`);
    const func = v.typed.view!.properties.func as string;
    expect(func.indexOf("def clean(")).toBeLessThan(func.indexOf("def to_number("));
    expect(v.typed.view!.properties.entry).toBe("to_number");
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
    expect(message("b")).toContain("map does not take a keyword `x`");
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
      ["does not take a keyword `nullz`", "accepted keywords: fn, doc"],
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
    ["lambda with two parameters", "a = map(t, lambda row, i: {})", ["takes exactly one parameter", "takes 2"]],
    ["map without a function", "a = map(t)", ["map needs a row function"]],
    ["undefined function", "a = filter(t, is_ok)", ["is_ok", "not a function defined in this program"]],
    ["invalid sort direction", 'a = sort(t, by=[("x", "down")])', ['got "down"']],
    ["invalid scan format", 'a = scan("d.csv", format="feather")', ['got "feather"']],
    ["filter without doc", "a = filter(t, lambda row: True)", ['filter needs doc="one sentence stating which rows']],
    [
      "map without doc",
      "a = map(t, lambda row: {**row})",
      ['map needs doc="one sentence stating what the returned row'],
    ],
    ["doc that is not a string", "a = map(t, lambda row: {**row}, doc=describe)", ["map needs doc="]],
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
    [
      "unknown operator",
      'a = select(t, keep=["x"])',
      ["Unknown operator `select`", "Available: scan, project, cast"],
    ],
    [
      "nested operator call",
      'a = limit(sort(t, by=["x"]), 1)',
      [
        "limit takes the input table as its first positional argument",
        "Nested operator calls are not supported",
        'assign sort(t, by=["x"]) to its own name',
      ],
    ],
    [
      "nested call in a many-input operator",
      'a = union(t, distinct(u, columns=["g"]))',
      ["union takes input tables by name", "Nested operator calls are not supported"],
    ],
  ];
  test.each(argumentSlips)("argument slip: %s", async (_name, statement, fragments) => {
    const compiled = await compileProgram(statement);
    if (compiled.errors.length) throw new Error(`unexpected syntax error: ${compiled.errors[0].message}`);
    const [st] = compiled.statements;
    expect(st.error).toBeDefined();
    for (const fragment of fragments) expect(st.error!.message).toContain(fragment);
    if (!st.error!.message.startsWith("Unknown operator")) expect(st.error!.message).toContain("Signature: ");
  });

  test("a statement that does not parse fails alone with its line; the rest of the program lands", async () => {
    for (const [program, message] of [
      ["x = 5", "must be an operator call"],
      ["import pandas\nx = scan('a.csv')", "Top-level imports are not allowed"],
      ["print(1)", "Only `name = operator(...)` assignments and `def` functions"],
      ["a, b = scan('x.csv')", "exactly one plain name"],
      ["x = scan('a.csv'", "was never closed"],
      ["global = scan('a.csv')", "`global` is a Python keyword and cannot be a table name"],
      ["def f(row):\n    return 1\ndef f(row):\n    return 2", "defined twice"],
      ["x = filter(t, lambda row, y=1: True)", "plain positional parameters"],
      ["x = filter(t, *tables)", "Star arguments"],
      ["x = scan(**{1: 2})", "string literals"],
    ] as const) {
      const result = await compileProgram(program);
      expect(result.errors.length, program).toBeGreaterThan(0);
      expect(result.errors[0].message, program).toContain(message);
      expect(result.errors[0].line).toBeGreaterThan(0);
    }
    // An unclosed parenthesis costs its own statement only; a def keeps its
    // continuation lines; a structural slip is reported at its own line.
    const mixed = await compileProgram(
      [
        'a = scan("x.csv"',
        "b = limit(a, 1)",
        "def f(row):",
        "    return (row['v'] +",
        "            1) > 1",
        'c = filter(t, f, doc="c")',
        "print(1)",
        'd = map(t, lambda row: {"k": "a#b("}, doc="d")',
      ].join("\n")
    );
    expect(mixed.statements.map(s => s.id)).toEqual(["b", "c", "d"]);
    expect(Object.keys(mixed.functions)).toEqual(["f"]);
    expect(mixed.errors.map(e => [e.id ?? null, e.line])).toEqual([
      ["a", 1],
      [null, 7],
    ]);
    expect(mixed.errors[0].message).toContain("was never closed");
    expect(mixed.statements[1].line).toBe(6);
  });

  test("revisions ignore formatting but follow the definition", async () => {
    const a = (await views('x = filter(t, lambda row: row["v"] > 1, doc="v above 1")')).x.view!.revision;
    const b = (await views('x = filter( t ,  fn = lambda row: row["v"] > 1 , doc = "v above 1" )')).x.view!.revision;
    const c = (await views('x = filter(t, lambda row: row["v"] > 2, doc="v above 1")')).x.view!.revision;
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
      edits: `
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

first = process(fn=first_fn, doc="first")
second = process(fn=second_fn, doc="second")
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
      edits: `
def load():
    import pandas as pd
    return pd.DataFrame({'id': [1, 2, 3], 'x': ['1', '2', None], 'y': [10, 20, 30]})

source = process(fn=load, doc="loads the fixture")
typed = cast(source, x=int64)
positive = filter(typed, lambda row: row["x"] is not None and row["x"] > 1, doc="Keeps rows with x above 1")
scored = map(positive, lambda row: {**row, "score": row["x"] * row["y"] / 2, "label": "big" if row["y"] > 15 else "small"}, doc="Adds score = x * y / 2 and a size label from y")
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
    expect(JSON.parse(attrs.stdout)).toEqual({
      readColumns: ["x", "y"],
      columnDependencies: { id: ["id"], x: ["x"], y: ["y"], score: ["x", "y"], label: ["x", "y"] },
      addedColumns: ["score", "label"],
      droppedColumns: [],
    });
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

  test("shape operators run through unpivot, window and pivot, and a source revision refreshes them", async () => {
    const { state, tools } = nativeTestTools();
    const shapes = `
long = unpivot(source, columns=["y2024", "y2025"])
lagged = window(long, partition_by=["code", "tags"], order_by=["variable"], previous=lag("value", 1))
wide = pivot(lagged, index=["code", "tags"], columns="variable", values="previous")`;
    const source = (value: number) =>
      `def load():\n    import pandas as pd\n    return pd.DataFrame({'code': ['A', 'A'], 'tags': [1, 2], 'y2024': [${value}, ${value}], 'y2025': [${value + 5}, ${value + 5}]})\nsource = process(fn=load, doc="loads the fixture")`;
    const first = await tools.dataflow.execute({ edits: `${shapes}\n${source(10)}`, observe: ["wide"] });
    expect(first.operators.map((o: any) => o.status)).toEqual(Array(4).fill("added"));
    expect(execute(state, "wide")).toEqual([
      { code: "A", tags: 1, y2024: null, y2025: 10 },
      { code: "A", tags: 2, y2024: null, y2025: 10 },
    ]);
    const changed = await tools.dataflow.execute({
      edits: `answer = project(wide, keep=["code", "tags", "y2025"])\n${source(20)}`,
      observe: ["answer"],
    });
    expect(changed.operators.map((o: any) => o.status)).toEqual(["added", "modified"]);
    expect(execute(state, "answer")).toEqual([
      { code: "A", tags: 1, y2025: 20 },
      { code: "A", tags: 2, y2025: 20 },
    ]);
    expect(state.getAllLinks()).toHaveLength(4);
  });

  test("invalid options fail before mutation, blocking only dependents", async () => {
    const { state, tools } = nativeTestTools();
    await tools.dataflow.execute({ edits: 'source = scan("data/placeholder.csv")' });
    const result = await tools.dataflow.execute({
      edits: `
bad = window(source, order_by=["label"], r=rank("x"))
blocked = project(bad, keep=["r"])
parts = project(source, keep=["label"])
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
  test("historical examples validate and use an available view", async () => {
    const { prepareDataflowActions } = await import("../tools/dataflow-actions");
    for (const view of ["full", "sample", "sample_stats"] as const) {
      const prompt = buildNativeModeSystemPrompt(ContextMode.DELTA, { stateHistory: true, retrievalViews: [view] });
      const section = prompt.split("### Example: compare with an earlier task and go back")[1]!;
      const calls = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1]));
      const inspect = calls.flatMap(call => call.actions).find((a: any) => a.type === "inspect");
      expect(inspect).toMatchObject({ target: "state", view: null });
      for (const call of calls) {
        expect(prepareDataflowActions(call, [view], true).status).toBe("pending");
        for (const item of call.actions) if (item.type === "retrieve") expect(item.view).toBe(view);
      }
      expect(prompt).not.toContain("{{");
    }
  });

  test("evidence examples show retrieval, diagnosis and repair only when enabled", async () => {
    const { prepareDataflowActions } = await import("../tools/dataflow-actions");
    const prompt = buildNativeModeSystemPrompt(ContextMode.DELTA, {
      retrievalViews: ["full", "sample", "sample_stats"],
      flowEvidence: true,
    });
    const examples = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map(([, json]) => JSON.parse(json));
    expect(
      examples.some(e => e.actions.some((a: any) => a.operator_id === "eligible" && a.view === "sample_stats"))
    ).toBe(true);
    expect(examples.some(e => e.actions.some((a: any) => a.operator_id === "summary" && a.view === "full"))).toBe(true);
    expect(prompt).toContain("all:");
    expect(prompt).toContain("Failed-value");
    expect(prompt).toContain("unmatched-key examples");
    expect(prompt).toContain("window boundary");
    expect(prompt).toContain("reconnect it and recompute");
    for (const [, json] of prompt.matchAll(/```json\n([\s\S]*?)\n```/g))
      expect(prepareDataflowActions(JSON.parse(json), ["full", "sample", "sample_stats"]).error).toBeUndefined();
    const plain = buildNativeModeSystemPrompt(ContextMode.DELTA, { retrievalViews: ["sample"] });
    expect(plain).not.toContain("failed-value examples");
    expect(plain).not.toContain('"view": "full"');
    expect(plain).not.toContain('"view": "sample_stats"');
  });
  test("new evidence examples use synthetic fields and conditional repair rules", () => {
    const examples = nativeRetrievalExamples({
      retrievalViews: ["full", "sample", "sample_stats"],
      flowEvidence: true,
    });
    expect(examples).not.toMatch(/KramaBench|ChromaBench|Case_excluded|North Carolina|APP-Z|PLK1|texera-observation/i);
    expect(examples).toContain("key values and definitions");
    expect(examples).toContain("exclusions are intentional");
    expect(examples).toContain("four missing values must be reported");
    expect(examples).not.toMatch(
      /\b(?:legal|biomedical|environment|archeology|wildfire|astronomy)-(?:easy|hard)-\d+\b/
    );
  });
  test("the synthetic decimal repair runs and preserves graph connections", async () => {
    const examples = nativeRetrievalExamples({ retrievalViews: ["sample_stats"], flowEvidence: true });
    const repair = [...examples.matchAll(/```json\n([\s\S]*?)\n```/g)]
      .map(([, json]) => JSON.parse(json))
      .find(e => e.actions.some((a: any) => a.type === "edit" && a.changes.includes("update operator typed")));
    const directory = mkdtempSync(join(tmpdir(), "native-evidence-prompt-"));
    try {
      const path = join(directory, "values.csv");
      writeFileSync(path, "value\n1.5\n2.5\n" + "1\n".repeat(18));
      const { state } = nativeTestTools();
      const metadataStore = new WorkflowSystemMetadata();
      metadataStore.seedCodeModeDefaults();
      const initial = await planGraphEdit(
        state.getWorkflowContent(),
        `
create operator source: scan(${JSON.stringify(path)}, all_text=True)
create operator typed: cast(value=int64, errors="null")
create operator total: aggregate(average=mean("value"))
create edge source.out -> typed.in
create edge typed.out -> total.in
`,
        { metadataStore }
      );
      state.setWorkflowContent(initial.workflow);
      expect(execute(state, "total")).toEqual([{ average: 1 }]);
      const updated = await planGraphEdit(state.getWorkflowContent(), repair.actions[0].changes, { metadataStore });
      state.setWorkflowContent(updated.workflow);
      expect(updated.workflow.links).toEqual(initial.workflow.links);
      expect(execute(state, "total")).toEqual([{ average: 1.1 }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test("retrieval guidance separates source previews, table sampling and computation", () => {
    const prompt = buildNativeModeSystemPrompt(ContextMode.DELTA, {
      retrievalViews: ["full", "sample", "sample_stats"],
    });
    expect(prompt).toContain("Start with `sample_stats`");
    expect(prompt).toContain("compute a focused projection, filter or aggregate");
    expect(prompt).toContain("A complete view of a scan preview");
    expect(prompt).toContain("not a random sample");
    expect(prompt).toContain("Statistics are collected independently of the displayed sample records");
    expect(prompt).toContain("window(partition_by=");
  });
  test("retrieval choices, limits and examples follow the session configuration", async () => {
    const { prepareDataflowActions } = await import("../tools/dataflow-actions");
    for (const flowEvidence of [false, true])
      for (const view of ["full", "sample", "sample_stats"] as const) {
        const prompt = buildNativeModeSystemPrompt(ContextMode.DELTA, {
          retrievalViews: [view],
          fullResultCharLimit: 90000,
          maxOperatorResultCharLimit: 750,
          maxResultRows: 4,
          dataEvidenceCharLimit: 900,
          flowEvidence,
        });
        expect(prompt).toContain(`| \`${view}\` |`);
        for (const other of ["full", "sample", "sample_stats"].filter(v => v !== view))
          expect(prompt).not.toContain(`| \`${other}\` |`);
        expect(prompt.includes("#### Data statistics")).toBe(view === "sample_stats");
        expect(prompt.includes("#### Flow statistics")).toBe(flowEvidence);
        expect(prompt).toContain(view === "full" ? "90000 characters" : "750 characters");
        for (const [, json] of prompt.matchAll(/```json\n([\s\S]*?)\n```/g))
          expect(prepareDataflowActions(JSON.parse(json), [view]).error).toBeUndefined();
      }
  });
  test("all layouts describe the action contract and every JSON example validates", async () => {
    const { prepareDataflowActions } = await import("../tools/dataflow-actions");
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
        expect(prompt).toContain("dataflow(reasoning, actions)");
        expect(prompt).toContain(graphCatalogText());
        expect(prompt.includes("recallState")).toBe("recall" in layout);
        expect(prompt).toContain("next call");
        expect(prompt).toContain("only action");
        expect(prompt).not.toContain("dataflow(edits");
        const examples = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1]));
        expect(examples.length).toBeGreaterThanOrEqual(2);
        for (const input of examples) {
          expect(prepareDataflowActions(input).error).toBeUndefined();
          for (const a of input.actions)
            if (a.type === "edit") {
              const { runNativePython } = await import("./codegen");
              const parsed = (await runNativePython({ changes: a.changes })) as any;
              expect(parsed.ok === true).toBe(true);
            }
        }
      }
    }
  });

  test("reasoning is always part of the native action contract", () => {
    const plain = buildNativeModeSystemPrompt(ContextMode.DELTA);
    expect(plain).toBe(buildNativeModeSystemPrompt(ContextMode.DELTA, { reasoning: true }));
    expect(plain).toContain("reasoning");
  });

  test("every graph-command example in the prompt parses", async () => {
    const { runNativePython } = await import("./codegen");
    const prompt = buildNativeModeSystemPrompt(ContextMode.DELTA);
    const examples = [...prompt.matchAll(/```dataflow\n([\s\S]*?)\n```/g)];
    expect(examples.length).toBeGreaterThanOrEqual(2);
    for (const [, changes] of examples) {
      const parsed = (await runNativePython({ changes })) as any;
      expect(parsed).toMatchObject({ ok: true });
      expect(parsed.commands.length).toBeGreaterThan(0);
    }
  });

  test("the native calculation example executes as separate connected stages in one edit", async () => {
    const prompt = buildNativeModeSystemPrompt(ContextMode.DELTA);
    const example = [...prompt.matchAll(/```dataflow\n([\s\S]*?)\n```/g)].find(([, changes]) =>
      changes.includes("create operator over_budget:")
    )?.[1];
    expect(example).toBeDefined();

    const directory = mkdtempSync(join(tmpdir(), "native-prompt-"));
    try {
      const transactions = join(directory, "transactions.csv");
      const budgets = join(directory, "budgets.csv");
      writeFileSync(transactions, "region,amount\nnorth,70\nsouth,40\nnorth,50\nunmatched,500\n");
      writeFileSync(budgets, "region,budget\nnorth,100\nsouth,50\n");
      const changes = example!
        .replace('"data/transactions.csv"', JSON.stringify(transactions))
        .replace('"data/budgets.csv"', JSON.stringify(budgets));
      const { state } = nativeTestTools();
      const metadataStore = new WorkflowSystemMetadata();
      metadataStore.seedCodeModeDefaults();
      const plan = await planGraphEdit(state.getWorkflowContent(), changes, { metadataStore });
      state.setWorkflowContent(plan.workflow);

      expect(missingGraphInputs(plan.workflow)).toEqual([]);
      expect(state.getAllOperators().map(op => op.nativeOp!.type)).toEqual([
        "Scan",
        "Scan",
        "Aggregate",
        "Join",
        "Filter",
      ]);
      expect(state.getOperator("compared")!.nativeOp!.inputs).toEqual(["spending", "budgets"]);
      expect(execute(state, "over_budget")).toEqual([{ region: "north", spent: 120, budget: 100 }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("only enabled evidence kinds are described", () => {
    const data = buildNativeModeSystemPrompt(ContextMode.DELTA, { retrievalViews: ["sample_stats"] });
    const flow = buildNativeModeSystemPrompt(ContextMode.DELTA, { retrievalViews: ["sample"], flowEvidence: true });
    const both = buildNativeModeSystemPrompt(ContextMode.DELTA, {
      retrievalViews: ["sample_stats"],
      flowEvidence: true,
    });
    const none = buildNativeModeSystemPrompt(ContextMode.DELTA, { retrievalViews: ["sample"] });
    expect(data).toContain("### Data statistics");
    expect(data).not.toContain("### Flow statistics");
    expect(flow).toContain("### Flow statistics");
    expect(flow).not.toContain("### Data statistics");
    expect(both).toContain("### Data statistics");
    expect(both).toContain("### Flow statistics");
    expect(none).not.toContain("### Data statistics");
    expect(none).not.toContain("### Flow statistics");
  });

  test("the prompt stays concise, generic, and documents result freshness", () => {
    const prompt = buildNativeModeSystemPrompt(ContextMode.DELTA);
    // 2026-10-02: values and semi/anti joins in the catalog, answering from a
    // table, column-scoped retrieve and two worked examples added ~2.5k chars.
    // 2026-10-03: a complete single-task example (preview, parse, answer)
    // built from real receipts added ~3.7k chars.
    expect(prompt.length).toBeLessThan(28500);
    expect(prompt).toContain("stale");
    expect(prompt).toContain("preview");
    expect(prompt).toContain("None");
    for (const token of ["texera", "kramabench", "wildfire", "biomedical", "archeology", "astronomy"])
      expect(prompt.toLowerCase()).not.toContain(token);
  });
});
