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
import { shareNativeObservation } from "./evidence-compaction";
import type { NativeEvidenceFact, NativeObservation } from "./evidence";

const upstream: NativeEvidenceFact = {
  id: "flow.upstream.source.version-a",
  family: "flow",
  kind: "measurement",
  priority: 98,
  text: 'Flow upstream source: Filter predicate columns=["x"]. Filter kept=3/5, rejected=2, null predicates=0 (a None verdict drops the row).',
  upstream: { operatorId: "source", resultVersion: "version-a" },
};

function frame(facts: NativeEvidenceFact[]): NativeObservation {
  return {
    version: 1,
    resultVersion: "version-a",
    inputs: [],
    options: { data: true, flow: true, maxChars: 2000 },
    chunks: facts.map(f => ({ id: f.id, text: f.text, ...(f.upstream ? { upstream: f.upstream } : {}) })),
    selected: facts.map(f => f.id),
    omitted: [],
    text: facts.map(f => f.text).join("\n"),
  };
}

test("shared references require an actually displayed same-version same-text producer", () => {
  const original = frame([upstream]);
  const saved = structuredClone(original);
  const seen = new Map<string, string>();
  expect(shareNativeObservation(original.text, original, "first", seen)).toBe(original.text);
  expect(shareNativeObservation(original.text, original, "second", seen)).toContain('see "first" above for "source"');
  expect(shareNativeObservation(original.text, original, "first", seen)).toBe(original.text);
  for (const changed of [
    { ...upstream, upstream: { operatorId: "other", resultVersion: "version-a" } },
    { ...upstream, upstream: { operatorId: "source", resultVersion: "version-b" } },
    { ...upstream, text: upstream.text.replace("kept=3/5", "kept=2/5") },
  ]) {
    const next = frame([changed]);
    expect(shareNativeObservation(next.text, next, "second", seen)).toBe(next.text);
  }
  expect(original).toEqual(saved);
});

test("a clipped or omitted first observation cannot become a shared-reference target", () => {
  const original = frame([upstream]);
  const seen = new Map<string, string>();
  const short = original.text.slice(0, 40);
  expect(shareNativeObservation(short, original, "first", seen)).toBe(short);
  expect(seen.size).toBe(0);
  expect(shareNativeObservation(original.text, original, "second", seen)).toBe(original.text);
});

test("old standalone frames and long IDs never acquire larger or invented references", () => {
  const original = frame([upstream]);
  const old = { ...original, chunks: [{ id: upstream.id, text: upstream.text }] };
  const seen = new Map<string, string>();
  shareNativeObservation(original.text, original, "first", seen);
  expect(shareNativeObservation(old.text, old, "second", seen)).toBe(old.text);
  const long = new Map<string, string>();
  shareNativeObservation(original.text, original, "x".repeat(400), long);
  expect(shareNativeObservation(original.text, original, "second", long)).toBe(original.text);
  expect(shareNativeObservation(original.text, original, "second", new Map())).toBe(original.text);
});
