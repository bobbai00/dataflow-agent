/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { expect, test } from "bun:test";
import { WorkflowState } from "./workflow-state";
import { WorkflowSnapshotStorage } from "./workflow-snapshot-storage";
import { WorkflowSystemMetadata } from "./util/workflow-system-metadata";
import { planGraphEdit } from "./tools/graph-edits";
import { inspectSubgraph } from "./state-history";

async function fixture() {
  const metadataStore = WorkflowSystemMetadata.getInstance();
  metadataStore.seedCodeModeDefaults();
  const context = { metadataStore };
  const first = await planGraphEdit(
    new WorkflowState().getWorkflowContent(),
    `source = scan("old.csv")
eligible = filter(source, lambda row: row["active"], doc="Keep active rows")
total = aggregate(eligible, n=count())
unrelated = scan("unrelated.csv")`,
    context
  );
  const storage = new WorkflowSnapshotStorage(id => (id === "s1" ? ["s1"] : ["s1", "s2"]));
  storage.createSnapshot("s1", first.workflow);
  const second = await planGraphEdit(first.workflow, 'source = scan("new.csv")\ndel total', context);
  storage.createSnapshot("s2", second.workflow);
  return { storage, first, second, task: { taskId: 1, stepId: "s1", request: "Count active rows", answer: "2" } };
}

test("task sub-DAG reads full historical upstream closure without unrelated work or mutation", async () => {
  const { storage, first, second, task } = await fixture();
  const result = inspectSubgraph(storage, task, ["total", "eligible"], true);
  expect(result.operators.map(o => o.operator_id)).toEqual(["source", "eligible", "total"]);
  expect(result.edges).toHaveLength(2);
  expect(result.operators[0].expression).toContain("old.csv");
  expect(result.operators.every(o => !o.input_definitions)).toBe(true);
  expect(storage.getWorkflow("s1")).toEqual(first.workflow);
  expect(storage.getWorkflow("s2")).toEqual(second.workflow);
});

test("unknown roots fail explicitly instead of returning a live or guessed branch", async () => {
  const { storage, task } = await fixture();
  expect(() => inspectSubgraph(storage, task, ["absent"], false)).toThrow("did not exist");
  expect(() => inspectSubgraph(storage, task, [], false)).toThrow("root");
});

test("saved subgraphs reject cycles and missing input edges", async () => {
  for (const invalid of ["cycle", "missing"] as const) {
    const { first, task } = await fixture();
    const storage = new WorkflowSnapshotStorage(id => [id]);
    const workflow = { ...structuredClone(first.workflow), links: [...first.workflow.links] };
    if (invalid === "missing")
      workflow.links.splice(
        workflow.links.findIndex(link => link.target.operatorID === "total"),
        1
      );
    else {
      workflow.links.push({
        ...workflow.links[0],
        linkID: "cycle",
        source: { ...workflow.links[0].source, operatorID: "total" },
      });
    }
    storage.createSnapshot("invalid", workflow);
    expect(() => inspectSubgraph(storage, { ...task, stepId: "invalid" }, ["total"], false)).toThrow(
      invalid === "cycle" ? "cyclic" : "incomplete"
    );
  }
});
