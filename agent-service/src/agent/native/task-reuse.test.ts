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
import { taskReuseFacts } from "./task-reuse";
import { taskModePrompt } from "./task-prompt";
import { validateNativeCatalogSettings } from "./settings";
import type { OperatorPredicate } from "../../types/workflow";

const op = (id: string, type: string, properties: Record<string, unknown>, inputs: string[] = []) =>
  ({ operatorID: id, nativeOp: { type, properties, inputs, version: "v2" } }) as OperatorPredicate;

test("reports inherited restrictions even through a projection and opaque UDF", () => {
  const nodes = [
    op("raw", "Scan", { files: "x.csv" }),
    op("recent", "Filter", { columns: ["year"], func: "def apply(row): return row['year'] == 2021" }, ["raw"]),
    op("leaders", "Limit", { n: 3 }, ["recent"]),
    op("report", "UDF", { code: "uninterpreted Python" }, ["leaders"]),
    op("copy", "Project", { keep: ["value"] }, ["report"]),
  ];
  const facts = taskReuseFacts("copy", nodes);
  expect(facts).toContain("leaders:limit(3)");
  expect(facts).toContain("recent:filter(year)");
  expect(facts).toContain("report:udf(opaque)");
  expect(facts).not.toContain("complete population");
});

test("historical ancestry uses recorded definitions and never current replacements", () => {
  const old = op("leaders", "Limit", { n: 3 }, ["raw"]);
  const source = { ...op("internal", "TaskResult", {}), taskSource: { operator: "leaders", atTask: 1 } };
  const nodes = [
    op("leaders", "Limit", { n: 99 }, ["raw"]),
    op("raw", "Scan", { files: "new.csv" }),
    source,
    op("answer", "Project", { keep: ["value"] }, ["internal"]),
  ];
  const history = {
    resolve: (ref: { operator: string; atTask: number }) => {
      if (ref.operator === "leaders" && ref.atTask === 1) return { operator: old };
      throw new Error("not retained");
    },
  } as any;
  const facts = taskReuseFacts("answer", nodes, history);
  expect(facts).toContain("leaders@task1:limit(3)");
  expect(facts).toContain("raw@task1:definition unavailable");
  expect(facts).not.toContain("99");
  expect(facts).not.toContain("internal");
});

test("long or cyclic ancestry remains bounded and discloses omissions", () => {
  const nodes = Array.from({ length: 70 }, (_, i) => op(`n${i}`, "Limit", { n: i + 1 }, [`n${(i + 1) % 70}`]));
  const facts = taskReuseFacts("n0", nodes);
  expect(facts.length).toBeLessThanOrEqual(280);
  expect(facts).toContain("more");
});

test("reuse is opt-in and requires the task-context/compact V2 path", () => {
  expect(taskModePrompt(true, true)).not.toContain("shared assumption");
  expect(taskModePrompt(true, true, true)).toContain("shared assumption");
  expect(() => validateNativeCatalogSettings({ nativeTaskReuse: true } as any)).toThrow();
  expect(() =>
    validateNativeCatalogSettings({
      nativeCatalogVersion: "v2",
      agentMode: "native",
      nativeToolMode: "batch",
      nativeTaskReuse: true,
    } as any)
  ).toThrow("nativeTaskContext");
});
