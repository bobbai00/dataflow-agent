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
import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import { formatKeptFrames, frameViewId, frameViewSpec, keptFramesOf, parseFrameReference } from "./kept-frames";
import { TaskHistory, type RetainedResult } from "./task-history";
import { createNativeBatchTools, nativeBatchSchema } from "../tools/native-batch-tools";
import { validateNativeCatalogSettings } from "./settings";
import { WorkflowState } from "../workflow-state";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import { assembleTaskContext } from "./task-context";
import { DEFAULT_AGENT_SETTINGS } from "../../types/agent";

const CODE =
  "import pandas as pd\n\ndef process(a):\n    w = a.assign(x2=a['x'] * 2)\n    pm = w.head(1)\n    return pd.DataFrame({'answer': [str(len(pm))]})\n";

const profileFor = (resultVersion: string, keptFrames: unknown) =>
  ({
    state: "Completed",
    resultMode: "table",
    result: [{ answer: "1" }],
    totalRowCount: 1,
    displayedRows: 1,
    truncated: false,
    resultSchema: [{ name: "answer", type: "string", encoding: "utf8" }],
    resultVersion: { id: resultVersion, complete: true },
    materialization: { outputPort: 0, executionId: "e1", cached: false },
    tableProfile: {
      status: "available",
      resultVersion,
      native: { operatorType: "UDF", operations: { keptFrames } },
    },
  }) as any;

const frames = [
  {
    name: "w",
    rows: 86,
    columns: [
      { name: "x", dtype: "int64" },
      { name: "x2", dtype: "int64" },
    ],
  },
  {
    name: "pm",
    rows: 1,
    columns: [
      { name: "x", dtype: "int64" },
      { name: "x2", dtype: "int64" },
    ],
    more: 7,
  },
];

const artifact = (execution: string): RetainedResult => ({
  path: `/tmp/archive/${execution}.arrow`,
  sha256: "a".repeat(64),
  rowCount: 1,
});

function setup(keptFrames = true) {
  const state = new WorkflowState();
  const metadata = new WorkflowSystemMetadata();
  metadata.seedCodeModeDefaults();
  const history = new TaskHistory(async () => artifact("11"));
  const tools = createNativeBatchTools(
    state,
    { metadataStore: metadata, taskHistory: history, settings: { nativeKeptFrames: keptFrames } },
    "v2"
  );
  return { state, history, dataflow: (args: Record<string, unknown>) => tools.dataflow.execute(args) };
}

