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
import { compileNativeOp } from "./codegen";
import { compileAnalysisProgram, planAnalysisForks } from "./analysis-state";
import { planRestores } from "./task-restore";
import { WorkflowState } from "../workflow-state";
import { nativeTestTools } from "./test-support";
import { DefinitionRegistry } from "./definition-registry";
import { registeredOperators, renderRegisteredOperators } from "./registered-operators";
import { renderLiveIndex, buildTaskEntry, renderTaskEntry } from "./task-entries";
import type { TaskHistory } from "./task-history";
import type { ReActStep } from "../../types/agent";

const python = process.env.UDF_PYTHON_PATH ?? fileURLToPath(new URL("../../../../.venv/bin/python", import.meta.url));

const RANK = [
  'def rank_by_score(scores, top=10, key="composite"):',
  '    """One row per learner in the top ranks by the chosen score column, with rank."""',
  "    ranked = scores.sort_values(key, ascending=False).head(top).reset_index(drop=True)",
  "    return ranked.assign(rank=range(1, len(ranked) + 1))",
].join("\n");

test("the parser records what makes a def callable: tables, settings with literal defaults, the docstring", async () => {
  const parsed = await parseNativeProgram(
    `${RANK}\n\ndef helper(df, *rest):\n    return df\n\ndef odd(df, n=len("x")):\n    return df\n\ntop5 = rank_by_score(scored, top=5)`
  );
  const fn = parsed.functions.rank_by_score!;
  expect(fn.tables).toEqual(["scores"]);
  expect(fn.keywords).toEqual({ top: { kind: "const", value: 10 }, key: { kind: "const", value: "composite" } });
  expect(fn.doc).toBe("One row per learner in the top ranks by the chosen score column, with rank.");
  expect(fn.variadic).toBeUndefined();
  expect(parsed.functions.helper!.variadic).toBe(true);
  expect(parsed.functions.odd!.keywords).toEqual({ n: null });
  // The called name has a span of its own, marked as the operator position.
  expect(parsed.statements[0]!.names).toEqual([
    { name: "rank_by_score", operator: true, span: [1, 7, 1, 20] },
    { name: "scored", argumentIndex: 0, span: [1, 21, 1, 27] },
  ]);
});

test("a registered call compiles to a process with the call's settings and the def's docstring as doc", async () => {
  const compiled = await compileProgram(`${RANK}\n\ntop5 = rank_by_score(scored, top=5)`, { registeredOperators: true });
  expect(compiled.errors).toEqual([]);
  const [top5] = compiled.statements;
  expect(top5!.op).toBe("rank_by_score");
  expect(top5!.error).toBeUndefined();
  expect(top5!.view).toMatchObject({
    type: "Process",
    inputs: ["scored"],
    source: "top5 = rank_by_score(scored, top=5)",
    properties: {
      entry: "rank_by_score",
      doc: "One row per learner in the top ranks by the chosen score column, with rank.",
      params: { top: 5 },
    },
  });
  expect(top5!.view!.functions).toEqual({ rank_by_score: RANK });
  expect(top5!.view!.properties.code).toBe(RANK);
  // Settings change the revision (a different table); a doc= in the call overrides the docstring.
  const other = await compileProgram(`${RANK}\n\ntop3 = rank_by_score(scored, top=3, doc="Top three")`, { registeredOperators: true });
  expect(other.statements[0]!.view!.properties).toMatchObject({ params: { top: 3 }, doc: "Top three" });
  expect(other.statements[0]!.view!.revision).not.toBe(top5!.view!.revision);
  // No settings at all is still a registered call (params present, empty).
  const bare = await compileProgram(`${RANK}\n\nall = rank_by_score(scored)`, { registeredOperators: true });
  expect(bare.statements[0]!.view!.properties.params).toEqual({});
});

test("a registered call is refused with a precise reason: wrong tables, unknown setting, no docstring, variadic, non-literal default", async () => {
  const messages = async (program: string) =>
    (await compileProgram(program, { registeredOperators: true })).statements.map(s => s.error?.message ?? "ok");
  expect(await messages(`${RANK}\n\nt = rank_by_score(a, b)`)).toEqual([
    expect.stringContaining("passes 2 input table(s) but rank_by_score takes 1 (scores)"),
  ]);
  expect(await messages(`${RANK}\n\nt = rank_by_score(a, limit=3)`)).toEqual([
    expect.stringContaining("does not take a keyword `limit`; its settings (parameters with a default) are top=10, key=\"composite\""),
  ]);
  expect(await messages(`${RANK}\n\nt = rank_by_score(a, top=n)`)).toEqual([expect.stringContaining("top must be a scalar literal")]);
  expect(await messages(`${RANK}\n\nt = rank_by_score(a, 5)`)).toEqual([expect.stringContaining("then its settings as keywords; got 5")]);
  expect(await messages("def plain(df, k=1):\n    return df\n\nt = plain(a)")).toEqual([expect.stringContaining("needs a docstring")]);
  expect(await messages('def plain(df, k=1):\n    return df\n\nt = plain(a, doc="Rows as they are")')).toEqual(["ok"]);
  expect(await messages('def v(df, *rest):\n    """x"""\n    return df\n\nt = v(a)')).toEqual([expect.stringContaining("cannot be called as an operator")]);
  expect(await messages('def d(df, n=len("x")):\n    """x"""\n    return df\n\nt = d(a)')).toEqual([expect.stringContaining("must be a literal")]);
  for (const item of (await compileProgram(`${RANK}\n\nt = rank_by_score(a, limit=3)`, { registeredOperators: true })).statements)
    expect(item.error!.message).toContain('Signature: rank_by_score(scores, top=10, key="composite")');
  // Without the feature a def is not an operator.
  const off = await compileProgram(`${RANK}\n\nt = rank_by_score(a)`);
  expect(off.statements[0]!.error!.message).toContain("Unknown operator `rank_by_score`");
});

