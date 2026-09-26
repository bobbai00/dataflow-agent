/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileProgram, parseNativeProgram } from "./program";
import { compileNativeOp, validateNativeOperators } from "./codegen";
import { compileAnalysisProgram, planAnalysisForks } from "./analysis-state";
import { planRestores } from "./task-restore";
import { WorkflowState } from "../workflow-state";
import { nativeTestTools } from "./test-support";
import { DefinitionRegistry } from "./definition-registry";
import { registeredOperators, renderRegisteredOperators } from "./registered-operators";
import { renderLiveIndex, buildTaskEntry, renderTaskEntry } from "./task-entries";
import { liftDefinition, nearDuplicates, nearDuplicateNote } from "./lift";
import type { TaskHistory } from "./task-history";
import type { ReActStep } from "../../types/agent";

const python = process.env.UDF_PYTHON_PATH ?? fileURLToPath(new URL("../../../../.venv/bin/python", import.meta.url));

const RANK = [
  'def rank_by_score(scores, top=10, key="composite"):',
  '    """One row per learner in the top {top} by {key}, with rank."""',
  "    ranked = scores.sort_values(key, ascending=False).head(top).reset_index(drop=True)",
  "    return ranked.assign(rank=range(1, len(ranked) + 1))",
].join("\n");
const BAND = [
  "def band_report(T, band_column, value, top=5):",
  '    """One row per {band_column} with the mean {value}, the {top} highest first."""',
  "    out = T.groupby(band_column)[value].mean().reset_index().sort_values(value, ascending=False).head(top)",
  "    return out.assign(rank=range(1, len(out) + 1))",
].join("\n");
const TOP = [
  "def top_composite(scores):",
  '    """Top 3 by composite."""',
  '    return scores.sort_values("composite", ascending=False).head(3)',
].join("\n");

test("the parser records what makes a def callable: its parameters, their literal defaults, the docstring", async () => {
  const parsed = await parseNativeProgram(
    `${BAND}\n\ndef helper(df, *rest):\n    return df\n\ndef odd(df, n=len("x")):\n    return df\n\ndef kw(df, *, cols=["a", "b"]):\n    return df\n\ntop_edu = band_report(cleaned, band_column="prevEducation", value="composite")`
  );
  const fn = parsed.functions.band_report!;
  expect(fn.params).toEqual(["T", "band_column", "value", "top"]);
  expect(fn.defaults).toEqual({ top: { kind: "const", value: 5 } });
  expect(fn.doc).toBe("One row per {band_column} with the mean {value}, the {top} highest first.");
  expect(fn.variadic).toBeUndefined();
  expect(parsed.functions.helper!.variadic).toBe(true);
  expect(parsed.functions.odd!.defaults).toEqual({ n: null });
  expect(parsed.functions.kw!.keywordOnly).toEqual(["cols"]);
  expect(parsed.functions.kw!.defaults).toEqual({ cols: { kind: "list", items: [{ kind: "const", value: "a" }, { kind: "const", value: "b" }], tuple: false } });
  // The called name has a span of its own, marked as the operator position.
  expect(parsed.statements[0]!.names).toEqual([
    { name: "band_report", operator: true, span: [1, 10, 1, 21] },
    { name: "cleaned", argumentIndex: 0, span: [1, 22, 1, 29] },
  ]);
});

