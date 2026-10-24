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

import type { OperatorInfo } from "../../types/execution";
import type { OperatorPredicate } from "../../types/workflow";
import { nativeAssignmentText, nativeOperatorName } from "./catalog";
import type { FlowReceiptObservation } from "./evidence-compaction";

export interface ObservationFormatSettings {
  tableFormat: "markdown" | "tsv";
  keyValueColumns: number;
  columnsShown: number;
  definitionChars: number;
  cellChars: number;
  topValues: number;
  catalogRecords: number;
  answerEcho: boolean;
  /** Rows a `full` view shows of a whole table that exceeds its character
   * budget; 0 shows as many rows as fit. Complete tables, tables read from
   * files, source previews and column selections are not capped. */
  fullPreviewRows: number;
  /** A dataflow call may leave out `python` when it defines nothing; the tool
   * schema and the prompt's examples then omit an empty one. */
  optionalPython: boolean;
  /** Text keys and missing values: notes for group and partition keys whose
   * values differ only in how they are written, for null keys a join leaves
   * unmatched on both sides, null counts with full views, and the prompt rule
   * to normalize keys before grouping or joining. */
  dataHygiene: boolean;
  /** `round(x, n)` in lambdas and registered functions rounds floats as
   * pandas and NumPy do (0.015 → 0.02), not as Python does (0.01). */
  pandasRound: boolean;
  /** Leave out the `columns:` line where the statistics rows already list
   * every column with its type. */
  compactRecords: boolean;
  /** The final reply holds only what the requested answer format asks for,
   * with no account of the steps behind it. */
  answerOnlyReply: boolean;
  /** Each dataflow call comes with one sentence of visible plan: replays of
   * recorded DeepSeek calls reasoned about a quarter less with it. */
  planLine: boolean;
}
export type ObservationFormatOptions = Partial<ObservationFormatSettings>;
export const DEFAULT_OBSERVATION_FORMAT: ObservationFormatSettings = {
  tableFormat: "markdown",
  keyValueColumns: 12,
  columnsShown: 40,
  definitionChars: 200,
  cellChars: 160,
  topValues: 4,
  catalogRecords: 0,
  answerEcho: false,
  fullPreviewRows: 0,
  optionalPython: false,
  dataHygiene: false,
  pandasRound: false,
  compactRecords: false,
  answerOnlyReply: false,
  planLine: false,
};
export function observationFormat(options: ObservationFormatOptions = {}): ObservationFormatSettings {
  return Object.fromEntries(
    Object.entries(DEFAULT_OBSERVATION_FORMAT).map(([key, value]) => [
      key,
      options[key as keyof ObservationFormatSettings] ?? value,
    ])
  ) as unknown as ObservationFormatSettings;
}
export function observationFormatPatch(options: ObservationFormatOptions): ObservationFormatOptions {
  return Object.fromEntries(
    Object.keys(DEFAULT_OBSERVATION_FORMAT)
      .filter(key => options[key as keyof ObservationFormatSettings] !== undefined)
      .map(key => [key, options[key as keyof ObservationFormatSettings]])
  );
}

export const formatCount = (value: number | null | undefined) =>
  value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value.toLocaleString("en-US")
    : "unknown";

/** `1 row`, `20 rows`, `unknown rows`: the noun agrees with the count. */
export const countOf = (value: number | null | undefined, noun: string, plural = `${noun}s`) =>
  `${formatCount(value)} ${value === 1 ? noun : plural}`;

/** `10,012 rows × 23 columns`. */
export const shapeText = (rows: number | null | undefined, columns: number | null | undefined) =>
  `${countOf(rows, "row")} × ${countOf(columns, "column")}`;

export function columnType(type: string): string {
  const key = type.toLowerCase();
  if (["string", "text", "varchar"].includes(key)) return "str";
  if (["integer", "int", "long", "int32", "short", "byte"].includes(key)) return "int64";
  if (["float", "double", "decimal", "number", "float32"].includes(key)) return "float64";
  if (key === "boolean") return "bool";
  if (["timestamp", "date", "timestamp with time zone"].includes(key)) return "datetime";
  return key;
}

