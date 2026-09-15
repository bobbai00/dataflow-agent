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

import { strict as assert } from "node:assert";
import { nativeTestSession } from "./native-test-session";

/** Real Texera worker/transport/context qualification, not an LLM run.
 * Starts no services. Requires matching C5+ engine and C6 candidate agent. */
const source = (value: number, tags = "[1,2]", empty = false) => ({
  op: "udf",
  id: "source",
  code: `def load():\n    import pandas as pd\n    frame = pd.DataFrame({'label': ['A:Alpha'], 'tags': [${JSON.stringify(tags)}], 'y2024': [${value}], 'y2025': [${value + 5}]})\n    return frame${empty ? ".iloc[:0]" : ""}`,
});
const reports: unknown[] = [];
for (const contextMode of ["delta", "latest"] as const) {
  const session = await nativeTestSession({
    contextMode,
    messageLayout: "block",
    nativeProfileCollection: true,
    dataLevel: 1,
    flowLevel: 1,
    columnStats: false,
    maxOperatorResultCharLimit: 1200,
  });
  try {
    const first = await session.debug({
      operators: [
        { op: "pivot", id: "wide", input: "lagged", index: ["code", "tags"], columns: "variable", values: "previous" },
        {
          op: "window",
          id: "lagged",
          input: "long",
          partitionBy: ["code", "tags"],
          orderBy: [{ col: "variable" }],
          columns: [{ fn: "lag", col: "value", as: "previous" }],
        },
        { op: "unpivot", id: "long", input: "items", columns: ["y2024", "y2025"] },
        { op: "explode", id: "items", input: "parts", column: "tags", encoding: "json" },
        { op: "split", id: "parts", input: "source", column: "label", into: ["code", "description"], separator: ":" },
        source(10),
      ],
      observe: ["wide"],
    });
    const rows = (step: typeof first, id = "wide") => (step.snapshot.results[id] as any)?.sampleRecords;
    assert.deepEqual(rows(first), [
      { code: "A", tags: 1, y2024: null, y2025: 10 },
      { code: "A", tags: 2, y2024: null, y2025: 10 },
    ]);
    assert.deepEqual(Object.keys(first.snapshot.nativeObservations ?? {}), ["wide"]);
    const frozen = first.snapshot.nativeObservations!.wide;
    assert.match(frozen.text, /Pivot unique pairs=4/);
    assert.equal((first.serviceContext.match(/Output Table:/g) ?? []).length, 1, "unobserved successful bodies leaked");

    const changed = await session.debug({
      operators: [{ op: "project", id: "answer", input: "wide", keep: ["tags", "y2025"] }, source(20)],
      observe: [],
    });
    assert.deepEqual(rows(changed, "answer"), [
      { tags: 1, y2025: 20 },
      { tags: 2, y2025: 20 },
    ]);
    assert.deepEqual(changed.snapshot.nativeObservations, {});
    const read = await session.debug({ operators: [], observe: ["wide", "lagged"] });
    assert.deepEqual(read.snapshot.results, changed.snapshot.results, "cached observe recomputed results");
    assert.match(read.snapshot.nativeObservations!.lagged.text, /boundary nulls=2\/4/);
    const pinned = await session.request(`/${session.agentId}/snapshots/${first.step.id}`);
    assert.ok(pinned.ok);
    assert.deepEqual(((await pinned.json()) as any).nativeObservations.wide, frozen);

    const failed = await session.debug({ operators: [source(20, "[1,1]")], observe: [] });
    assert.match((failed.snapshot.results.wide as any)?.error ?? "", /PIVOT_DUPLICATE/);
    assert.match(failed.serviceContext, /PIVOT_DUPLICATE/);
    assert.deepEqual(failed.snapshot.nativeObservations, {});
    const repaired = await session.debug({ operators: [source(20)], observe: ["wide"] });
    assert.deepEqual(
      rows(repaired)?.map((row: any) => row.y2025),
      [20, 20]
    );
    const pinnedFailure = await session.request(`/${session.agentId}/snapshots/${failed.step.id}`);
    assert.ok(pinnedFailure.ok);
    assert.match(((await pinnedFailure.json()) as any).results.wide.error, /PIVOT_DUPLICATE/);

    const empty = await session.debug({ operators: [source(20, "[1,2]", true)], observe: ["wide"] });
    assert.equal((empty.snapshot.results.wide as any)?.totalRowCount, 0);
    assert.ok(!(empty.snapshot.results.wide as any)?.error, "empty pivot execution failed");
    assert.deepEqual(
      (empty.snapshot.results.wide as any)?.resultSchema.map((column: any) => column.name),
      ["code", "tags"]
    );
    assert.match((empty.snapshot.results.answer as any)?.error ?? "", /MISSING_COLUMN/);
    assert.match(empty.serviceContext, /MISSING_COLUMN/);
    const restored = await session.debug({ operators: [source(30)], observe: ["answer"] });
    assert.deepEqual(rows(restored, "answer"), [
      { tags: 1, y2025: 30 },
      { tags: 2, y2025: 30 },
    ]);
    assert.ok(!(restored.snapshot.results.answer as any)?.error);
    reports.push({
      contextMode,
      workflowId: session.workflowId,
      passed: true,
      debugSteps: 7,
      checks: [
        "five shape operators through real workers",
        "reversed chain and existing DAG revision",
        "explicit/cached observation",
        "version-bound evidence",
        "hidden failure and same-ID repair",
        "empty dynamic schema invalidates downstream columns",
        "historical snapshots remain pinned",
      ],
    });
  } finally {
    await session.close();
  }
}
console.log(JSON.stringify({ suite: "native-v2-shapes", realLLM: false, reports, cleanup: "complete" }, null, 2));
