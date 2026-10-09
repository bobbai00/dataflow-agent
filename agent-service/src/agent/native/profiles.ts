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

import { z } from "zod";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ratio = z.number().finite().min(0).max(1).nullable();
const omissions = z.array(z.string().regex(/^[a-z0-9_]{1,80}$/)).max(64);
const kind = z.enum(["str", "int64", "float64", "bool", "datetime", "unknown", "unsupported"]);
const scalar = z.discriminatedUnion("type", [
  z.object({ type: z.literal("str"), value: z.string().max(192) }),
  z.object({
    type: z.literal("int64"),
    value: z
      .string()
      .regex(/^-?(0|[1-9]\d{0,18})$/)
      .refine(v => BigInt(v) >= -(1n << 63n) && BigInt(v) < 1n << 63n),
  }),
  z.object({ type: z.literal("float64"), value: z.number().finite() }),
  z.object({ type: z.literal("bool"), value: z.boolean() }),
  z.object({
    type: z.literal("datetime"),
    value: z
      .string()
      .max(64)
      .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{9}(?:\+00:00)?$/)
      .refine(v => Number.isFinite(Date.parse(v))),
  }),
]);
const frequency = z.object({ value: scalar, count: count.refine(v => v > 0) });
/** Optional native diagnostics. Values share the lossless table-profile scalar
 * encoding; their clipped display is never used as a key or a frequency domain. */
export const nativeWitnessSchema = z.object({
  values: z.array(scalar.nullable()).min(1).max(8),
  count: count.refine(v => v > 0),
  truncated: z.boolean(),
});
export type NativeWitness = z.infer<typeof nativeWitnessSchema>;
const frequencies = z.object({ values: z.array(frequency).max(4096), otherCount: count, truncated: z.boolean() });
const columnSchema = z.object({
  type: kind,
  rowsProcessed: count,
  nullCount: count,
  nonnullCount: count,
  nullRatio: ratio,
  distinctCount: count.nullable(),
  uniquenessRatio: ratio,
  min: scalar.nullable(),
  max: scalar.nullable(),
  frequencies: frequencies.nullable(),
  mergeValues: z.array(frequency).max(4096).nullable(),
  omissions,
});
export type ProfileScalar = z.infer<typeof scalar>;
export type ProfileColumn = Omit<z.infer<typeof columnSchema>, "mergeValues">;
const columnsSchema = z.unknown().transform((value, context): Record<string, z.infer<typeof columnSchema>> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 128) {
    context.addIssue({ code: "custom", message: "Invalid profile columns" });
    return {};
  }
  // Preserve legitimate names such as __proto__ without prototype assignment.
  const entries = Object.entries(value).map(([name, column]) => [name, columnSchema.safeParse(column)] as const);
  if (entries.some(([, result]) => !result.success))
    context.addIssue({ code: "custom", message: "Invalid profile column" });
  return Object.fromEntries(
    entries.filter(([, result]) => result.success).map(([name, result]) => [name, result.data!])
  );
});
const schemaField = z.object({ name: z.string(), type: kind, dtype: z.string().max(128) });
const nativeSchema = z.object({
  operatorType: z.string().optional(),
  inputOperators: z.array(z.string()).max(256).optional(),
  rowEffect: z.string().optional(),
  inputRows: z.array(count).max(256).optional(),
  outputRows: count.optional(),
  operations: z.record(z.unknown()).optional(),
});
const workerSchema = z.object({
  protocol: z.literal("texera.table-profile"),
  version: z.literal(1),
  workerId: z.string().min(1).max(1024),
  producerId: z.string().regex(/^[a-f0-9]{32}$/),
  operatorId: z.string().min(1),
  operatorRevision: z.string().regex(/^[a-f0-9]{16}$/),
  status: z.enum(["available", "unavailable"]),
  coverage: z.object({ scope: z.literal("worker"), complete: z.boolean(), rowsProcessed: count, yields: count }),
  rowCount: count,
  columnCount: count,
  schema: z.array(schemaField).max(128),
  schemaComplete: z.boolean(),
  columns: columnsSchema,
  native: nativeSchema.nullable(),
  structure: z.object({
    duplicateRows: count.nullable().optional(),
    allNullRows: count.nullable().optional(),
    allNullColumns: z.array(z.string()).max(128).optional(),
  }),
  algorithm: z.object({
    name: z.literal("bounded-exact-v1"),
    rowSelection: z.literal("prefix"),
    distinctLimit: count.refine(v => v <= 4096),
    rowDistinctLimit: count,
    topK: count.refine(v => v <= 32),
  }),
  omissions,
  cost: z.object({
    collectionMs: z.number().finite().min(0),
    snapshotMs: z.number().finite().min(0).optional(),
    cellsProcessed: count,
    payloadBytes: count,
  }),
});
type WorkerProfile = z.infer<typeof workerSchema>;