type Layout = "markdown" | "tsv" | "key-value";
/** Only the cell separator needs escaping: the model reads the raw text, so
 * doubling backslashes would corrupt JSON-quoted values such as "a\nb". */
const escapeMarkdown = (text: string) => text.replace(/\|/g, "\\|");

/** A table cell that is not a data value (names, shapes, lists in an index
 * row): only the layout's separator is escaped, nothing is quoted. */
export function tableCell(text: string, format: "markdown" | "tsv"): string {
  return format === "tsv" ? text.replace(/[\t\r\n]+/g, " ") : text.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");
}

/** ISO 8601 in UTC with the original fractional digits. A value without a
 * zone is UTC by the runtime's contract; an offset is converted exactly. */
export function utcDatetime(text: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?$/.exec(
      text.trim()
    );
  if (!match) return text;
  const [, y, mo, d, h, mi, sec = "00", fraction, zone] = match;
  let offsetMinutes = 0;
  if (zone && !/^[zZ]$/.test(zone)) {
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || "0"));
  }
  const instant = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec) - offsetMinutes * 60_000);
  if (!Number.isFinite(instant.getTime())) return text;
  const iso = instant.toISOString().slice(0, 19);
  return `${iso}${fraction ? `.${fraction}` : ""}Z`;
}
const ambiguousText = /^(?:null|true|false|nan|[+-]?infinity|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/i;

/** Values are encoded by their schema, including decimal-string int64 transport.
 * Formatting never rounds a record or turns numeric-looking text into a number. */
export function displayValue(
  value: unknown,
  type: string,
  layout: Layout,
  cellChars = 0
): { text: string; clipped: boolean } {
  if (value === undefined) return { text: "unknown", clipped: false };
  if (value === null) return { text: "null", clipped: false };
  const kind = columnType(type);
  let text: string;
  let clipped = false;
  if (kind === "int64" && typeof value === "string" && /^-?(?:0|[1-9]\d*)$/.test(value)) text = value;
  else if (kind === "datetime" && (typeof value === "string" || value instanceof Date)) {
    text = value instanceof Date ? value.toISOString() : utcDatetime(value);
  } else if (typeof value === "string") {
    let shown = value;
    if (cellChars > 0 && shown.length > cellChars) {
      shown = shown.slice(0, cellChars) + "…";
      clipped = true;
    }
    if (value.includes("...[truncated]...")) clipped = true;
    const quote =
      !shown.length ||
      ambiguousText.test(shown) ||
      /^\s|\s$/.test(shown) ||
      /[\t\r\n\\]/.test(shown) ||
      (layout === "markdown" && shown.includes("|")) ||
      (layout === "key-value" && /, |: /.test(shown));
    text = quote ? JSON.stringify(shown) : shown;
  } else if (typeof value === "number")
    // Integers are exact. A fraction shows 15 significant digits: float64
    // carries about 16, and the last one or two are binary rounding noise
    // (63.153999999999996 for a sum that is 63.154).
    text = !Number.isFinite(value)
      ? "null"
      : Number.isInteger(value) || kind === "int64"
        ? String(value)
        : String(Number(value.toPrecision(15)));
  else if (typeof value === "bigint") text = String(value);
  else text = JSON.stringify(value) ?? "unknown";
  return { text: layout === "markdown" ? escapeMarkdown(text) : text, clipped };
}

export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  format: "markdown" | "tsv"
): string {
  const names = headers.map(name => displayValue(name, "str", format).text);
  return format === "tsv"
    ? [names.join("\t"), ...rows.map(row => row.join("\t"))].join("\n")
    : [
        `| ${names.join(" | ")} |`,
        `|${names.map(() => "---").join("|")}|`,
        ...rows.map(row => `| ${row.join(" | ")} |`),
      ].join("\n");
}

