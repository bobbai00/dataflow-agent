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
import { WorkflowState } from "../workflow-state";
import { formatNativeError } from "../tools/result-formatting";
import {
  describeInputs,
  nativeInputsOf,
  nativeToolSchema,
  nativeViewOf,
  toolSignature,
} from "../tools/native-typed-tools";
import { defaultParseDeps, defaultProducedOpId } from "../tools/tool-call-scheduler";
import { NATIVE_BY_TYPE } from "./catalog";
import { compileNativeOp } from "./codegen";
import { NATIVE_OPERATORS, nativeCatalogText } from "./catalog";
import { profileDiff, retiredPreviews, selectResultShapes, selectScopedShapes } from "./selection";
import type { OperatorLink, OperatorPredicate } from "../../types/workflow";
import type { OperatorInfo } from "../../types/execution";

describe("native codegen", () => {
  test("Scan compiles to a DataLoading load() over read_csv", () => {
    const r = compileNativeOp({
      type: "Scan",
      inputs: [],
      properties: { files: "data/x/*.csv", skipLines: 3, header: false, allText: true },
    });
    expect(r.operatorType).toBe("DataLoading");
    expect(r.code).toContain("def load():");
    expect(r.code).toContain("read_csv(");
    expect(r.code).toContain("skip=3");
    expect(r.code).toContain("header=false");
    expect(r.code).toContain("all_varchar=true");
  });

  test("Scan variants: preview, lines, whitespace/comment, fwf, json, encoding routing", () => {
    const scan = (properties: Record<string, unknown>) =>
      compileNativeOp({ type: "Scan", properties, inputs: [] }).code;
    const preview = scan({ files: "a.xlsx", preview: 5 });
    expect(preview).toContain("n = 5");
    expect(preview).toContain("xl.sheet_names"); // sheet heads for xlsx
    expect(preview).toContain("pd.read_html(files[0])"); // table heads for html
    expect(preview).toContain("' | '.join(cells)"); // one text line per sheet / table row
    // `columns` is gone: naming a header-less file is `names`, selecting is a project
    expect(() => scan({ files: "a.csv", columns: ["x"] })).toThrow(/has no `columns`/);
    expect(() => scan({ files: "a.csv", header: false, columns: ["x"] })).toThrow(/use `names`/);
    // `names` needs header: false — with a header the columns already have names
    expect(() => scan({ files: "a.csv", names: ["x"] })).toThrow(/needs `header: false`/);
    // and it is applied AFTER the read, with a count check, so a short list
    // cannot silently fold the leading columns into the index
    const named = scan({ files: "a.csv", header: false, names: ["year", "count"] });
    expect(named).toContain('_names = ["year","count"]');
    expect(named).toContain("if len(_names) != len(d.columns):");
    expect(named).toContain("names given for");
    expect(named).toContain("d.columns = _names");
    expect(named).not.toContain("names=["); // never handed to the reader
    // …and every reader path normalises those placeholders to strings
    expect(scan({ files: "a.csv" })).toContain("def _norm(d):");
    expect(scan({ files: "a.csv" })).toContain("'column' + str(i)");
    expect(preview).toContain("BINARY_HINT"); // pointer row for binary formats
    const lines = scan({ files: "x.tle", format: "lines", fileColumn: "file" });
    expect(lines).toContain("if fmt == 'lines':");
    expect(lines).toContain("'line_no': range(len(ls)), 'line': ls");
    const ws = scan({ files: "omni.dat", delim: "whitespace", comment: "#", header: false });
    expect(ws).toContain("sep=r'\\s+', engine='python'");
    expect(ws).toContain('comment="#"');
    expect(ws).toContain("return _pandas_csv()");
    expect(ws).not.toContain("read_csv(' + flist"); // whitespace never goes to DuckDB
    expect(scan({ files: "omni.dat", format: "whitespace", header: false })).toContain("sep=r'\\s+'"); // alias of delim whitespace
    const fwf = scan({ files: "x.txt", format: "fwf", widths: [4, 3, 8] });
    expect(fwf).toContain("pd.read_fwf(f, widths=[4,3,8]");
    const csv = scan({ files: "a.csv", skipLines: 2 });
    expect(csv).toContain("_text_enc(f).lower() not in ('utf-8', 'utf8')"); // cp1252 files take the pandas path
    expect(csv).toContain("read_csv(' + flist + ', header=true, skip=2, union_by_name=true)");
    expect(csv).toContain("return 'cp1252'");
    const json = scan({ files: "s.json" });
    expect(json).toContain("pd.DataFrame({'key': list(j.keys()), 'value': list(j.values())})");
    expect(json).toContain("pd.json_normalize(j)");
    expect(csv).toContain("contains: ' + ', '.join(names[:40])"); // a wrong path names the directory's files
  });

  test("DuckDB stages return timestamp differences in seconds", () => {
    const code = compileNativeOp({
      type: "Compute",
      properties: { columns: { gap: "epoch - prev_epoch" } },
      inputs: ["t"],
    }).code;
    expect(code).toContain("if str(d[_c].dtype).startswith('timedelta'):");
    expect(code).toContain("d[_c] = d[_c].dt.total_seconds()");
  });

  test("Unpivot melts the named columns and keeps the rest as keys", () => {
    const r = compileNativeOp({
      type: "Unpivot",
      properties: { columns: ["beat", "hit"], nameColumn: "event_type", valueColumn: "n" },
      inputs: ["t"],
    });
    expect(r.operatorType).toBe("DataProcessing");
    expect(r.code).toContain('value_vars = ["beat","hit"]');
    expect(r.code).toContain('var_name="event_type", value_name="n"');
    expect(() => compileNativeOp({ type: "Unpivot", properties: { columns: ["a"] }, inputs: ["t", "u"] })).toThrow(
      /exactly one input/
    );
  });

  test("Filter embeds the predicate as a Python string literal", () => {
    const r = compileNativeOp({
      type: "Filter",
      inputs: ["t0"],
      properties: { predicate: `"Beach Name" = 'Wollaston' AND x IS NOT NULL` },
    });
    expect(r.operatorType).toBe("DataProcessing");
    expect(r.code.startsWith("def process(t0):")).toBe(true);
    expect(r.code).toContain(`SELECT * FROM t WHERE (`);
    expect(r.code).toContain(`\\"Beach Name\\" = 'Wollaston' AND x IS NOT NULL`);
  });

  test("Aggregate quotes identifiers and maps functions", () => {
    const r = compileNativeOp({
      type: "Aggregate",
      inputs: ["src"],
      properties: {
        groupBy: ["state"],
        aggregations: [
          { fn: "sum", col: "reports", as: "total" },
          { fn: "count" },
          { fn: "count_distinct", col: "area" },
        ],
      },
    });
    expect(r.code).toContain(
      `SELECT \\"state\\", SUM(\\"reports\\") AS \\"total\\", COUNT(*) AS \\"count\\", COUNT(DISTINCT \\"area\\") AS \\"count_distinct_area\\" FROM t GROUP BY \\"state\\"`
    );
  });

  test("Join and Union take their inputs in order", () => {
    const j = compileNativeOp({ type: "Join", inputs: ["l", "r"], properties: { on: [["k", "key"]], type: "left" } });
    expect(j.code).toContain("def process(l, r):");
    expect(j.code).toContain('_left_on, _right_on = ["k"], ["key"]');
    expect(j.code).toContain('l.merge(r, left_on=_left_on, right_on=_right_on, how="left"');
    const u = compileNativeOp({ type: "Union", inputs: ["a", "b", "c"], properties: {} });
    expect(u.code).toContain("pd.concat([a, b, c]");
    const x = compileNativeOp({ type: "Join", inputs: ["num", "den"], properties: {} });
    expect(x.code).toContain("how='cross'");
    // self-join: one parameter used on both sides
    const s = compileNativeOp({
      type: "Join",
      inputs: ["rates", "rates"],
      properties: { on: [["year_prev", "year"]] },
    });
    expect(s.code).toContain("def process(rates):");
    expect(s.code).toContain("rates.merge(rates,");
  });

  test("UDF parameters must match the input ids", () => {
    expect(() =>
      compileNativeOp({ type: "UDF", inputs: ["x"], properties: { code: "def process(y):\n    return y" } })
    ).toThrow(/must equal the input operator ids/);
    const ok = compileNativeOp({ type: "UDF", inputs: ["x"], properties: { code: "def process(x):\n    return x" } });
    expect(ok.operatorType).toBe("DataProcessing");
    const loader = compileNativeOp({
      type: "UDF",
      inputs: [],
      properties: { code: "def load():\n    return pd.DataFrame()" },
    });
    expect(loader.operatorType).toBe("DataLoading");
  });

  test("arity and identifier errors are explicit", () => {
    expect(() => compileNativeOp({ type: "Filter", inputs: [], properties: { predicate: "1=1" } })).toThrow(
      /exactly one input/
    );
    expect(() => compileNativeOp({ type: "Join", inputs: ["a"], properties: { on: [["k", "k"]] } })).toThrow(
      /two inputs/
    );
    expect(() => compileNativeOp({ type: "Union", inputs: ["a", "a"], properties: {} })).toThrow(/distinct/);
    expect(() => compileNativeOp({ type: "Filter", inputs: ["bad-id"], properties: { predicate: "1=1" } })).toThrow(
      /identifier/
    );
  });

  test("join `on` takes shared key names, and checks key types at runtime", () => {
    // [["sat_id","date_key"]] was read as left.sat_id = right.date_key when the
    // model meant both keys (astronomy-easy-3: str compared with datetime).
    const shared = compileNativeOp({ type: "Join", inputs: ["l", "r"], properties: { on: ["sat_id", "date_key"] } });
    expect(shared.code).toContain('_left_on, _right_on = ["sat_id","date_key"], ["sat_id","date_key"]');
    // a single shared key may be written bare: the model generalised from
    // "an item may be a name" to "the parameter may be a name"
    const bare = compileNativeOp({ type: "Join", inputs: ["l", "r"], properties: { on: "sat_id" } });
    expect(bare.code).toContain('_left_on, _right_on = ["sat_id"], ["sat_id"]');
    const pairs = compileNativeOp({ type: "Join", inputs: ["l", "r"], properties: { on: [["k", "key"]] } });
    expect(pairs.code).toContain('_left_on, _right_on = ["k"], ["key"]');
    // the type guard, and the hint for the both-keys case
    expect(shared.code).toContain("compares a ' + _lt");
    expect(shared.code).toContain("to join on both keys pass on: [");
  });

  test("aggregate coerces a text column under an arithmetic function", () => {
    const r = compileNativeOp({
      type: "Aggregate",
      inputs: ["t"],
      properties: { groupBy: ["state"], aggregations: [{ fn: "sum", col: "reports" }, { fn: "count" }] },
    });
    expect(r.code).toContain('for _c in ["reports"]:');
    expect(r.code).toContain("pd.to_numeric(");
    expect(r.code).toContain("str.replace(',', '', regex=False)");
    // the coercion runs on the INPUT frame, before the SQL sees it
    expect(r.code.indexOf("pd.to_numeric(")).toBeLessThan(r.code.indexOf("_con.register('t', t)"));
    // a non-arithmetic aggregation needs no coercion
    const c = compileNativeOp({
      type: "Aggregate",
      inputs: ["t"],
      properties: { aggregations: [{ fn: "count_distinct", col: "state" }] },
    });
    expect(c.code).not.toContain("pd.to_numeric(");
  });

  test("expressions accept the type names the Schema line shows", () => {
    const f = compileNativeOp({
      type: "Filter",
      inputs: ["t"],
      properties: { predicate: "TRY_CAST(x AS numeric) > 1" },
    });
    expect(f.code).toContain("TRY_CAST(x AS DOUBLE) > 1");
    const c = compileNativeOp({ type: "Compute", inputs: ["t"], properties: { columns: { k: "CAST(d AS str)" } } });
    expect(c.code).toContain("CAST(d AS VARCHAR)");
    // SQL's own spellings keep working
    const s = compileNativeOp({
      type: "Compute",
      inputs: ["t"],
      properties: { columns: { k: "TRY_CAST(v AS INTEGER)" } },
    });
    expect(s.code).toContain("TRY_CAST(v AS INTEGER)");
  });

  test("engine errors are rewritten in the agent's terms (no generated-code pointers)", () => {
    const direct =
      "(line 21) `d = _con.sql(q).df()` - BinderException: Binder Error: Cannot mix values of type VARCHAR and INTEGER_LITERAL in BETWEEN clause - an explicit cast is required";
    expect(formatNativeError("web_fraud", "Filter", direct)).toBe(
      "Filter `web_fraud` failed: Cannot mix values of type str and numeric literal in BETWEEN clause - an explicit cast is required"
    );
    const cascade =
      "execution failed — Execution failed due to the following error:\n  Execution error:\n    web_fraud: (line 21) `d = _con.sql(q).df()` - BinderException: Binder Error: Cannot mix values\n  more";
    expect(formatNativeError("web_fraud_numeric", "Compute", cascade)).toBe(
      "not executed — upstream `web_fraud` failed: Cannot mix values"
    );
    const timeout =
      "execution failed — Execution failed due to the following error:\n  Error:\n    The operation timed out.";
    expect(formatNativeError("x", "Aggregate", timeout)).toContain("timed out");
    const scan =
      "(line 36) `d = _con.sql('SELECT * FROM read_csv(' + flist + ', header=true)').df()` - InvalidInputException: Invalid Input Error: File is not latin-1 encoded";
    expect(formatNativeError("noaa", "Scan", scan)).toBe("Scan `noaa` failed: File is not latin-1 encoded");
  });

  test("per-operator tools: schema, signature, view, deps", () => {
    const filter = NATIVE_BY_TYPE.get("Filter")!;
    const schema = nativeToolSchema(filter) as any;
    expect(schema.required).toEqual(["id", "input", "predicate"]);
    expect(Object.keys(schema.properties)).toEqual(["id", "input", "predicate"]);
    expect(toolSignature(filter).startsWith("filter(id, input, predicate)")).toBe(true);
    const join = NATIVE_BY_TYPE.get("Join")!;
    expect((nativeToolSchema(join) as any).required).toEqual(["id", "left", "right"]);
    expect(toolSignature(join).startsWith("join(id, left, right, on?, type?)")).toBe(true);
    // the view strips id and input refs; inputs come from the refs in port order
    const call = { id: "pairs", left: "rates", right: "rates", on: [["year_prev", "year"]] };
    expect(nativeViewOf("join", call)).toEqual({
      type: "Join",
      properties: { on: [["year_prev", "year"]] },
      inputs: ["rates", "rates"],
    });
    expect(nativeInputsOf("union", { id: "u", inputs: ["a", "b"] })).toEqual(["a", "b"]);
    expect(describeInputs("Join", ["a", "b"])).toBe("inputs: left = a, right = b");
    expect(describeInputs("Filter", ["a"])).toBe("inputs: a");
    // scheduler: dependencies and produced id from the typed refs
    expect(defaultParseDeps("filter", { id: "f", input: "s", predicate: "1=1" })).toEqual(["s"]);
    expect(defaultParseDeps("join", call)).toEqual(["rates", "rates"]);
    expect(defaultProducedOpId("aggregate", { id: "total" })).toBe("total");
    expect(defaultProducedOpId("deleteOperator", { id: "x" })).toBe("x");
  });

  test("catalog text lists every type once", () => {
    const text = nativeCatalogText();
    for (const d of NATIVE_OPERATORS) expect(text).toContain(d.type + " ");
  });
});

