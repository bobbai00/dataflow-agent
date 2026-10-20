/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * `answer_from`: the final answer composed by the runtime from an observed
 * table, so a turn whose last call already built the answer table ends
 * without another model call (the answer call was 43% of a two-call turn's
 * cost). The composition is a fixed, documented mapping from the table's
 * rows to one JSON object; nothing is invented, and a table that cannot be
 * the answer (empty, not completely held, too large) is refused with a reason
 * the model reads in the observation.
 */
import type { OperatorInfo } from "../../types/execution";

export const ANSWER_ROW_LIMIT = 50;
export const ANSWER_CHAR_LIMIT = 4000;
export const ANSWER_MARKER = "Final Answer:";

export type ComposedAnswer = { text: string; json: string } | { reason: string; hint?: string };

/** The key of a projection entry that states the precision of every column
 * without its own (`t[:4]`, `t[:full]`). */
export const EVERY_COLUMN = "*";

/** One entry of an `answer_from` projection: `key=column:digits`. */
export interface AnswerShape {
  /** The key the value gets in the answer. */
  name: string;
  /** The table column it comes from; `*` for the precision of every column. */
  column: string;
  /** Round a number to this many decimals; "full" keeps it as computed. */
  digits?: number | "full";
}

/** `table[key=column:2, other, :4]` → the table id and its projection, or the
 * reason the text is not a valid answer_from. A bare `:digits` (or `:full`)
 * entry states the precision of every column that has none of its own; with
 * no column entries the answer takes every column. */
