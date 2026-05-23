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
 * Pure parser for the local-react LLM's text-mode output. Maps the model's
 * raw completion into a thought string plus the list of tool calls it
 * emitted. The driver uses the actions list as both the work to execute
 * and the termination signal — `actions.length === 0` ends the loop.
 *
 * Format (verified against the kramabench training set):
 *
 *   Thought: <free text>
 *
 *   Action: <toolName>
 *   Action Input: { ... }
 *
 *   Action: <toolName>           # multiple Action/Action Input pairs per
 *   Action Input: { ... }        # turn map to parallel tool calls
 *
 *   Observation:                 # everything from this line onward is
 *   <ignored>                    # echo / noise — discarded before parsing
 *
 * Payloads are Python-dict-style literals (single-quoted keys + mixed
 * single/double quoted values, `True`/`False`/`None`), not strict JSON.
 * The repair pass converts them to JSON before `JSON.parse`.
 */

export interface ParsedAction {
  /** Tool name as emitted by the model. */
  name: string;
  /** Parsed call arguments. When the Action Input payload cannot be parsed,
   *  this is `{ __parseError: <error message>, __rawInput: <raw string> }`
   *  so the downstream tool fails with a clear error that travels back to
   *  the model on the next turn — never `undefined`, never silently
   *  dropped, so the loop can't hang on a malformed emission. */
  input: any;
}

export interface ParsedReActOutput {
  /** Free-text content before the first Action / Final Answer marker.
   *  Leading "Thought:" label is stripped. May be the empty string. */
  thought: string;
  /** Tool calls in emit order. Empty ⇒ terminal: the driver ends the loop. */
  actions: ParsedAction[];
}

/** Find the byte offset where the parseable region ends — i.e. the start
 *  of the first `Observation:` line. Returns `text.length` when there is
 *  no Observation marker. */
function findObservationCutoff(text: string): number {
  const m = /^[ \t]*Observation\s*:/m.exec(text);
  return m ? m.index : text.length;
}

/** Find the byte offset of the first `Thought:` label (case-insensitive,
 *  line-anchored). Returns -1 when no such label exists.
 *
 *  Used to strip model-emitted scratchpad prefixes — `<Analyze>…</Analyze>`
 *  blocks, hidden reasoning, etc. — that appear before the real ReAct
 *  transcript begins. The local LLM was trained to lead with `Thought:`,
 *  so anything before it is preamble the agent should not record. */
function findThoughtAnchor(text: string): number {
  const m = /(?:^|\n)[ \t]*Thought\s*:/i.exec(text);
  if (!m) return -1;
  // The (?:^|\n) prefix may capture the leading newline; advance past it
  // so the returned offset points at the `T` of `Thought`.
  return text[m.index] === "\n" ? m.index + 1 : m.index;
}

/**
 * Tolerant Python-literal → JSON converter, scoped to what the local LLM
 * actually emits:
 *  - single-quoted strings become double-quoted, with `\'` unescaped to `'`
 *    and unescaped `"` escaped to `\"`;
 *  - bare `True` / `False` / `None` tokens become `true` / `false` / `null`;
 *  - everything inside double-quoted strings is preserved verbatim.
 *
 * Not a full Python parser — it only handles the shapes seen in training
 * data. When the result is not valid JSON the caller falls back to the
 * raw-input marker so the loop survives.
 */
function pythonLiteralToJson(src: string): string {
  let out = "";
  let i = 0;
  // 0 = normal, 1 = inside single-quoted string, 2 = inside double-quoted string
  let state: 0 | 1 | 2 = 0;
  while (i < src.length) {
    const ch = src[i];
    if (state === 0) {
      if (ch === "'") {
        out += '"';
        state = 1;
        i++;
        continue;
      }
      if (ch === '"') {
        out += '"';
        state = 2;
        i++;
        continue;
      }
      // Bare True/False/None at a word boundary.
      const tail = src.slice(i);
      let m: RegExpMatchArray | null;
      if ((m = /^True(?![A-Za-z0-9_])/.exec(tail))) {
        out += "true";
        i += 4;
        continue;
      }
      if ((m = /^False(?![A-Za-z0-9_])/.exec(tail))) {
        out += "false";
        i += 5;
        continue;
      }
      if ((m = /^None(?![A-Za-z0-9_])/.exec(tail))) {
        out += "null";
        i += 4;
        continue;
      }
      out += ch;
      i++;
      continue;
    }
    if (state === 1) {
      if (ch === "\\" && i + 1 < src.length) {
        const next = src[i + 1];
        if (next === "'") {
          out += "'";
          i += 2;
          continue;
        }
        if (next === '"') {
          out += '\\"';
          i += 2;
          continue;
        }
        out += ch + next;
        i += 2;
        continue;
      }
      if (ch === "'") {
        out += '"';
        state = 0;
        i++;
        continue;
      }
      if (ch === '"') {
        out += '\\"';
        i++;
        continue;
      }
      out += ch;
      i++;
      continue;
    }
    // state === 2 — inside double-quoted string, preserve content.
    if (ch === "\\" && i + 1 < src.length) {
      out += ch + src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') {
      out += '"';
      state = 0;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Attempt strict JSON parse, then fall back to the Python-literal repair.
 *  Returns the parsed value or throws — caller wraps the error. */
function tolerantParseObject(payload: string): any {
  try {
    return JSON.parse(payload);
  } catch {
    // fall through
  }
  const repaired = pythonLiteralToJson(payload);
  return JSON.parse(repaired);
}

/**
 * Starting at `start` (which must point at `{`), return the index just past
 * the matching `}`. Tracks quote state so braces inside string literals
 * don't count. Returns -1 if no balanced match is found.
 */
function findBalancedBraceEnd(text: string, start: number): number {
  if (text[start] !== "{") return -1;
  let depth = 0;
  let i = start;
  // 0 = normal, 1 = single-string, 2 = double-string
  let state: 0 | 1 | 2 = 0;
  while (i < text.length) {
    const ch = text[i];
    if (state === 0) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return i + 1;
      } else if (ch === "'") state = 1;
      else if (ch === '"') state = 2;
    } else if (state === 1) {
      if (ch === "\\" && i + 1 < text.length) {
        i += 2;
        continue;
      }
      if (ch === "'") state = 0;
    } else {
      if (ch === "\\" && i + 1 < text.length) {
        i += 2;
        continue;
      }
      if (ch === '"') state = 0;
    }
    i++;
  }
  return -1;
}

/** Skip ASCII spaces / tabs / line breaks. */
function skipWhitespace(text: string, i: number): number {
  while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\r" || text[i] === "\n")) {
    i++;
  }
  return i;
}

