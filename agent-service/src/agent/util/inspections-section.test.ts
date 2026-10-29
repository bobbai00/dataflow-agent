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
import { assembleContext } from "./context-utils";
import { buildScenario, makeInfo, makeWorkflow, renderText, type Scenario } from "../context/summarize/fixtures";

const PULL_OUTPUT =
  "Inspection of `loader` (where nonnumeric:amount) — showing 2 of 2 matching sampled row(s), 3 column(s):\n" +
  "Output Table: 2 rows, 3 cols\n\tid\tamount\n0\t7\tN/A\n1\t9\tn.a.";

/** ev2: create loader; ev3: inspect it (pull); ev4: create clean. */
function pullScenario(): Scenario {
  const scenario = buildScenario([
    { id: "u", stepId: 0, role: "user", messageId: "m", content: "parse the file" },
    {
      id: "a1",
      stepId: 1,
      role: "agent",
      messageId: "m",
      parentId: "u",
      content: "load",
      toolCalls: [{ toolName: "noop", toolCallId: "t1", input: {} }],
      toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
    },
    {
      id: "a2",
      stepId: 2,
      role: "agent",
      messageId: "m",
      parentId: "a1",
      content: "check the contaminants",
      toolCalls: [
        {
          toolName: "inspectResult",
          toolCallId: "t2",
          input: { operatorId: "loader", where: "nonnumeric:amount", maxRows: 20 },
        },
      ],
      toolResults: [{ toolCallId: "t2", output: PULL_OUTPUT, isError: false }],
    },
    {
      id: "a3",
      stepId: 3,
      role: "agent",
      messageId: "m",
      parentId: "a2",
      content: "clean it",
      toolCalls: [{ toolName: "noop", toolCallId: "t3", input: {} }],
      toolResults: [{ toolCallId: "t3", output: "ok", isError: false }],
    },
  ]);
  scenario.storage.createSnapshot("a1", makeWorkflow([{ id: "loader", type: "DataLoading" }]));
  scenario.storage.setOperatorResult("a1", "loader", makeInfo(100));
  scenario.storage.createSnapshot(
    "a3",
    makeWorkflow(
      [
        { id: "loader", type: "DataLoading" },
        { id: "clean", type: "DataProcessing", numInputPorts: 1 },
      ],
      [["loader", "clean"]]
    )
  );
  scenario.storage.setOperatorResult("a3", "clean", makeInfo(90));
  return scenario;
}

const OPTS = { maxResultRows: 3 } as const;

describe("inspection pulls", () => {
  test("fresh error inspections never advertise a removed result tool", () => {
    const scenario = pullScenario();
    const inspected = scenario.steps.find(step => step.id === "a2")!;
    inspected.toolCalls![0].toolName = "inspectError";
    inspected.toolResults![0].output = "CALLBACK_RUNTIME: diagnostic marker";
    const text = JSON.stringify(assembleContext(scenario.steps, scenario.workflowState, scenario.storage, { ...OPTS }));
    expect(text).toContain("CALLBACK_RUNTIME: diagnostic marker");
    expect(text).not.toContain("inspectResult");
  });

  test("DELTA keeps the pull's output at its event, not in a trailing section", () => {
    const text = renderText(pullScenario(), OPTS);
    const pull = text.slice(text.indexOf("## Agent Event 3"), text.indexOf("## Agent Event 4"));
    expect(pull).toContain("- inspectResult output:");
    expect(pull).toContain("n.a.");
    expect(text).not.toContain("# Inspections");
  });
});
