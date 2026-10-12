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
 * The answer statement (AgentSettings.answerStatement): a call can end its
 * request with an answer composed from the tables it computed, instead of a
 * reply after seeing them.
 *
 *     answer {"leaders": top5[market, score], "match": check.matches} digits=4
 *
 * A table is its rows, as objects (`t[a, b]` keeps those columns); `t.c` is
 * the value of a one-row table, or the column's values; strings, numbers,
 * booleans and null are literal, and lists and objects nest. `digits=N`
 * rounds every non-integer number. An answer names at least one table, and
 * each must be computed, complete, and between 1 and 50 rows; otherwise it is
 * refused and the request stays open.
 */

export type AnswerValue =
  | { kind: "table"; id: string; columns?: string[] }
  | { kind: "column"; id: string; column: string }
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "list"; items: AnswerValue[] }
  | { kind: "object"; entries: Array<[string, AnswerValue]> };

export interface AnswerSpec {
  value: AnswerValue;
  digits?: number;
}

/** Rows of an answer table, as an answer reads them. */
export interface AnswerTable {
  rows: Record<string, unknown>[];
  columns: string[];
  /** All rows of the result; more than `rows.length` means the rows are cut. */
  total: number;
}

export const ANSWER_MAX_ROWS = 50;

type Token = { kind: "punct" | "string" | "number" | "name"; text: string; value?: string | number };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if ("{}[]:,.".includes(c)) {
      tokens.push({ kind: "punct", text: c });
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let value = "";
      while (j < text.length && text[j] !== c) {
        if (text[j] === "\\" && j + 1 < text.length) {
          const next = text[j + 1];
          value += next === "n" ? "\n" : next === "t" ? "\t" : next;
          j += 2;
        } else value += text[j++];
      }
      if (j >= text.length) throw new Error("a string is not closed");
      tokens.push({ kind: "string", text: text.slice(i, j + 1), value });
      i = j + 1;
      continue;
    }
    const number = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(text.slice(i));
    if (number && (c === "-" || /\d|\./.test(c)) && !(c === "." && !/\d/.test(text[i + 1] ?? ""))) {
      tokens.push({ kind: "number", text: number[0], value: Number(number[0]) });
      i += number[0].length;
      continue;
    }
    const name = /^[A-Za-z_]\w*/.exec(text.slice(i));
    if (name) {
      tokens.push({ kind: "name", text: name[0] });
      i += name[0].length;
      continue;
    }
    throw new Error(`unexpected ${JSON.stringify(c)}`);
  }
  return tokens;
}

const LITERALS: Record<string, boolean | null> = {
  true: true,
  false: false,
  True: true,
  False: false,
  null: null,
  None: null,
};

/** Parse what follows `answer`; throws with a reason the receipt can show. */
export function parseAnswer(text: string): AnswerSpec {
  let body = text.trim();
  let digits: number | undefined;
  const digitsMatch = /[\s,]\s*digits\s*=\s*(\d+)\s*$/.exec(body);
  if (digitsMatch) {
    digits = Number(digitsMatch[1]);
    body = body.slice(0, digitsMatch.index).trim();
  }
  if (!body) throw new Error('answer needs a value: answer {"key": table, ...}');
  const tokens = tokenize(body);
  let at = 0;
  const peek = () => tokens[at];
  const take = (punct?: string) => {
    const token = tokens[at];
    if (!token || (punct && !(token.kind === "punct" && token.text === punct)))
      throw new Error(punct ? `expected ${JSON.stringify(punct)}` : "the answer ends early");
    at++;
    return token;
  };
  const columnNames = (): string[] => {
    const names: string[] = [];
    // Both t[a, b] and t[["a", "b"]] keep columns a and b.
    const nested = peek()?.kind === "punct" && peek()?.text === "[";
    if (nested) take("[");
    while (!(peek()?.kind === "punct" && peek()?.text === "]")) {
      const token = take();
      if (token.kind !== "string" && token.kind !== "name") throw new Error("columns are names or strings");
      names.push(token.kind === "string" ? String(token.value) : token.text);
      if (peek()?.kind === "punct" && peek()?.text === ",") take(",");
    }
    take("]");
    if (nested) take("]");
    if (!names.length) throw new Error("t[...] names at least one column");
    return names;
  };
  const value = (): AnswerValue => {
    const token = take();
    if (token.kind === "punct" && token.text === "{") {
      const entries: Array<[string, AnswerValue]> = [];
      while (!(peek()?.kind === "punct" && peek()?.text === "}")) {
        const key = take();
        if (key.kind !== "string") throw new Error("object keys are quoted strings");
        take(":");
        entries.push([String(key.value), value()]);
        if (peek()?.kind === "punct" && peek()?.text === ",") take(",");
        else break;
      }
      take("}");
      return { kind: "object", entries };
    }
    if (token.kind === "punct" && token.text === "[") {
      const items: AnswerValue[] = [];
      while (!(peek()?.kind === "punct" && peek()?.text === "]")) {
        items.push(value());
        if (peek()?.kind === "punct" && peek()?.text === ",") take(",");
        else break;
      }
      take("]");
      return { kind: "list", items };
    }
    if (token.kind === "string") return { kind: "literal", value: String(token.value) };
    if (token.kind === "number") return { kind: "literal", value: Number(token.value) };
    if (token.kind === "name") {
      if (Object.hasOwn(LITERALS, token.text)) return { kind: "literal", value: LITERALS[token.text] };
      if (peek()?.kind === "punct" && peek()?.text === ".") {
        take(".");
        const column = take();
        if (column.kind !== "name") throw new Error(`${token.text}. needs a column name`);
        return { kind: "column", id: token.text, column: column.text };
      }
      if (peek()?.kind === "punct" && peek()?.text === "[") {
        take("[");
        return { kind: "table", id: token.text, columns: columnNames() };
      }
      return { kind: "table", id: token.text };
    }
    throw new Error(`unexpected ${JSON.stringify(token.text)}`);
  };
  const parsed = value();
  if (at < tokens.length) throw new Error(`unexpected ${JSON.stringify(tokens[at].text)} after the answer`);
  if (!answerTables(parsed).length)
    throw new Error("an answer names at least one table it was computed in; reply with text for anything else");
  return digits === undefined ? { value: parsed } : { value: parsed, digits };
}