function op(id: string, type: string, inputs: string[], properties: Record<string, unknown> = {}): OperatorPredicate {
  return {
    operatorID: id,
    operatorType: type === "Scan" ? "DataLoading" : "DataProcessing",
    operatorVersion: "N/A",
    operatorProperties: { code: "" },
    inputPorts: inputs.map((_, i) => ({
      portID: `input-${i}`,
      displayName: "",
      allowMultiInputs: false,
      isDynamicPort: false,
    })) as any,
    outputPorts: [{ portID: "output-0", displayName: "", allowMultiInputs: false, isDynamicPort: false }] as any,
    showAdvanced: false,
    nativeOp: { type, properties, inputs },
  };
}

function links(ops: OperatorPredicate[]): OperatorLink[] {
  const out: OperatorLink[] = [];
  for (const o of ops) {
    (o.nativeOp?.inputs ?? []).forEach((up, i) => {
      out.push({
        linkID: `${up}-->${o.operatorID}`,
        source: { operatorID: up, portID: "output-0" },
        target: { operatorID: o.operatorID, portID: `input-${i}` },
      });
    });
  }
  return out;
}

function info(rows: number, columnStats?: Record<string, string>): OperatorInfo {
  return {
    state: "COMPLETED",
    inputTuples: 0,
    outputTuples: rows,
    totalRowCount: rows,
    resultMode: "tsv",
    result: [{ a: 1 }],
    columnStats,
  };
}

