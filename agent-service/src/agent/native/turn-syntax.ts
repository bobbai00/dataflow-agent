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
 * The turn: the two fields of one `dataflow` call (tools/turn-tool.ts).
 *
 *   python      definitions to register or replace, or ""
 *   statements  one per line:
 *                 set <id>: <op>(<inputs>, <key>=<value>, ...)
 *                 delete <id>
 *                 execute <id>, ...
 *                 show result <id>[<col>, ...] [view]
 *                 show schema <id> [from <index>]
 *                 show operator <id>
 *                 show function <name>
 *                 show builtin <name>, ...
 *
 * The parser turns the fields into an action list: one edit holding the
 * definitions and every `set`/`delete` line at its own line number (so a
 * validation error names the line of `statements`), then the requests in the
 * order written. The answer is a reply without a tool call; with
 * `answerStatement`, a call may instead end with
 *
 *                 answer {"key": table, "key2": table.column, ...} [digits=N]
 *
 * which composes the answer from computed tables (native/answer-statement.ts).
 */
import type { DataflowAction } from "../tools/dataflow-actions";
import type { RetrievalView } from "../../types/agent";
import { answerTables, parseAnswer } from "./answer-statement";

export type TurnResource = "result" | "schema" | "operator" | "function" | "builtin";

export interface TurnStatement {
  /** 1-based line of `statements` where the statement starts. */
  line: number;
  /** The statement as written (its first line). */
  text: string;
  kind: "edit" | "execute" | "show" | "answer";
  resource?: TurnResource;
  ids?: string[];
  view?: RetrievalView;
  columns?: string[];
  /** 1-based indexes into `ParsedTurn.actions`. */
  actionIndexes: number[];
}

/** What the receipt renderer needs to know about the turn that produced a result. */
export interface TurnReceiptInfo {
  statements: TurnStatement[];
  /** Lines of `statements` that were prose, not statements; ignored. */
  ignoredProse: number[];
}

export interface ParsedTurn extends TurnReceiptInfo {
  /** Python definitions: the `python` field plus any fence in `statements`. */
  definitions: string;
  /** `set`/`delete` lines at their line numbers; other lines blank. */
  changes: string;
  actions: DataflowAction[];
}

export type TurnParse = { ok: true; turn: ParsedTurn } | { ok: false; line?: number; error: string };

export interface TurnParseOptions {
  /** Retrieval views this session allows; the first sample view is the default. */
  views: readonly RetrievalView[];
  /** A call may end with `answer ...` (AgentSettings.answerStatement). */
  answerStatement?: boolean;
}

/** The arguments of a `dataflow` call. */
export interface TurnFields {
  python?: unknown;
  statements?: unknown;
}

const IDENTIFIER = /^[A-Za-z_]\w*$/;
/** A line that can only begin top-level Python, never a statement. */
const PYTHON_TOP_LEVEL = /^(?:def |class |import \w|from [\w.]+ import |@\w)/;
const KEYWORDS = "set, delete, execute, or show";
const ANSWER_IS_A_REPLY =
  "the answer is not a statement: to answer, reply with the answer text and no tool call, after show result has displayed what it rests on.";

/** The first data file a request names, for the starter call a correction
 * shows; a placeholder when the request names none. */
export function requestFilePath(request: string): string {
  return (
    /[\w.-]+(?:\/[\w.-]+)+\.(?:csv|tsv|xlsx|xls|json|jsonl|parquet|txt|gpkg|html|xml)\b/i.exec(request)?.[0] ??
    "data/<folder>/input/<file>"
  );
}

function fail(line: number, error: string): TurnParse {
  return { ok: false, line, error: `line ${line}: ${error}` };
}