export function parseAnswerFrom(text: string): { id: string; shape?: AnswerShape[] } | { error: string } {
  const match = /^\s*([A-Za-z_]\w*)\s*(?:\[(.*)\])?\s*$/s.exec(text);
  if (!match)
    return {
      error: `answer_from must be a table id, optionally with a projection [key=column:digits, ..., :digits]; got ${JSON.stringify(text)}.`,
    };
  const [, id, inner] = match;
  if (inner === undefined) return { id };
  const shape: AnswerShape[] = [];
  for (const raw of inner.split(",")) {
    const item = raw.trim();
    if (!item) continue;
    const every = /^:\s*(\d{1,2}|full)$/.exec(item);
    if (every) {
      if (shape.some(entry => entry.column === EVERY_COLUMN))
        return { error: "answer_from states the precision of every column twice." };
      shape.push({ name: EVERY_COLUMN, column: EVERY_COLUMN, digits: every[1] === "full" ? "full" : Number(every[1]) });
      continue;
    }
    const spec = /^(?:([^=:]+?)\s*=\s*)?([^=:]+?)\s*(?::\s*(\d{1,2}|full))?$/.exec(item);
    if (!spec) return { error: `answer_from projection entry ${JSON.stringify(item)} is not key=column:digits.` };
    const strip = (value: string) => value.trim().replace(/^["']|["']$/g, "");
    const column = strip(spec[2]);
    const name = spec[1] !== undefined ? strip(spec[1]) : column;
    if (!column || !name) return { error: `answer_from projection entry ${JSON.stringify(item)} names no column.` };
    const digits = spec[3] === undefined ? undefined : spec[3] === "full" ? "full" : Number(spec[3]);
    shape.push({ name, column, ...(digits !== undefined ? { digits } : {}) });
  }
  if (!shape.length) return { error: "answer_from projection is empty; drop the brackets to take every column." };
  return { id, shape };
}

/** One part of an `answer_from` with several tables: `key=table[...]`. */
export interface AnswerPart {
  key: string;
  id: string;
  shape?: AnswerShape[];
}

/** `a[x:2]; totals=b[y]` → the parts of a multi-table answer, each a table
 * reference with an optional key (the table id by default). A single part
 * without a key is the plain single-table form. */
export function parseAnswerFromParts(text: string): { parts: AnswerPart[] } | { error: string } {
  const parts: AnswerPart[] = [];
  for (const raw of text.split(";")) {
    const item = raw.trim();
    if (!item) continue;
    const keyed = /^([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*\s*(?:\[.*\])?)$/s.exec(item);
    const parsed = parseAnswerFrom(keyed ? keyed[2] : item);
    if ("error" in parsed) return parsed;
    parts.push({ key: keyed ? keyed[1] : parsed.id, id: parsed.id, ...(parsed.shape ? { shape: parsed.shape } : {}) });
  }
  if (!parts.length) return { error: "answer_from names no table." };
  const keys = parts.map(part => part.key);
  if (new Set(keys).size !== keys.length)
    return { error: "answer_from repeats a key; name each part, e.g. leaders=t1; movers=t2." };
  return { parts };
}

/** The answer of several tables: one key per part, each composed as a single
 * table would be (an object for one row, a list of row objects for several, a
 * list of values for one column). Any refused part refuses the answer. */
export function composeAnswerParts(
  parts: AnswerPart[],
  lookup: (id: string) => OperatorInfo | undefined,
  options: { decimalRules?: number[] } = {}
): ComposedAnswer {
  if (parts.length === 1) return composeAnswer(parts[0].id, lookup(parts[0].id), parts[0].shape, options);
  const value: Record<string, unknown> = {};
  for (const part of parts) {
    const composed = composeAnswer(part.id, lookup(part.id), part.shape, options);
    if ("reason" in composed) return composed;
    const parsed = JSON.parse(composed.json) as Record<string, unknown>;
    // A single-table composition wraps several rows under the table id and a
    // single column under the column name; inside a multi-table answer the
    // part's key is that wrapper.
    const keys = Object.keys(parsed);
    value[part.key] =
      keys.length === 1 && (keys[0] === part.id || Array.isArray(parsed[keys[0]])) ? parsed[keys[0]] : parsed;
  }
  const json = JSON.stringify(value);
  if (json.length > ANSWER_CHAR_LIMIT)
    return {
      reason: `the answer composed from ${parts.map(p => `\`${p.id}\``).join(", ")} is ${json.length} characters; keep it under ${ANSWER_CHAR_LIMIT}`,
    };
  return { json, text: `**${ANSWER_MARKER} ${json}**` };
}

/** A number as a person writes it: binary noise such as 93.05000000000001
 * or 2.9999999999999996 is removed (12 significant digits), exact values are
 * unchanged. */
export function cleanNumber(value: number): number {
  return Number.isInteger(value) ? value : Number(value.toPrecision(12));
}

/**
 * `value` rounded to `digits` decimals as Python's `round(value, digits)`
 * rounds: on the exact binary value, ties to even. `toFixed` would round
 * exact ties away from zero (0.125 to 0.13, where Python and the pandas-based
 * references give 0.12).
 */
export function roundHalfEven(value: number, digits: number): number {
  if (!Number.isFinite(value) || Number.isInteger(value)) return value;
  const buffer = new DataView(new ArrayBuffer(8));
  buffer.setFloat64(0, Math.abs(value));
  const bits = buffer.getBigUint64(0);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  // |value| = mantissa * 2^exponent exactly.
  const mantissa = exponentBits === 0 ? fraction : fraction | (1n << 52n);
  const exponent = (exponentBits === 0 ? 1 : exponentBits) - 1075;
  const scale = 10n ** BigInt(digits);
  const numerator = exponent >= 0 ? mantissa * scale * (1n << BigInt(exponent)) : mantissa * scale;
  const denominator = exponent >= 0 ? 1n : 1n << BigInt(-exponent);
  let quotient = numerator / denominator;
  const twice = 2n * (numerator - quotient * denominator);
  if (twice > denominator || (twice === denominator && quotient % 2n === 1n)) quotient += 1n;
  const text = quotient.toString().padStart(digits + 1, "0");
  const decimal = digits ? `${text.slice(0, -digits)}.${text.slice(-digits)}` : text;
  const rounded = Number(decimal);
  return value < 0 && rounded !== 0 ? -rounded : rounded;
}

/** A decimal number written in text, not part of a dotted run (a date, a version). */
const DECIMAL_IN_TEXT = /(?<![\d.])-?\d+\.\d+(?![\d.])/g;

/** A stated precision applies wherever the numbers are: inside a list or
 * struct cell, and written inside a text cell (BI task 2 t8 returned the
 * per-gender means as a dict in a string, so 75.99658914728683 stayed where
 * 75.9966 was asked). */
function cell(value: unknown, digits?: number | "full"): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return typeof digits === "number" ? roundHalfEven(value, digits) : cleanNumber(value);
  }
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(item => cell(item, digits));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cell(v, digits)]));
  if (typeof value === "string" && typeof digits === "number")
    return value.replace(DECIMAL_IN_TEXT, text =>
      text.split(".")[1].length > digits ? String(roundHalfEven(Number(text), digits)) : text
    );
  return value;
}

const WORD_DIGITS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

/** The decimal places a session's requests state ("rounded to three decimal
 * places", "to 4 decimals"), in the order they were first stated. Most LongDS
 * tasks state the rule once, in the first request (56 of 68). */
export function statedDecimals(texts: string[]): number[] {
  const found = new Set<number>();
  for (const text of texts)
    for (const match of text.matchAll(/\b(\d{1,2}|zero|one|two|three|four|five|six)[\s-]+decimal/gi)) {
      const word = match[1].toLowerCase();
      found.add(word in WORD_DIGITS ? WORD_DIGITS[word] : Number(word));
    }
  return [...found];
}

function fractional(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && !Number.isInteger(cleanNumber(value));
}

/** One row → an object of its columns; several rows → `{<table>: [row
 * objects]}` in the table's order; one column over several rows →
 * `{<column>: [values]}`. A projection picks and renames the columns and
 * rounds numbers first. Numbers with decimals need a stated precision, and an
 * answer of nothing but nulls is not an answer. */
export function composeAnswer(
  id: string,
  info: OperatorInfo | undefined,
  shape?: AnswerShape[],
  options: {
    /** The decimal places the session's requests state (`statedDecimals`); a
     * stated precision outside them is refused. */
    decimalRules?: number[];
  } = {}
): ComposedAnswer {
  if (!info) return { reason: `\`${id}\` has no result` };
  if (info.error) return { reason: `\`${id}\` failed` };
  const held = (info.result ?? []) as Array<Record<string, unknown>>;
  const total = info.totalRowCount ?? held.length;
  if (total === 0) return { reason: `\`${id}\` is empty (0 rows)` };
  if (held.length < total)
    return {
      reason: `only ${held.length} of ${total} rows of \`${id}\` are held; the answer needs the complete table`,
    };
  if (total > ANSWER_ROW_LIMIT)
    return {
      reason: `\`${id}\` has ${total} rows; an answer table holds at most ${ANSWER_ROW_LIMIT} (aggregate, project or limit it)`,
    };
  const available = Object.keys(held[0] ?? {}).filter(name => !name.startsWith("__"));
  if (!available.length) return { reason: `\`${id}\` has no columns` };
  const every = shape?.find(item => item.column === EVERY_COLUMN)?.digits;
  const named = (shape ?? []).filter(item => item.column !== EVERY_COLUMN);
  for (const item of named)
    if (!available.includes(item.column))
      return { reason: `\`${id}\` has no column ${JSON.stringify(item.column)} (columns: ${available.join(", ")})` };
  const projection: AnswerShape[] = named.length ? named : available.map(name => ({ name, column: name }));
  const columns = projection.map(item => item.name);
  if (new Set(columns).size !== columns.length) return { reason: "the answer_from projection repeats a key" };
  const unstated = new Map<string, number>();
  const rows = held.map(row =>
    Object.fromEntries(
      projection.map(item => {
        const digits = item.digits ?? every;
        const raw = row[item.column];
        if (
          digits === undefined &&
          typeof raw === "number" &&
          Number.isFinite(raw) &&
          !Number.isInteger(cleanNumber(raw))
        )
          if (!unstated.has(item.name)) unstated.set(item.name, raw);
        return [item.name, cell(raw, digits)];
      })
    )
  );
  if (unstated.size) {
    const listed = [...unstated].slice(0, 4).map(([name, raw]) => `${JSON.stringify(name)} (e.g. ${raw})`);
    const first = [...unstated.keys()][0];
    return {
      reason: `\`${id}\` has numbers with decimals and answer_from states no precision for ${listed.join(", ")}${unstated.size > 4 ? ` and ${unstated.size - 4} more` : ""}`,
      hint: `Set answer_from again with the rounding the request asks for, e.g. "${id}[:2]" for every number or "${id}[${first}:2]" per column (":full" keeps the computed value), or write the final answer yourself.`,
    };
  }
  if (rows.every(row => columns.every(name => row[name] === null)))
    return {
      reason: `every value answer_from would report from \`${id}\` is null, so the table does not hold the answer`,
    };
  // A precision no request of the session states (survey-2020 task 3 t17:
  // 4 decimals where the session's rule is 3).
  const rules = options.decimalRules ?? [];
  const off = rules.length
    ? projection.find(item => {
        const digits = item.digits ?? every;
        return typeof digits === "number" && !rules.includes(digits) && held.some(row => fractional(row[item.column]));
      })
    : undefined;
  if (off) {
    const rule = rules[rules.length - 1];
    return {
      reason: `answer_from rounds ${JSON.stringify(off.name)} to ${off.digits ?? every} decimals, but this session's requests state ${rules.join(" or ")} decimal places`,
      hint: `Set answer_from again with the stated rounding, e.g. "${id}[:${rule}]" (":full" keeps the computed value); if this request asks for another precision, write the final answer yourself.`,
    };
  }
  // Numbers without the column that says which row they belong to (acea task
  // 3 t14 kept the cv column and dropped the waterbody names).
  if (rows.length > 1 && named.length) {
    const kept = new Set(projection.map(item => item.column));
    const numeric = projection.every(item =>
      held.every(
        row => row[item.column] === null || row[item.column] === undefined || typeof row[item.column] === "number"
      )
    );
    const label = numeric
      ? available.find(
          name =>
            !kept.has(name) &&
            held.every(row => typeof row[name] === "string" && row[name] !== "") &&
            new Set(held.map(row => row[name])).size === held.length
        )
      : undefined;
    if (label)
      return {
        reason: `the projection of \`${id}\` keeps only numbers, so its ${rows.length} rows would not say which is which; ${JSON.stringify(label)} names each row`,
        hint: `Keep ${JSON.stringify(label)} in answer_from, e.g. "${id}[${label}, ...]", or write the final answer yourself.`,
      };
  }
  let value: unknown;
  if (rows.length === 1) value = rows[0];
  else if (columns.length === 1) value = { [columns[0]]: rows.map(row => row[columns[0]]) };
  else value = { [id]: rows };
  const json = JSON.stringify(value);
  if (json.length > ANSWER_CHAR_LIMIT)
    return {
      reason: `the answer composed from \`${id}\` is ${json.length} characters; keep it under ${ANSWER_CHAR_LIMIT}`,
    };
  return { json, text: `**${ANSWER_MARKER} ${json}**` };
}

/** Typed source answers round only numeric JSON values. Null precision preserves
 * the computed number, and strings (including timestamps) are never rewritten. */
function structuredCell(value: unknown, decimals: number | null): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return decimals === null ? value : roundHalfEven(value, decimals);
  }
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(item => structuredCell(item, decimals));
  if (typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, structuredCell(item, decimals)]));
  return value;
}