export interface TableProfile {
  version: 1;
  status: "available" | "partial" | "unavailable";
  coverage: {
    scope: "full" | "partial";
    complete: boolean;
    expectedWorkers: number | null;
    receivedWorkers: number;
    rowsProcessed: number;
  };
  rowCount: number | null;
  columnCount: number | null;
  schema: z.infer<typeof schemaField>[];
  schemaComplete: boolean;
  columns: Record<string, ProfileColumn>;
  structure: { duplicateRows: number | null; allNullRows: number | null; allNullColumns: string[] };
  native: z.infer<typeof nativeSchema> | null;
  producerIds: string[];
  omissions: string[];
  cost: { collectionMs: number; snapshotMs?: number; cellsProcessed: number; payloadBytes: number };
}

function validWorker(w: WorkerProfile): boolean {
  if (
    w.coverage.rowsProcessed > w.rowCount ||
    (w.coverage.complete && (w.status !== "available" || w.coverage.rowsProcessed !== w.rowCount))
  )
    return false;
  if (
    new Set(w.schema.map(c => c.name)).size !== w.schema.length ||
    (w.schemaComplete && w.schema.length !== w.columnCount)
  )
    return false;
  if (w.status === "unavailable") return true;
  if (w.schema.length !== Object.keys(w.columns).length) return false;
  return w.schema.every(field => {
    const col = Object.hasOwn(w.columns, field.name) ? w.columns[field.name] : undefined;
    if (
      !col ||
      col.type !== field.type ||
      col.rowsProcessed !== w.coverage.rowsProcessed ||
      col.nullCount + col.nonnullCount !== col.rowsProcessed
    )
      return false;
    if (col.distinctCount !== null && col.distinctCount > col.nonnullCount) return false;
    if (col.min && col.max && compare(col.min, col.max) > 0) return false;
    if (col.nonnullCount === 0 && (col.min !== null || col.max !== null)) return false;
    for (const v of [col.min, col.max, ...(col.mergeValues?.map(v => v.value) ?? [])])
      if (v && v.type !== col.type) return false;
    if (col.mergeValues !== null) {
      if (col.mergeValues.length > w.algorithm.distinctLimit) return false;
      if (
        col.mergeValues.length !== col.distinctCount ||
        new Set(col.mergeValues.map(v => JSON.stringify(v.value))).size !== col.mergeValues.length
      )
        return false;
      if (col.mergeValues.reduce((sum, v) => sum + v.count, 0) !== col.nonnullCount) return false;
    }
    return true;
  });
}

