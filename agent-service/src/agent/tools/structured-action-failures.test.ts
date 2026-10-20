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
import { prepareDataflowActions, runDataflowActions } from "./dataflow-actions";
import { prepareStructuredDataflowActions } from "./structured-dataflow-actions";

test.each(["throw", "outcome"] as const)("a typed read failure (%s) skips every later action", async mode => {
  const receipt = prepareStructuredDataflowActions({
    reasoning: "Read the tables, then report the total.",
    actions: [
      { type: "read", ids: ["missing"], view: "full", columns: null },
      { type: "read", ids: ["independent"], view: "full", columns: null },
      { type: "inspect", target: "graph", operator_ids: ["independent"] },
      { type: "answer", content: "42", operator_ids: null },
    ],
  });
  expect(receipt.status).toBe("pending");
  const called: string[] = [];
  await runDataflowActions(receipt, async action => {
    called.push(action.type);
    if (mode === "throw") throw new Error("UNKNOWN_OPERATOR: missing");
    return { status: "error", output: { code: "EXECUTION_FAILED", message: "The requested branch failed." } };
  });
  expect(called).toEqual(["read"]);
  expect(receipt.actions.map(item => item.status)).toEqual(["error", "skipped", "skipped", "skipped"]);
  expect(receipt.status).toBe("error");
  expect(receipt.answer).toBeUndefined();
  expect(receipt.actions.slice(1).map(item => item.output)).toEqual(
    Array(3).fill("Not run because an earlier action failed.")
  );
});

test("a typed mutation failure also skips reads and preserves the first error", async () => {
  const receipt = prepareStructuredDataflowActions({
    reasoning: "Replace the table, then inspect its result.",
    actions: [
      { type: "delete", ids: ["missing"] },
      { type: "read", ids: ["independent"], view: "full", columns: null },
    ],
  });
  const called: string[] = [];
  await runDataflowActions(receipt, async action => {
    called.push(action.type);
    return { status: "error", output: "UNKNOWN_OPERATOR: missing" };
  });
  expect(called).toEqual(["delete"]);
  expect(receipt.error).toContain("Action 1 (delete)");
  expect(receipt.actions.map(item => item.status)).toEqual(["error", "skipped"]);
});

test.each(["throw", "outcome"] as const)(
  "legacy execution failure (%s) still permits independent inspection and retrieval",
  async mode => {
    const receipt = prepareDataflowActions({
      reasoning: "Execute the workflow and inspect the independent completed branch.",
      actions: [
        { type: "execute" },
        { type: "retrieve", operator_id: "independent", view: "full" },
        { type: "inspect", target: "graph" },
        { type: "edit", changes: 'later = scan("later.csv")' },
      ],
    });
    expect(receipt.status).toBe("pending");
    const called: string[] = [];
    await runDataflowActions(receipt, async action => {
      called.push(action.type);
      if (action.type === "execute") {
        if (mode === "throw") throw new Error("worker unavailable");
        return { status: "error", output: "worker unavailable" };
      }
      return { status: "ok", output: "completed independent result" };
    });
    expect(called).toEqual(["execute", "retrieve", "inspect"]);
    expect(receipt.actions.map(item => item.status)).toEqual(["error", "ok", "ok", "skipped"]);
    expect(receipt.status).toBe("error");
    expect(receipt.error).toContain("worker unavailable");
  }
);