/** Explicit JSON answer shape: no projection language or implicit object wrapper. */
export function composeStructuredAnswer(
  source: { id: string; column: string | null; shape: "scalar" | "list" | "records"; decimals: number | null },
  info: OperatorInfo | undefined
): ComposedAnswer {
  if (!info || info.error || !["Completed", "CompletedFromCache"].includes(info.state))
    return { reason: `${source.id} has no completed current result.` };
  if (info.resultVersion?.complete === false) return { reason: `${source.id} has an incomplete result version.` };
  if (!Array.isArray(info.result)) return { reason: `${source.id} is not a table result.` };
  const rows = info.result as Array<Record<string, unknown>>;
  const total = info.totalRowCount ?? info.outputTuples ?? rows.length;
  if (rows.length !== total)
    return { reason: `Only ${rows.length} of ${total} rows are held; a source answer requires the complete table.` };
  if (!rows.length) return { reason: `${source.id} is empty.` };
  if (rows.length > ANSWER_ROW_LIMIT)
    return { reason: `Source answers hold at most ${ANSWER_ROW_LIMIT} rows; reduce the table first.` };
  const columns = (info.resultSchema?.map(c => c.name) ?? Object.keys(rows[0])).filter(name => !name.startsWith("__"));
  if (source.column !== null && !columns.includes(source.column))
    return { reason: `Unknown column ${JSON.stringify(source.column)} in ${source.id}.` };
  const column = source.column ?? (columns.length === 1 ? columns[0] : undefined);
  let value: unknown;
  if (source.shape === "scalar") {
    if (rows.length !== 1 || column === undefined)
      return { reason: "A scalar answer requires one row and one selected column." };
    value = structuredCell(rows[0][column], source.decimals);
  } else if (source.shape === "list") {
    if (column === undefined) return { reason: "A list answer requires a selected column." };
    value = rows.map(row => structuredCell(row[column], source.decimals));
  } else {
    const selected = source.column === null ? columns : [source.column];
    value = rows.map(row =>
      Object.fromEntries(selected.map(name => [name, structuredCell(row[name], source.decimals)]))
    );
  }
  const json = JSON.stringify(value);
  if (json.length > ANSWER_CHAR_LIMIT)
    return { reason: `Source answers hold at most ${ANSWER_CHAR_LIMIT} characters; reduce the table first.` };
  return { json, text: json };
}