export interface FrozenRecords {
  view: string;
  layout: Layout;
  fields: Array<{ name: string; type: string }>;
  /** In selection priority (for samples, one row per cell pattern, then head
   * and tail rows alternating); `index` is
   * the row's position in the retained result, used to print rows in table
   * order. Older frozen observations have no index and print as stored. */
  rows: Array<{ line: string; clipped: number; index?: number }>;
  totalRows: number | null;
  totalColumns: number;
  sourceComplete: boolean;
  preview: boolean;
  schema: string;
  /** Records restricted to requested columns. */
  columnsRequested?: boolean;
  /** Characters the records were cut at, when the budget removed rows. */
  cutAt?: number;
  /** Characters a whole table exceeded when its full view kept only its first rows. */
  capped?: number;
  /** Sample rows were chosen one per cell pattern before head and tail rows. */
  shapes?: boolean;
}
export interface RenderedRecords {
  text: string;
  frozen: FrozenRecords;
  totalRows: number | null;
  returnedRows: number;
  totalColumns: number;
  columnsShown: number;
  clippedCells: number;
  complete: boolean;
}

function recordCaption(view: FrozenRecords, rows: FrozenRecords["rows"], shapeOnly = false, cutAt?: number): string {
  const clipped = rows.reduce((sum, row) => sum + row.clipped, 0);
  const complete =
    !shapeOnly &&
    view.sourceComplete &&
    rows.length === view.totalRows &&
    view.fields.length === view.totalColumns &&
    !clipped;
  // Every row is shown, but some columns or cell contents are not.
  const allRows = !shapeOnly && view.sourceComplete && rows.length === view.totalRows;
  const gaps = rows.length > 1 && rows.some(row => row.index !== undefined) && !isContiguous(rows);
  const annotations = [
    ...(complete
      ? ["complete"]
      : allRows
        ? ["all rows"]
        : [
            gaps
              ? `${view.shapes ? "one row per cell pattern, then " : ""}first and last retained records; … marks omitted rows`
              : "retained records, not a random sample",
          ]),
    ...(view.columnsRequested ? ["columns requested"] : []),
    ...(view.capped !== undefined
      ? [`first ${countOf(rows.length, "row")}; the whole table exceeds ${formatCount(view.capped)} characters`]
      : []),
    ...(cutAt !== undefined ? [`cut at ${formatCount(cutAt)} characters`] : []),
    ...(view.preview ? ["source preview only"] : []),
    ...(clipped ? [`${countOf(clipped, "clipped cell")}`] : []),
  ];
  return `records: ${view.view}; ${formatCount(rows.length)} of ${countOf(view.totalRows, "row")}, ${formatCount(view.fields.length)} of ${countOf(view.totalColumns, "column")} (${annotations.join("; ")})`;
}

const isContiguous = (rows: FrozenRecords["rows"]) => {
  const indexes = rows.map(row => row.index ?? -1).sort((a, b) => a - b);
  return indexes.every((index, i) => i === 0 || index === indexes[i - 1] + 1);
};

/** A cell's class in a row's pattern: missing, number-like, or other text. */
function cellClass(value: unknown): "missing" | "number" | "text" {
  if (value === null || value === undefined) return "missing";
  if (typeof value === "number" || typeof value === "bigint") return "number";
  if (typeof value !== "string") return "text";
  const text = value.replace(/\s/g, "");
  if (!text) return "missing";
  return /^[(+\-$€£]*\d[\d,]*(\.\d+)?(e[+-]?\d+)?%?\)?$/i.test(text) ? "number" : "text";
}

/** Sample priority: one row of each cell pattern (common patterns first, the
 * all-missing one last), then head and tail rows alternating. A few rows from
 * each end alone can miss the rows a filter must handle: an unranked row just
 * above a footnote, a subtotal, a repeated header. */
function sampleOrder(
  rows: readonly Record<string, unknown>[],
  fields: readonly { name: string }[]
): { order: number[]; patterns: number } {
  const ends = rows.map((_, i) => (i % 2 === 0 ? i / 2 : rows.length - 1 - Math.floor(i / 2)));
  const patterns = new Map<string, { first: number; count: number; empty: boolean }>();
  rows.forEach((row, i) => {
    const classes = fields.map(field => cellClass(row[field.name]));
    const key = classes.join(",");
    const pattern = patterns.get(key);
    if (pattern) pattern.count++;
    else patterns.set(key, { first: i, count: 1, empty: classes.every(c => c === "missing") });
  });
  // Patterns that barely repeat (a sparse wide table where every row differs)
  // carry no shape signal; head and tail rows then show the table's ends.
  if (patterns.size < 2 || patterns.size * 2 > rows.length) return { order: ends, patterns: 1 };
  const representatives = [...patterns.values()]
    .sort((a, b) => Number(a.empty) - Number(b.empty) || b.count - a.count || a.first - b.first)
    .map(pattern => pattern.first);
  const chosen = new Set(representatives);
  return { order: [...representatives, ...ends.filter(i => !chosen.has(i))], patterns: patterns.size };
}

