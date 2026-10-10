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

export type TurnResource = "result" | "schema" | "operator" | "function" | "builtin";

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

/** What the receipt renderer needs to know about the turn that produced a result. */
export interface TurnReceiptInfo {
  statements: TurnStatement[];
  /** The turn had no summary; leading prose, if any, stood in for it. */
  missingSummary: boolean;
  /** Lines of prose after the statements, ignored. */
  ignoredProse: number[];
  /** The turn went on to write a receipt of its own; the text was cut there. */
  wroteReceipt: boolean;
  /** The turn arrived as tool fields (`summary`, `python`, `statements`), not as a message. */
  fields?: boolean;
}

export interface ParsedTurn extends TurnReceiptInfo {
  summary: string;
  /** Text transport: the answer came from a bare `Final Answer:` line, not an
   *  `answer:` statement. The driver accepts it only after a result was shown. */
  bareAnswer: boolean;
  /** Python definitions from every fence, in order. */
  definitions: string;
  /** `set`/`delete` lines at their turn line numbers; other lines blank. */
  changes: string;
  actions: DataflowAction[];
}

export type TurnParse = { ok: true; turn: ParsedTurn } | { ok: false; line?: number; error: string };

export interface TurnParseOptions {
  /** Retrieval views this session allows; the first sample view is the default. */
  views: readonly RetrievalView[];
}

/** The turn as the tool transport carries it: three strings instead of one message. */
export interface TurnFields {
  summary?: unknown;
  python?: unknown;
  statements?: unknown;
}

interface StatementParseOptions extends TurnParseOptions {
  /** Tool-field mode: the summary and definitions arrive separately, and
   *  the answer is a reply without a tool call, never a statement. */
  fields?: boolean;
  summary?: string;
  definitions?: string;
}

const IDENTIFIER = /^[A-Za-z_]\w*$/;
/** Text transport: generation stops at a receipt heading, because the receipt
 * is the engine's message (Opus kept writing one and reasoned from invented
 * rows). Four entries, the most an OpenAI-compatible `stop` accepts. A receipt
 * that slips past a provider without stop support is still cut by
 * `sanitizeTurnReplay`. */
export const RECEIPT_STOP_SEQUENCES = ["## edits ", "## turn rejected", "## execute ", "## show "] as const;

/** The first data file a request names, for the starter turn a correction
 * shows; a placeholder when the request names none. */
export function requestFilePath(request: string): string {
  return (
    /[\w.-]+(?:\/[\w.-]+)+\.(?:csv|tsv|xlsx|xls|json|jsonl|parquet|txt|gpkg|html|xml)\b/i.exec(request)?.[0] ??
    "data/<folder>/input/<file>"
  );
}

/** The labels the prompt examples put above a receipt; a model copying the
 * example's layout writes one, then a receipt of its own. */
const RECEIPT_LABEL =
  /^(?:\*\*)?(?:engine receipt|tool result(?: \(the receipt\))?|suppose the receipt is)(?:\*\*)?\s*:?(?:\*\*)?\s*$/i;
/** Receipt headers only mark engine text outside definitions and answer bodies. */
const RECEIPT_HEADER =
  /^(?:user\s*:?\s*)?## (?:edits applied|edits rejected|turn rejected|execute(?:\s|$)|show(?:\s|$))/;
const KEYWORDS = "summary, set, delete, execute, show, or answer";
/** A line that can only begin top-level Python, never a statement. */
const PYTHON_TOP_LEVEL = /^(?:def |class |import \w|from [\w.]+ import |@\w)/;
const FIELD_KEYWORDS = "set, delete, execute, or show";
const ANSWER_IN_FIELDS =
  "the answer is not a statement: to answer, reply with the answer text and no tool call, after show result has displayed what it rests on.";

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

interface DeclarationScan {
  depth: number;
  quote?: string;
}

/** Track multiline declarations without treating literal parentheses or receipt
 * headings as syntax. Only triple quotes and escaped newlines continue strings. */
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
  // An invalid single-line string must not shield a fabricated receipt on
  // the next line. The declaration validator still rejects the original text.
  if (state.quote?.length === 1 && !escaped) state.quote = undefined;
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
  // A bare fence of the same width inside closes the first block early: the
  // message is several blocks (summary, python, statements), read in place.
  const separate = !!open && lines.slice(first + 1, last).some(line => line.trim() === open[1]);
  if (open && close && last > first && close[1] === open[1] && !separate)
    return lines.slice(first + 1, last).join("\n");
  return text;
}

/** The same recovery boundary is used by parsing and replay sanitization. */
function resumesAfterUnclosedFence(lines: string[], index: number, marker: string): boolean {
  const line = lines[index];
  return (
    !/^\s/.test(line) &&
    /^(set\s+[A-Za-z_]\w*\s*:|delete\s+[A-Za-z_]\w*\b|execute\b|show\s+\w+|answer:)/.test(line.trim()) &&
    !lines.slice(index + 1).some(rest => rest.trim() === marker)
  );
}

/** Remove a fabricated engine reply before parsing or replay. This scan is
 * deliberately independent of validation: even a malformed command must not
 * carry a fabricated result into the next model request. */