describe("probe retirement", () => {
  const op = (
    id: string,
    type: string,
    inputs: string[],
    properties: Record<string, unknown> = {}
  ): OperatorPredicate =>
    ({
      operatorID: id,
      operatorType: type === "Scan" ? "DataLoading" : "DataProcessing",
      operatorProperties: {},
      inputPorts: [],
      outputPorts: [],
      showAdvanced: false,
      isDisabled: false,
      customDisplayName: id,
      nativeOp: { type, properties, inputs },
    }) as unknown as OperatorPredicate;
  const link = (a: string, b: string) => ({
    linkID: `${a}-->${b}`,
    source: { operatorID: a, portID: "output-0" },
    target: { operatorID: b, portID: "input-0" },
  });
  const info = (rows: number, error?: string) =>
    ({ outputTuples: rows, totalRowCount: rows, error }) as unknown as OperatorInfo;

  test("a preview covered by a real scan and read by nobody renders header-only with a pointer", () => {
    const ops = [
      op("csn_preview", "Scan", [], { files: "data/legal/input/2024_CSN_Data_Contributors.csv", preview: 12 }),
      op("csn_data", "Scan", [], { files: "data/legal/input/2024_CSN_Data_Contributors.csv", skipLines: 3 }),
      op("msa_preview", "Scan", [], {
        files: "data/legal/input/State MSA Identity Theft data/Alabama.csv",
        preview: 5,
      }),
      op("msa", "Scan", [], { files: "data/legal/input/State MSA Identity Theft data/*.csv", skipLines: 3 }),
      op("spec_preview", "Scan", [], { files: "data/astronomy/input/omni2.text", preview: 30 }),
      op("spec_lines", "Filter", ["spec_preview"], { predicate: "line LIKE '%ap%'" }),
      op("lonely_preview", "Scan", [], { files: "data/x/other.csv", preview: 5 }),
    ];
    const links = [link("spec_preview", "spec_lines")];
    const r = retiredPreviews(ops, links, () => info(12));
    expect(r.get("csn_preview")).toEqual({ shape: "header", note: "(preview superseded by scan `csn_data`)" });
    expect(r.get("msa_preview")).toEqual({ shape: "header", note: "(preview superseded by scan `msa`)" }); // glob covers the file
    expect(r.has("spec_preview")).toBe(false); // has a consumer: still the input of a filter
    expect(r.has("lonely_preview")).toBe(false); // no real scan yet: still the thing being inspected
    expect(r.has("csn_data")).toBe(false);
    // and the rule inherits it
    const shapes = selectResultShapes(ops, links, () => info(12));
    expect(shapes.get("csn_preview")?.shape).toBe("header");
    expect(shapes.get("lonely_preview")?.shape).toBe("full");
  });

  test("an errored preview nobody reads collapses to its first error line", () => {
    const ops = [op("bad_preview", "Scan", [], { files: "data/x/missing.txt", preview: 5 })];
    const r = retiredPreviews(ops, [], () =>
      info(0, "FileNotFoundError: not found: data/x/missing.txt. data/x/ contains: a.csv\n  at line 9")
    );
    expect(r.get("bad_preview")).toEqual({
      shape: "header",
      note: "[ERROR] FileNotFoundError: not found: data/x/missing.txt. data/x/ contains: a.csv",
    });
  });
});