/** Rows in table order, with a gap line wherever retained rows were skipped. */
function displayLines(rows: FrozenRecords["rows"], layout: Layout, width: number): string[] {
  if (rows.some(row => row.index === undefined)) return rows.map(row => row.line);
  const ordered = [...rows].sort((a, b) => a.index! - b.index!);
  const gap =
    layout === "key-value" ? "- …" : layout === "tsv" ? "…" : `| ${Array(Math.max(1, width)).fill("…").join(" | ")} |`;
  const lines: string[] = [];
  ordered.forEach((row, i) => {
    if (i > 0 && row.index! !== ordered[i - 1].index! + 1) lines.push(gap);
    lines.push(row.line);
  });
  return lines;
}

/** Restrict only frozen display lines. No fresh rows, profiles or graph are read. */
export function restrictRecords(
  frozen: FrozenRecords,
  limits: { maxChars: number; maxRows?: number; detail?: "shape"; previewRows?: number }
): RenderedRecords {
  const budget = Math.max(0, Math.floor(limits.maxChars));
  const rowLimit = limits.maxRows && limits.maxRows > 0 ? Math.floor(limits.maxRows) : frozen.rows.length;
  let rows = limits.detail === "shape" ? [] : frozen.rows.slice(0, rowLimit);
  const header =
    frozen.layout === "key-value" || !frozen.fields.length
      ? ""
      : renderTable(
          frozen.fields.map(c => c.name),
          [],
          frozen.layout
        );
  let cutAt: number | undefined;
  let shown = frozen;
  const render = () =>
    [
      frozen.schema,
      recordCaption(shown, rows, limits.detail === "shape", cutAt),
      header,
      ...displayLines(rows, frozen.layout, frozen.fields.length),
    ]
      .filter(Boolean)
      .join("\n");
  // A whole table that exceeds the budget shows its first rows only: the rows
  // that would fill the budget are a preview of the table either way. Source
  // previews and column selections keep the rows they were narrowed to show,
  // and so does a one-column table, which is text read line by line (a
  // docstring, a file's lines) rather than records.
  const previewRows = limits.previewRows && limits.previewRows > 0 ? Math.floor(limits.previewRows) : 0;
  if (
    previewRows &&
    rows.length > previewRows &&
    frozen.fields.length > 1 &&
    !frozen.preview &&
    !frozen.columnsRequested &&
    render().length > budget
  ) {
    rows = rows.slice(0, previewRows);
    shown = { ...frozen, capped: budget };
  }
  if (render().length > budget && rows.length) {
    cutAt = budget;
    const available = rows;
    let low = 0,
      high = rows.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      rows = available.slice(0, middle);
      if (render().length <= budget) low = middle;
      else high = middle - 1;
    }
    rows = available.slice(0, low);
  }
  let text = render();
  let fields = frozen.fields;
  if (text.length > budget) {
    fields = [];
    const notice = `records: ${frozen.view}; omitted (budget); ${shapeText(frozen.totalRows, frozen.totalColumns)}`;
    text = notice.length <= budget ? notice : budget >= 7 ? "omitted" : "…".slice(0, budget);
  }
  const clippedCells = rows.reduce((sum, row) => sum + row.clipped, 0);
  const complete =
    fields.length === frozen.totalColumns &&
    frozen.sourceComplete &&
    rows.length === frozen.totalRows &&
    limits.detail !== "shape" &&
    !clippedCells &&
    text.includes("(complete");
  return {
    text,
    frozen: { ...shown, fields, rows, sourceComplete: complete },
    totalRows: frozen.totalRows,
    returnedRows: rows.length,
    totalColumns: frozen.totalColumns,
    columnsShown: fields.length,
    clippedCells,
    complete,
  };
}

/**
 * A visualization operator's record (`is_visualization=True`) carries a chart's
 * HTML in `html-content`. The chart is for the user's panel; the model reads
 * what it is, not the markup.
 */