test("the engine runs a registered call with its settings; defaults apply to the rest", () => {
  const code = compileNativeOp(
    { type: "Process", inputs: ["scored"], properties: { code: RANK, entry: "rank_by_score", doc: "d", params: { top: 2 } } },
    "top2"
  ).code;
  const result = spawnSync(
    python,
    [
      "-I",
      "-c",
      [
        "import sys, pandas as pd",
        "scope = {}",
        "exec(sys.stdin.read(), scope)",
        'scored = pd.DataFrame({"name": ["x", "y", "z"], "composite": [1.0, 3.0, 2.0]})',
        "out = scope['process'](scored)",
        "print(out.to_json(orient='records'))",
      ].join("\n"),
    ],
    { input: code, encoding: "utf8", timeout: 60_000 }
  );
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout.trim())).toEqual([
    { name: "y", composite: 3.0, rank: 1 },
    { name: "z", composite: 2.0, rank: 2 },
  ]);
});

test("through the tool: the def persists with its consumers, a redefinition revises them, the index lists the operator with its version", async () => {
  const registry = new DefinitionRegistry();
  let task = 1;
  const { tools, state } = nativeTestTools(new WorkflowState(), {
    definitionRegistry: registry,
    activeTaskNumber: () => task,
    settings: { nativeAnalysisState: true, nativeRegisteredOperators: true, nativeTaskEfficiency: true },
  });
  const first = await tools.dataflow.execute({
    edits: `${RANK}\n\nscored = scan("data/scores.csv")\ntop5 = rank_by_score(scored, top=5)`,
  });
  expect(first.operators.map((o: any) => [o.id, o.op, o.status])).toEqual([
    ["scored", "scan", "added"],
    ["top5", "rank_by_score", "added"],
  ]);
  const view = state.getOperator("top5")!.nativeOp!;
  expect(view.properties.params).toEqual({ top: 5 });
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
      doc: "One row per learner in the top ranks by the chosen score column, with rank.",
      source: RANK,
      consumers: ["top5", "top3"],
    },
  ]);
  expect(renderRegisteredOperators(state, name => registry.operatorVersion(name))).toEqual([
    "Your operators (defs called by name, like any operator; settings shown with their defaults):",
    'rank_by_score(scores, top=10, key="composite") "One row per learner in the top ranks by the chosen score column, with rank." — used by top5, top3',
  ]);
  expect(renderLiveIndex(state, new Map())).toContain("Your operators");
  expect(registry.render(state, new Map())).toContain('rank_by_score(scores, top=10, key="composite")');
  // Redefining the def revises every consumer; the version advances.
  task = 3;
  const revised = RANK.replace("ascending=False", "ascending=True");
  const before = [state.getOperator("top5")!.nativeOp!.revision, state.getOperator("top3")!.nativeOp!.revision];
  const third = await tools.dataflow.execute({ edits: revised });
  expect(third.operators.map((o: any) => [o.id, o.status]).sort()).toEqual([["top3", "modified"], ["top5", "modified"]]);
  expect([state.getOperator("top5")!.nativeOp!.revision, state.getOperator("top3")!.nativeOp!.revision]).not.toEqual(before);
  expect(state.getOperator("top5")!.nativeOp!.properties.params).toEqual({ top: 5 });
  expect(registry.operatorVersion("rank_by_score")).toBe(2);
  expect(registry.render(state, new Map())).toContain('" v2 — used by top5, top3');
  // A settings error names the signature; the other statements land.
  const bad = await tools.dataflow.execute({ edits: "oops = rank_by_score(scored, limit=1)\nok = rank_by_score(scored, top=1)" });
  expect(bad.operators.map((o: any) => [o.id, o.status])).toEqual([["oops", "error"], ["ok", "added"]]);
  expect(bad.operators[0].message).toContain("does not take a keyword `limit`");
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
    properties: { entry: "rank_by_score", params: { top: 5 } },
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
      nativeOp: { type: "Process", properties: { entry: "rank_by_score", doc: "d", ...(params ? { params } : {}) }, inputs: ["scored"], source, ...(functions ? { functions } : {}) },
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
