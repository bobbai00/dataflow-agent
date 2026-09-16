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
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, test } from "bun:test";
import { AgentMode, ContextMode } from "../../types/agent";
import { assembleContext } from "./context-utils";
import { buildScenario, makeInfo, makeWorkflow, type Scenario } from "../context/summarize/fixtures";

/**
 * The measured case: three inputs of 354/353/353 rows joined to 210, in six
 * different arms, none of which noticed — and every one then scored 3.1 on the
 * task because the analysis ran over 210 of 353 teams. The Lineage line cannot
 * surface it (it divides by the SUM of inputs, so a broken join reads as a
 * filter), so retention is measured against the smallest input.
 */
function joinScenario(inputRows: number[], outputRows: number): Scenario {
  const ups = inputRows.map((_, i) => `src${i}`);
  const s = buildScenario([
    { id: "u1", stepId: 0, role: "user", messageId: "m1", content: "join them" },
    {
      id: "a1",
      stepId: 1,
      role: "agent",
      messageId: "m1",
      parentId: "u1",
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "joined" } }],
      toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
    },
  ]);
  // `links` is readonly on WorkflowContent, so build them through makeWorkflow's
  // own links parameter ([source, target, targetPort]) rather than assigning after.
  const wf = makeWorkflow(
    [...ups.map(id => ({ id, type: "DataLoading" })), { id: "joined", type: "DataProcessing" }],
    ups.map((id, i) => [id, "joined", i] as [string, string, number])
  );
  const joined = wf.operators.find((o: any) => o.operatorID === "joined") as any;
  joined.inputPorts = ups.map((_, i) => ({ portID: `input-${i}` }));
  s.storage.createSnapshot("a1", wf);
  ups.forEach(id => s.storage.setOperatorResult("a1", id, makeInfo(5, {})));
  const info: any = makeInfo(Math.min(outputRows, 5), {});
  info.totalRowCount = outputRows;
  info.inputPortShapes = inputRows.map((rows, i) => ({ portIndex: i, rows, columns: 2 }));
  s.storage.setOperatorResult("a1", "joined", info);
  return s;
}

const render = (s: Scenario): string =>
  String(
    assembleContext(s.steps, s.workflowState, s.storage, ContextMode.LATEST, {
      compilationResult: null,
      agentMode: AgentMode.CODE,
    } as any)
      .map(m => m.content)
      .join("\n")
  );

describe("legacy join heuristics are not context evidence", () => {
  test("row-count differences must not invent unmatched-row counts", () => {
    const text = render(joinScenario([354, 353, 353], 210));
    expect(text).not.toContain("Join retention:");
    expect(text).not.toContain("143 rows had no match");
    expect(text).not.toContain("the join key does not agree");
  });

  test("a join that keeps everything says nothing — no warning inflation", () => {
    const text = render(joinScenario([353, 353], 353));
    expect(text).not.toContain("Join retention");
  });

  test("a join that GROWS rows (many-to-many) says nothing either", () => {
    const text = render(joinScenario([353, 353], 700));
    expect(text).not.toContain("Join retention");
  });

  test("a single-input operator never gets the line — that is a filter, not a join", () => {
    const text = render(joinScenario([353], 10));
    expect(text).not.toContain("Join retention");
  });
});

/** Value loss: the same idea applied to values instead of rows. */
function coerceScenario(upNulls: number, upRows: number, outNulls: number, outRows: number): Scenario {
  const s = buildScenario([
    { id: "u1", stepId: 0, role: "user", messageId: "m1", content: "clean it" },
    {
      id: "a1",
      stepId: 1,
      role: "agent",
      messageId: "m1",
      parentId: "u1",
      toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "cleaned" } }],
      toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
    },
  ]);
  const wf = makeWorkflow(
    [
      { id: "raw", type: "DataLoading" },
      { id: "cleaned", type: "DataProcessing" },
    ],
    [["raw", "cleaned", 0]]
  );
  (wf.operators.find((o: any) => o.operatorID === "cleaned") as any).inputPorts = [{ portID: "input-0" }];
  s.storage.createSnapshot("a1", wf);
  const up: any = makeInfo(5, {});
  up.totalRowCount = upRows;
  up.columnStats = { amount: `null=${upNulls}, distinct=${upRows}` };
  s.storage.setOperatorResult("a1", "raw", up);
  const out: any = makeInfo(5, {});
  out.totalRowCount = outRows;
  out.columnStats = { amount: `null=${outNulls}, mean=1.0, min=0, max=2` };
  out.inputPortShapes = [{ portIndex: 0, rows: upRows, columns: 1 }];
  s.storage.setOperatorResult("a1", "cleaned", out);
  return s;
}
