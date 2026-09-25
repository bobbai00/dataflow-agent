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
import { WorkflowState } from "../workflow-state";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { WorkflowUtilService } from "../util/workflow-utils";
import { DefinitionRegistry } from "./definition-registry";
import type { TaskHistory } from "./task-history";
import { nativeTestTools } from "./test-support";
import { renderTaskEntry, type TaskEntry } from "./task-entries";
import { buildNativeModeSystemPrompt } from "../prompts";
import { validateNativeSettings, NativeCatalogSettingsError } from "./settings";
import { TexeraAgent } from "../texera-agent";
import { nativeBatchSchema } from "../tools/native-batch-tools";

/** A graph of native operators with statements, docs and inputs, no engine. */
function graph(
  specs: Array<{ id: string; inputs?: string[]; doc?: string; type?: string; source?: string; functions?: Record<string, string> }>
): WorkflowState {
  const state = new WorkflowState();
  const metadata = new WorkflowSystemMetadata();
  metadata.seedCodeModeDefaults();
  const util = new WorkflowUtilService(metadata, state);
  for (const spec of specs) {
    const base = util.getNewOperatorPredicate("DataProcessing", spec.id);
    state.addOperator({
      ...base,
      operatorID: spec.id,
      nativeOp: {
        type: spec.type ?? "Process",
        properties: spec.doc ? { doc: spec.doc } : {},
        inputs: spec.inputs ?? [],
        source: spec.source ?? `${spec.id} = process(${(spec.inputs ?? []).join(", ")}, fn=f, doc=${JSON.stringify(spec.doc ?? "")})`,
        revision: `rev-${spec.id}`,
        ...(spec.functions ? { functions: spec.functions } : {}),
      },
    });
    for (const input of spec.inputs ?? [])
      state.addLink({
        linkID: `${input}->${spec.id}`,
        source: { operatorID: input, portID: "output-0" },
        target: { operatorID: spec.id, portID: `input-${(spec.inputs ?? []).indexOf(input)}` },
      } as any);
  }
  return state;
}

/** Task history as the registry reads it: provenance events and retained tasks. */
function history(
  events: Record<string, { created: number; edited?: number[] }>,
  available: Record<string, number[]> = {},
  entries: TaskEntry[] = []
): TaskHistory {
  return {
    provenance: () =>
      new Map(
        Object.entries(events).map(([id, e]) => [
          id,
          { created: e.created, edited: e.edited ?? [], lastSaved: Math.max(...(available[id] ?? [e.created])), gaps: [] },
        ])
      ),
    available: (id: string) => available[id] ?? [],
    definition: (id: string, task: number) => ((available[id] ?? []).includes(task) ? ({ operator: { operatorID: id } } as any) : undefined),
    entries: () => entries,
  } as unknown as TaskHistory;
}

const BI = () =>
  graph([
    { id: "raw_preview", doc: undefined, type: "Scan", source: 'raw_preview = scan("bi.csv", preview=5)' },
    { id: "baseline_cleaned_data", doc: "Imputes missing Python scores with the mean" },
    { id: "age_grouped_data", inputs: ["baseline_cleaned_data"], doc: "Adds the active four-band age grouping", type: "Map" },
    { id: "composite_scored_data", inputs: ["baseline_cleaned_data"], doc: "Adds the equal-weight composite", type: "Map" },
    { id: "weighted_composite_data", inputs: ["baseline_cleaned_data"], doc: "Adds the active weighted composite", type: "Map" },
    { id: "age_band_means", inputs: ["age_grouped_data", "weighted_composite_data"], doc: "Mean composite per age band" },
  ]);
const BI_HISTORY = () =>
  history(
    {
      raw_preview: { created: 1 },
      baseline_cleaned_data: { created: 3 },
      age_grouped_data: { created: 11, edited: [23] },
      composite_scored_data: { created: 12 },
      weighted_composite_data: { created: 18 },
      age_band_means: { created: 23 },
    },
    {
      baseline_cleaned_data: [3, 4, 5, 22, 23],
      age_grouped_data: [11, 12, 22, 23],
      composite_scored_data: [12, 22, 23],
      weighted_composite_data: [18, 22, 23],
      age_band_means: [23],
    }
  );

