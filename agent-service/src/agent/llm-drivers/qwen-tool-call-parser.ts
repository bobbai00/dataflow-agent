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
 * Pure parser for the local LLM's Qwen3-Coder-style tool-call output (the
 * `qwen-xml` dialect — see `prompts/local-qwen-tools.txt`). Maps the model's raw
 * completion into a thought string plus the ordered list of tool calls it
 * emitted, returning the same `{ thought, actions }` shape as the
 * `react-text` parser so the driver is dialect-agnostic. The driver uses
 * the actions list as both the work to execute and the termination signal —
 * `actions.length === 0` ends the loop (the model's final text-only answer).
 *
 * Format. Optional natural-language reasoning comes BEFORE the call (never
 * after), then one or more tool calls, each wrapped in `<tool_call>`:
 *
 *   <reasoning text>                       # optional — becomes the thought
 *   <tool_call>
 *   <function=createOrModifyOperator>
 *   <parameter=operatorId>
 *   loadData
 *   </parameter>
 *   <parameter=code>
 *   def load() -> pd.DataFrame:
 *       return pd.read_csv('/data/x.csv')
 *   </parameter>
 *   <parameter=summary>
 *   Load x.csv
 *   </parameter>
 *   </function>
 *   </tool_call>
 *
 *   <tool_call>                            # multiple <tool_call> blocks in
 *   <function=deleteOperator>...</function># one turn map to parallel calls
 *   </tool_call>
 *
 * Parameter values are plain strings — every tool parameter in this service
 * is a string (operatorId / code / summary), so there is NO JSON / Python
 * literal coercion: the bytes between the tags are taken verbatim, with only
 * the formatting whitespace at the value boundaries trimmed.
 */

import type { ParsedAction, ParsedReActOutput } from "./react-text-parser";

/** Byte offset of the first tool-call marker (`<tool_call>` or, if the model
 *  drops the wrapper, a bare `<function=`). Returns -1 when neither exists —
 *  the whole completion is then free text (a terminal turn). */
function findFirstMarker(text: string): number {
  const a = text.indexOf("<tool_call>");
  const b = text.search(/<function=/);
  const found = [a, b].filter(i => i >= 0);
  return found.length > 0 ? Math.min(...found) : -1;
}

/** Remove `<think>…</think>` reasoning blocks. Applied only to the
 *  pre-tool-call region so it can never corrupt parameter values (which live
 *  inside `<tool_call>` and may legitimately contain angle brackets). */
function stripThinkBlocks(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/gi, "");
}

/**
 * Strip the formatting whitespace the protocol wraps around a value (the
 * newline right after `<parameter=…>` and the trailing newline before
 * `</parameter>`) without touching interior indentation.
 *
 * A plain `.trim()` is correct for this tool surface: every parameter is a
 * string whose first content line is flush-left (operatorId / summary are
 * single-line; a `code` block's top-level `def` sits at column 0), so
 * trimming the ends never removes indentation that Python relies on, while
 * robustly absorbing any extra blank lines the model adds at the boundaries.
 */
function trimValue(v: string): string {
  return v.trim();
}

/** Parse the `<parameter=KEY>VALUE</parameter>` pairs inside one function
 *  body into a `{ key: value }` record. Tolerant of a missing closing
 *  `</parameter>` on the final pair (truncated output) — it then captures to
 *  the end of the body. */
function parseParameters(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  const re = /<parameter=([^>\r\n\t ]+)\s*>([\s\S]*?)(?:<\/parameter>|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    params[m[1]] = trimValue(m[2]);
    if (re.lastIndex <= m.index) break; // zero-width guard
  }
  return params;
}

/**
 * Parse one local-LLM emission in the `qwen-xml` dialect.
 *
 * - Everything before the first tool-call marker is the thought (with
 *   `<think>` blocks and a leading "Thought:" label stripped). Anything the
 *   model emits AFTER the calls (the protocol forbids a suffix, but be
 *   defensive) is ignored — it is neither thought nor action.
 * - Every `<function=NAME>…</function>` block (across all `<tool_call>`
 *   wrappers) becomes one `ParsedAction`, in emit order. The `<tool_call>` /
 *   `</tool_call>` tags themselves are not required for extraction.
 * - When tool-call markers are present but nothing parseable is found, a
 *   single `__parseError` action is emitted so the driver does NOT mistake
 *   the turn for a terminal (zero-action) one and the model gets feedback.
 *
 * Never throws.
 */
export function parseQwenToolCall(raw: string): ParsedReActOutput {
  const markerIdx = findFirstMarker(raw);

  const thoughtRegion = markerIdx >= 0 ? raw.slice(0, markerIdx) : raw;
  let thought = stripThinkBlocks(thoughtRegion).trim();
  thought = thought.replace(/^Thought\s*:\s*/i, "").trim();

  const actions: ParsedAction[] = [];
  if (markerIdx >= 0) {
    const region = raw.slice(markerIdx);
    // Tolerant of a missing trailing `</function>` (truncated output): the
    // `$` alternative lets the final block capture to end of string.
    const fnRe = /<function=([^>\r\n\t ]+)\s*>([\s\S]*?)(?:<\/function>|$)/g;
    let m: RegExpExecArray | null;
    while ((m = fnRe.exec(region)) !== null) {
      actions.push({ name: m[1], input: parseParameters(m[2]) });
      if (fnRe.lastIndex <= m.index) break; // zero-width guard
    }
    if (actions.length === 0) {
      actions.push({
        name: "__unparsed__",
        input: {
          __parseError: "tool-call markers found but no <function=...> block could be parsed",
          __rawInput: region.trim().slice(0, 2000),
        },
      });
    }
  }

  return { thought, actions };
}
