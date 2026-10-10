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
 * The text turn: what a model writes when the registered protocol runs
 * without tool calls. One message is one turn:
 *
 *   summary: <one line>
 *   ```python
 *   <definitions>
 *   ```
 *   set <id>: <op>(<inputs>, <key>=<value>, ...)
 *   delete <id>
 *   execute <id>, ...
 *   show result <id>[<col>, ...] [full]
 *   show schema <id>
 *   show sheets <id>
 *   show operator <id>
 *   show function <name>
 *   show builtin <name>, ...
 *   answer: <text to the end of the turn>
 *
 * The parser turns a message into the same action list the JSON tool takes,
 * so execution, receipts and traces are shared with the tool transport. It
 * keeps every `set`/`delete` line at its own line number, so a validation
 * error reported against the changes names the line of the turn.
 */
import type { DataflowAction } from "../tools/dataflow-actions";
import type { RetrievalView } from "../../types/agent";

export type TurnResource = "result" | "schema" | "sheets" | "operator" | "function" | "builtin";

export interface TurnStatement {
  /** 1-based line of the turn where the statement starts. */
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

export interface ParsedTurn {
  summary: string;
  /** The turn had no `summary:` line; leading prose, if any, stood in for it. */
  missingSummary: boolean;
  /** Lines of prose after the statements, ignored. */
  ignoredProse: number[];
  /** Python definitions from every fence, in order. */
  definitions: string;
  /** `set`/`delete` lines at their turn line numbers; other lines blank. */
  changes: string;
  statements: TurnStatement[];
  actions: DataflowAction[];
}

export type TurnParse = { ok: true; turn: ParsedTurn } | { ok: false; line?: number; error: string };

export interface TurnParseOptions {
  /** Retrieval views this session allows; the first sample view is the default. */
  views: readonly RetrievalView[];
}

const IDENTIFIER = /^[A-Za-z_]\w*$/;
const KEYWORDS = "summary, set, delete, execute, show, or answer";

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

/** Column names inside `[...]`: bare, or quoted when they contain spaces or commas. */
function columnList(text: string, line: number): string[] | TurnParse {
  const columns: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ",") {
      if (current.trim()) columns.push(current.trim());
      current = "";
    } else current += char;
  }
  if (quote) return fail(line, "unclosed quote in the column list.");
  if (current.trim()) columns.push(current.trim());
  if (!columns.length) return fail(line, "the column list is empty.");
  return columns;
}

/** Parentheses still open at the end of a statement line, ignoring quoted text. */
function openParentheses(text: string, depth: number): number {
  let quote: string | undefined;
  let escaped = false;
  for (const char of text) {
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "#") break;
    if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
  }
  return depth;
}

/** A turn wrapped whole in a fence (a model copying the example's framing) is unwrapped. */
function unwrapOuterFence(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let first = 0;
  while (first < lines.length && !lines[first].trim()) first++;
  let last = lines.length - 1;
  while (last > first && !lines[last].trim()) last--;
  const open = /^\s*(`{3,})(turn|text)?\s*$/.exec(lines[first] ?? "");
  const close = /^\s*(`{3,})\s*$/.exec(lines[last] ?? "");
  if (open && close && last > first && close[1] === open[1]) return lines.slice(first + 1, last).join("\n");
  return text;
}