describe("kept frames", () => {
  test("frames come only from the profile of exactly this result version", () => {
    expect(keptFramesOf(profileFor("r1", frames))).toEqual(frames);
    expect(keptFramesOf({ ...profileFor("r1", frames), resultVersion: { id: "r2" } })).toEqual([]);
    expect(keptFramesOf({ ...profileFor("r1", frames), error: "boom" })).toEqual([]);
    expect(keptFramesOf(profileFor("r1", [{ name: "not valid", rows: 1, columns: [] }, ...frames]))).toEqual(frames);
    expect(keptFramesOf(profileFor("r1", "garbage"))).toEqual([]);
    expect(formatKeptFrames(frames)).toBe("w(86×2: x,x2); pm(1×9: x,x2, …+7)");
    const wide = [
      { name: "w", rows: 1, columns: Array.from({ length: 40 }, (_, i) => ({ name: `column_${i}`, dtype: "int64" })) },
    ];
    const text = formatKeptFrames(wide, 60);
    // As many column names as fit the budget, then the count of the rest.
    expect(text).toBe("w(1×40: column_0,column_1,column_2,column_3,column_4,column_5, …+34)");
    expect(text.length).toBeLessThan(90);
  });

  test("a frame reference names a udf local, live or at a completed task", () => {
    expect(parseFrameReference({ operator: "report", frame: "w" })).toEqual({ operator: "report", frame: "w" });
    expect(parseFrameReference({ operator: "report", frame: "w", atTask: 2 })).toEqual({
      operator: "report",
      frame: "w",
      atTask: 2,
    });
    expect(parseFrameReference({ operator: "report", atTask: 2 })).toBeUndefined();
    expect(parseFrameReference({ operator: "report", frame: "w", extra: 1 })).toBeUndefined();
    expect(parseFrameReference({ operator: "report", frame: "not valid" })).toBeUndefined();
    expect(frameViewId({ operator: "report", frame: "w" })).toBe("report__w");
    expect(frameViewId({ operator: "report", frame: "w", atTask: 2 })).toBe("report__w__at2");
    const parent = {
      operatorID: "report",
      nativeOp: {
        type: "UDF",
        properties: { code: CODE },
        inputs: ["a", "task_archive_x"],
        taskInputs: ["a", { operator: "b", atTask: 1 }],
      },
    } as any;
    expect(frameViewSpec({ operator: "report", frame: "w" }, parent)).toEqual({
      op: "udf",
      id: "report__w",
      inputs: ["a", { operator: "b", atTask: 1 }],
      code: CODE,
      frame: "w",
    });
    // A replay reads every live input as retained at that task; fixed inputs stay fixed.
    expect(frameViewSpec({ operator: "report", frame: "w", atTask: 3 }, parent).inputs).toEqual([
      { operator: "a", atTask: 3 },
      { operator: "b", atTask: 1 },
    ]);
    expect(() =>
      frameViewSpec({ operator: "a", frame: "w" }, { operatorID: "a", nativeOp: { type: "Scan" } } as any)
    ).toThrow("only udf locals");
  });

  test("the input schema offers frame references only with kept frames on", () => {
    const plain = new Ajv({ strict: false }).compile(nativeBatchSchema("v2", { taskHistory: true }));
    const enabled = new Ajv({ strict: false }).compile(
      nativeBatchSchema("v2", { taskHistory: true, keptFrames: true })
    );
    const batch = (input: unknown) => ({ operators: [{ op: "project", id: "p", input, keep: ["x"] }] });
    expect(plain(batch({ operator: "report", frame: "w" }))).toBe(false);
    expect(enabled(batch({ operator: "report", frame: "w" }))).toBe(true);
    expect(enabled(batch({ operator: "report", atTask: 2, frame: "w" }))).toBe(true);
    expect(enabled(batch({ operator: "report", atTask: 2 }))).toBe(true);
    expect(enabled(batch({ operator: "report", frame: "" }))).toBe(false);
    // The runtime-owned `frame` property is not offered to the model at all.
    expect(JSON.stringify(nativeBatchSchema("v2", { taskHistory: true, keptFrames: true }))).not.toContain(
      '"frame":{"type":"string"}'
    );
    expect(enabled({ operators: [{ op: "udf", id: "u", inputs: [], code: "def load(): pass", frame: "w" }] })).toBe(
      false
    );
  });

  test("the setting needs the profile channel and task history", () => {
    const base = { agentMode: "native", nativeToolMode: "batch", nativeCatalogVersion: "v2" as const };
    expect(() => validateNativeCatalogSettings({ ...base, nativeKeptFrames: true })).toThrow("nativeProfileCollection");
    expect(
      validateNativeCatalogSettings({
        ...base,
        nativeKeptFrames: true,
        nativeProfileCollection: true,
        nativeTaskHistory: true,
      })
    ).toBe("v2");
  });

  test("a frame reference synthesizes a derived view; editing the udf refreshes it", async () => {
    const { state, dataflow } = setup();
    const first = await dataflow({
      operators: [
        { op: "scan", id: "a", files: "data/a.csv" },
        { op: "udf", id: "report", inputs: ["a"], code: CODE },
        { op: "project", id: "wide", input: { operator: "report", frame: "w" }, keep: ["x2"] },
      ],
    });
    expect(first.operators.map((o: any) => [o.id, o.status])).toEqual([
      ["a", "added"],
      ["report", "added"],
      ["wide", "added"],
      ["report__w", "added"],
    ]);
    const view = state.getOperator("report__w")!;
    expect(view.nativeOp).toMatchObject({
      type: "UDF",
      inputs: ["a"],
      properties: { code: CODE, frame: "w" },
      frameOf: { operator: "report", frame: "w" },
      keepFrames: true,
    });
    expect(state.getOperator("report")!.nativeOp!.keepFrames).toBe(true);
    expect(state.getOperator("report")!.nativeOp!.frameOf).toBeUndefined();
    expect(state.getDownstreamOperators("a")).toEqual(expect.arrayContaining(["report", "report__w"]));
    expect(state.getDownstreamOperators("report__w")).toEqual(["wide"]);
    expect(state.getDownstreamOperators("report")).toEqual([]);
    const revision = view.nativeOp!.revision;

    // The same reference again reuses the view; nothing is duplicated.
    const again = await dataflow({
      operators: [{ op: "project", id: "narrow", input: { operator: "report", frame: "w" }, keep: ["x"] }],
    });
    expect(again.operators.map((o: any) => [o.id, o.status])).toEqual([["narrow", "added"]]);

    // Editing the parent regenerates its live views with the new code.
    const edited = CODE.replace("* 2", "* 3");
    const modify = await dataflow({ operators: [{ op: "udf", id: "report", inputs: ["a"], code: edited }] });
    expect(modify.operators.map((o: any) => [o.id, o.status])).toEqual([
      ["report", "modified"],
      ["report__w", "modified"],
    ]);
    expect(state.getOperator("report__w")!.nativeOp!.properties.code).toBe(edited);
    expect(state.getOperator("report__w")!.nativeOp!.revision).not.toBe(revision);

    // frame is runtime-owned; a model-authored one is refused before any write.
    const authored = await dataflow({ operators: [{ op: "udf", id: "mine", inputs: ["a"], code: CODE, frame: "w" }] });
    expect(authored.operators[0].status).toBe("error");
    expect(authored.operators[0].message).toContain("runtime-owned");
    expect(state.getOperator("mine")).toBeUndefined();

    // A frame of a non-udf, or of nothing, is an error on the referencing item only.
    const bad = await dataflow({
      operators: [
        { op: "project", id: "p1", input: { operator: "a", frame: "w" }, keep: ["x"] },
        { op: "project", id: "p2", input: { operator: "ghost", frame: "w" }, keep: ["x"] },
        { op: "project", id: "p3", input: { operator: "report", frame: "w", junk: 1 }, keep: ["x"] },
      ],
    });
    expect(bad.operators.map((o: any) => o.status)).toEqual(["error", "error", "error"]);
    expect(bad.operators[0].message).toContain("only udf locals");
    expect(bad.operators[1].message).toContain("does not exist");
    expect(bad.operators[2].message).toContain("Invalid frame reference");
  });

  test("a frame at a completed task replays that task's definition over its retained inputs", async () => {
    const { state, history, dataflow } = setup();
    await dataflow({
      operators: [
        { op: "scan", id: "a", files: "data/a.csv" },
        { op: "udf", id: "report", inputs: ["a"], code: CODE },
      ],
    });
    const results = new Map(
      ["a", "report"].map(id => [
        id,
        { ...profileFor("r-" + id, []), materialization: { outputPort: 0, executionId: id } },
      ])
    );
    await history.seal(1, state.getAllOperators(), results as any, state.getAllLinks());
    // The parent changes afterwards; the replay must use the sealed code.
    const edited = CODE.replace("* 2", "* 3");
    await dataflow({ operators: [{ op: "udf", id: "report", inputs: ["a"], code: edited }] });
    const replay = await dataflow({
      operators: [
        { op: "project", id: "old_wide", input: { operator: "report", atTask: 1, frame: "w" }, keep: ["x2"] },
      ],
    });
    expect(replay.operators.map((o: any) => [o.id, o.status])).toEqual([
      ["old_wide", "added"],
      ["report__w__at1", "added"],
    ]);
    const view = state.getOperator("report__w__at1")!;
    expect(view.nativeOp!.properties).toEqual({ code: CODE, frame: "w" });
    expect(view.nativeOp!.frameOf).toEqual({ operator: "report", frame: "w", atTask: 1 });
    expect(view.nativeOp!.taskInputs).toEqual([{ operator: "a", atTask: 1 }]);
    expect(view.nativeOp!.inputs[0]).toMatch(/^task_archive_/);
    expect(state.getDownstreamOperators("a")).not.toContain("report__w__at1");
    // Not sealed at that task: no replay, no partial writes.
    const missing = await dataflow({
      operators: [{ op: "project", id: "p", input: { operator: "report", atTask: 2, frame: "w" }, keep: ["x2"] }],
    });
    expect(missing.operators[0].status).toBe("error");
    expect(missing.operators[0].message).toContain("unavailable");
    expect(state.getOperator("report__w__at2")).toBeUndefined();
  });

  test("the catalog lists a udf's frames and names a view by the local it returns", async () => {
    const { state, dataflow } = setup();
    await dataflow({
      operators: [
        { op: "scan", id: "a", files: "data/a.csv" },
        { op: "udf", id: "report", inputs: ["a"], code: CODE },
        { op: "project", id: "wide", input: { operator: "report", frame: "w" }, keep: ["x2"] },
      ],
    });
    // Results as the renderer reads them, without the binding rules of a live snapshot.
    const results = new Map([["report", profileFor("r1", frames)]]);
    const storage = new (class extends WorkflowSnapshotStorage {
      override getOperatorResult(_step: string | undefined, id: string) {
        return results.get(id);
      }
      override getAllVisibleResults() {
        return results;
      }
    })(() => []);
    const render = (nativeKeptFrames: boolean) =>
      String(
        assembleTaskContext({
          visibleSteps: [{ id: "u1", role: "user", messageId: "one", content: "Next", isBegin: true } as any],
          workflowState: state,
          snapshotStorage: storage,
          settings: { ...DEFAULT_AGENT_SETTINGS, systemPrompt: "", nativeCompactIndex: true, nativeKeptFrames },
          compilationResult: null,
        }).find(m => String(m.content).startsWith("# Current operator catalog"))!.content
      );
    const shown = render(true);
    expect(shown).toMatch(
      /^report = udf\(def process\(a\)\) <- a; schema=answer:string; Completed; rows=1; frames: w\(86×2: x,x2\); pm\(1×9: x,x2, …\+7\)$/m
    );
    expect(shown).toMatch(/^report__w = frame\(w of report\) <- a; schema=unknown; not executed$/m);
    expect(render(false)).not.toContain("frames:");
  });

  test("without the setting, frame references stay ordinary invalid inputs", async () => {
    const { dataflow } = setup(false);
    await dataflow({
      operators: [
        { op: "scan", id: "a", files: "data/a.csv" },
        { op: "udf", id: "report", inputs: ["a"], code: CODE },
      ],
    });
    const result = await dataflow({
      operators: [{ op: "project", id: "wide", input: { operator: "report", frame: "w" }, keep: ["x2"] }],
    });
    expect(result.operators[0].status).toBe("error");
  });
});