test("a call binds tables and settings by parameter and renders the docstring as the doc", async () => {
  const compiled = await compileProgram(
    `${BAND}\n\ntop_edu = band_report(cleaned, band_column="prevEducation", value="composite")\nby_pos = band_report(cleaned, "age_band", "total", 3)`,
    { registeredOperators: true }
  );
  expect(compiled.errors).toEqual([]);
  const [edu, pos] = compiled.statements;
  expect(edu!.op).toBe("band_report");
  expect(edu!.error).toBeUndefined();
  expect(edu!.view).toMatchObject({
    type: "Process",
    inputs: ["cleaned"],
    source: 'top_edu = band_report(cleaned, band_column="prevEducation", value="composite")',
    properties: {
      entry: "band_report",
      doc: "One row per prevEducation with the mean composite, the 5 highest first.",
      params: { band_column: "prevEducation", value: "composite" },
      tables: ["T"],
    },
  });
  expect(edu!.view!.functions).toEqual({ band_report: BAND });
  expect(edu!.view!.properties.code).toBe(BAND);
  expect(pos!.view!.properties).toMatchObject({
    params: { band_column: "age_band", value: "total", top: 3 },
    doc: "One row per age_band with the mean total, the 3 highest first.",
  });
  expect(pos!.view!.revision).not.toBe(edu!.view!.revision);
  // A table bound to a defaulted parameter is an input; a list is a setting;
  // a saved table reads through at(); the tables keep the parameter order.
  const more = await compileProgram(
    [
      "def merge_ref(T, cols, ref=None):",
      '    """{T} with the {cols} of {ref} joined on."""',
      "    return T if ref is None else T.merge(ref[cols])",
      "",
      'joined = merge_ref(a, ["k", "v"], ref=at(b, task=2))',
    ].join("\n"),
    { registeredOperators: true }
  );
  expect(more.statements[0]!.error).toBeUndefined();
  expect(more.statements[0]!.view).toMatchObject({
    inputs: ["a", expect.stringMatching(/^task_archive_/)],
    taskInputs: ["a", { operator: "b", atTask: 2 }],
    properties: { params: { cols: ["k", "v"] }, tables: ["T", "ref"], doc: "a with the k, v of at(b, task=2) joined on." },
  });
});

test("a call is refused with a precise reason, and the signature", async () => {
  const messages = async (program: string) =>
    (await compileProgram(program, { registeredOperators: true })).statements.map(s => s.error?.message ?? "ok");
  const sig = 'Signature: band_report(T, band_column, value, top=5)';
  expect(await messages(`${BAND}\n\nt = band_report(a, "x", "y", 1, 2)`)).toEqual([
    expect.stringContaining("takes 4 positional parameter(s) (T, band_column, value, top); got 5"),
  ]);
  expect(await messages(`${BAND}\n\nt = band_report(a, band_column="x", value="y", limit=3)`)).toEqual([
    expect.stringContaining("does not take a keyword `limit`; its parameters are T, band_column, value, top"),
  ]);
  expect(await messages(`${BAND}\n\nt = band_report(a, band_column="x")`)).toEqual([expect.stringContaining("needs an argument for value")]);
  expect(await messages(`${BAND}\n\nt = band_report(a, "x", "y", top=len("x"))`)).toEqual([
    expect.stringContaining("top must name a table or be a literal"),
  ]);
  // A bare name is a table, like everywhere else; it binds to that parameter.
  expect((await compileProgram(`${BAND}\n\nt = band_report(a, "x", "y", top=n)`, { registeredOperators: true })).statements[0]!.view).toMatchObject({
    inputs: ["a", "n"],
    properties: { tables: ["T", "top"] },
  });
  expect(await messages(`${BAND}\n\nt = band_report(a, "x", "y", top=lambda r: 1)`)).toEqual([
    expect.stringContaining("top must name a table or be a literal"),
  ]);
  expect(await messages(`${BAND}\n\nt = band_report(a, "x", value="y", band_column="z")`)).toEqual([
    expect.stringContaining("parameter band_column is given twice"),
  ]);
  expect(await messages(`${BAND}\n\nt = band_report(a, a, "y")`)).toEqual([expect.stringContaining("binds the table a to two parameters")]);
  expect(await messages("def plain(df, k=1):\n    return df\n\nt = plain(a)")).toEqual([
    expect.stringContaining("needs a docstring to be an operator: one sentence over its parameters"),
  ]);
  expect(await messages('def v(df, *rest):\n    """x"""\n    return df\n\nt = v(a)')).toEqual([expect.stringContaining("cannot be called as an operator")]);
  expect(await messages('def p(df, /, k=1):\n    """x"""\n    return df\n\nt = p(a)')).toEqual([expect.stringContaining("cannot be called as an operator")]);
  expect(await messages('def d(df, n=len("x")):\n    """x"""\n    return df\n\nt = d(a)')).toEqual([expect.stringContaining("must be a literal")]);
  for (const item of (await compileProgram(`${BAND}\n\nt = band_report(a, limit=3)`, { registeredOperators: true })).statements)
    expect(item.error!.message).toContain(sig);
  // Without the feature a def is not an operator.
  const off = await compileProgram(`${BAND}\n\nt = band_report(a, "x", "y")`);
  expect(off.statements[0]!.error!.message).toContain("Unknown operator `band_report`");
});

