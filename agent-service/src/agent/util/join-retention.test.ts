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
import { buildScenario, makeInfo, makeWorkflow, renderText, type Scenario } from "../context/summarize/fixtures";

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
      toolCalls: [{ toolName: "noop", toolCallId: "t1", input: {} }],
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

const render = (s: Scenario): string => renderText(s);

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
