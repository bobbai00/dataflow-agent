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
 * End-to-end DECORATE level matrix through the public assembleContext API.
 * Builds one scenario whose single operator carries a result + columnStats with
 * a structural hint and a dirty-value tag, then asserts which decoration lines
 * appear at each (flowLevel, dataLevel) — the cheap→rich ladder behavior — plus
 * determinism and the level↔boolean equivalence at the assembler boundary.
 */

import { describe, expect, test } from "bun:test";
import { assembleContext } from "../../util/context-utils";
import { WorkflowSnapshotStorage } from "../../workflow-snapshot-storage";
import { WorkflowState } from "../../workflow-state";
import { AgentMode, ContextMode, type ReActStep } from "../../../types/agent";
import type { WorkflowContent } from "../../../types/workflow";
import type { OperatorInfo } from "../../../types/execution";

const opts = { compilationResult: null, agentMode: AgentMode.CODE };

function step(over: Partial<ReActStep> & Pick<ReActStep, "id" | "stepId" | "role">): ReActStep {
  return {
    messageId: "m", parentId: undefined, timestamp: 1, content: "", isBegin: true, isEnd: true,
    ...over,
  } as ReActStep;
}

function workflow(ids: string[]): WorkflowContent {
  return {
    operators: ids.map(id => ({
      operatorID: id, operatorType: "DataProcessing", operatorVersion: "1",
      operatorProperties: {}, inputPorts: [], outputPorts: [], showAdvanced: false,
    })),
    operatorPositions: {}, links: [], commentBoxes: [], settings: { dataTransferBatchSize: 400 },
  } as unknown as WorkflowContent;
}

/** info with a result + columnStats carrying a structural hint (__table_hints__)
 *  and a dirty currency tag (format=currency) so data L2 and L3 are observable. */
function richInfo(opId: string): OperatorInfo {
  return {
    operatorID: opId, state: "Completed", inputTuples: 0, outputTuples: 2, totalRowCount: 2,
    result: [{ amt: "$1,200", region: "East" }, { amt: "$3,400", region: "West" }],
    columnStats: {
      amt: "(str): null=0, distinct=2, format=currency",
      region: "(str): null=0, distinct=2",
      __table_hints__: 'duplicate rows: 1 of 2 (50%) || empty columns: ["notes"] are entirely null',
    },
  } as unknown as OperatorInfo;
}

function scenario() {
  const steps = [
    step({ id: "init", stepId: 0, role: "agent", content: "init",
      toolCalls: [{ toolName: "initialize", toolCallId: "t0", input: {} }] as any,
      toolResults: [{ toolCallId: "t0", output: "ok", isError: false }] as any }),
    step({ id: "user", stepId: 0, role: "user", parentId: "init", content: "go" }),
    step({ id: "t1", stepId: 1, role: "agent", parentId: "user", content: "build",
      isBegin: true, isEnd: false,
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t1c", input: { operatorId: "p" } }] as any,
      toolResults: [{ toolCallId: "t1c", output: "ok", isError: false }] as any }),
  ];
  const byId = new Map(steps.map(s => [s.id, s]));
  const storage = new WorkflowSnapshotStorage(id => {
    const chain: string[] = []; let cur: string | undefined = id;
    while (cur) { chain.unshift(cur); cur = byId.get(cur)?.parentId; }
    return chain;
  });
  storage.createSnapshot("t1", workflow(["p"]));
  storage.setOperatorResult("t1", "p", richInfo("p"));
  return { steps, storage, ws: new WorkflowState() };
}

function render(over: Record<string, unknown>): string {
  const { steps, storage, ws } = scenario();
  const msgs = assembleContext(steps, ws, storage, ContextMode.LATEST, { ...opts, ...over });
  const c = msgs[0]?.content;
  return typeof c === "string" ? c : JSON.stringify(c);
}

describe("DECORATE level matrix (e2e via assembleContext)", () => {
  test("data L0: no schema, no structural hints, no value-format", () => {
    const c = render({ dataLevel: 0, flowLevel: 0 });
    expect(c).not.toContain("Schema (");
    expect(c).not.toContain('Output Table profile:');
    expect(c).not.toContain("Format hints:");
  });

  test("data L1: schema appears; structural + value-format still absent", () => {
    const c = render({ dataLevel: 1 });
    expect(c).toContain("Schema (");
    expect(c).not.toContain('Output Table profile:');
    expect(c).not.toContain("Format hints:");
  });

  test("data L2: schema + structural profile (the win); value-format still absent", () => {
    const c = render({ dataLevel: 2 });
    expect(c).toContain("Schema (");
    expect(c).toContain('Output Table profile:');
    expect(c).toContain('empty columns: ["notes"]');
    expect(c).not.toContain("Format hints:");
  });

  test("data L3: adds value-format on top of L2", () => {
    const c = render({ dataLevel: 3 });
    expect(c).toContain("Schema (");
    expect(c).toContain('Output Table profile:');
    expect(c).toContain("Format hints:");
    expect(c).toContain("strip $");
  });

  test("ladder is monotone in content: each level ⊇ the previous", () => {
    const l1 = render({ dataLevel: 1 });
    const l2 = render({ dataLevel: 2 });
    const l3 = render({ dataLevel: 3 });
    // every marker present at Lk is present at L(k+1)
    expect(l1.includes("Schema (")).toBe(true);
    expect(l2.includes("Schema (") && l2.includes('Output Table profile:')).toBe(true);
    expect(l3.includes("Schema (") && l3.includes('Output Table profile:') && l3.includes("Format hints:")).toBe(true);
  });

  test("header-resolution hint renders through the structural-profile rung (data L2)", () => {
    // simulate the worker having published a header hint on __table_hints__
    const { steps, storage, ws } = scenario();
    const info = richInfo("p");
    (info as any).columnStats.__table_hints__ =
      "header: 2 of 5 columns are unnamed/placeholder (Unnamed:N) -> re-read with header=/skiprows=";
    storage.setOperatorResult("t1", "p", info);
    const msgs = assembleContext(steps, ws, storage, ContextMode.LATEST, { ...opts, dataLevel: 2 });
    const c = typeof msgs[0]?.content === "string" ? (msgs[0].content as string) : "";
    expect(c).toContain('Output Table profile:');
    expect(c).toContain("header: 2 of 5 columns are unnamed/placeholder");
  });

  test("determinism: assembling twice yields identical output (pure decorators)", () => {
    expect(render({ flowLevel: 3, dataLevel: 3 })).toBe(render({ flowLevel: 3, dataLevel: 3 }));
  });

  test("level↔boolean equivalence at the data facet", () => {
    const viaLevel = render({ dataLevel: 3 });
    const viaBool = render({ schemaInResult: true, tableStructureHint: true, valueFormatFlags: true });
    expect(viaLevel).toBe(viaBool);
  });
});