export function parseTurn(text: string, options: TurnParseOptions): TurnParse {
  const lines = unwrapOuterFence(text).replace(/\r\n?/g, "\n").split("\n");
  const changes: string[] = lines.map(() => "");
  const definitions: string[] = [];
  const statements: TurnStatement[] = [];
  const actions: DataflowAction[] = [];
  let summary: string | undefined;
  let leadingProse: string[] = [];
  const ignoredProse: number[] = [];
  let answer: string | undefined;
  let answerLine = 0;
  let fenceStart: number | undefined;
  let fenceBody: string[] = [];
  /** The backticks of a `text`/`turn` fence whose lines are read as the turn. */
  let turnFence: string | undefined;
  let pendingSet: { line: number; depth: number } | undefined;
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
      if (/^\s*```\s*$/.test(line)) {
        definitions.push(fenceBody.join("\n"));
        fenceBody = [];
        fenceStart = undefined;
        continue;
      }
      // A fence left open runs until the first statement line: the model
      // forgot the closing mark, not the statements.
      if (!/^\s/.test(line) && /^(set\s+[A-Za-z_]\w*\s*:|delete\s+[A-Za-z_]\w*\b|execute\b|show\s+\w+|answer:)/.test(line.trim()) && !lines.slice(i + 1).some(rest => /^\s*```\s*$/.test(rest))) {
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
      pendingSet.depth = openParentheses(line, pendingSet.depth);
      if (pendingSet.depth === 0) pendingSet = undefined;
      continue;
    }
    const fence = /^\s*(`{3,})(\w*)\s*$/.exec(line);
    if (fence) {
      const language = fence[2].toLowerCase();
      if (turnFence && fence[1] === turnFence && !language) {
        turnFence = undefined;
        continue;
      }
      if (["python", "py"].includes(language)) {
        fenceStart = number;
        continue;
      }
      const next = lines.slice(i + 1).find(candidate => candidate.trim());
      // A bare fence with nothing after it is a stray closing mark.
      if (!language && next === undefined) continue;
      // An unlabeled fence holds definitions when it reads as Python; a
      // `text`/`turn` fence (a model framing its turn as in the example) holds
      // statements, which are read in place.
      if (!language && next && /^\s*(def |import |from |class |[A-Z_][A-Z0-9_]* *=)/.test(next)) {
        fenceStart = number;
        continue;
      }
      if (!turnFence && (!language || ["text", "turn", "markdown", "md"].includes(language))) {
        turnFence = fence[1];
        continue;
      }
      return fail(number, "only ```python fences are accepted; they hold definitions.");
    }
    if (!trimmed) continue;

    const summaryMatch = /^summary:\s*(.*)$/i.exec(trimmed);
    if (summaryMatch) {
      if (summary !== undefined) return fail(number, "one summary line per turn.");
      if (statements.length) return fail(number, "the summary line comes before the statements.");
      summary = summaryMatch[1].trim();
      continue;
    }
    const answerMatch = /^answer:\s*(.*)$/is.exec(trimmed);
    if (answerMatch) {
      answer = [answerMatch[1], ...lines.slice(i + 1)].join("\n").trim();
      answerLine = number;
      break;
    }
    const setMatch = /^(set\s+([A-Za-z_]\w*)\s*:|delete\s+([A-Za-z_]\w*))(.*)$/s.exec(trimmed);
    if (setMatch) {
      changes[i] = line;
      statements.push({ line: number, text: trimmed, kind: "edit", ids: [setMatch[2] ?? setMatch[3]], actionIndexes: [] });
      if (setMatch[1].startsWith("set")) {
        const depth = openParentheses(setMatch[4], 0);
        if (depth > 0) pendingSet = { line: number, depth };
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
        actions.push({ type: "execute", operator_ids: ids });
        statement.actionIndexes.push(actions.length);
        actions.push(columns ? { type: "retrieve", operator_ids: ids, view, columns } : { type: "retrieve", operator_ids: ids, view });
        statement.actionIndexes.push(actions.length);
      } else if (resource === "schema" || resource === "sheets" || resource === "operator") {
        const fromMatch = /^([A-Za-z_]\w*)(?:\s+from\s+(\d+))?$/.exec(rest);
        if (!fromMatch) return fail(number, `show ${resource} takes one operator ID${resource === "operator" ? "" : ", optionally `from <index>`"}.`);
        const id = fromMatch[1];
        statement.ids = [id];
        const target = resource === "sheets" ? "source" : resource;
        actions.push(
          resource === "operator"
            ? ({ type: "inspect", target: "operator", operator_id: id, include_implementation: true } as DataflowAction)
            : fromMatch[2] !== undefined
              ? ({ type: "inspect", target, operator_id: id, offset: Number(fromMatch[2]), limit: 200 } as DataflowAction)
              : ({ type: "inspect", target, operator_id: id } as DataflowAction)
        );
        statement.actionIndexes.push(actions.length);
      } else if (resource === "function") {
        const ids = identifiers(rest, number, "show function");
        if (!Array.isArray(ids)) return ids;
        statement.ids = ids;
        actions.push({ type: "inspect", target: "namespace", names: ids, include_implementation: true } as DataflowAction);
        statement.actionIndexes.push(actions.length);
      } else if (resource === "builtin") {
        const ids = identifiers(rest, number, "show builtin");
        if (!Array.isArray(ids)) return ids;
        statement.ids = ids;
        actions.push({ type: "inspect", target: "reference", topic: "operators", operator_names: ids } as DataflowAction);
        statement.actionIndexes.push(actions.length);
      } else return fail(number, `show takes a resource: result, schema, sheets, operator, function, or builtin.`);
      statements.push(statement);
      continue;
    }
    // Prose before the first statement stands in for a missing summary line;
    // prose after the statements is noted and ignored.
    if (summary === undefined && !statements.length && !definitions.length) {
      leadingProse.push(trimmed);
      continue;
    }
    if (statements.length) {
      ignoredProse.push(number);
      continue;
    }
    return fail(number, `${JSON.stringify(trimmed.slice(0, 60))} is not a statement; a line starts with ${KEYWORDS}.`);
  }
  if (fenceStart !== undefined) return fail(fenceStart, "the ```python fence is not closed.");
  if (turnFence !== undefined) return fail(1, "the fence around the turn is not closed.");
  if (pendingSet) return fail(pendingSet.line, "the statement's parentheses are not closed.");

  const missingSummary = summary === undefined;
  if (missingSummary) summary = leadingProse.join(" ");
  const changesText = changes.join("\n").replace(/\n+$/, "");
  const definitionsText = definitions.join("\n\n").trim();
  if (answer !== undefined) {
    if (statements.length || definitionsText)
      return fail(answerLine, "answer must be the only statement of its turn; show the result first, then answer in the next turn.");
    if (!answer) return fail(answerLine, "answer: needs the answer text.");
    actions.push({ type: "answer", content: answer });
    statements.push({ line: answerLine, text: "answer:", kind: "answer", actionIndexes: [actions.length] });
  } else if (!statements.length && !definitionsText) {
    return { ok: false, error: "no statements: a turn has at least one set, delete, execute, show, or answer line." };
  }
  // The edit goes first: definitions register before any request runs.
  if (changesText.trim() || definitionsText) {
    actions.unshift({ type: "edit", python: definitionsText, changes: changesText.trim() ? changesText : "" });
    for (const statement of statements) statement.actionIndexes = statement.actionIndexes.map(index => index + 1);
    for (const statement of statements) if (statement.kind === "edit") statement.actionIndexes = [1];
  }
  return {
    ok: true,
    turn: { summary: summary ?? "", missingSummary, ignoredProse, definitions: definitionsText, changes: changesText, statements, actions },
  };
}
