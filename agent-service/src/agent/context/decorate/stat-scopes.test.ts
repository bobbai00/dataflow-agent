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
 * Position-aware stat scopes. The asymmetry under test: a SOURCE operator (no
 * inbound link) can only lose data at parse time, a CONSUMER only inside its own
 * transform — so each channel should render where its failure lives and stay
 * silent elsewhere, WITHOUT touching the flag that enabled it.
 */

import { describe, expect, test } from "bun:test";
import { assembleContext } from "../../util/context-utils";
import { WorkflowSnapshotStorage } from "../../workflow-snapshot-storage";
import { WorkflowState } from "../../workflow-state";
import { AgentMode, ContextMode, type ReActStep } from "../../../types/agent";
import type { WorkflowContent } from "../../../types/workflow";
import type { OperatorInfo } from "../../../types/execution";

const SRC = "load_src";
const DOWN = "join_dn";

function step(over: Partial<ReActStep> & Pick<ReActStep, "id" | "stepId" | "role">): ReActStep {
  return { messageId: "m", parentId: undefined, timestamp: 1, content: "", isBegin: true, isEnd: true, ...over } as ReActStep;
}

/** src -> dn, so `src` is a source (no inbound link) and `dn` is a consumer. */
function workflow(): WorkflowContent {
  const op = (id: string, hasInput: boolean) => ({
    operatorID: id, operatorType: "DataProcessing", operatorVersion: "1",
    operatorProperties: {}, inputPorts: hasInput ? [{ portID: "input-0" }] : [],
    outputPorts: [{ portID: "output-0" }], showAdvanced: false,
  });
  return {
    operators: [op(SRC, false), op(DOWN, true)],
    operatorPositions: {},
    links: [{ linkID: "l1", source: { operatorID: SRC, portID: "output-0" }, target: { operatorID: DOWN, portID: "input-0" } }],
    commentBoxes: [], settings: { dataTransferBatchSize: 400 },
  } as unknown as WorkflowContent;
}

/** Result carrying every data-facet signal: column stats, a structural hint,
 *  a dirty currency tag (value-format), and row counts that imply loss. */
function richInfo(opId: string, inTuples: number, outTuples: number): OperatorInfo {
  return {
    operatorID: opId, state: "Completed",
    inputTuples: inTuples, outputTuples: outTuples, totalRowCount: outTuples,
    result: [{ amt: "$1,200", region: "East" }, { amt: "$3,400", region: "West" }],
    columnStats: {
      amt: "(str): null=0, distinct=2, format=currency",
      region: "(str): null=0, distinct=2",
      __table_hints__: 'duplicate rows: 1 of 2 (50%)',
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
      toolCalls: [
        { toolName: "createOrModifyOperator", toolCallId: "c1", input: { operatorId: SRC } },
        { toolName: "createOrModifyOperator", toolCallId: "c2", input: { operatorId: DOWN } },
      ] as any,
      toolResults: [
        { toolCallId: "c1", output: "ok", isError: false },
        { toolCallId: "c2", output: "ok", isError: false },
      ] as any }),
  ];
  const byId = new Map(steps.map(s => [s.id, s]));
  const storage = new WorkflowSnapshotStorage(id => {
    const chain: string[] = []; let cur: string | undefined = id;
    while (cur) { chain.unshift(cur); cur = byId.get(cur)?.parentId; }
    return chain;
  });
  storage.createSnapshot("t1", workflow());
  storage.setOperatorResult("t1", SRC, richInfo(SRC, 0, 2));   // source: no input rows
  storage.setOperatorResult("t1", DOWN, richInfo(DOWN, 12, 2)); // consumer: 12 in -> 2 out

  // WorkflowState mirrors the same DAG so isSourceOperator can see the link.
  const ws = new WorkflowState();
  ws.setWorkflowContent(workflow());
  return { steps, storage, ws };
}

function render(statScopes: unknown): string {
  const { steps, storage, ws } = scenario();
  const msgs = assembleContext(steps, ws, storage, ContextMode.LATEST, {
    compilationResult: null,
    agentMode: AgentMode.CODE,
    schemaInResult: true,
    columnStats: true,
    coercionTelemetry: true,
    rowLineage: true,
    tableStructureHint: true,
    valueFormatFlags: true,
    maxResultRows: 5,
    statScopes,
  } as never);
  return msgs.map(m => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
}

/** Text of one operator's block, so a channel can be attributed to a position. */
function blockOf(text: string, opId: string): string {
  // Split on the operator header — a downstream block mentions the upstream id
  // in its `Inputs:` line, so searching for the other id truncates the block.
  const parts = text.split("### Operator ");
  return parts.find(p => p.startsWith(`\`${opId}\``)) ?? "";
}

describe("statScopes — position-aware channel gating", () => {
  test("undefined and {} render identically (no gating configured)", () => {
    expect(render(undefined)).toBe(render({}));
  });

  test("both operators carry column stats when unscoped", () => {
    const t = render({});
    expect(blockOf(t, SRC)).toContain("distinct=2");
    expect(blockOf(t, DOWN)).toContain("distinct=2");
  });

  test("columnStats scoped to source renders on the source only", () => {
    const t = render({ columnStats: "source" });
    expect(blockOf(t, SRC)).toContain("distinct=2");
    expect(blockOf(t, DOWN)).not.toContain("distinct=2");
  });

  test("columnStats scoped to nonsource renders on the consumer only", () => {
    const t = render({ columnStats: "nonsource" });
    expect(blockOf(t, SRC)).not.toContain("distinct=2");
    expect(blockOf(t, DOWN)).toContain("distinct=2");
  });

  test("'off' silences the channel everywhere but leaves the rest intact", () => {
    const t = render({ columnStats: "off" });
    expect(t).not.toContain("distinct=2");
    expect(t.length).toBeGreaterThan(0);
    expect(t).toContain(SRC);
    expect(t).toContain(DOWN);
  });

  test("source and nonsource are complementary — together they equal all", () => {
    const all = render({ columnStats: "all" });
    const src = render({ columnStats: "source" });
    const dn = render({ columnStats: "nonsource" });
    const off = render({ columnStats: "off" });
    // every partial is shorter than all-on and longer than fully-off
    for (const partial of [src, dn]) {
      expect(partial.length).toBeLessThan(all.length);
      expect(partial.length).toBeGreaterThan(off.length);
    }
    expect(src).not.toBe(dn);
  });

  test("the motivating combo differs from all-on and stays non-empty", () => {
    const combo = render({ coercion: "source", fileIo: "source", lineage: "nonsource", columnStats: "nonsource" });
    expect(combo).not.toBe(render({}));
    expect(combo).toContain(SRC);
    expect(combo).toContain(DOWN);
  });

  test("scoping is deterministic", () => {
    const a = render({ columnStats: "nonsource", lineage: "nonsource" });
    const b = render({ columnStats: "nonsource", lineage: "nonsource" });
    expect(a).toBe(b);
  });
});