/** The tables an answer reads, in first-mention order. */
export function answerTables(value: AnswerValue): string[] {
  const ids = new Set<string>();
  const visit = (v: AnswerValue) => {
    if (v.kind === "table" || v.kind === "column") ids.add(v.id);
    else if (v.kind === "list") v.items.forEach(visit);
    else if (v.kind === "object") v.entries.forEach(([, item]) => visit(item));
  };
  visit(value);
  return [...ids];
}

const rounded = (value: unknown, digits?: number): unknown => {
  if (digits === undefined) return value;
  if (typeof value === "number" && Number.isFinite(value) && !Number.isInteger(value))
    return Number(value.toFixed(digits));
  if (Array.isArray(value)) return value.map(item => rounded(item, digits));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rounded(item, digits)]));
  return value;
};

/**
 * The answer as JSON text, or the reason it is refused. `table` gives the
 * rows of a computed operator, or throws why it has none.
 */
export function composeAnswer(
  spec: AnswerSpec,
  table: (id: string) => AnswerTable
): { ok: true; text: string; value: unknown } | { ok: false; error: string } {
  try {
    const tables = new Map<string, AnswerTable>();
    for (const id of answerTables(spec.value)) {
      const t = table(id);
      if (t.total === 0) return { ok: false, error: `ANSWER_EMPTY: \`${id}\` has no rows.` };
      if (t.total > ANSWER_MAX_ROWS)
        return {
          ok: false,
          error: `ANSWER_TOO_LARGE: \`${id}\` has ${t.total} rows; an answer table has at most ${ANSWER_MAX_ROWS}. Limit or aggregate it to what the request asks for.`,
        };
      if (t.rows.length < t.total)
        return {
          ok: false,
          error: `ANSWER_INCOMPLETE: only ${t.rows.length} of \`${id}\`'s ${t.total} rows are held.`,
        };
      tables.set(id, t);
    }
    const known = (id: string, names: string[]) => {
      const t = tables.get(id)!;
      const unknown = names.filter(name => !t.columns.includes(name));
      if (unknown.length)
        throw new Error(
          `UNKNOWN_COLUMN: \`${id}\` has no column ${unknown.map(n => JSON.stringify(n)).join(", ")}; its columns are ${t.columns.map(n => JSON.stringify(n)).join(", ")}.`
        );
    };
    const allNull = (id: string, column: string) => tables.get(id)!.rows.every(row => row[column] == null);
    const build = (v: AnswerValue): unknown => {
      if (v.kind === "literal") return v.value;
      if (v.kind === "list") return v.items.map(build);
      if (v.kind === "object") return Object.fromEntries(v.entries.map(([key, item]) => [key, build(item)]));
      const t = tables.get(v.id)!;
      if (v.kind === "column") {
        known(v.id, [v.column]);
        if (allNull(v.id, v.column)) throw new Error(`ANSWER_ALL_NULL: \`${v.id}.${v.column}\` is null in every row.`);
        return t.rows.length === 1 ? t.rows[0][v.column] : t.rows.map(row => row[v.column]);
      }
      const columns = v.columns ?? t.columns;
      known(v.id, columns);
      const empty = columns.filter(column => allNull(v.id, column));
      if (v.columns && empty.length)
        throw new Error(
          `ANSWER_ALL_NULL: \`${v.id}\` column ${empty.map(n => JSON.stringify(n)).join(", ")} is null in every row.`
        );
      return t.rows.map(row => Object.fromEntries(columns.map(column => [column, row[column] ?? null])));
    };
    const value = rounded(build(spec.value), spec.digits);
    return { ok: true, text: JSON.stringify(value), value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