/** Comma-separated identifiers: `a, b` or `a b`. */
function identifiers(text: string, line: number, what: string): string[] | TurnParse {
  const ids = text
    .split(/[\s,]+/)
    .map(part => part.trim())
    .filter(Boolean);
  if (!ids.length) return fail(line, `${what} needs at least one operator ID.`);
  const bad = ids.find(id => !IDENTIFIER.test(id));
  if (bad) return fail(line, `${JSON.stringify(bad)} is not an operator ID.`);
  return ids;
}

/** Column names inside `[...]`: bare, or quoted when they contain spaces or
 * commas. Quoted text is kept exactly, so a name with a leading or trailing
 * space survives; only whitespace outside quotes is trimmed. */
function columnList(text: string, line: number): string[] | TurnParse {
  const columns: string[] = [];
  let parts: Array<{ text: string; quoted: boolean }> = [];
  let quote: string | undefined;
  const add = (char: string, quoted: boolean) => {
    const last = parts[parts.length - 1];
    if (last && last.quoted === quoted) last.text += char;
    else parts.push({ text: char, quoted });
  };
  const push = () => {
    if (parts.length && !parts[0].quoted) parts[0].text = parts[0].text.trimStart();
    const last = parts[parts.length - 1];
    if (last && !last.quoted) last.text = last.text.trimEnd();
    const name = parts.map(part => part.text).join("");
    if (name) columns.push(name);
    parts = [];
  };
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = undefined;
      else add(char, true);
    } else if (char === '"' || char === "'") {
      quote = char;
      parts.push({ text: "", quoted: true });
    } else if (char === ",") push();
    else add(char, false);
  }
  if (quote) return fail(line, "unclosed quote in the column list.");
  push();
  if (!columns.length) return fail(line, "the column list is empty.");
  return columns;
}

interface DeclarationScan {
  depth: number;
  quote?: string;
}

/** Track a `set` statement that spans lines without treating literal
 * parentheses as syntax. Only triple quotes and escaped newlines continue strings. */
function scanDeclaration(text: string, state: DeclarationScan): void {
  let escaped = false;
  const line = text.replace(/\r?\n$/, "");
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (state.quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (line.startsWith(state.quote, i)) {
        i += state.quote.length - 1;
        state.quote = undefined;
      }
      continue;
    }
    if (char === "#") break;
    if (char === '"' || char === "'") {
      state.quote = line.startsWith(char.repeat(3), i) ? char.repeat(3) : char;
      i += state.quote.length - 1;
    } else if (char === "(" || char === "[" || char === "{") state.depth++;
    else if (char === ")" || char === "]" || char === "}") state.depth = Math.max(0, state.depth - 1);
  }
  // An unterminated single-quoted string ends with its line; the edit
  // validator still rejects the statement.
  if (state.quote?.length === 1 && !escaped) state.quote = undefined;
}

/** A field wrapped whole in a Markdown fence (a model copying a Markdown
 * example) is unwrapped. Several fenced blocks are read in place instead. */
function unwrapFence(text: string, languages: readonly string[]): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let first = 0;
  while (first < lines.length && !lines[first].trim()) first++;
  let last = lines.length - 1;
  while (last > first && !lines[last].trim()) last--;
  const open = /^\s*(`{3,})(\w*)\s*$/.exec(lines[first] ?? "");
  const close = /^\s*(`{3,})\s*$/.exec(lines[last] ?? "");
  if (!open || !close || last <= first || close[1] !== open[1]) return text;
  if (open[2] && !languages.includes(open[2].toLowerCase())) return text;
  // A bare fence of the same width inside closes the first block early.
  if (lines.slice(first + 1, last).some(line => line.trim() === open[1])) return text;
  return lines.slice(first + 1, last).join("\n");
}

/** A Python fence left open runs until the first statement line. */
function resumesAfterUnclosedFence(lines: string[], index: number, marker: string): boolean {
  const line = lines[index];
  return (
    !/^\s/.test(line) &&
    /^(set\s+[A-Za-z_]\w*\s*:|delete\s+[A-Za-z_]\w*\b|execute\b|show\s+\w+)/.test(line.trim()) &&
    !lines.slice(index + 1).some(rest => rest.trim() === marker)
  );
}