describe("result selection rule", () => {
  test("legal-hard-15 chain: scan full, filter count, compute header, aggregate input full, aggregate full", () => {
    const ops = [
      op("identity_theft", "Scan", []),
      op("non_blank", "Filter", ["identity_theft"], { predicate: "x IS NOT NULL" }),
      op("reports_num", "Compute", ["non_blank"], { columns: { reports: "TRY_CAST(reports AS INTEGER)" } }),
      op("cross_state", "Filter", ["reports_num"], { predicate: "regexp_matches(a, 'x')" }),
      op("total", "Aggregate", ["cross_state"], { aggregations: [{ fn: "sum", col: "reports" }] }),
    ];
    const infos: Record<string, OperatorInfo> = {
      identity_theft: info(660),
      non_blank: info(452, { reports: "(str): null=0, distinct=342" }),
      reports_num: info(452, { reports: "(numeric): null=0, distinct=342, mean=1" }),
      cross_state: info(94),
      total: info(1),
    };
    const shapes = selectResultShapes(ops, links(ops), id => infos[id]);
    expect(shapes.get("identity_theft")?.shape).toBe("full");
    expect(shapes.get("non_blank")?.shape).toBe("count");
    expect(shapes.get("reports_num")?.shape).toBe("header");
    expect(shapes.get("cross_state")?.shape).toBe("full"); // input of an Aggregate
    expect(shapes.get("total")?.shape).toBe("full"); // frontier + aggregate
  });

  test("a Compute whose null count moved gets a count line with the moved fact", () => {
    const ops = [
      op("src", "Scan", []),
      op("cast", "Compute", ["src"], { columns: { v: "TRY_CAST(v AS INTEGER)" } }),
      op("keep", "Filter", ["cast"], { predicate: "v > 0" }),
    ];
    const infos: Record<string, OperatorInfo> = {
      src: info(100, { v: "(str): null=0, distinct=90" }),
      cast: info(100, { v: "(numeric): null=12, distinct=80" }),
      keep: info(50),
    };
    const shapes = selectResultShapes(ops, links(ops), id => infos[id]);
    expect(shapes.get("cast")?.shape).toBe("count");
    expect(shapes.get("cast")?.note).toContain("null 0 → 12");
    expect(shapes.get("keep")?.shape).toBe("full"); // frontier
  });

  test("modify re-materializes every descendant, not only the sinks", () => {
    // scan -> filter -> compute -> aggregate, plus a second branch filter -> distinct
    const ws = new WorkflowState();
    const chain = [
      op("scan", "Scan", []),
      op("f", "Filter", ["scan"]),
      op("c", "Compute", ["f"]),
      op("agg", "Aggregate", ["c"]),
      op("d", "Distinct", ["f"]),
    ];
    for (const o of chain) ws.addOperator(o);
    for (const l of links(chain)) ws.addLink(l);
    expect(ws.getDownstreamSinks("f").sort()).toEqual(["agg", "d"]);
    expect(ws.getDownstreamOperators("f").sort()).toEqual(["agg", "c", "d"]);
    expect(ws.getDownstreamOperators("agg")).toEqual([]);
  });

  test("errors, non-native operators and unexecuted operators stay full", () => {
    const plain: OperatorPredicate = { ...op("u", "UDF", ["s"]), nativeOp: undefined };
    const ops = [op("s", "Scan", []), plain];
    const shapes = selectResultShapes(ops, links([op("u", "UDF", ["s"])]), id => (id === "s" ? info(10) : undefined));
    expect(shapes.get("s")?.shape).toBe("full"); // consumed by a non-native operator
    expect(shapes.get("u")?.shape).toBe("full");
  });
});