test("the engine binds the tables and settings by name; defaults fill the rest", async () => {
  const view = {
    type: "Process",
    inputs: ["scored"],
    properties: { code: BAND, entry: "band_report", doc: "d", params: { band_column: "band", value: "composite", top: 2 }, tables: ["T"] },
  };
  expect(await validateNativeOperators([{ id: "top2", view }])).toEqual([undefined]);
  const wrong = { ...view, properties: { ...view.properties, params: { nope: 1 } } };
  const [diagnostic] = await validateNativeOperators([{ id: "bad", view: wrong }]);
  expect(diagnostic?.code).toBe("CALLBACK_SIGNATURE");
  expect(diagnostic?.message).toContain("binds by name");
  const code = compileNativeOp(view, "top2").code;
  const result = spawnSync(
    python,
    [
      "-I",
      "-c",
      [
        "import sys, pandas as pd",
        "scope = {}",
        "exec(sys.stdin.read(), scope)",
        'scored = pd.DataFrame({"band": ["x", "y", "z", "x"], "composite": [1.0, 3.0, 2.0, 5.0]})',
        "out = scope['process'](scored)",
        "print(out.to_json(orient='records'))",
      ].join("\n"),
    ],
    { input: code, encoding: "utf8", timeout: 60_000 }
  );
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout.trim())).toEqual([
    { band: "x", composite: 3.0, rank: 1 },
    { band: "y", composite: 3.0, rank: 2 },
  ]);
});

test("lift turns a def's literals into parameters and its docstring into a template; near duplicates are classified", async () => {
  const lifted = await liftDefinition(TOP, { from: "top_composite", as: "top_by", params: { key: "composite", n: 3 } });
  expect(lifted).toEqual({
    ok: true,
    source: ["def top_by(scores, key='composite', n=3):", '    """Top {n} by {key}."""', "    return scores.sort_values(key, ascending=False).head(n)"].join("\n"),
  });
  expect(await liftDefinition(TOP, { from: "top_composite", params: { k: "missing" } })).toEqual({
    ok: false,
    message: "The body of top_composite holds no literal 'missing' to turn into k.",
  });
  expect(await liftDefinition("def f(t):\n    return t.head(3)", { from: "f", params: { n: 3 } })).toMatchObject({
    ok: false,
    message: expect.stringContaining("has no docstring; give doc="),
  });
  expect(await liftDefinition("def f(t):\n    return t.head(3)", { from: "f", params: { n: 3 }, doc: "The first {n} rows." })).toEqual({
    ok: true,
    source: 'def f(t, n=3):\n    """The first {n} rows."""\n    return t.head(n)',
  });
  const variant = TOP.replace("top_composite", "top_age").replace('"composite"', '"age"').replace("by composite", "by age");
  const other = 'def top_median(scores):\n    """Median."""\n    return scores.sort_values("composite", ascending=False).median()';
  const matches = await nearDuplicates({ top_age: variant, top_median: other, unrelated: "def u(t):\n    return 1" }, { top_composite: TOP });
  expect(matches).toEqual([
    { name: "top_age", existing: "top_composite", ratio: 1, kind: "literals", differences: [['"composite"', '"age"']] },
    { name: "top_median", existing: "top_composite", ratio: expect.any(Number), kind: "structure", differences: [] },
  ]);
  expect(nearDuplicateNote(matches[0]!)).toBe(
    'near-duplicate: `top_age` differs from `top_composite` only in literals ("composite" → "age"); next time lift top_composite instead: lift=[{"from": "top_composite", "as": "top_age", "params": {"value1": "composite"}}] (name the parameters as you like) then `t = top_age(..., value1="age")`.'
  );
});