test("an id reassigned in a later task is one definition with two versions; the earlier one keeps its saved values", () => {
  const registry = new DefinitionRegistry();
  const definitions = registry.definitions(BI(), BI_HISTORY());
  const age = definitions.get("age_grouped_data")!;
  expect(age.versions.map(v => [v.k, v.task, v.active, v.savedAt])).toEqual([
    [1, 11, false, 22],
    [2, 23, true, undefined],
  ]);
  expect(age.versions[1].doc).toBe("Adds the active four-band age grouping");
});

test("supersede folds a new-name version into the old table's definition and makes it active", () => {
  const registry = new DefinitionRegistry();
  registry.supersede("weighted_composite_data", "composite_scored_data", 18);
  const definitions = registry.definitions(BI(), BI_HISTORY());
  expect(definitions.has("weighted_composite_data")).toBe(false);
  const composite = definitions.get("composite_scored_data")!;
  expect(composite.versions.map(v => [v.k, v.table, v.active, v.sameId])).toEqual([
    [1, "composite_scored_data", false, true],
    [2, "weighted_composite_data", true, false],
  ]);
  expect(registry.definitionOf("weighted_composite_data")).toBe("composite_scored_data");
  expect(() => registry.supersede("composite_scored_data", "weighted_composite_data", 30)).toThrow(/earlier version/);
  expect(() => registry.supersede("x", "x", 1)).toThrow(/cannot supersede itself/);
});

test("the task-start index names versions, current tables with their docs, and probes by name only", () => {
  const registry = new DefinitionRegistry();
  registry.supersede("weighted_composite_data", "composite_scored_data", 18);
  const results = new Map<string, any>([
    ["age_grouped_data", { totalRowCount: 77 }],
    ["age_band_means", { totalRowCount: 4 }],
    ["raw_preview", { totalRowCount: 5 }],
  ]);
  const text = registry.render(BI(), results, BI_HISTORY());
  expect(text).toContain("# Definitions at the start of this task");
  expect(text).toContain("age_grouped_data: v1 t11 [values: at(age_grouped_data, task=22)] | v2 t23 ACTIVE \"Adds the active four-band age grouping\"; rows=77");
  expect(text).toContain("composite_scored_data: v1 t12 \"Adds the equal-weight composite\" | v2 weighted_composite_data t18 ACTIVE \"Adds the active weighted composite\"");
  expect(text).toContain("baseline_cleaned_data (t3, read by 3) \"Imputes missing Python scores with the mean\"");
  expect(text).toMatch(/Not read by any table.*raw_preview/);
  expect(text).not.toContain("def ");
  // A table with a single reader is named without its doc; its entry has it.
  const chain = graph([
    { id: "base", doc: "The base" },
    { id: "step", inputs: ["base"], doc: "A single-reader step" },
    { id: "report", inputs: ["step"], doc: "The report" },
  ]);
  const compact = registry.render(chain, new Map(), history({ base: { created: 1 }, step: { created: 1 }, report: { created: 2 } }));
  expect(compact).toContain("Other current tables (their entries hold the definitions): base (t1) · step (t1)");
  expect(compact).not.toContain("A single-reader step");
});

test("bind accepts an existing undeclared table as a replacement and says how to declare it", () => {
  const registry = new DefinitionRegistry();
  const plan = registry.plan(
    [{ target: "age_band_means", as: "alt_means", versions: { weighted_composite_data: "composite_scored_data" } }],
    BI(),
    BI_HISTORY()
  );
  expect(plan.errors).toEqual([]);
  expect(plan.forks).toEqual([{ operator: "age_band_means", as: "alt_means", bindings: { weighted_composite_data: "composite_scored_data" } }]);
  expect(plan.notes[0]).toContain('not a declared version; supersede={"composite_scored_data": "weighted_composite_data"}');
});

