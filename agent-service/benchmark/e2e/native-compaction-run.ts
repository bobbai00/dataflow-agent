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

/** Real service/engine qualification. No LLM calls and no service restarts. */
const directory = mkdtempSync(join(tmpdir(), "native-compaction-e2e-"));
const file = join(directory, "source.csv");
writeFileSync(file, "x,tag,extra\n-1,HIDDEN_SOURCE_VALUE,private\n0,A,a\n1,B,b\n2,C,c\n3,D,d\n4,E,e\n");
const reports: unknown[] = [];
try {
  for (const contextMode of ["delta", "latest"] as const)
    for (const data of [false, true])
      for (const flow of [false, true]) {
        const session = await nativeTestSession({
          contextMode,
          messageLayout: "block",
          nativeProfileCollection: true,
          dataEvidence: data,
          flowEvidence: flow,
          maxResultRows: 1,
          maxOperatorResultCharLimit: 2000,
        });
        try {
          const first = await session.debug({
            operators: [
              { op: "project", id: "first", input: "selected", keep: ["x", "tag"] },
              { op: "project", id: "second", input: "selected", keep: ["x", "tag"] },
              {
                op: "filter",
                id: "selected",
                input: "source",
                columns: ["x"],
                func: "def apply(row):\n    return row['x'] > 0",
              },
              { op: "scan", id: "source", files: file },
            ],
            observe: ["first", "second"],
          });
          assert.deepEqual(Object.keys(first.snapshot.nativeObservations ?? {}).sort(), ["first", "second"]);
          assert.equal((first.serviceContext.match(/Flow upstream selected:/g) ?? []).length, flow ? 1 : 0);
          assert.equal(first.serviceContext.includes("Flow upstream: see"), flow);
          assert.equal(first.serviceContext.includes("Data measurement: column counts"), data);
          assert.ok(!first.serviceContext.includes("HIDDEN_SOURCE_VALUE"));
          for (const frame of Object.values(first.snapshot.nativeObservations ?? {})) {
            assert.ok(frame.text.length <= 2000);
            assert.equal(frame.chunks.filter(c => c.id.startsWith("sample.")).length, 1);
          }
          const cached = await session.debug({ operators: [], observe: ["second"] });
          assert.deepEqual(cached.snapshot.results, first.snapshot.results, "cached observe re-executed results");
          assert.equal(
            (cached.serviceContext.match(/Flow upstream selected:/g) ?? []).length,
            flow ? (contextMode === "delta" ? 2 : 1) : 0
          );
          if (contextMode === "latest") assert.ok(!cached.serviceContext.includes("Flow upstream: see"));
          const pinned = await session.request(`/${session.agentId}/snapshots/${first.step.id}`);
          assert.ok(pinned.ok);
          assert.deepEqual(((await pinned.json()) as any).nativeObservations, first.snapshot.nativeObservations);
          reports.push({
            contextMode,
            data,
            flow,
            workflowId: session.workflowId,
            sourceVersion: (first.snapshot.results.source as any).resultVersion?.id,
            contexts: [first.serviceContext, cached.serviceContext],
            observations: first.snapshot.nativeObservations,
          });
        } finally {
          await session.close();
        }
      }
  console.log(
    JSON.stringify({ suite: "native-evidence-compaction", realLLM: false, reports, cleanup: "complete" }, null, 2)
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