function visualizationRows(rows: Array<Record<string, any>>): Array<Record<string, any>> {
  if (rows[0]?.["__is_visualization__"] !== true || typeof rows[0]["html-content"] !== "string") return rows;
  return rows.map(row => {
    const html = row["html-content"];
    return typeof html === "string"
      ? { ...row, "html-content": `<chart: ${formatCount(html.length)} chars of HTML, rendered in the user's panel>` }
      : row;
  });
}

export function renderRecords(
  info: OperatorInfo,
  options: ObservationFormatOptions & {
    view?: string;
    maxChars: number;
    maxRows?: number;
    columns?: readonly string[];
    detail?: "shape" | "sample";
    preview?: boolean;
    /** The table was read from files (a scan or a loader): its first look shows as many rows as fit. */
    source?: boolean;
    relevant?: ReadonlySet<string>;
  }
): RenderedRecords {
  const config = observationFormat(options);
  const rows = visualizationRows(info.result ?? []);
  const declared =
    info.resultSchema ?? [...new Set(rows.flatMap(row => Object.keys(row)))].map(name => ({ name, type: "unknown" }));
  const totalRows =
    typeof info.totalRowCount === "number" && Number.isSafeInteger(info.totalRowCount) && info.totalRowCount >= 0
      ? info.totalRowCount
      : null;
  const totalColumns = Math.max(declared.length, info.tableProfile?.columnCount ?? 0);
  const allowed = declared.filter(field => !options.columns?.length || options.columns.includes(field.name));
  const position = new Map(declared.map((field, i) => [field.name, i]));
  const rowLimit =
    options.view !== "full" && options.maxRows && options.maxRows > 0 ? Math.floor(options.maxRows) : rows.length;
  const sampled = options.view === "full" || options.preview ? undefined : sampleOrder(rows, allowed);
  const ordered = sampled ? sampled.order : rows.map((_, i) => i);
  const build = (fields: typeof allowed, cellLimit?: number): FrozenRecords => {
    const layout =
      config.keyValueColumns > 0 && fields.length > config.keyValueColumns ? "key-value" : config.tableFormat;
    const cap = cellLimit ?? (options.view === "full" || (options.preview && rows.length === 1) ? 0 : config.cellChars);
    const rendered = ordered.slice(0, rowLimit).map(index => {
      const values = fields.map(field => displayValue(rows[index][field.name], field.type, layout, cap));
      const cells = values.map(value => value.text);
      const line = !fields.length
        ? "- (no columns)"
        : layout === "key-value"
          ? `- ${fields.map((field, i) => `${displayValue(field.name, "str", "key-value").text}: ${cells[i]}`).join(", ")}`
          : layout === "tsv"
            ? cells.join("\t")
            : `| ${cells.join(" | ")} |`;
      return { line, clipped: values.filter(value => value.clipped).length, index };
    });
    const schema = fields.length
      ? `columns: ${columnEntries(fields, config.columnsShown, true, totalColumns).join(", ")}`
      : "";
    return {
      view: options.view ?? "sample",
      layout,
      fields: fields.map(field => ({ name: field.name, type: columnType(field.type) })),
      rows: rendered,
      totalRows,
      totalColumns,
      schema,
      preview: !!options.preview,
      ...(options.columns?.length ? { columnsRequested: true } : {}),
      ...(sampled && sampled.patterns > 1 ? { shapes: true } : {}),
      sourceComplete:
        !!info.resultSchema &&
        info.truncated === false &&
        totalRows === rows.length &&
        rows.every(row =>
          declared.every(
            field =>
              Object.hasOwn(row, field.name) &&
              !(typeof row[field.name] === "string" && row[field.name].includes("...[truncated]..."))
          )
        ),
    };
  };
  const limits = {
    maxChars: Math.max(0, options.maxChars - (options.view === "sample" ? "sample_stats".length - "sample".length : 0)),
    maxRows: options.view === "full" ? 0 : options.maxRows,
    detail: options.detail === "shape" ? ("shape" as const) : undefined,
    previewRows: options.view === "full" && !options.source ? config.fullPreviewRows : 0,
  };
  let frozen = build(allowed);
  let rendered = restrictRecords(frozen, limits);
  // A one-row raw header preview uses the record budget rather than the
  // ordinary sample-cell cap. Clip its text explicitly instead of dropping
  // the header needed to choose parsing options.
  if (
    options.preview &&
    rows.length === 1 &&
    options.view !== "full" &&
    rendered.returnedRows === 0 &&
    allowed.length
  ) {
    let low = 1,
      high = Math.max(1, ...allowed.map(field => String(rows[0][field.name] ?? "").length));
    let best: RenderedRecords | undefined;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = restrictRecords(build(allowed, middle), limits);
      if (candidate.returnedRows) {
        best = candidate;
        low = middle + 1;
      } else high = middle - 1;
    }
    if (best) rendered = best;
  }
  // Keep a useful example on wide sampled tables by narrowing columns within
  // the same budget. This selection is independent of evidence switches.
  if (options.view !== "full" && rows.length && rendered.returnedRows === 0 && allowed.length > 1) {
    const ranked = [...allowed].sort(
      (a, b) =>
        Number(options.relevant?.has(b.name) ?? false) - Number(options.relevant?.has(a.name) ?? false) ||
        position.get(a.name)! - position.get(b.name)!
    );
    for (let size = ranked.length - 1; size >= 1; size--) {
      const chosen = new Set(ranked.slice(0, size).map(field => field.name));
      frozen = build(allowed.filter(field => chosen.has(field.name)));
      rendered = restrictRecords(frozen, limits);
      if (rendered.returnedRows) break;
    }
  }
  return rendered;
}