test("bind resolves versions to a fork, rebuilding an earlier in-place version from its saved definition", () => {
  const registry = new DefinitionRegistry();
  registry.supersede("weighted_composite_data", "composite_scored_data", 18);
  const plan = registry.plan(
    [
      { target: "age_band_means", as: "rollback_means", versions: { age_grouped_data: "v1", composite_scored_data: "v1" } },
      { target: "age_band_means", as: "same", versions: { age_grouped_data: "active" } },
      { target: "age_band_means", as: "bad_version", versions: { age_grouped_data: "v9" } },
      { target: "baseline_cleaned_data", as: "unrelated", versions: { age_grouped_data: "v1" } },
      { target: "age_band_means", as: "age_band_means", versions: { age_grouped_data: "v1" } },
    ],
    BI(),
    BI_HISTORY()
  );
  expect(plan.restores).toEqual([{ operator: "age_grouped_data", task: 22, as: "age_grouped_data__v1" }]);
  expect(plan.forks).toEqual([
    {
      operator: "age_band_means",
      as: "rollback_means",
      bindings: { age_grouped_data: "age_grouped_data__v1", weighted_composite_data: "composite_scored_data" },
    },
  ]);
  expect(plan.notes).toEqual([
    "rollback_means: age_grouped_data v2 → v1 (age_grouped_data__v1)",
    "rollback_means: composite_scored_data v2 → v1 (composite_scored_data)",
    "same: `age_band_means` already reads age_grouped_data v2",
  ]);
  expect(plan.errors.map(e => e.id)).toEqual(["same", "bad_version", "unrelated", "age_band_means"]);
  expect(plan.errors[1].message).toMatch(/versions: v1 \(t11\), v2 \(t23\)/);
  expect(plan.errors[2].message).toMatch(/does not read any version/);
  expect(plan.errors[3].message).toMatch(/new valid table name/);
});

test("explain prints the lineage with each definition's version and flags a superseded ancestor", () => {
  const registry = new DefinitionRegistry();
  registry.supersede("weighted_composite_data", "composite_scored_data", 18);
  const state = BI();
  const text = registry.explain(state, "age_band_means", BI_HISTORY());
  expect(text).toContain("Lineage of age_band_means:");
  expect(text).toContain("[age_grouped_data v2, active]");
  expect(text).toContain("[composite_scored_data v2, active]");
  // A consumer of the superseded composite is flagged.
  const stale = graph([
    { id: "composite_scored_data", doc: "equal-weight" },
    { id: "weighted_composite_data", doc: "weighted" },
    { id: "old_report", inputs: ["composite_scored_data"], doc: "report" },
  ]);
  const flagged = registry.explain(stale, "old_report", history({ composite_scored_data: { created: 12 }, weighted_composite_data: { created: 18 }, old_report: { created: 13 } }));
  expect(flagged).toContain("[composite_scored_data v1, superseded by v2]");
  expect(flagged).toContain("read a superseded version");
  expect(registry.explain(stale, "missing")).toBe("No current table `missing`.");
});

test("entries show functions by their signature line in registry mode", () => {
  const fn = 'def score(rows):\n    import pandas as pd\n    return rows.assign(score=rows["x"] / 7.0)';
  const entry: TaskEntry = {
    task: 2,
    request: "Score the rows.",
    changes: [{ id: "scores", status: "added", statement: 'scores = process(rows, fn=score, doc="Scores rows")', functions: [fn], rows: 3, columns: ["x", "score"] }],
    tables: [],
    answer: "done",
    from: [],
  };
  const text = renderTaskEntry(entry, true, { signatures: true });
  expect(text).toContain("def score(rows): … (3 lines; inspect for the body)");
  expect(text).not.toContain("rows.assign");
  expect(renderTaskEntry(entry, true)).toContain("rows.assign");
});

