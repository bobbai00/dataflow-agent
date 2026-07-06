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
 * `Type anomaly:` line — columns rendered as TEXT whose values are mostly (but
 * not entirely) numeric. This is the "loaded as string but the samples look
 * like digits" signal: a handful of contaminant cells (`N/A`, `—`, a footnote,
 * `"12 or 14"`) force pandas to type an otherwise-numeric column as `object`,
 * and the fix is to see EXACTLY those non-numeric tokens — not more random
 * rows. For each qualifying column we report the numeric fraction and a few of
 * the offending non-numeric values (the surgical version of "reload with more
 * samples"). Returns undefined when no column qualifies (the common case, so
 * the knob is usually free).
 *
 * Gate: a column qualifies when its sampled cells are predominantly strings
 * (so it really did load as text), ≥ `MIN_NUMERIC_FRAC` of the non-empty
 * strings parse as numeric, and at least one does NOT (the contaminant). A
 * 100%-numeric-text column is pure numbers-as-text — that is `valueFormatHints`'
 * job (worker-published `format=` tags), so we don't double-report it here.
 */
const MIN_NUMERIC_FRAC = 0.6;

export function formatDtypeAnomaly(rows: Record<string, any>[] | undefined): string | undefined {
  if (!rows || rows.length < 2) return undefined;
  const cols = visibleColumns(rows);
  if (cols.length === 0) return undefined;

  const clauses: string[] = [];
  for (const c of cols.slice(0, MAX_PROFILE_COLUMNS)) {
    const vals = rows.map(r => r[c]).filter(v => v !== null && v !== undefined && v !== "");
    if (vals.length < 2) continue;
    const strs = vals.filter(v => typeof v === "string") as string[];
    // Predominantly string-typed cells (a genuinely numeric column arrives as
    // JS numbers, not strings, so it never trips this).
    if (strs.length < vals.length * 0.8) continue;
    const numeric = strs.filter(looksNumeric);
    const frac = numeric.length / strs.length;
    if (frac < MIN_NUMERIC_FRAC || frac >= 1) continue; // not mostly-numeric, or fully numeric (→ valueFormat)
    const offenders = Array.from(new Set(strs.filter(s => !looksNumeric(s)))).slice(0, 5);
    clauses.push(
      `\`${c}\` is text but ${Math.round(frac * 100)}% numeric — non-numeric values: [${offenders.map(o => JSON.stringify(o)).join(", ")}]`
    );
    if (clauses.length >= MAX_LISTED) break;
  }
  if (clauses.length === 0) return undefined;
  return `Type anomaly (sample-based): ${clauses.join("; ")}`;
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

/**
 * `Embedded header:` warning — a DIRTY load (generic `Unnamed:`/numeric headers)
 * whose early sample rows contain the REAL header row with REPEATED names
 * (e.g. `Tag, Enterococcus, Tag, Enterococcus, Tag, Enterococcus` under a
 * merged super-header of sampling locations). This is the environment-hard-11
 * trap: the agent re-headers from that row, then a lazy `columns.duplicated()`
 * dedup silently drops all but the first of each repeated name — discarding
 * distinct locations. Name the trap explicitly when the raw table is first read.
 *
 * Header-ness is NOT shape-matched ("short strings") — that misfires on
 * text-heavy data rows. It uses the standard `csv.Sniffer.has_header` evidence:
 * **type contrast** — a real header's string cells sit on top of columns whose
 * body values are typed (numeric); a text data row sits on top of more text.
 * A candidate row must win the per-column type-contrast vote (≥40% of its
 * header-like columns have predominantly numeric bodies below it), including at
 * least one of the DUPLICATED names. Scanning stops at the first data-like row
 * (majority numeric) — a header precedes data by definition. Returns undefined
 * when headers look real or no candidate survives (the common case).
 */
export function formatEmbeddedDupHeader(rows: Record<string, any>[] | undefined): string | undefined {
  if (!rows || rows.length < 3) return undefined;
  const cols = visibleColumns(rows);
  if (cols.length < 3) return undefined;
  // Only dirty loads: most headers generic (Unnamed: N, bare indices).
  const generic = cols.filter(c => /^Unnamed/i.test(c) || /^\d+$/.test(c)).length;
  if (generic < Math.ceil(cols.length * 0.5)) return undefined;

  const HEADERISH = (v: unknown): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= 40 && !/^\d+(\.\d+)?$/.test(v.trim());
  const NUMERICISH = (v: unknown): boolean => {
    if (typeof v === "number") return Number.isFinite(v);
    if (typeof v !== "string") return false;
    const s = v.trim().replace(/[%$,]/g, "");
    return s !== "" && !Number.isNaN(Number(s));
  };
  const present = (v: unknown) => v !== null && v !== undefined && v !== "";

  for (let r = 0; r < Math.min(rows.length, 4); r++) {
    const entries = cols.map(c => ({ c, v: rows[r][c] })).filter(e => present(e.v));
    if (entries.length === 0) continue;
    // Data started (majority numeric row) before any embedded header → stop:
    // a header precedes data by definition.
    if (entries.filter(e => NUMERICISH(e.v)).length >= Math.ceil(entries.length * 0.5)) break;
    const headerish = entries.filter(e => HEADERISH(e.v));
    if (headerish.length < Math.max(3, Math.ceil(entries.length * 0.6))) continue;
    // Repeated names among the header-like cells.
    const counts = new Map<string, string[]>(); // name -> columns carrying it
    for (const e of headerish) {
      const name = (e.v as string).trim();
      (counts.get(name) ?? counts.set(name, []).get(name)!).push(e.c);
    }
    const dups = [...counts.entries()].filter(([, cs]) => cs.length >= 2);
    if (dups.length === 0) continue;
    // csv.Sniffer-style type contrast: for each header-like column, do the
    // sampled body values BELOW this row look predominantly numeric? A text
    // data row (e.g. repeated city names) fails this vote — its body is text.
    const body = rows.slice(r + 1, r + 9);
    const votes = (c: string): boolean => {
      const below = body.map(row => row[c]).filter(present);
      if (below.length === 0) return false;
      return below.filter(NUMERICISH).length >= Math.ceil(below.length * 0.6);
    };
    const voting = headerish.filter(e => votes(e.c));
    if (voting.length < Math.ceil(headerish.length * 0.4)) continue;
    if (!dups.some(([, cs]) => cs.some(votes))) continue; // a DUPLICATED name must show contrast
    const listed = dups
      .slice(0, MAX_LISTED)
      .map(([name, cs]) => `\`${name}\` ×${cs.length}`)
      .join(", ");
    return (
      `Embedded header ⚠: row ${r} looks like the real header (its labels sit on typed value columns) and ` +
      `contains DUPLICATE names (${listed}) — likely one group per super-header section (see the row above it). ` +
      `When re-headering, disambiguate (e.g. suffix by section) — dropping duplicate-named columns silently ` +
      `discards distinct data.`
    );
  }
  return undefined;
}
