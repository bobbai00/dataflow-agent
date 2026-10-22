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

import { expect, test } from "bun:test";
import type { WorkflowContent } from "../../types/workflow";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { planRegisteredGraphEdit } from "./graph-edits";

const metadataStore = new WorkflowSystemMetadata();
metadataStore.seedCodeModeDefaults();
const empty: WorkflowContent = {
  operators: [],
  operatorPositions: {},
  links: [],
  commentBoxes: [],
  settings: { dataTransferBatchSize: 400 },
};
const edit = (workflow: WorkflowContent, changes: string, operatorDoc: boolean, python = "") =>
  planRegisteredGraphEdit(workflow, python, changes, { metadataStore, settings: { operatorDoc } });

const twoOperators = [
  "set records: scan(files='data/orders.csv', doc='Reads the orders file.')",
  "set totals: aggregate(records, by=['region'], outputs={'n': count()})",
].join("\n");

test("with operator docs on, an edit lists the operators it set without a doc, and still applies", async () => {
  const plan = await edit(empty, twoOperators, true);
  expect(plan.missing_docs).toEqual(["totals"]);
  expect(plan.workflow.operators.map(op => op.operatorID).sort()).toEqual(["records", "totals"]);
  expect(plan.workflow.operators.find(op => op.operatorID === "records")?.nativeOp?.doc).toBe("Reads the orders file.");
});

test("with operator docs off, nothing is listed", async () => {
  expect((await edit(empty, twoOperators, false)).missing_docs).toBeUndefined();
});

test("only operators the edit sets count: an untouched or deleted operator without a doc is not listed", async () => {
  const { workflow } = await edit(empty, twoOperators, false);
  const later = await edit(
    workflow,
    "set report: sort(records, by=['region'], doc='Orders the records by region.')\ndelete totals",
    true
  );
  expect(later.missing_docs).toBeUndefined();
});

test("a registered Python operator and a filter lambda need a doc too", async () => {
  const python = "import pandas as pd\n\ndef widen(table):\n    return table";
  const plan = await edit(
    empty,
    [
      "set records: scan(files='data/orders.csv', doc='Reads the orders file.')",
      "set wide: widen(records)",
      "set big: filter(records, lambda row: row['amount'] > 10)",
    ].join("\n"),
    true,
    python
  );
  expect(plan.missing_docs).toEqual(["wide", "big"]);
});

test("restating an operator with only a new doc clears the reminder and leaves its result current", async () => {
  const { workflow } = await edit(empty, twoOperators, true);
  const documented = await edit(
    workflow,
    "set totals: aggregate(records, by=['region'], outputs={'n': count()}, doc='Counts orders per region.')",
    true
  );
  expect(documented.missing_docs).toBeUndefined();
  expect(documented.changes).toContainEqual({
    change: "operator",
    operator_id: "totals",
    operator: "aggregate",
    action: "updated",
  });
  expect(documented.invalidated_results).toEqual([]);
});