export function inlineCode(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const mark = "`".repeat(longest + 1);
  const content = text.replace(/[\r\n]+/g, " ");
  return `${mark}${content.startsWith("`") ? " " : ""}${content}${content.endsWith("`") ? " " : ""}${mark}`;
}

/** Compress only consecutive numbered columns of the same type; count every
 * hidden physical column rather than the number of compressed entries. */
export function columnEntries(
  fields: readonly { name: string; type?: string }[],
  limit = 16,
  types = true,
  total = fields.length
): string[] {
  const entries: Array<{ text: string; size: number }> = [];
  for (let i = 0; i < fields.length; i++) {
    let end = i;
    const match = /^(.*?)(\d+)$/.exec(fields[i].name);
    if (match && String(Number(match[2])) === match[2]) {
      while (end + 1 < fields.length) {
        const next = /^(.*?)(\d+)$/.exec(fields[end + 1].name);
        if (
          !next ||
          next[1] !== match[1] ||
          Number(next[2]) !== Number(match[2]) + end - i + 1 ||
          String(Number(next[2])) !== next[2] ||
          fields[end + 1].type !== fields[i].type
        )
          break;
        end++;
      }
    }
    if (end - i < 2) end = i;
    const name = fields[i].name + (end > i ? `..${fields[end].name}` : "");
    entries.push({
      text: `${displayValue(name, "str", "key-value").text}${types ? ` ${columnType(fields[i].type ?? "unknown")}` : ""}`,
      size: end - i + 1,
    });
    i = end;
  }
  const shown = limit > 0 ? entries.slice(0, limit) : entries;
  const more = total - shown.reduce((n, entry) => n + entry.size, 0);
  return [...shown.map(entry => entry.text), ...(more ? [`… +${more} more`] : [])];
}

/** A table's columns relative to its first input's, when that is shorter
 * than listing them: `same as x`, then retyped, dropped or added columns. */
export function columnsFromInput(
  fields: readonly { name: string; type?: string }[],
  input: readonly { name: string; type?: string }[],
  inputName: string,
  limit = 0
): string | undefined {
  const types = new Map(input.map(field => [field.name, field.type]));
  const names = new Set(fields.map(field => field.name));
  const kept = fields.filter(field => types.has(field.name));
  const order = input.filter(field => names.has(field.name));
  const firstAdded = fields.findIndex(field => !types.has(field.name));
  if (
    kept.some((field, i) => field.name !== order[i].name) ||
    (firstAdded >= 0 && fields.slice(firstAdded).some(field => types.has(field.name)))
  )
    return undefined;
  const retyped = kept.filter(field => field.type !== types.get(field.name));
  const dropped = input.filter(field => !names.has(field.name));
  const added = fields.filter(field => !types.has(field.name));
  const text = [
    `same as ${inlineCode(inputName)}`,
    ...(retyped.length ? [`retyped ${columnEntries(retyped, limit).join(", ")}`] : []),
    ...(dropped.length ? [`without ${columnEntries(dropped, limit, false).join(", ")}`] : []),
    ...(added.length ? [`plus ${columnEntries(added, limit).join(", ")}`] : []),
  ].join("; ");
  return text.length < columnEntries(fields, limit).join(", ").length ? text : undefined;
}

