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
import { FlowReceiptMemo } from "./evidence-compaction";
import type { NativeObservation } from "./evidence";
function view(version: string | null, chunks: NativeObservation["chunks"]): NativeObservation {
  return {
    version: 2,
    resultVersion: version,
    inputs: [],
    options: { data: false, flow: true, maxChars: 2000 },
    chunks,
    selected: chunks.map(c => c.id),
    omitted: [],
    text: chunks.map(c => c.text).join("\n"),
  };
}
const text = "- flow: 95 of 95 left records matched; 95 of 153 right records matched; no left records unmatched.";
const measurement = { id: "flow.join.counts", text };
test("same-call references require the same producing result and printed fact", () => {
  const memo = new FlowReceiptMemo();
  expect(memo.render(view("v1", [measurement]), "joined", "action 1 / joined")).toBe(text);
  expect(memo.render(view("v1", [measurement]), "joined", "action 2 / joined")).toContain("see action 1 / joined");
  expect(memo.render(view("v2", [measurement]), "joined", "action 3 / joined")).toBe(text);
  expect(memo.render(view(null, [measurement]), "joined", "action 4 / joined")).toBe(text);
  expect(new FlowReceiptMemo().render(view("v1", [measurement]), "joined", "action 1 / joined")).toBe(text);
});
test("ancestor references retain opaque scope and never reference omitted measurements", () => {
  const memo = new FlowReceiptMemo();
  memo.render(view("v1", [measurement]), "joined", "action 1 / joined");
  const scope = "Before custom processing; row/column correspondence to this output unknown.";
  const upstream = {
    id: "flow.upstream.joined.v1",
    text: `- flow (joined): Join type=left. ${text} ${scope}`,
    upstream: {
      operatorId: "joined",
      resultVersion: "v1",
      factIds: [measurement.id],
      description: "Join type=left",
      scope,
    },
  };
  const rendered = memo.render(view("out1", [upstream]), "report", "action 2 / report");
  expect(rendered).toContain("see action 1 / joined");
  expect(rendered).toContain(scope);
  const missing = { ...upstream, upstream: { ...upstream.upstream, factIds: [measurement.id, "flow.join.unseen"] } };
  expect(memo.render(view("out1", [missing]), "report", "action 3 / report")).toBe(missing.text);
});
