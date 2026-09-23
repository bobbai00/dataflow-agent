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

/**
 * Seeded source roots.
 *
 * A dataflow's root operators are the scans of the task's input files. Their
 * result does not depend on anything the model decides — the file is what it
 * is — so the system can materialize them before the first model call and
 * hand the model the same observation it would otherwise spend its first
 * step(s) asking for. In the 2026-09-16 campaign 93–101 of 104 tasks opened
 * with a scan-only step and averaged 1.5 such steps; those steps carried 16–18%
 * of the model bill without any modelling content.
 *
 * The seed is recorded as an ordinary `dataflow` batch step (tool call + tool
 * result + captured observations) so every context layout renders it through
 * the existing code path, byte-for-byte as if the model had issued it. The
 * step is marked `synthetic: "seed"` and carries zero usage because no model
 * request produced it.
 *
 * This module is the pure planning half: which files become which scans, and
 * how the observation budget is shared. Execution lives in `TexeraAgent`.
 */
import { basename, dirname, extname } from "node:path";

/** Total observation budget for the seed, as a multiple of one result's limit. */
export const SEED_BUDGET_MULTIPLIER = 4;
/** Below this a table observation cannot show its header and a sample row. */
export const SEED_MIN_CHARS_PER_SOURCE = 400;
/**
 * Tasks listing more sources than this are not seeded: choosing which files
 * matter is then part of the task itself, and seeding all of them would spend
 * more context than the scan steps it replaces.
 */
export const SEED_MAX_SOURCES = 6;

/** Formats the V2 scan resolves from the extension on its own (`format: auto`). */
const AUTO_EXTENSIONS = new Set([
  ".csv",
  ".tsv",
  ".xlsx",
  ".xls",
  ".xlsm",
  ".json",
  ".jsonl",
  ".ndjson",
  ".html",
  ".htm",
  ".parquet",
]);
/** Extensions the runtime classifies as binary pointers: a scan without a
 * preview is rejected (`SCAN_FORMAT`), so they need a UDF loader instead. */
const BINARY_EXTENSIONS = new Set([
  ".gpkg",
  ".shp",
  ".npz",
  ".npy",
  ".cdf",
  ".nc",
  ".h5",
  ".hdf5",
  ".pkl",
  ".zip",
  ".gz",
  ".db",
  ".sqlite",
]);

export interface SeedScanSpec {
  op: "scan";
  id: string;
  files: string;
  format?: "lines";
}

export interface SeedPlan {
  operators: SeedScanSpec[];
  /** The seed as a native program: one `id = scan("path")` per source. */
  program: string;
  observe: string[];
  skipped: Array<{ path: string; reason: string }>;
  /** Observation budget per seeded source, in characters. */
  perSourceChars: number;
}

/** A stable operator id from a path or glob: the file stem as an identifier;
 * a glob whose last segment is only a pattern (`dir/*.csv`) takes the
 * directory's name instead. */
export function seedOperatorId(path: string, taken: Set<string>): string {
  const stripped = path.replace(/[*?[\]{}]+/g, "");
  const identifier = (s: string) => s.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  let stem = identifier(basename(stripped).replace(/\.[^.]*$/, ""));
  if (!stem) stem = identifier(basename(dirname(stripped)));
  let id = stem;
  if (!id) id = "source";
  if (!/^[A-Za-z_]/.test(id)) id = `src_${id}`;
  let candidate = id;
  for (let n = 2; taken.has(candidate); n++) candidate = `${id}_${n}`;
  taken.add(candidate);
  return candidate;
}

/** Budget per source: share `SEED_BUDGET_MULTIPLIER` results' worth of
 * characters, never more than one result's limit, never less than a header
 * and a row. */
export function seedPerSourceChars(sourceCount: number, maxResultChars: number): number {
  if (sourceCount <= 0) return maxResultChars;
  const share = Math.floor((maxResultChars * SEED_BUDGET_MULTIPLIER) / sourceCount);
  return Math.max(SEED_MIN_CHARS_PER_SOURCE, Math.min(maxResultChars, share));
}

/**
 * Plan the seed batch for a task's listed sources. Tabular formats rely on the
 * scan's own extension detection; other text files are read as raw `lines`
 * (the same raw discovery the model performs) so parsing stays the model's
 * decision; binary pointers are skipped and reported.
 */
export function planSeedSources(sources: readonly string[], maxResultChars: number): SeedPlan {
  const paths = [...new Set(sources.map(s => s.trim()).filter(s => s.length > 0))];
  const skipped: SeedPlan["skipped"] = [];
  if (paths.length > SEED_MAX_SOURCES) {
    return {
      operators: [],
      program: "",
      observe: [],
      skipped: paths.map(path => ({ path, reason: `more than ${SEED_MAX_SOURCES} sources listed` })),
      perSourceChars: maxResultChars,
    };
  }
  const taken = new Set<string>();
  const operators: SeedScanSpec[] = [];
  for (const path of paths) {
    const ext = extname(path.replace(/[*?[\]{}]+/g, "")).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      skipped.push({ path, reason: "binary format needs a process loader" });
      continue;
    }
    const spec: SeedScanSpec = { op: "scan", id: seedOperatorId(path, taken), files: path };
    if (!AUTO_EXTENSIONS.has(ext)) spec.format = "lines";
    operators.push(spec);
  }
  return {
    operators,
    program: operators.map(seedStatement).join("\n"),
    observe: operators.map(o => o.id),
    skipped,
    perSourceChars: seedPerSourceChars(operators.length, maxResultChars),
  };
}

/** `id = scan("path")`, exactly as the model would write it. */
export function seedStatement(spec: SeedScanSpec): string {
  return `${spec.id} = scan(${JSON.stringify(spec.files)}${spec.format ? `, format=${JSON.stringify(spec.format)}` : ""})`;
}
