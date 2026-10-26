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

/**
 * The memory of the context tracker's own structure, apart from what the snapshots hold (dataflows, results,
 * observations, which the session's history keeps either way), at each point of a replay where replay-dataflow.ts read
 * the service's memory ("rest" lines).
 *
 * The structure is rebuilt from the replay's trace (traces.db) as the agent holds it (WorkflowSnapshotStorage and
 * TexeraAgent): per snapshot, its id, parent, step, time, version and action; the map of snapshots by id, of each
 * step's newest snapshot, the set of snapshots with children, the version numbers, and each step's children. Strings
 * are shared as the agent shares them: a snapshot's id is one string for it, its children and the indexes; step ids
 * belong to the steps, which the history keeps. Each point is measured in a fresh process: the live bytes of a heap
 * snapshot with the structure built, minus before (in the agent service itself, heap snapshots crash Bun after a few
 * calls, and the heap's size, counted in whole blocks, cannot show a few megabytes in a heap that has freed more).
 *
 *   bun benchmark/tracker/structure_memory.ts RUN_DIR   # writes RUN_DIR/structure.jsonl
 */
import { Database } from "bun:sqlite";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const [run, snapshotCount, stepCount] = Bun.argv.slice(2);

if (snapshotCount === undefined) {
  // Driver: one fresh process per point.
  const points = readFileSync(`${run}/replay.jsonl`, "utf8")
    .split("\n")
    .filter(line => line.includes('"kind":"rest"'))
    .map(line => JSON.parse(line));
  const out = `${run}/structure.jsonl`;
  writeFileSync(out, "");
  for (const point of points) {
    const child = Bun.spawnSync(["bun", import.meta.path, run, String(point.snapshots), String(point.steps)]);
    if (child.exitCode !== 0) throw new Error(`point ${point.index}: ${child.stderr.toString()}`);
    const measured = JSON.parse(child.stdout.toString());
    appendFileSync(out, JSON.stringify({ index: point.index, ...measured }) + "\n");
    console.log(`${point.index}: ${point.snapshots} snapshots, ${(measured.bytes / 2 ** 20).toFixed(2)} MiB`);
  }
  process.exit(0);
}

/** Live objects after a full collection, from a heap snapshot (four numbers per object: id, size, class, flags). */
function liveHeap(): { bytes: number; objects: number } {
  Bun.gc(true);
  const nodes: number[] = (Bun.generateHeapSnapshot() as any).nodes;
  let bytes = 0;
  for (let index = 1; index < nodes.length; index += 4) bytes += nodes[index];
  return { bytes, objects: nodes.length / 4 };
}

const db = new Database(`${run}/traces.db`, { readonly: true });
const stepNumber = (id: string) => Number(/-(\d+)-\d+$/.exec(id)![1]);
// The history's steps, in the order they were added: these exist with or without the tracker.
const steps = (db.query("SELECT id, parent_id AS parentId FROM steps").all() as Array<{ id: string; parentId: string }>)
  .sort((a, b) => stepNumber(a.id) - stepNumber(b.id))
  .slice(0, Number(stepCount));
const stepIds = new Map(steps.map(step => [step.id, step.id]));
// The snapshots in the order they were made (S1, S2, ...; the root S0 is not in the trace).
const rows = (
  db.query("SELECT id, parent_id AS parentId, step_id AS stepId, version, action, created_at AS at FROM snapshots").all() as Array<{
    id: string;
    parentId: string | null;
    stepId: string | null;
    version: number | null;
    action: string | null;
    at: number;
  }>
)
  .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
  .slice(0, Number(snapshotCount) - 1);
db.close();

const before = liveHeap();
// Each snapshot id, copied once and shared by its uses; the helper map goes before the measurement.
let ids: Map<string, string> | undefined = new Map();
const own = (id: string | null | undefined) => {
  if (id === null || id === undefined) return undefined;
  let copy = ids!.get(id);
  if (copy === undefined) ids!.set(id, (copy = JSON.parse(JSON.stringify(id)) as string));
  return copy;
};
const records = new Map<string, object>([[own("S0")!, { id: own("S0"), createdAt: 0 }]]);
const byStep = new Map<string, string>();
const parents = new Set<string>();
const versions = new Set<number>();
for (const row of rows) {
  const id = own(row.id)!;
  const step = row.stepId === null ? undefined : (stepIds.get(row.stepId) ?? row.stepId);
  records.set(id, {
    id,
    parentId: own(row.parentId),
    reactStepId: step,
    createdAt: row.at,
    version: row.version ?? undefined,
    action: row.action === null ? undefined : JSON.parse(row.action),
  });
  if (step !== undefined) byStep.set(step, id);
  if (row.parentId !== null) parents.add(own(row.parentId)!);
  if (row.version !== null) versions.add(row.version);
}
const children = new Map<string, string[]>();
for (const step of steps)
  if (step.parentId !== null) {
    const parent = stepIds.get(step.parentId) ?? step.parentId;
    const list = children.get(parent);
    if (list) list.push(stepIds.get(step.id)!);
    else children.set(parent, [stepIds.get(step.id)!]);
  }
const structure = { records, byStep, parents, versions, children };
ids = undefined;
const after = liveHeap();
console.log(
  JSON.stringify({
    snapshots: structure.records.size,
    steps: steps.length,
    bytes: after.bytes - before.bytes,
    objects: after.objects - before.objects,
    // What was loaded stays live through both measurements, so only the structure differs.
    loaded: rows.length + stepIds.size,
  })
);