describe("scoped selection", () => {
  const op = (
    id: string,
    type: string,
    inputs: string[],
    properties: Record<string, unknown> = {}
  ): OperatorPredicate =>
    ({
      operatorID: id,
      operatorType: type === "Scan" ? "DataLoading" : "DataProcessing",
      operatorProperties: {},
      inputPorts: [],
      outputPorts: [],
      showAdvanced: false,
      isDisabled: false,
      customDisplayName: id,
      nativeOp: { type, properties, inputs },
    }) as unknown as OperatorPredicate;
  const links = (ops: OperatorPredicate[]) =>
    ops.flatMap(o =>
      (o.nativeOp?.inputs ?? []).map(src => ({
        linkID: `${src}-->${o.operatorID}`,
        source: { operatorID: src, portID: "output-0" },
        target: { operatorID: o.operatorID, portID: "input-0" },
      }))
    );
  const info = (rows: number, stats: Record<string, string>) =>
    ({ outputTuples: rows, totalRowCount: rows, columnStats: stats }) as unknown as OperatorInfo;
  const STATS = {
    year: "(numeric): null=0, distinct=5, min=2019, max=2023",
    team: "(str): null=0, distinct=32",
    yards: "(numeric): null=3, distinct=120, min=-5, max=99",
  };

  test("a frontier filter ships its count, the schema line and the predicate column only, no rows", () => {
    const ops = [op("plays", "Scan", []), op("recent", "Filter", ["plays"], { predicate: "year >= 2021" })];
    const shapes = selectScopedShapes(ops, links(ops), id => info(id === "plays" ? 1000 : 400, STATS));
    expect(shapes.get("plays")).toEqual({ shape: "full", budget: 1 });
    expect(shapes.get("recent")).toEqual({ shape: "full", columns: ["year"], budget: 0, schemaLine: true });
  });

  test("a text predicate earns three matching rows; the literal is not read as a column", () => {
    const ops = [op("plays", "Scan", []), op("bears", "Filter", ["plays"], { predicate: "team LIKE '%Bears%'" })];
    const shapes = selectScopedShapes(ops, links(ops), () => info(10, STATS));
    expect(shapes.get("bears")?.budget).toBe(0.2);
    expect(shapes.get("bears")?.columns).toEqual(["team"]);
  });

  test("a compute ships the new column beside its sources; the consumer's keys join the scope", () => {
    const ops = [
      op("plays", "Scan", []),
      op("yps", "Compute", ["plays"], { columns: { yards_per_year: "yards / year" } }),
      op("by_team", "Aggregate", ["yps"], { groupBy: ["team"], aggregations: [{ fn: "avg", col: "yards_per_year" }] }),
    ];
    const stats = { ...STATS, yards_per_year: "(numeric): null=3, distinct=300" };
    const shapes = selectScopedShapes(ops, links(ops), id => info(id === "by_team" ? 32 : 1000, stats));
    expect(shapes.get("yps")?.shape).toBe("full"); // input of an aggregate
    expect(shapes.get("yps")?.columns).toEqual(["yards_per_year", "yards", "year", "team"]);
    expect(shapes.get("yps")?.budget).toBe(0.3);
    expect(shapes.get("by_team")).toEqual({ shape: "full", budget: 1 }); // the table is the summary
  });

  test("count and header shapes pass through; a frontier limit shows its whole table", () => {
    const ops = [
      op("plays", "Scan", []),
      op("recent", "Filter", ["plays"], { predicate: "year >= 2021" }),
      op("top", "Sort", ["recent"], { by: [{ col: "yards", desc: true }] }),
      op("few", "Limit", ["top"], { n: 10 }),
    ];
    const shapes = selectScopedShapes(ops, links(ops), () => info(10, STATS));
    expect(shapes.get("recent")).toEqual({ shape: "count" });
    expect(shapes.get("top")).toEqual({ shape: "header" });
    expect(shapes.get("few")).toEqual({ shape: "full", budget: 1 });
  });

  test("a join scopes to its key columns", () => {
    const ops = [
      op("a", "Scan", []),
      op("b", "Scan", []),
      op("j", "Join", ["a", "b"], { on: [["team", "club"]], type: "left" }),
    ];
    const stats = { ...STATS, club: "(str): null=4, distinct=30" };
    const shapes = selectScopedShapes(ops, links(ops), () => info(50, stats));
    expect(shapes.get("j")).toEqual({ shape: "full", columns: ["team", "club"], budget: 0.3, schemaLine: true });
  });

  test("profileDiff names what moved and stays silent when nothing did", () => {
    const before = info(660, { reports: "(str): null=0, distinct=342", state: "(str): null=0, distinct=50" });
    const after = info(452, { reports: "(str): null=12, distinct=300", state: "(str): null=0, distinct=50" });
    expect(profileDiff(before, after)).toBe('rows 660 → 452; "reports": null 0 → 12, distinct 342 → 300');
    expect(profileDiff(before, before)).toBeUndefined();
    const widened = info(660, {
      reports: "(str): null=0, distinct=342",
      state: "(str): null=0, distinct=50",
      extra: "(str): null=0, distinct=1",
    });
    expect(profileDiff(before, widened)).toBe('+"extra"');
    const shifted = info(660, {
      reports: "(str): null=0, distinct=342",
      state: "(str): null=0, distinct=50, min=AK, max=WY",
    });
    const shifted2 = info(660, {
      reports: "(str): null=0, distinct=342",
      state: "(str): null=0, distinct=50, min=AL, max=WY",
    });
    expect(profileDiff(shifted, shifted2)).toBe('"state": min AK → AL');
  });
});