export function sanitizeTurnReplay(text: string): { replayText: string; wroteReceipt: boolean } {
  const lines = text.split(/(?<=\n)/);
  let pythonFence: string | undefined;
  const declaration: DeclarationScan = { depth: 0 };
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (pythonFence) {
      if (trimmed === pythonFence) {
        pythonFence = undefined;
        offset += line.length;
        continue;
      }
      if (resumesAfterUnclosedFence(lines, i, pythonFence)) pythonFence = undefined;
      else {
        offset += line.length;
        continue;
      }
    }
    if (!declaration.quote && (RECEIPT_HEADER.test(trimmed) || RECEIPT_LABEL.test(trimmed)))
      return { replayText: text.slice(0, offset), wroteReceipt: true };
    if (declaration.depth > 0 || declaration.quote) {
      scanDeclaration(line, declaration);
    } else {
      // Everything after the explicit answer command is user-facing content.
      if (/^answer:/i.test(trimmed)) break;
      const fence = /^(`{3,})(\w*)$/.exec(trimmed);
      if (fence) {
        const language = fence[2].toLowerCase();
        const next = lines.slice(i + 1).find(candidate => candidate.trim());
        if (
          ["python", "py"].includes(language) ||
          (!language && next && /^\s*(def |import |from |class |[A-Z_][A-Z0-9_]* *=)/.test(next))
        ) {
          pythonFence = fence[1];
        }
      } else if (/^set\s+[A-Za-z_]\w*\s*:/.test(trimmed)) {
        scanDeclaration(line, declaration);
      }
    }
    offset += line.length;
  }
  return { replayText: text, wroteReceipt: false };
}

export function parseTurn(
  text: string,
  options: TurnParseOptions
): TurnParse & { replayText: string; wroteReceipt: boolean } {
  const replay = sanitizeTurnReplay(text);
  return { ...parseStatements(replay.replayText, options, replay.wroteReceipt), ...replay };
}

/** A `python` field wrapped in a fence (a model copying a Markdown example) is unwrapped. */
function unwrapPythonFence(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let first = 0;
  while (first < lines.length && !lines[first].trim()) first++;
  let last = lines.length - 1;
  while (last > first && !lines[last].trim()) last--;
  const open = /^\s*(`{3,})(python|py)?\s*$/.exec(lines[first] ?? "");
  const close = /^\s*(`{3,})\s*$/.exec(lines[last] ?? "");
  if (open && close && last > first && close[1] === open[1]) return lines.slice(first + 1, last).join("\n");
  return text;
}

/** The tool transport's turn: `summary` (one line), `python` (definitions or
 * empty) and `statements` (one per line). Line numbers in errors refer to
 * `statements`. The answer is never a statement here: a reply without a
 * tool call is the answer. */
export function parseTurnFields(fields: TurnFields, options: TurnParseOptions): TurnParse {
  const text = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));
  const statements = text(fields.statements);
  const python = unwrapPythonFence(text(fields.python));
  if (!statements.trim() && !python.trim())
    return {
      ok: false,
      error: `no statements: a call has at least one ${FIELD_KEYWORDS} line in statements, or definitions in python.`,
    };
  return parseStatements(
    statements,
    { ...options, fields: true, summary: text(fields.summary), definitions: python },
    false
  );
}

function parseStatements(text: string, options: StatementParseOptions, wroteReceipt: boolean): TurnParse {
  const lines = unwrapOuterFence(text).replace(/\r\n?/g, "\n").split("\n");
  const changes: string[] = lines.map(() => "");
  const definitions: string[] = options.definitions?.trim() ? [options.definitions.trim()] : [];
  const statements: TurnStatement[] = [];
  const actions: DataflowAction[] = [];
  let summary: string | undefined = options.summary?.trim() || undefined;
  let leadingProse: string[] = [];
  const ignoredProse: number[] = [];
  let answer: string | undefined;
  let answerLine = 0;
  let bareAnswer = false;
  let fenceStart: number | undefined;
  let fenceMarker = "```";
  let fenceBody: string[] = [];
  /** The backticks of a `text`/`turn` fence whose lines are read as the turn. */
  let turnFence: string | undefined;
  let pendingSet: { line: number; scan: DeclarationScan } | undefined;
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
      // A fence left open runs until the first statement line: the model
      // forgot the closing mark, not the statements.
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
      if (turnFence && fence[1] === turnFence && !language) {
        turnFence = undefined;
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
      // An unlabeled fence holds definitions when it reads as Python; a
      // `text`/`turn` fence (a model framing its turn as in the example) holds
      // statements, which are read in place.
      if (!language && next && /^\s*(def |import |from |class |[A-Z_][A-Z0-9_]* *=)/.test(next)) {
        fenceStart = number;
        fenceMarker = fence[1];
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
      // A restated summary (a model redoing its turn) replaces the first.
      if (statements.length) return fail(number, "the summary line comes before the statements.");
      summary = summaryMatch[1].trim();
      continue;
    }
    const explicit = /^answer:\s*(.*)$/is.exec(trimmed);
    // Text transport: a bare `Final Answer:` line in a turn without statements
    // is the line the request asked for, so it is the answer; the driver
    // rejects it as a guess until a result has been shown.
    const answerMatch =
      explicit ?? (!options.fields && !statements.length ? /^(\**\s*Final Answer:.*)$/is.exec(trimmed) : null);
    if (answerMatch) {
      if (options.fields) return fail(number, ANSWER_IN_FIELDS);
      bareAnswer = !explicit;
      let rest = lines.slice(i + 1);
      if (turnFence) {
        let close = rest.length - 1;
        while (close >= 0 && !rest[close].trim()) close--;
        // Only the final framing fence ends a wrapped answer. An earlier
        // matching fence may close a code example in the answer itself.
        if (close >= 0 && rest[close].trim() === turnFence) {
          rest = rest.slice(0, close);
          turnFence = undefined;
        }
      }
      answer = [answerMatch[1], ...rest].join("\n").trim();
      answerLine = number;
      break;
    }
    // After statements, a `Final Answer:` line is a guess written before the
    // receipt: in a text turn it is prose and ignored below.
    if (options.fields && /^\**\s*Final Answer:/i.test(trimmed)) return fail(number, ANSWER_IN_FIELDS);
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
        const target = resource;
        if (resource !== "operator") {
          // The schema describes a computed result: compute it first.
          actions.push({ type: "execute", operator_ids: [id] });
          statement.actionIndexes.push(actions.length);
        }
        actions.push(
          resource === "operator"
            ? ({ type: "inspect", target: "operator", operator_id: id, include_implementation: true } as DataflowAction)
            : fromMatch[2] !== undefined
              ? ({
                  type: "inspect",
                  target,
                  operator_id: id,
                  offset: Number(fromMatch[2]),
                  limit: 200,
                } as DataflowAction)
              : ({ type: "inspect", target, operator_id: id } as DataflowAction)
        );
        statement.actionIndexes.push(actions.length);
      } else if (resource === "function") {
        const ids = identifiers(rest, number, "show function");
        if (!Array.isArray(ids)) return ids;
        statement.ids = ids;
        actions.push({
          type: "inspect",
          target: "namespace",
          names: ids,
          include_implementation: true,
        } as DataflowAction);
        statement.actionIndexes.push(actions.length);
      } else if (resource === "builtin") {
        const ids = identifiers(rest, number, "show builtin");
        if (!Array.isArray(ids)) return ids;
        statement.ids = ids;
        actions.push({
          type: "inspect",
          target: "reference",
          topic: "operators",
          operator_names: ids,
        } as DataflowAction);
        statement.actionIndexes.push(actions.length);
      } else return fail(number, `show takes a resource: result, schema, operator, function, or builtin.`);
      statements.push(statement);
      continue;
    }
    // Python written in the turn without a fence (a model dropping the inner
    // fence of the example): a top-level def/class/import block runs through
    // its indented and blank lines until the next statement or fence.
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
    return fail(
      number,
      `${JSON.stringify(trimmed.slice(0, 60))} is not a statement; a line starts with ${options.fields ? FIELD_KEYWORDS : KEYWORDS}.`
    );
  }
  if (fenceStart !== undefined) return fail(fenceStart, "the ```python fence is not closed.");
  if (pendingSet) return fail(pendingSet.line, "the statement's parentheses are not closed.");

  // The answer turn is the stop: it needs no summary.
  const missingSummary = summary === undefined && answer === undefined;
  if (missingSummary) summary = leadingProse.join(" ");
  const changesText = changes.join("\n").replace(/\n+$/, "");
  const definitionsText = definitions.join("\n\n").trim();
  if (answer !== undefined) {
    if (statements.length || definitionsText)
      return fail(
        answerLine,
        "answer must be the only statement of its turn; show the result first, then answer in the next turn."
      );
    if (!answer) return fail(answerLine, "answer: needs the answer text.");
    actions.push({ type: "answer", content: answer });
    statements.push({ line: answerLine, text: "answer:", kind: "answer", actionIndexes: [actions.length] });
  } else if (!statements.length && !definitionsText) {
    return {
      ok: false,
      error: options.fields
        ? `no statements: a call has at least one ${FIELD_KEYWORDS} line in statements, or definitions in python.`
        : "no statements: a turn has at least one set, delete, execute, show, or answer line.",
    };
  }
  // The edit goes first: definitions register before any request runs.
  if (changesText.trim() || definitionsText) {
    actions.unshift({ type: "edit", python: definitionsText, changes: changesText.trim() ? changesText : "" });
    for (const statement of statements) statement.actionIndexes = statement.actionIndexes.map(index => index + 1);
    for (const statement of statements) if (statement.kind === "edit") statement.actionIndexes = [1];
  }
  return {
    ok: true,
    turn: {
      summary: summary ?? "",
      bareAnswer,
      missingSummary,
      ignoredProse,
      wroteReceipt,
      ...(options.fields ? { fields: true } : {}),
      definitions: definitionsText,
      changes: changesText,
      statements,
      actions,
    },
  };
}