test("through the tool: the def persists with its consumers, a redefinition revises them, lift and the near-duplicate receipt, the index", async () => {
  const registry = new DefinitionRegistry();
  let task = 1;
  const { tools, state } = nativeTestTools(new WorkflowState(), {
    definitionRegistry: registry,
    activeTaskNumber: () => task,
    settings: { nativeAnalysisState: true, nativeRegisteredOperators: true, nativeTaskEfficiency: true },
  });
  const first = await tools.dataflow.execute({
    edits: `${RANK}\n\n${TOP}\n\nscored = scan("data/scores.csv")\ntop5 = rank_by_score(scored, top=5)\nt3 = process(scored, fn=top_composite, doc="Top 3 by composite")`,
  });
  expect(first.operators.map((o: any) => [o.id, o.op, o.status])).toEqual([
    ["scored", "scan", "added"],
    ["top5", "rank_by_score", "added"],
    ["t3", "process", "added"],
  ]);
  expect(first.notes).toBeUndefined();
  const view = state.getOperator("top5")!.nativeOp!;
  expect(view.properties).toMatchObject({ params: { top: 5 }, tables: ["scores"], doc: "One row per learner in the top 5 by composite, with rank." });
  expect(registry.operatorVersion("rank_by_score")).toBe(1);
  // A later call reuses the def by name without resending it.
  task = 2;
  const second = await tools.dataflow.execute({ edits: "top3 = rank_by_score(scored, top=3)" });
  expect(second.operators.map((o: any) => [o.id, o.status])).toEqual([["top3", "added"]]);
  expect(state.getOperator("top3")!.nativeOp!.functions).toEqual({ rank_by_score: RANK });
  expect(registeredOperators(state)).toEqual([
    {
      name: "rank_by_score",
      signature: 'rank_by_score(scores, top=10, key="composite")',
      doc: "One row per learner in the top {top} by {key}, with rank.",
      source: RANK,
      consumers: ["top5", "top3"],
      example: "top5 = rank_by_score(scored, top=5)",
    },
  ]);
  expect(renderRegisteredOperators(state, name => registry.operatorVersion(name))).toEqual([
    "Your operators (call them like any operator; the doc reads with the arguments of the call):",
    'T2 = rank_by_score(scores, top=10, key="composite")\n    One row per learner in the top {top} by {key}, with rank. Example: `top5 = rank_by_score(scored, top=5)`. Used by top5, top3.',
  ]);
  expect(renderLiveIndex(state, new Map())).toContain("Your operators");
  expect(registry.render(state, new Map())).toContain('T2 = rank_by_score(scores, top=10, key="composite")');
  // Redefining the def revises every consumer; the version advances.
  task = 3;
  const revised = RANK.replace("ascending=False", "ascending=True");
  const before = [state.getOperator("top5")!.nativeOp!.revision, state.getOperator("top3")!.nativeOp!.revision];
  const third = await tools.dataflow.execute({ edits: revised });
  expect(third.operators.map((o: any) => [o.id, o.status]).sort()).toEqual([["top3", "modified"], ["top5", "modified"]]);
  expect([state.getOperator("top5")!.nativeOp!.revision, state.getOperator("top3")!.nativeOp!.revision]).not.toEqual(before);
  expect(state.getOperator("top5")!.nativeOp!.properties.params).toEqual({ top: 5 });
  expect(registry.operatorVersion("rank_by_score")).toBe(2);
  expect(registry.render(state, new Map())).toContain("v2. Used by top5, top3.");
  // A settings error names the signature; the other statements land.
  const bad = await tools.dataflow.execute({ edits: "oops = rank_by_score(scored, limit=1)\nok = rank_by_score(scored, top=1)" });
  expect(bad.operators.map((o: any) => [o.id, o.status])).toEqual([["oops", "error"], ["ok", "added"]]);
  expect(bad.operators[0].message).toContain("does not take a keyword `limit`");
  // Lift: the specific def becomes an operator under a new name, listed until called.
  task = 4;
  const lifted = await tools.dataflow.execute({ lift: [{ from: "top_composite", as: "top_by", params: { key: "composite", n: 3 } }] });
  expect(lifted.operators).toEqual([
    {
      id: "top_by",
      op: "lift",
      status: "added",
      message: "top_by(scores, key='composite', n=3) is now an operator (from top_composite); `x = top_by(scored, key=\"composite\", n=3)` reproduces `t3`.",
    },
  ]);
  expect(lifted.lifts).toEqual([{ name: "top_by", source: expect.stringContaining("def top_by(scores, key='composite', n=3):"), call: 'top_by(scored, key="composite", n=3)' }]);
  expect(registry.liftedOperators()).toEqual([{ name: "top_by", source: lifted.lifts[0].source, task: 4, from: "top_composite" }]);
  expect(renderRegisteredOperators(state, undefined, registry).join("\n")).toContain(
    "T2 = top_by(scores, key='composite', n=3)\n    Top {n} by {key}. Not called yet (lifted from top_composite)."
  );
  // The lifted operator resolves by name; its docstring renders with the call.
  const called = await tools.dataflow.execute({ edits: "t2 = top_by(scored, n=2)" });
  expect(called.operators.map((o: any) => [o.id, o.status])).toEqual([["t2", "added"]]);
  expect(state.getOperator("t2")!.nativeOp!.properties).toMatchObject({ entry: "top_by", params: { n: 2 }, tables: ["scores"], doc: "Top 2 by composite." });
  expect(state.getOperator("t2")!.nativeOp!.functions).toEqual({ top_by: lifted.lifts[0].source });
  expect(renderRegisteredOperators(state, undefined, registry).join("\n")).toContain("Example: `t2 = top_by(scored, n=2)`. Used by t2.");
  // A variant of an existing def gets the lift and call in the receipt.
  const variant = await tools.dataflow.execute({
    edits: `${TOP.replace("top_composite", "top_age").replace('"composite"', '"age"').replace("by composite", "by age")}\n\nta = process(scored, fn=top_age, doc="Top 3 by age")`,
  });
  expect(variant.operators.map((o: any) => [o.id, o.status])).toEqual([["ta", "added"]]);
  expect(variant.notes).toEqual([
    'near-duplicate: `top_age` differs from `top_composite` only in literals ("composite" → "age"); next time lift top_composite instead: lift=[{"from": "top_composite", "as": "top_age", "params": {"value1": "composite"}}] (name the parameters as you like) then `t = top_age(..., value1="age")`.',
  ]);
  // Lifting in place revises the def; the table that ran it through process(fn=) now calls the operator.
  const inPlace = await tools.dataflow.execute({ lift: [{ from: "top_composite", params: { n: 3 } }] });
  expect(inPlace.operators.map((o: any) => [o.id, o.op, o.status, o.message])).toEqual([
    ["top_composite", "lift", "modified", "top_composite(scores, n=3) now takes n as parameters; t3 now calls it and recomputes unchanged."],
    ["t3", "top_composite", "modified", expect.any(String)],
  ]);
  const t3 = state.getOperator("t3")!.nativeOp!;
  expect(t3.source).toBe("t3 = top_composite(scored)");
  expect(t3.functions!.top_composite).toContain("def top_composite(scores, n=3):");
  expect(t3.properties).toMatchObject({ entry: "top_composite", params: {}, tables: ["scores"], doc: "Top 3 by composite." });
  expect(renderRegisteredOperators(state, undefined, registry).join("\n")).toContain("T2 = top_composite(scores, n=3)\n    Top {n} by composite. Example: `t3 = top_composite(scored)`. Used by t3.");
  // A def used as a row function cannot be lifted in place.
  await tools.dataflow.execute({ edits: 'def big(row):\n    return row["composite"] > 2\n\nbigs = filter(scored, big, doc="Keeps composite above 2")' });
  const rowFn = await tools.dataflow.execute({ lift: [{ from: "big", params: { limit: 2 }, doc: "Rows above {limit}" }] });
  expect(rowFn.operators[0]).toMatchObject({ id: "big", op: "lift", status: "error", message: expect.stringContaining("uses it as a row function or a helper; lift it under a new name") });
  const missing = await tools.dataflow.execute({ lift: [{ from: "nothing", params: { n: 3 } }] });
  expect(missing.operators[0]).toMatchObject({ id: "nothing", op: "lift", status: "error", message: expect.stringContaining("No def `nothing`") });
});

