/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * SAMPLE-BASED tuple-level profiling for summarize()'s
 * `result.*.tuple.{duplicates,fdHints}` params.
 *
 * These run SERVICE-SIDE over the operator's *sampled* result rows (the only
 * rows this service holds — the worker keeps the full frame). Every emitted
 * line is therefore explicitly labeled "sample-based": a duplicate or a
 * functional dependency observed on the sample is evidence, not proof.
 * (Whole-frame equivalents belong in the worker, alongside the existing
 * `__table_hints__` instrumentation, if they ever prove their token cost.)
 *
 * Determinism: output depends only on the row array (column order taken from
 * the first row), so re-rendering a recorded trace is stable.
 */

const HIDDEN_KEYS = new Set(["__row_index__", "__is_visualization__"]);

/** Max columns considered by the O(cols²) passes — wide frames get the first
 *  MAX_PROFILE_COLUMNS columns only (matching the TSV's own column cap ethos). */
const MAX_PROFILE_COLUMNS = 12;
/** Cap on duplicate-column pairs / FD candidates listed. */
const MAX_LISTED = 5;

function visibleColumns(rows: Record<string, any>[]): string[] {
  if (rows.length === 0) return [];
  return Object.keys(rows[0]).filter(k => !HIDDEN_KEYS.has(k));
}

function cellKey(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return `${typeof v}:${String(v)}`;
}

/**
 * `Sample duplicates:` line — duplicate ROWS (identical across all visible
 * columns) and duplicate COLUMN PAIRS (equal in every sampled row) observed
 * in the sample. Returns undefined when neither exists (the common case, so
 * the knob is usually free).
 */
export function formatSampleDuplicates(rows: Record<string, any>[] | undefined): string | undefined {
  if (!rows || rows.length < 2) return undefined;
  const cols = visibleColumns(rows);
  if (cols.length === 0) return undefined;

  // Duplicate rows.
  const seen = new Map<string, number>();
  for (const row of rows) {
    const key = cols.map(c => cellKey(row[c])).join("");
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const dupRows = rows.length - seen.size;

  // Duplicate column pairs (first MAX_PROFILE_COLUMNS columns).
  const probe = cols.slice(0, MAX_PROFILE_COLUMNS);
  const dupPairs: string[] = [];
  outer: for (let i = 0; i < probe.length; i++) {
    for (let j = i + 1; j < probe.length; j++) {
      let equal = true;
      for (const row of rows) {
        if (cellKey(row[probe[i]]) !== cellKey(row[probe[j]])) {
          equal = false;
          break;
        }
      }
      if (equal) {
        dupPairs.push(`\`${probe[i]}\` = \`${probe[j]}\``);
        if (dupPairs.length >= MAX_LISTED) break outer;
      }
    }
  }

  const clauses: string[] = [];
  if (dupRows > 0) clauses.push(`${dupRows} duplicate row${dupRows === 1 ? "" : "s"}`);
  if (dupPairs.length > 0) clauses.push(`identical columns: ${dupPairs.join(", ")}`);
  if (clauses.length === 0) return undefined;
  return `Sample duplicates (over ${rows.length} sampled rows): ${clauses.join("; ")}`;
}

/** Strip the punctuation a number might wear (`$`, thousands `,`, `%`, spaces,
 *  accounting parens) and test whether what remains is a finite number. */
function looksNumeric(s: string): boolean {
  const t = s.trim();
  if (t === "") return false;
  const cleaned = t.replace(/^\((.*)\)$/, "-$1").replace(/[$,%\s]/g, "");
  if (cleaned === "" || cleaned === "-") return false;
  return Number.isFinite(Number(cleaned));
}


/**
 * `Sample FDs:` line — candidate functional dependencies `A → B` that hold on
 * every sampled row. Trivial dependencies are suppressed:
 *   - A near-unique on the sample (a key determines everything);
 *   - B constant on the sample (anything determines a constant).
 * Capped at MAX_LISTED, columns capped at MAX_PROFILE_COLUMNS. Approximate by
 * construction — labeled as sample-based.
 */
export function formatSampleFds(rows: Record<string, any>[] | undefined): string | undefined {
  if (!rows || rows.length < 3) return undefined;
  const cols = visibleColumns(rows).slice(0, MAX_PROFILE_COLUMNS);
  if (cols.length < 2) return undefined;

  const distinct = new Map<string, number>();
  for (const c of cols) {
    distinct.set(c, new Set(rows.map(r => cellKey(r[c]))).size);
  }

  const fds: string[] = [];
  outer: for (const a of cols) {
    const dA = distinct.get(a)!;
    // A key-like column trivially determines everything; a constant column
    // can't meaningfully determine anything either.
    if (dA >= rows.length || dA <= 1) continue;
    for (const b of cols) {
      if (a === b) continue;
      const dB = distinct.get(b)!;
      if (dB <= 1) continue; // constant B — trivial
      // Check: every value of A maps to exactly one value of B.
      const mapping = new Map<string, string>();
      let holds = true;
      for (const row of rows) {
        const ka = cellKey(row[a]);
        const kb = cellKey(row[b]);
        const prev = mapping.get(ka);
        if (prev === undefined) mapping.set(ka, kb);
        else if (prev !== kb) {
          holds = false;
          break;
        }
      }
      // Skip the degenerate "A and B are copies" direction — the duplicates
      // pass reports identical columns already.
      if (holds && dA === dB && distinct.get(a) === rows.length) continue;
      if (holds) {
        fds.push(`\`${a}\` → \`${b}\``);
        if (fds.length >= MAX_LISTED) break outer;
      }
    }
  }

  if (fds.length === 0) return undefined;
  return `Sample FDs (over ${rows.length} sampled rows, approximate): ${fds.join("; ")}`;
}