/**
 * Parse one local-react model emission.
 *
 * - Truncates at the first `Observation:` line so the trailing
 *   `Function(...)` echo / backend `[WARNING]` blocks the gateway sometimes
 *   appends don't get re-parsed as tool calls.
 * - Collects every `Action: <name>` / `Action Input: <{...}>` pair in emit
 *   order. Each pair becomes one `ParsedAction`.
 * - Anything before the first `Action:` is the thought (leading `Thought:`
 *   label stripped).
 *
 * Returns `{ thought, actions }`. Never throws — malformed payloads
 * surface as `__parseError` actions so the loop can recover via the
 * tool-result feedback channel.
 */
export function parseReActText(raw: string): ParsedReActOutput {
  const cutoff = findObservationCutoff(raw);
  let text = raw.slice(0, cutoff);

  // Drop any pre-`Thought:` preamble the model emits (e.g.
  // `<Analyze>…</Analyze>` blocks, scratchpad notes). The local LLM was
  // trained to lead with `Thought:`, so content before it is noise that
  // would otherwise bleed into the recorded thought. If the output has
  // no `Thought:` label at all, leave the text untouched — terminal
  // turns may emit just an Action or just a final answer.
  const thoughtIdx = findThoughtAnchor(text);
  if (thoughtIdx > 0) {
    text = text.slice(thoughtIdx);
  }

  const actions: ParsedAction[] = [];
  // Match `Action:` followed by a tool name. The (?:^|\n) anchor keeps us
  // from matching `Action:` that appears inside a quoted thought (the model
  // rarely does this but cheap insurance).
  const actionRe = /(?:^|\n)[ \t]*Action\s*:[ \t]*(\S+)[ \t]*\r?\n[ \t]*Action Input\s*:[ \t]*/g;
  let firstMarkerIndex = -1;

  let m: RegExpExecArray | null;
  while ((m = actionRe.exec(text)) !== null) {
    if (firstMarkerIndex < 0) firstMarkerIndex = m.index;
    const name = m[1];
    const payloadStart = skipWhitespace(text, actionRe.lastIndex);
    if (text[payloadStart] !== "{") {
      // Action Input present but doesn't open with `{` — record a parse
      // error so the tool layer surfaces it to the model next turn.
      actions.push({
        name,
        input: {
          __parseError: "Action Input did not begin with '{'",
          __rawInput: text.slice(actionRe.lastIndex).split("\n")[0] ?? "",
        },
      });
      continue;
    }
    const payloadEnd = findBalancedBraceEnd(text, payloadStart);
    if (payloadEnd < 0) {
      actions.push({
        name,
        input: {
          __parseError: "Action Input has no matching closing brace",
          __rawInput: text.slice(payloadStart),
        },
      });
      // Can't reliably advance past unbalanced braces — bail on further
      // actions from this turn rather than risk re-parsing the same bytes.
      break;
    }
    const payloadStr = text.slice(payloadStart, payloadEnd);
    let input: any;
    try {
      input = tolerantParseObject(payloadStr);
    } catch (err) {
      input = {
        __parseError: err instanceof Error ? err.message : String(err),
        __rawInput: payloadStr,
      };
    }
    actions.push({ name, input });
    // Continue scanning after the payload; reset the regex index so
    // multi-action turns work.
    actionRe.lastIndex = payloadEnd;
  }

  const thoughtEnd = firstMarkerIndex >= 0 ? firstMarkerIndex : text.length;
  let thought = text.slice(0, thoughtEnd).trim();
  thought = thought.replace(/^\s*Thought\s*:\s*/i, "").trim();

  return { thought, actions };
}