test("forks and restores rewrite a registered call together with its function", async () => {
  const { tools, state } = nativeTestTools(new WorkflowState(), {
    settings: { nativeAnalysisState: true, nativeRegisteredOperators: true },
  });
  await tools.dataflow.execute({
    edits: `${RANK}\n\nscored = scan("data/scores.csv")\nother = scan("data/other.csv")\ntop5 = rank_by_score(scored, top=5)`,
  });
  const forked = await planAnalysisForks(
    [{ operator: "top5", as: "top5_other", bindings: { scored: "other" } }],
    state,
    [],
    undefined,
    { registeredOperators: true }
  );
  expect(forked.errors).toEqual([]);
  expect(forked.statements[0]!.view).toMatchObject({
    type: "Process",
    inputs: ["other"],
    properties: { entry: "rank_by_score", params: { top: 5 }, tables: ["scores"] },
    analysisBranch: { root: "top5_other", origin: "top5" },
  });
  // A restore renames the saved def and the call that names it.
  const sealed = structuredClone(state.getOperator("top5")!);
  const history = {
    definition: (id: string, task: number) => (id === "top5" && task === 1 ? { operator: sealed, info: {}, artifact: {} } : undefined),
    available: (id: string) => (id === "top5" ? [1] : []),
  } as unknown as TaskHistory;
  await tools.dataflow.execute({ edits: "top5 = rank_by_score(scored, top=7)" });
  const plans = await planRestores([{ operator: "top5", task: 1, as: "top5_v1" }], history, state);
  expect(plans.refusals).toEqual([]);
  expect(plans.plans[0]!.program).toBe(
    `${RANK.replace("def rank_by_score(", "def rank_by_score_t1(")}\ntop5_v1 = rank_by_score_t1(scored, top=5)`
  );
  const restored = await compileAnalysisProgram(plans.plans[0]!.program, state, [], { registeredOperators: true });
  expect(restored.statements.map(s => [s.id, s.error?.message ?? "ok"])).toEqual([["top5_v1", "ok"]]);
  expect(restored.statements[0]!.view!.properties).toMatchObject({ entry: "rank_by_score_t1", params: { top: 5 } });
});

