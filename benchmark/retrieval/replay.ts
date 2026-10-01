/**
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/** Replay bounded large-table snapshots to check renderer invariants.
 * No engine/model calls. Historical snapshots omit the transport truncation
 * flag, so only replay tables whose retained records are provably incomplete.
 * Usage: bun benchmark/retrieval/replay.ts <pilot-directory>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { strict as assert } from "node:assert";
import { selectNativeObservation } from "../../agent-service/src/agent/native/evidence";
import type { OperatorInfo } from "../../agent-service/src/types/execution";
import type { WorkflowContent } from "../../agent-service/src/types/workflow";

const directory = resolve(Bun.argv[2]);
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
let replayed = 0;
let partialProfiles = 0;
const failures: Array<{ path: string; operator: string; error: string }> = [];
for (const path of new Bun.Glob("system_scratch/*/*/snapshot.json").scanSync({
  cwd: directory,
  absolute: true,
})) {
  const snapshot = read(path);
  const settings = read(resolve(dirname(path), "settings.json"));
  const workflow: WorkflowContent = snapshot.workflow;
  const results = new Map<string, OperatorInfo>(
    Object.entries(snapshot.results).map(([id, raw]: [string, any]) => [
      id,
      {
        ...raw,
        result: raw.sampleRecords,
        truncated: true,
        resultMode: "table",
      },
    ]),
  );
  for (const op of workflow.operators) {
    const info = results.get(op.operatorID);
    if (
      !info?.resultVersion?.complete ||
      info.error ||
      !op.nativeOp ||
      !info.result?.length ||
      (info.totalRowCount ?? 0) <= info.result.length ||
      info.resultVersion.operatorRevision !== op.nativeOp.revision
    )
      continue;
    replayed++;
    partialProfiles += Number(info.tableProfile?.status === "partial");
    try {
      const context = {
        op,
        info,
        workflow,
        resolveInput: (id: string) => results.get(id),
        maxChars: settings.maxOperatorResultCharLimit,
        maxRows: settings.maxResultRows,
        dataMaxChars: settings.dataEvidenceCharLimit,
        flowMaxChars: settings.flowEvidenceCharLimit,
      };
      const sample = selectNativeObservation({
        ...context,
        view: "sample",
        data: false,
        flow: false,
      });
      const stats = selectNativeObservation({
        ...context,
        view: "sample_stats",
        data: true,
        flow: false,
      });
      const both = selectNativeObservation({
        ...context,
        view: "sample_stats",
        data: true,
        flow: true,
      });
      const records = (observation: typeof sample) =>
        observation.chunks.filter((c) => /^(table|sample|record)\./.test(c.id));
      assert.deepEqual(records(sample), records(stats));
      assert.deepEqual(records(stats), records(both));
      assert.deepEqual(sample.table, stats.table);
      assert.equal(sample.resultVersion, stats.resultVersion);
      assert.equal(stats.table?.complete, false);
      assert.ok(
        stats.text.length <= context.maxChars + context.dataMaxChars + 2,
      );
      assert.ok(
        both.text.length <=
          context.maxChars + context.dataMaxChars + context.flowMaxChars + 3,
      );
      if (
        info.tableProfile &&
        info.tableProfile.coverage.rowsProcessed < info.totalRowCount! &&
        stats.text.includes("column counts")
      ) {
        assert.ok(stats.text.includes("partial prefix"));
        assert.ok(!stats.text.includes("column counts (full="));
      }
    } catch (error) {
      failures.push({ path, operator: op.operatorID, error: String(error) });
    }
  }
}
const result = {
  replayed,
  partialProfiles,
  failures,
  scope:
    "Provably incomplete retained tables; archived completeness flags were unavailable. Rendering only, no new executions or model calls.",
};
writeFileSync(
  resolve(directory, "renderer-replay.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exitCode = 1;
