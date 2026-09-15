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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nativeTestSession } from "./native-test-session";

/** Real engine + service context, no LLM. Does not start/restart services. */
const directory = mkdtempSync(join(tmpdir(), "native-evidence-e2e-"));
const file = join(directory, "source.csv");
writeFileSync(
  file,
  "x,tag,__row_index__,__is_visualization__\n1,private_source_value,user_a,true\n2,A,user_b,false\n3,B,user_c,true\n4,B,user_d,false\n"
);
const reports: unknown[] = [];
try {
  for (const contextMode of ["delta", "latest"] as const)
    for (const data of [false, true])
      for (const flow of [false, true]) {
        const session = await nativeTestSession({
          contextMode,
          messageLayout: "block",
          nativeProfileCollection: true,
          dataLevel: data ? 1 : 0,
          flowLevel: flow ? 1 : 0,
          columnStats: false,
          maxResultRows: 1,
          maxOperatorResultCharLimit: 1200,
        });
        try {
          const first = await session.debug({
            operators: [
              { op: "aggregate", id: "answer", input: "selected", aggregations: [{ fn: "count", as: "n" }] },
              {
                op: "filter",
                id: "selected",
                input: "source",
                columns: ["x"],
                func: "def apply(row):\n    return row['x'] > 2",
              },
              { op: "scan", id: "source", files: file },
            ],
            observe: ["answer"],
          });
          assert.deepEqual(Object.keys(first.snapshot.nativeObservations ?? {}), ["answer"]);
          const frozen = first.snapshot.nativeObservations!.answer;
          assert.ok(frozen.text.length <= 1200);
          assert.equal(frozen.text.includes("groups=1 from 2 rows"), flow);
          assert.equal(frozen.text.includes("Flow upstream selected@"), flow);
          assert.equal(frozen.text.includes("kept=2/4"), flow);
          assert.ok(
            first.serviceContext.includes("Complete table"),
            "service did not render the observed complete answer"
          );
          assert.ok(!first.serviceContext.includes("private_source_value"), "hidden source content leaked");

          const observed = await session.debug({ operators: [], observe: ["source", "selected"] });
          assert.deepEqual(observed.snapshot.results, first.snapshot.results, "cached observe reran materialization");
          assert.ok(observed.serviceContext.includes("private_source_value"));
          assert.ok(observed.serviceContext.includes("user_a"), "user __row_index__ overwritten in transport");
          assert.equal(observed.serviceContext.includes("Data measurement:"), data);
          assert.equal(observed.serviceContext.includes("kept=2/4"), flow);
          for (const frame of Object.values(observed.snapshot.nativeObservations ?? {}))
            assert.ok(frame.text.length <= 1200);

          const changed = await session.debug({
            operators: [
              {
                op: "filter",
                id: "selected",
                input: "source",
                columns: ["x"],
                func: "def apply(row):\n    return row['x'] > 3",
              },
              { op: "project", id: "final", input: "answer", keep: ["n"] },
            ],
            observe: [],
          });
          assert.deepEqual(changed.snapshot.nativeObservations, {});
          assert.equal((changed.snapshot.results.answer as any).sampleRecords[0].n, 1);
          assert.ok(!changed.serviceContext.includes("kept=1/4"), "recomputed hidden flow evidence leaked");
          if (contextMode === "latest") assert.ok(!changed.serviceContext.includes("Output Table:"));
          const pinned = await session.request(`/${session.agentId}/snapshots/${first.step.id}`);
          assert.ok(pinned.ok);
          assert.deepEqual(((await pinned.json()) as any).nativeObservations.answer, frozen);
          reports.push({
            contextMode,
            data,
            flow,
            workflowId: session.workflowId,
            debugSteps: 3,
            observations: Object.fromEntries(
              Object.entries(observed.snapshot.nativeObservations ?? {}).map(([id, frame]) => [
                id,
                {
                  chars: frame.text.length,
                  selected: frame.selected,
                  omittedCount: frame.omitted.length,
                },
              ])
            ),
          });
        } finally {
          await session.close();
        }
      }
  console.log(JSON.stringify({ suite: "native-v2-evidence", realLLM: false, reports, cleanup: "complete" }, null, 2));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