test("entries show a registered call as its statement, with the def's code once", () => {
  const state = new WorkflowState();
  const add = (id: string, source: string, functions?: Record<string, string>, params?: Record<string, unknown>) =>
    state.addOperator({
      operatorID: id,
      operatorType: "DataProcessing",
      operatorVersion: "1",
      operatorProperties: {},
      inputPorts: [],
      outputPorts: [],
      showAdvanced: false,
      nativeOp: {
        type: "Process",
        properties: { entry: "rank_by_score", doc: "d", ...(params ? { params, tables: ["scores"] } : {}) },
        inputs: ["scored"],
        source,
        ...(functions ? { functions } : {}),
      },
    } as any);
  add("top5", "top5 = rank_by_score(scored, top=5)", { rank_by_score: RANK }, { top: 5 });
  add("top3", "top3 = rank_by_score(scored, top=3)", { rank_by_score: RANK }, { top: 3 });
  const receipt = (operators: Array<Record<string, unknown>>) =>
    ({
      id: `s${Math.random()}`,
      role: "agent",
      messageId: "m1",
      content: "",
      toolCalls: [{ toolName: "dataflow", toolCallId: "c", input: { edits: "", observe: [] } }],
      toolResults: [{ toolCallId: "c", output: { kind: "native-batch", operators, observe: [], observationErrors: [] } }],
    }) as unknown as ReActStep;
  const entry = buildTaskEntry({
    task: 1,
    steps: [
      { id: "u", role: "user", messageId: "m1", content: "Rank", isBegin: true } as any,
      receipt([{ id: "top5", op: "rank_by_score", status: "added", message: "" }, { id: "top3", op: "rank_by_score", status: "added", message: "" }]),
      { id: "a", role: "agent", messageId: "m1", content: "done", isEnd: true } as any,
    ],
    results: new Map(),
    state,
  });
  const text = renderTaskEntry(entry, true);
  expect(text).toContain("added top5 = rank_by_score(scored, top=5)");
  expect(text).toContain("added top3 = rank_by_score(scored, top=3)");
  expect(text.split("def rank_by_score(").length).toBe(2);
  expect(text).toContain("function code as in top5");
});