test("the dataflow tool accepts supersede, bind and explain only with the registry, and records declarations", async () => {
  const registry = new DefinitionRegistry();
  const { tools } = nativeTestTools(undefined, {
    settings: { nativeAnalysisState: true, nativeTaskEfficiency: true, nativeDefinitionRegistry: true },
    definitionRegistry: registry,
    activeTaskNumber: () => 4,
    activeTaskId: () => "task-4",
  } as any);
  const first = await tools.dataflow.execute({ edits: 'source = scan("data/test.csv")' });
  expect(first.operators[0].status).toBe("added");
  const second = await tools.dataflow.execute({
    edits: 'wider = scan("data/other.csv")',
    supersede: { wider: "source" },
    explain: ["wider"],
  });
  expect(second.notes).toEqual(["supersede: `wider` is now the active version of `source`; `source` stays readable as an earlier version"]);
  expect(second.inspection[0]).toContain("Lineage of wider:");
  expect(registry.declarations()).toEqual([{ table: "wider", of: "source", task: 4 }]);
  const bad = await tools.dataflow.execute({ edits: "", supersede: { nothing: "source" } });
  expect(bad.operators.find((o: any) => o.op === "supersede")?.status).toBe("error");
  const bound = await tools.dataflow.execute({ edits: "", bind: [{ target: "wider", as: "again", versions: { source: "v1" } }] });
  expect(bound.operators.find((o: any) => o.op === "bind")?.message).toMatch(/does not read any version/);
  const { tools: plain } = nativeTestTools(undefined, { settings: { nativeAnalysisState: true } } as any);
  const refused = await plain.dataflow.execute({ edits: "", explain: ["x"] });
  expect(String(refused.output ?? refused)).toMatch(/require nativeDefinitionRegistry/);
  const schema = nativeBatchSchema({ analysisState: true, definitionRegistry: true }) as any;
  expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["bind", "supersede", "explain"]));
  expect(Object.keys((nativeBatchSchema({ analysisState: true }) as any).properties)).not.toContain("bind");
});

test("a bind's internal restore is planned even when the model-facing restore field is off", async () => {
  const registry = new DefinitionRegistry();
  // A history in which `source` was revised in place at task 2 and its task-1 version was retained.
  const taskHistory = {
    provenance: () => new Map([["source", { created: 1, edited: [2], lastSaved: 2, gaps: [] }], ["report", { created: 2, edited: [], lastSaved: 2, gaps: [] }]]),
    available: (id: string) => (id === "source" ? [1, 2] : [2]),
    definition: (id: string, task: number) =>
      id === "source" && task === 1
        ? ({ operator: { operatorID: "source", nativeOp: { type: "Scan", inputs: [], source: 'source = scan("data/one.csv")', revision: "r1", properties: {} } }, info: {}, artifact: { path: "", sha256: "", rowCount: 0 } } as any)
        : undefined,
    entries: () => [],
  } as any;
  const { state, tools } = nativeTestTools(undefined, {
    settings: { nativeAnalysisState: true, nativeTaskEfficiency: true, nativeDefinitionRegistry: true, nativeTaskRestore: false },
    definitionRegistry: registry,
    taskHistory,
    activeTaskNumber: () => 3,
  } as any);
  await tools.dataflow.execute({ edits: 'source = scan("data/two.csv")\nreport = limit(source, 1)' });
  const result = await tools.dataflow.execute({
    edits: "",
    bind: [{ target: "report", as: "report_v1", versions: { source: "v1" } }],
  });
  const messages = result.operators.map((o: any) => `${o.id}:${o.op}:${o.status}:${o.message}`).join("\n");
  expect(messages).not.toContain("keeps no task history");
  expect(result.notes).toEqual(["report_v1: source v2 → v1 (source__v1)"]);
  expect(state.getOperator("source__v1")?.nativeOp?.source).toContain("data/one.csv");
  expect(state.getOperator("report_v1")?.nativeOp?.inputs).toEqual(["source__v1"]);
  // The model's own restore request still follows the toggle.
  const own = await tools.dataflow.execute({ edits: "", restore: [{ operator: "source", task: 1, as: "again" }] });
  expect(own.operators[0].message).toContain("keeps no task history to restore from");
});

test("registry receipts hint at unretained fits and literal assumptions once per call", async () => {
  const registry = new DefinitionRegistry();
  const { tools } = nativeTestTools(undefined, {
    settings: { nativeAnalysisState: true, nativeTaskEfficiency: true, nativeDefinitionRegistry: true },
    definitionRegistry: registry,
    activeTaskNumber: () => 1,
  } as any);
  const result = await tools.dataflow.execute({
    edits: [
      'source = scan("data/test.csv")',
      "def fit(df):",
      "    from sklearn.linear_model import LinearRegression",
      "    import pandas as pd",
      "    cut = 0.995; lo = 0.01; hi = 0.99; k = 12",
      "    return pd.DataFrame({'ok': [cut + lo + hi + k]})",
      'model = process(source, fn=fit, doc="Fits a line")',
    ].join("\n"),
  });
  const model = result.operators.find((o: any) => o.id === "model");
  expect(model.status).toBe("added");
  expect(model.message).toContain("Hint: this fits a model");
  expect(model.message).toContain("numeric assumptions are inside this code");
});