function compare(a: ProfileScalar, b: ProfileScalar): number {
  const x = a.type === "int64" ? BigInt(a.value) : a.value;
  const y = b.type === "int64" ? BigInt(b.value) : b.value;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Decodes only the reserved structured channel, never legacy rendered stats.
 * Counts describe the recorded prefix until all expected workers are complete.
 * Missing/invalid evidence cannot turn a successful execution into an error. */
export function mergeTableProfiles(
  metadata: Record<string, string> | undefined,
  expected: { operatorId: string; operatorRevision: string; expectedWorkers?: number }
): TableProfile {
  const result: TableProfile = {
    version: 1,
    status: "unavailable",
    coverage: {
      scope: "partial",
      complete: false,
      expectedWorkers: expected.expectedWorkers ?? null,
      receivedWorkers: 0,
      rowsProcessed: 0,
    },
    rowCount: null,
    columnCount: null,
    schema: [],
    schemaComplete: false,
    columns: {},
    structure: { duplicateRows: null, allNullRows: null, allNullColumns: [] },
    native: null,
    producerIds: [],
    omissions: [],
    cost: { collectionMs: 0, cellsProcessed: 0, payloadBytes: 0 },
  };
  const fail = (reason: string): TableProfile => ({
    ...result,
    status: "unavailable",
    rowCount: null,
    columnCount: null,
    schema: [],
    schemaComplete: false,
    coverage: { ...result.coverage, scope: "partial", complete: false },
    columns: {},
    structure: { duplicateRows: null, allNullRows: null, allNullColumns: [] },
    native: null,
    producerIds: [],
    omissions: [reason],
  });
  const payloads = Object.values(metadata ?? {});
  if (!payloads.length) return fail("profile_missing");
  if (payloads.length > 64) return fail("metadata_worker_budget");
  let bytes = 0;
  const workers: WorkerProfile[] = [];
  for (const payload of payloads) {
    if (typeof payload !== "string" || payload.length > 65536) return fail("metadata_payload_budget");
    const size = Buffer.byteLength(payload);
    bytes += size;
    if (size > 65536 || bytes > 262144) return fail("metadata_payload_budget");
    try {
      const w = workerSchema.parse(JSON.parse(payload));
      if (!validWorker(w)) return fail("profile_inconsistent");
      if (w.operatorId !== expected.operatorId || w.operatorRevision !== expected.operatorRevision)
        return fail("profile_identity_mismatch");
      workers.push(w);
    } catch {
      return fail("profile_invalid");
    }
  }
  workers.sort((a, b) => (a.workerId < b.workerId ? -1 : a.workerId > b.workerId ? 1 : 0));
  if (
    new Set(workers.map(w => w.workerId)).size !== workers.length ||
    new Set(workers.map(w => w.producerId)).size !== workers.length
  )
    return fail("profile_duplicate_worker");
  if (!Number.isSafeInteger(expected.expectedWorkers) || expected.expectedWorkers! < 1)
    return fail("expected_workers_unknown");
  if (workers.length > expected.expectedWorkers!) return fail("profile_worker_count_mismatch");
  if (workers.some(w => w.status === "unavailable")) {
    const unavailable = fail("worker_profile_unavailable");
    unavailable.omissions = [...new Set([...unavailable.omissions, ...workers.flatMap(w => w.omissions)])];
    // Statistics can exhaust their budget independently of compact source
    // identity. Preserve only that identity from one verified, complete worker
    // set; never merge opaque native operation counters across workers.
    const native = workers[0].native;
    const scan = native?.operations?.scan;
    if (
      workers.length === 1 &&
      expected.expectedWorkers === 1 &&
      scan &&
      typeof scan === "object" &&
      !Array.isArray(scan)
    ) {
      const value = scan as Record<string, unknown>;
      if (Array.isArray(value.sources))
        unavailable.native = {
          operatorType: native?.operatorType,
          inputOperators: native?.inputOperators,
          operations: {
            scan: Object.fromEntries(
              ["sources", "sourcesOmitted", "sourceDetailsOmitted"]
                .filter(key => key in value)
                .map(key => [key, value[key]])
            ),
          },
        };
    }
    return unavailable;
  }
  const first = workers[0];
  const sameSchema = workers.every(
    w =>
      w.columnCount === first.columnCount &&
      JSON.stringify(w.schema.map(({ name, type }) => [name, type])) ===
        JSON.stringify(first.schema.map(({ name, type }) => [name, type]))
  );
  if (!sameSchema) return fail("profile_schema_mismatch");
  const missing = new Set(workers.flatMap(w => w.omissions));
  const allWorkers = workers.length === expected.expectedWorkers;
  const complete = allWorkers && workers.every(w => w.coverage.complete);
  if (!allWorkers) missing.add("missing_workers");
  if (!complete) missing.add("partial_coverage");
  const sum = (fn: (w: WorkerProfile) => number) => workers.reduce((total, w) => total + fn(w), 0);
  result.coverage = {
    scope: complete ? "full" : "partial",
    complete,
    expectedWorkers: expected.expectedWorkers!,
    receivedWorkers: workers.length,
    rowsProcessed: sum(w => w.coverage.rowsProcessed),
  };
  result.rowCount = allWorkers ? sum(w => w.rowCount) : null;
  if (
    !Number.isSafeInteger(result.coverage.rowsProcessed) ||
    (result.rowCount !== null && !Number.isSafeInteger(result.rowCount))
  )
    return fail("profile_count_overflow");
  result.status = complete ? "available" : "partial";
  result.schema = first.schema;
  result.columnCount = first.columnCount;
  result.schemaComplete = workers.every(w => w.schemaComplete);
  result.producerIds = workers.map(w => w.producerId).sort();
  result.native = workers.length === 1 ? first.native : null;
  if (workers.length > 1) missing.add("cross_worker_native_unavailable");
  result.cost = {
    collectionMs: sum(w => w.cost.collectionMs),
    ...(workers.every(w => w.cost.snapshotMs !== undefined) ? { snapshotMs: sum(w => w.cost.snapshotMs!) } : {}),
    cellsProcessed: sum(w => w.cost.cellsProcessed),
    payloadBytes: bytes,
  };
  result.columns = Object.fromEntries(
    first.schema.map(field => {
      const cols = workers.map(w => w.columns[field.name]);
      const nullCount = cols.reduce((n, c) => n + c.nullCount, 0);
      const nonnullCount = cols.reduce((n, c) => n + c.nonnullCount, 0);
      const rowsProcessed = nullCount + nonnullCount;
      const colOmissions = new Set(cols.flatMap(c => c.omissions));
      let values: Map<string, z.infer<typeof frequency>> | null = cols.every(c => c.mergeValues !== null)
        ? new Map()
        : null;
      const distinctLimit = Math.min(...workers.map(w => w.algorithm.distinctLimit));
      for (const col of cols) {
        if (!values) break;
        for (const entry of col.mergeValues!) {
          const key = JSON.stringify(entry.value);
          const old = values.get(key);
          if (old) old.count += entry.count;
          else values.set(key, { value: entry.value, count: entry.count });
        }
        if (values.size > distinctLimit) {
          values = null;
          colOmissions.add("merged_distinct_limit");
        }
      }
      const distinctCount = values ? values.size : workers.length === 1 ? cols[0].distinctCount : null;
      const ordered = values
        ? [...values.values()].sort((a, b) => b.count - a.count || compare(a.value, b.value))
        : null;
      const top = ordered?.slice(0, Math.min(...workers.map(w => w.algorithm.topK)));
      const freq = top
        ? {
            values: top,
            otherCount: nonnullCount - top.reduce((n, c) => n + c.count, 0),
            truncated: top.length < ordered!.length,
          }
        : null;
      if (distinctCount === null) colOmissions.add("distinct_unavailable");
      function range(which: "min" | "max"): ProfileScalar | null {
        const nonempty = cols.filter(c => c.nonnullCount > 0);
        if (!nonempty.length || nonempty.some(c => !c[which])) return null;
        const candidates = nonempty.map(c => c[which]!);
        if (field.type === "datetime" && new Set(candidates.map(c => String(c.value).endsWith("+00:00"))).size > 1) {
          colOmissions.add("datetime_domain_mismatch");
          return null;
        }
        return candidates.reduce((a, b) => ((which === "min" ? compare(a, b) <= 0 : compare(a, b) >= 0) ? a : b));
      }
      const min = range("min"),
        max = range("max");
      return [
        field.name,
        {
          type: field.type,
          rowsProcessed,
          nullCount,
          nonnullCount,
          nullRatio: rowsProcessed ? nullCount / rowsProcessed : null,
          distinctCount,
          uniquenessRatio: nonnullCount && distinctCount !== null ? distinctCount / nonnullCount : null,
          min,
          max,
          frequencies: freq,
          omissions: [...colOmissions].sort(),
        } satisfies ProfileColumn,
      ];
    })
  );
  result.structure = {
    duplicateRows: workers.length === 1 ? (first.structure.duplicateRows ?? null) : null,
    allNullRows: workers.every(w => w.structure.allNullRows != null) ? sum(w => w.structure.allNullRows!) : null,
    allNullColumns: Object.entries(result.columns)
      .filter(([, c]) => c.rowsProcessed > 0 && c.nonnullCount === 0)
      .map(([name]) => name),
  };
  if (workers.length > 1) missing.add("cross_worker_duplicates_unavailable");
  result.omissions = [...missing].sort();
  return result;
}