export interface OperatorBlock {
  id: string;
  kind: string;
  state: string;
  definition?: string;
  functions?: string;
  description?: string;
  signature?: string;
  /** A catalog entry's input names the earlier task that last set it. */
  inputs?: Array<{ port?: string; id: string; taskId?: number }>;
  origin?: string;
  result?: string;
  columns?: readonly string[];
  /** Catalog entries: the columns stated relative to the first input's. */
  columnsFromInput?: string;
  usedBy?: readonly string[];
  /** Bounded structural facts from the graph and results of this observation. */
  scope?: readonly string[];
  issues?: readonly string[];
  /** Self-contained selected flow facts; text receipts share them only after
   * deciding which operator blocks are actually displayed. */
  flow_observation?: FlowReceiptObservation;
}
export function operatorBlock(block: OperatorBlock): string {
  const state = block.state === "cached" || block.state === "executed" ? "completed" : block.state;
  return [
    `- **${block.id}** (${block.kind}, ${state})`,
    ...(block.definition ? [`  - definition: ${inlineCode(block.definition)}`] : []),
    ...(block.description ? [`  - description: ${block.description.replace(/\n/g, " ")}`] : []),
    ...(block.signature ? [`  - signature: ${inlineCode(block.signature)}`] : []),
    ...(block.functions
      ? (() => {
          const fence = "`".repeat(Math.max(3, ...(block.functions.match(/`+/g) ?? []).map(run => run.length + 1)));
          return [
            "  - functions:",
            `    ${fence}python`,
            ...block.functions.split("\n").map(line => `    ${line}`),
            `    ${fence}`,
          ];
        })()
      : []),
    ...(block.inputs?.length
      ? [
          `  - inputs: ${block.inputs.map(input => `${input.port ? `${input.port} ` : ""}${input.id === "unconnected" ? "unconnected" : inlineCode(input.id)}${input.taskId !== undefined ? ` (task ${input.taskId})` : ""}`).join(", ")}`,
        ]
      : []),
    ...(block.origin ? [`  - origin: ${block.origin}`] : []),
    ...(block.result ? [`  - result: ${block.result}`] : []),
    ...(block.columnsFromInput
      ? [`  - columns: ${block.columnsFromInput}`]
      : block.columns?.length
        ? [`  - columns: ${block.columns.join(", ")}`]
        : []),
    ...(block.usedBy?.length ? [`  - used by: ${block.usedBy.map(inlineCode).join(", ")}`] : []),
    // A scan's reading notes keep their own label.
    ...(block.scope ?? []).map(line => (line.startsWith("note: ") ? `  - ${line}` : `  - scope: ${line}`)),
    // An issue's own detail lines (`- at:`, `- fix:`) nest under it.
    ...(block.issues ?? []).flatMap(issue => {
      const [first, ...rest] = issue.split("\n");
      return [
        `  ${first.trimStart().startsWith("- ") ? first.trimStart() : `- ${first.trimStart()}`}`,
        ...rest
          .filter(line => line.trim())
          .map(line => `    ${line.trimStart().startsWith("- ") ? line.trimStart() : `- ${line.trimStart()}`}`),
      ];
    }),
  ].join("\n");
}

export function describeOperator(
  op: OperatorPredicate,
  info: OperatorInfo | undefined,
  options: ObservationFormatOptions & {
    state?: string;
    origin?: string;
    definition?: boolean;
    implementation?: boolean;
    usedBy?: string[];
    scope?: readonly string[];
    issues?: string[];
    stale?: boolean;
    definitionLimit?: boolean;
    /** The result is the one an earlier task saved for this copy's original. */
    savedBy?: number;
    namespace?: import("./registered").RegisteredNamespace;
  } = {}
): OperatorBlock {
  const config = observationFormat(options);
  const view = op.nativeOp;
  const ready = info && !info.error && ["Completed", "CompletedFromCache"].includes(info.state);
  const failed = info?.error && (!info.nativeError || info.nativeError.diagnostic.operatorId === op.operatorID);
  const state =
    options.state ??
    (info?.error
      ? failed
        ? "failed"
        : "not run"
      : ready
        ? options.savedBy !== undefined
          ? "saved"
          : info!.state === "CompletedFromCache" || info!.materialization?.cached
            ? "cached"
            : "executed"
        : options.stale
          ? "stale"
          : "not run");
  const names =
    view?.graph?.inputPorts ??
    (view?.inputs.length === 2 && view?.type === "Join"
      ? ["left", "right"]
      : view?.inputs.map((_, i) => (view.inputs.length === 1 ? "in" : `in[${i}]`))) ??
    [];
  const inputs = (view?.inputs ?? []).map((id, i) => ({
    id: id || "unconnected",
    ...(names.length > 1 || !id ? { port: names[i] } : {}),
  }));
  let definition = view ? nativeAssignmentText(op.operatorID, view) : undefined;
  if (definition && options.definitionLimit && config.definitionChars > 0 && definition.length > config.definitionChars)
    definition =
      definition.slice(0, config.definitionChars) + "… (definition clipped; show operator gives the full text)";
  const predicate =
    view?.type === "Filter" ? (view.properties.registered as { entry?: unknown } | undefined)?.entry : undefined;
  const registeredName = view?.registeredName ?? (typeof predicate === "string" ? predicate : undefined);
  const registeredFunction = registeredName ? options.namespace?.functions[registeredName] : undefined;
  const functions = options.implementation
    ? registeredFunction?.source ||
      Object.values(view?.functions ?? {})
        .filter(Boolean)
        .join("\n\n") ||
      (typeof view?.properties.code === "string"
        ? view.properties.code
        : typeof view?.properties.func === "string"
          ? view.properties.func
          : undefined)
    : undefined;
  const schema = ready ? (info!.resultSchema ?? []) : [];
  return {
    id: op.operatorID,
    kind: view ? (view.registeredName ?? nativeOperatorName(view.type)) : op.operatorType,
    state,
    ...(options.definition !== false && definition ? { definition } : {}),
    ...(functions ? { functions } : {}),
    ...(options.definition !== false && (view?.doc ?? registeredFunction?.doc)
      ? { description: view?.doc ?? registeredFunction?.doc }
      : {}),
    ...(options.definition !== false && registeredFunction?.signature
      ? { signature: registeredFunction.signature }
      : {}),
    inputs,
    ...(options.origin ? { origin: options.origin } : {}),
    result: ready
      ? shapeText(info!.totalRowCount, Math.max(schema.length, info!.tableProfile?.columnCount ?? 0)) +
        (options.savedBy !== undefined ? ` (saved by task ${options.savedBy})` : "")
      : state === "stale" || (options.stale && state !== "failed")
        ? "stale (execute to recompute)"
        : state === "failed"
          ? "failed"
          : "not run",
    columns: columnEntries(schema, config.columnsShown),
    ...(options.usedBy ? { usedBy: options.usedBy } : {}),
    ...(options.scope?.length ? { scope: [...options.scope] } : {}),
    ...(options.issues ? { issues: options.issues } : {}),
  };
}

/** Stable Kahn traversal; cycles are displayed once rather than hanging. */
export function topologicalOperators<T extends { operatorID: string; nativeOp?: { inputs: string[] } }>(
  operators: readonly T[]
): T[] {
  const remaining = new Set(operators.map(op => op.operatorID));
  const ordered: T[] = [];
  while (remaining.size) {
    const next = operators.find(
      op => remaining.has(op.operatorID) && !(op.nativeOp?.inputs ?? []).some(id => remaining.has(id))
    );
    if (!next) {
      ordered.push(...operators.filter(op => remaining.has(op.operatorID)));
      break;
    }
    ordered.push(next);
    remaining.delete(next.operatorID);
  }
  return ordered;
}