test("the compare operator executes in the engine runtime: keys, membership and deltas", () => {
  const { compileNativeOp } = require("./codegen") as typeof import("./codegen");
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const { fileURLToPath } = require("node:url") as typeof import("node:url");
  const python = process.env.UDF_PYTHON_PATH ?? fileURLToPath(new URL("../../../../.venv/bin/python", import.meta.url));
  const code = compileNativeOp({ type: "Compare", inputs: ["a", "b"], properties: { keys: ["name"] } }, "diff").code;
  const result = spawnSync(
    python,
    [
      "-I",
      "-c",
      [
        "import sys, pandas as pd",
        "scope = {}",
        "exec(sys.stdin.read(), scope)",
        'a = pd.DataFrame({"name": ["x", "y"], "v": [1.0, 2.0], "label": ["p", "q"]})',
        'b = pd.DataFrame({"name": ["y", "z"], "v": [2.5, 3.0], "label": ["q", "r"]})',
        "out = scope['process'](a, b)",
        "print(out.to_json(orient='records'))",
        "print(list(out.columns))",
        "print(out.attrs['native_v2']['operations']['compare'])",
      ].join("\n"),
    ],
    { input: code, encoding: "utf8", timeout: 60_000 }
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const [records, columns, operations] = result.stdout.trim().split("\n");
  expect(JSON.parse(records)).toEqual([
    { name: "x", in_a: true, in_b: false, v_a: 1.0, v_b: null, v_delta: null, label_a: "p", label_b: null },
    { name: "y", in_a: true, in_b: true, v_a: 2.0, v_b: 2.5, v_delta: 0.5, label_a: "q", label_b: "q" },
    { name: "z", in_a: false, in_b: true, v_a: null, v_b: 3.0, v_delta: null, label_a: null, label_b: "r" },
  ]);
  expect(columns).toBe("['name', 'in_a', 'in_b', 'v_a', 'v_b', 'v_delta', 'label_a', 'label_b']");
  expect(operations).toContain("'inBoth': 1, 'onlyA': 1, 'onlyB': 1");
  expect(operations).toContain("'changed': {'v': 1, 'label': 0}");
});

test("the registry prompt and settings: text is present, it requires efficiency, and it cannot change mid-session", () => {
  const prompt = buildNativeModeSystemPrompt(undefined, {
    taskCatalog: true,
    taskHistory: true,
    analysisState: true,
    taskEfficiency: true,
    definitionRegistry: true,
    reasoning: true,
  });
  expect(prompt).toContain("# Definitions");
  expect(prompt).toContain('bind=[{"target"');
  expect(prompt).toContain("compare(new_table, old_table");
  expect(prompt).toContain("supersede=");
  expect(prompt).toContain("compare(A, B, keys=");
  expect(prompt).toContain("Entries show each function's code once");
  expect(buildNativeModeSystemPrompt(undefined, { taskCatalog: true, taskHistory: true, analysisState: true, taskEfficiency: true, definitionRegistry: true, definitionSignatures: true })).toContain("signature only");
  expect(() => validateNativeSettings({ nativeDefinitionRegistry: true })).toThrow(NativeCatalogSettingsError);
  expect(() => validateNativeSettings({ nativeDefinitionSignatures: true, nativeTaskEfficiency: true, nativeTaskHistory: true, nativeTaskContext: true, nativeAnalysisState: true })).toThrow(/requires nativeDefinitionRegistry/);
  const agent = new TexeraAgent({
    agentId: "registry-setting",
    modelType: "test",
    driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
    contextAssembler: () => [],
  });
  agent.updateSettings({
    nativeTaskHistory: true,
    nativeTaskContext: true,
    nativeAnalysisState: true,
    nativeTaskEfficiency: true,
    nativeDefinitionRegistry: true,
  });
  expect(agent.getSettings().nativeDefinitionRegistry).toBe(true);
  expect(agent.getSettings().systemPrompt).toContain("# Definitions");
  (agent as any).stepsById.set("u", { id: "u", role: "user", isBegin: true });
  expect(() => agent.updateSettings({ nativeDefinitionRegistry: false })).toThrow("fresh session");
});
