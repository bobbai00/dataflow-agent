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
import { compactNativeObservation, shareNativeObservation, type NativeColumnCount } from "./evidence-compaction";
import { restrictNativeObservation, type NativeEvidenceFact, type NativeObservation } from "./evidence";

const metric: NativeColumnCount = {
  column: "x",
  resultVersion: "version-a",
  scope: "full=3 rows",
  rows: 3,
  nulls: 1,
  nonnull: 2,
  distinct: null,
};
const data: NativeEvidenceFact = {
  id: "data.column.x.counts",
  family: "data",
  kind: "measurement",
  priority: 80,
  text: 'Data measurement: "x" (full=3 rows): null=1/3, nonnull=2; distinct(nonnull)=unknown.',
  columnCount: metric,
};
const flow: NativeEvidenceFact = {
  id: "flow.filter.column.x",
  family: "flow",
  kind: "measurement",
  priority: 88,
  text: 'Flow measurement: predicate column "x": input (full=5 rows) null=1/5, distinct(nonnull)=4; output (full=3 rows) null=1/3, distinct(nonnull)=unknown.',
  coveredCount: metric,
};
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

test("undisplayed or differently bound flow cannot suppress a data count", () => {
  for (const changed of [
    { resultVersion: "version-b" },
    { scope: "partial prefix=3/3 rows" },
    { rows: 4 },
    { nulls: 0 },
    { nonnull: 3 },
    { distinct: 2 },
    { column: "y" },
  ]) {
    const other = { ...flow, coveredCount: { ...metric, ...changed } };
    expect(compactNativeObservation(frame([other, data]), [other, data]).selected).toContain(data.id);
  }
  expect(compactNativeObservation(frame([data]), [flow, data]).selected).toContain(data.id);
});

test("compaction is non-mutating, bounded and does not expand a single-column sentence", () => {
  const original = frame([data]);
  const saved = structuredClone(original);
  const result = compactNativeObservation(original, [data]);
  expect(original).toEqual(saved);
  expect(result.text).toBe(original.text);
  expect(result.text.length).toBeLessThanOrEqual(original.text.length);
});

test("a displayed exact comparison suppresses its duplicate count only within the same family", () => {
  // Flow and data are orthogonal: a flow comparison leaves the data count in place.
  const original = frame([flow, data]);
  const result = compactNativeObservation(original, [flow, data]);
  expect(result.text).toBe(original.text);
  expect(result.selected).toEqual([flow.id, data.id]);
  expect(original.selected).toEqual([flow.id, data.id]);
  // The same comparison shown as a data fact does suppress the duplicate count.
  const sameFamily: NativeEvidenceFact = { ...flow, id: "data.column.x.compare", family: "data" };
  const compacted = compactNativeObservation(frame([sameFamily, data]), [sameFamily, data]);
  expect(compacted.text).toBe(sameFamily.text);
  expect(compacted.selected).toEqual([sameFamily.id]);
  expect(compacted.omitted).toContainEqual({ id: data.id, reason: "redundant_displayed_fact" });
});

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
  const short = restrictNativeObservation(original, { maxChars: 40 });
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