const fieldText = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));

/** Several calls of one response read as one call: each field is unwrapped as
 * it would be alone, then the definitions and the statements are joined in
 * call order. */
export function mergeTurnFields(calls: readonly TurnFields[]): { python: string; statements: string } {
  const join = (values: string[], separator: string) =>
    values
      .map(value => value.trim())
      .filter(Boolean)
      .join(separator);
  return {
    python: join(
      calls.map(call => unwrapFence(fieldText(call.python), ["python", "py"])),
      "\n\n"
    ),
    statements: join(
      calls.map(call => unwrapFence(fieldText(call.statements), ["text", "turn", "markdown", "md"])),
      "\n"
    ),
  };
}

/** Parse the fields of a `dataflow` call into its action list. */
export function parseTurn(fields: TurnFields, options: TurnParseOptions): TurnParse {
  const text = fieldText;
  const python = unwrapFence(text(fields.python), ["python", "py"]);
  const lines = unwrapFence(text(fields.statements), ["text", "turn", "markdown", "md"])
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const changes: string[] = lines.map(() => "");
  const definitions: string[] = python.trim() ? [python.trim()] : [];
  const statements: TurnStatement[] = [];
  const actions: DataflowAction[] = [];
  const ignoredProse: number[] = [];
  let fenceStart: number | undefined;
  let fenceMarker = "```";
  let fenceBody: string[] = [];
  /** The backticks of a `text`/`turn` fence whose lines are read in place. */
  let blockFence: string | undefined;
  let pendingSet: { line: number; scan: DeclarationScan } | undefined;
  let answered = false;
  const defaultView: RetrievalView = options.views.includes("sample_stats")
    ? "sample_stats"
    : options.views.includes("sample")
      ? "sample"
      : options.views[0];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const number = i + 1;
    const trimmed = line.trim();

    if (fenceStart !== undefined) {
      if (trimmed === fenceMarker) {
        definitions.push(fenceBody.join("\n"));
        fenceBody = [];
        fenceStart = undefined;
        continue;
      }
      if (resumesAfterUnclosedFence(lines, i, fenceMarker)) {
        definitions.push(fenceBody.join("\n"));
        fenceBody = [];
        fenceStart = undefined;
      } else {
        fenceBody.push(line);
        continue;
      }
    }
    if (pendingSet) {
      changes[i] = line;
      scanDeclaration(line, pendingSet.scan);
      if (pendingSet.scan.depth === 0 && !pendingSet.scan.quote) pendingSet = undefined;
      continue;
    }
    const fence = /^\s*(`{3,})(\w*)\s*$/.exec(line);
    if (fence) {
      const language = fence[2].toLowerCase();
      if (blockFence && fence[1] === blockFence && !language) {
        blockFence = undefined;
        continue;
      }
      if (["python", "py"].includes(language)) {
        fenceStart = number;
        fenceMarker = fence[1];
        continue;
      }
      const next = lines.slice(i + 1).find(candidate => candidate.trim());
      // A bare fence with nothing after it is a stray closing mark.
      if (!language && next === undefined) continue;
      // An unlabeled fence holds definitions when it reads as Python.
      if (!language && next && /^\s*(def |import |from |class |[A-Z_][A-Z0-9_]* *=)/.test(next)) {
        fenceStart = number;
        fenceMarker = fence[1];
        continue;
      }
      if (!blockFence && (!language || ["text", "turn", "markdown", "md"].includes(language))) {
        blockFence = fence[1];
        continue;
      }
      return fail(number, "only ```python fences are accepted; they hold definitions.");
    }
    if (!trimmed) continue;

    if (answered) return fail(number, "answer is the call's last statement; nothing follows it.");
    const answerMatch = options.answerStatement ? /^answer(?:\s+|(?=[{\[]))(.*)$/s.exec(trimmed) : null;
    if (answerMatch) {
      // The value may run over several lines until its brackets close.
      let text = answerMatch[1];
      const scan: DeclarationScan = { depth: 0 };
      scanDeclaration(text, scan);
      while ((scan.depth > 0 || scan.quote) && i + 1 < lines.length) {
        text += "\n" + lines[++i];
        scanDeclaration(lines[i], scan);
      }
      let spec;
      try {
        spec = parseAnswer(text);
      } catch (error) {
        return fail(number, `answer: ${error instanceof Error ? error.message : String(error)}.`);
      }
      const ids = answerTables(spec.value);
      const statement: TurnStatement = { line: number, text: trimmed, kind: "answer", ids, actionIndexes: [] };
      // The tables the answer reads are computed first, as show result does.
      actions.push({ type: "execute", operator_ids: ids });
      statement.actionIndexes.push(actions.length);
      actions.push({ type: "answer", operator_ids: ids, answer: spec });
      statement.actionIndexes.push(actions.length);
      statements.push(statement);
      answered = true;
      continue;
    }
    if (/^(?:answer:|\**\s*Final Answer:)/i.test(trimmed)) return fail(number, ANSWER_IS_A_REPLY);
    const setMatch = /^(set\s+([A-Za-z_]\w*)\s*:|delete\s+([A-Za-z_]\w*))(.*)$/s.exec(trimmed);
    if (setMatch) {
      changes[i] = line;
      statements.push({
        line: number,
        text: trimmed,
        kind: "edit",
        ids: [setMatch[2] ?? setMatch[3]],
        actionIndexes: [],
      });
      if (setMatch[1].startsWith("set")) {
        const scan: DeclarationScan = { depth: 0 };
        scanDeclaration(setMatch[4], scan);
        if (scan.depth > 0 || scan.quote) pendingSet = { line: number, scan };
      }
      continue;
    }
    const executeMatch = /^execute\b(.*)$/.exec(trimmed);
    if (executeMatch) {
      const rest = executeMatch[1].trim();
      const statement: TurnStatement = { line: number, text: trimmed, kind: "execute", actionIndexes: [] };
      if (rest) {
        const ids = identifiers(rest, number, "execute");
        if (!Array.isArray(ids)) return ids;
        statement.ids = ids;
        actions.push({ type: "execute", operator_ids: ids });
      } else actions.push({ type: "execute" });
      statement.actionIndexes.push(actions.length);
      statements.push(statement);
      continue;
    }
    const showMatch = /^show\s+(\w+)\b(.*)$/.exec(trimmed);
    if (showMatch) {
      const resource = showMatch[1] as TurnResource;
      const rest = showMatch[2].trim();
      const statement: TurnStatement = { line: number, text: trimmed, kind: "show", resource, actionIndexes: [] };
      if (resource === "result") {
        let spec = rest;
        let view: RetrievalView = defaultView;
        const viewMatch = /\s+(full|sample_stats|sample)\s*$/.exec(spec);
        if (viewMatch) {
          view = viewMatch[1] as RetrievalView;
          spec = spec.slice(0, viewMatch.index).trim();
        }
        let columns: string[] | undefined;
        const columnMatch = /^([A-Za-z_]\w*)\s*\[(.*)\]$/s.exec(spec);
        if (columnMatch) {
          const parsed = columnList(columnMatch[2], number);
          if (!Array.isArray(parsed)) return parsed;
          columns = parsed;
          spec = columnMatch[1];
        }
        const ids = identifiers(spec, number, "show result");
        if (!Array.isArray(ids)) return ids;
        if (!options.views.includes(view))
          return fail(number, `the view ${JSON.stringify(view)} is unavailable; use ${options.views.join(" or ")}.`);
        statement.ids = ids;
        statement.view = view;
        statement.columns = columns;
        // Showing a result computes what is stale first.
        actions.push({ type: "execute", operator_ids: ids });
        statement.actionIndexes.push(actions.length);
        actions.push(
          columns
            ? { type: "retrieve", operator_ids: ids, view, columns }
            : { type: "retrieve", operator_ids: ids, view }
        );
        statement.actionIndexes.push(actions.length);
      } else if (resource === "schema" || resource === "operator") {
        const fromMatch = /^([A-Za-z_]\w*)(?:\s+from\s+(\d+))?$/.exec(rest);
        if (!fromMatch)
          return fail(
            number,
            /[\/.(:]/.test(rest)
              ? `show ${resource} takes the ID of an operator, not a path or a call: first \`set book: scan(files='<path>')\`, then \`show ${resource} book\`.`
              : `show ${resource} takes one operator ID${resource === "operator" ? "" : ", optionally \`from <index>\`"}.`
          );
        const id = fromMatch[1];
        statement.ids = [id];
        if (resource === "schema") {
          // The schema describes a computed result: compute it first.
          actions.push({ type: "execute", operator_ids: [id] });
          statement.actionIndexes.push(actions.length);
          actions.push(
            fromMatch[2] !== undefined
              ? { type: "inspect", target: "schema", operator_id: id, offset: Number(fromMatch[2]), limit: 200 }
              : { type: "inspect", target: "schema", operator_id: id }
          );
        } else actions.push({ type: "inspect", target: "operator", operator_id: id, include_implementation: true });
        statement.actionIndexes.push(actions.length);
      } else if (resource === "function") {
        const ids = identifiers(rest, number, "show function");
        if (!Array.isArray(ids)) return ids;
        statement.ids = ids;
        actions.push({ type: "inspect", target: "namespace", names: ids, include_implementation: true });
        statement.actionIndexes.push(actions.length);
      } else if (resource === "builtin") {
        const ids = identifiers(rest, number, "show builtin");
        if (!Array.isArray(ids)) return ids;
        statement.ids = ids;
        actions.push({ type: "inspect", target: "reference", topic: "operators", operator_names: ids });
        statement.actionIndexes.push(actions.length);
      } else return fail(number, "show takes a resource: result, schema, operator, function, or builtin.");
      statements.push(statement);
      continue;
    }
    // Python written in `statements` without a fence: a top-level
    // def/class/import block runs through its indented and blank lines until
    // the next statement or fence.
    if (PYTHON_TOP_LEVEL.test(line)) {
      const block = [line];
      while (
        i + 1 < lines.length &&
        (!lines[i + 1].trim() || /^\s/.test(lines[i + 1]) || PYTHON_TOP_LEVEL.test(lines[i + 1]))
      )
        block.push(lines[++i]);
      definitions.push(block.join("\n").trimEnd());
      continue;
    }
    // Anything else is prose: noted in the receipt and ignored.
    ignoredProse.push(number);
  }
  if (fenceStart !== undefined) return fail(fenceStart, "the ```python fence is not closed.");
  if (pendingSet) return fail(pendingSet.line, "the statement's parentheses are not closed.");

  const changesText = changes.join("\n").replace(/\n+$/, "");
  const definitionsText = definitions.join("\n\n").trim();
  if (!statements.length && !definitionsText)
    return {
      ok: false,
      error: `no statements: a call has at least one ${KEYWORDS} line in statements, or definitions in python.`,
    };
  // The edit goes first: definitions register before any request runs.
  if (changesText.trim() || definitionsText) {
    actions.unshift({ type: "edit", python: definitionsText, changes: changesText.trim() ? changesText : "" });
    for (const statement of statements)
      statement.actionIndexes = statement.kind === "edit" ? [1] : statement.actionIndexes.map(index => index + 1);
  }
  return {
    ok: true,
    turn: { definitions: definitionsText, changes: changesText, statements, ignoredProse, actions },
  };
}
