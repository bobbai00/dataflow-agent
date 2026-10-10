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

import type { ModelMessage } from "ai";
import type { ReActStep } from "../../../types/agent";

/** Context layout and result sampling are independent of data/flow evidence. */

/** `## Agent Event N` at line start — the boundary the renderer emits. */
const EVENT_RE = /^## Agent Event (\d+)\s*$/gm;
/** A top-level section rendered after the last event (current state, not history). */
const TRAILING_SECTION_RE = /^# [^\n]+$/m;

export interface NativeFramesResult {
  messages: ModelMessage[];
  /** Events converted to frame pairs. 0 ⇒ nothing to convert (caller keeps the block). */
  events: number;
}

/**
 * Split a rendered context into its append-only HEAD and its volatile TAIL.
 *
 * The tail is the top-level section rendered AFTER the last agent event — the
 * CURRENT dataflow state, which is re-rendered from scratch every step. The
 * head is the task plus the event history, which only ever grows.
 *
 * This split is what makes prompt caching possible. Anthropic can only reuse a
 * prefix that some earlier request already stored a cache entry for, and an
 * entry is only reusable if every byte before it is unchanged. Keeping the two
 * in ONE message means the volatile tail sits inside the only cacheable unit,
 * so nothing is ever reused. Measured directly against the proxy: one message
 * with a changing tail re-wrote all 19,814 tokens on the second call and read
 * 0; the same bytes split into two messages wrote 10 and read 19,804.
 *
 * Returns `tail === ""` when there is no trailing state section, in which case
 * the caller should emit the text unsplit.
 */
export function splitTrailingState(text: string): { head: string; tail: string } {
  EVENT_RE.lastIndex = 0;
  let lastEventAt = -1;
  for (let m = EVENT_RE.exec(text); m !== null; m = EVENT_RE.exec(text)) lastEventAt = m.index;
  if (lastEventAt < 0) return { head: text, tail: "" };
  const nl = text.indexOf("\n", lastEventAt) + 1;
  if (nl <= 0) return { head: text, tail: "" };
  // Scan line-wise and skip fenced code: rendered Action blocks contain python
  // comments like `# not a heading`, and matching one would cut the render in
  // the middle of a step — content still reconstructs, so the caller's equality
  // guard would not catch it, but the cached head would end mid-event.
  const rest = text.slice(nl);
  let off = 0;
  let fenced = false;
  let cut = -1;
  for (const line of rest.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    else if (!fenced && /^# [^\n]*$/.test(line)) {
      cut = off;
      break;
    }
    off += line.length + 1;
  }
  if (cut < 0) return { head: text, tail: "" };
  return { head: text.slice(0, nl + cut).trimEnd(), tail: text.slice(nl + cut).trimEnd() };
}

/**
 * Build the transcript. `stepByEvent` maps a rendered event index to the step
 * that produced it (populated by the renderer's `eventStepSink`), which is what
 * lets us emit the step's true toolCallIds — a fabricated id would not match the
 * result part and providers reject the pair.
 *
 * Events whose step has no tool calls cannot become a frame pair (a tool result
 * with no call is invalid), so their rendered text is carried as an assistant
 * text turn instead — thought-only turns stay visible without breaking pairing.
 */
export function buildNativeFrames(text: string, stepByEvent: Map<number, ReActStep>): NativeFramesResult {
  const marks: Array<{ at: number; index: number }> = [];
  EVENT_RE.lastIndex = 0;
  for (let m = EVENT_RE.exec(text); m !== null; m = EVENT_RE.exec(text)) {
    marks.push({ at: m.index, index: Number(m[1]) });
  }
  if (marks.length === 0) {
    // No events yet: end the message exactly where later steps' prefix ends
    // (`# Agent Events`), so step 1 shares the cached prefix with step 2.
    return { messages: [{ role: "user", content: text.replace(/\n+\(no agent actions yet\)\s*$/, "") }], events: 0 };
  }

  const messages: ModelMessage[] = [];
  const prefix = text.slice(0, marks[0].at).trimEnd();
  if (prefix) messages.push({ role: "user", content: prefix });

  let converted = 0;
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].at : text.length;
    let chunk = text.slice(marks[i].at, end);

    // Split off a trailing top-level section: it is CURRENT state, re-rendered
    // every step, so it must sit last or it would break the append-only prefix.
    let trailing = "";
    if (i === marks.length - 1) {
      const nl = chunk.indexOf("\n") + 1;
      const t = chunk.slice(nl).search(TRAILING_SECTION_RE);
      if (t >= 0) {
        trailing = chunk.slice(nl + t).trimEnd();
        chunk = chunk.slice(0, nl + t);
      }
    }

    // An earlier user turn (`## User Event N`) is rendered between agent events;
    // it belongs to the user, not to the previous tool result.
    let userTurn = "";
    const userAt = chunk.search(/^## User Event \d+\s*$/m);
    if (userAt >= 0) {
      userTurn = chunk
        .slice(userAt)
        .replace(/^## User Event \d+\s*\n/, "")
        .trim();
      chunk = chunk.slice(0, userAt);
    }

    const obsAt = chunk.search(/^Observation:\s*$/m);
    const head = (obsAt >= 0 ? chunk.slice(0, obsAt) : chunk).trimEnd();
    const observation =
      obsAt >= 0
        ? chunk
            .slice(obsAt)
            .replace(/^Observation:\s*\n?/, "")
            .trim()
        : "";

    const step = stepByEvent.get(marks[i].index);
    const calls = step?.toolCalls ?? [];

    // `Thought:` is the model's own reasoning; keep it as the assistant's text.
    // The `Action:` render is dropped here — the tool-call parts below ARE the
    // action, and repeating it as prose is what caused the narration failure.
    const thought = extractThought(head);

    if (calls.length === 0) {
      const body = thought || head;
      if (body) messages.push({ role: "assistant", content: body });
      if (observation) messages.push({ role: "user", content: observation });
      if (userTurn) messages.push({ role: "user", content: userTurn });
      if (trailing) messages.push({ role: "user", content: trailing });
      continue;
    }

    messages.push({
      role: "assistant",
      content: [
        ...(thought ? [{ type: "text" as const, text: thought }] : []),
        ...calls.map(tc => ({
          type: "tool-call" as const,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input ?? {},
        })),
      ],
    });

    // Every call needs exactly one result. The event's rendered evidence covers
    // the whole step (it is a per-operator delta, not per-call), so it rides on
    // the LAST result and earlier calls carry their own one-line outcome.
    messages.push({
      role: "tool",
      content: calls.map((tc, k) => {
        const isLast = k === calls.length - 1;
        const own = ownOutcome(step, tc.toolCallId, isLast && !!observation);
        const value = isLast && observation ? (own ? `${own}\n\n${observation}` : observation) : own || "ok";
        return {
          type: "tool-result" as const,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          output: { type: "text" as const, value },
        };
      }),
    });
    converted++;

    if (userTurn) messages.push({ role: "user", content: userTurn });
    if (trailing) messages.push({ role: "user", content: trailing });
  }

  // A transcript must not end on an assistant turn (a thought-only event), so
  // that case gets a closing user turn. A tool turn is left as the last message:
  // the model's move follows tool results in the standard loop, and a constant
  // user message after them would sit where the next step inserts new content,
  // which made the provider's prefix cache stop at the system prompt (measured:
  // with `Continue.` cached = system + tools only; without it the whole
  // previous prompt is a cache hit).
  const last = messages[messages.length - 1];
  if (last && last.role === "assistant") messages.push({ role: "user", content: "Continue." });

  return { messages, events: converted };
}

/** The `Thought: …` body of a rendered event, up to the `Action:` block. */
function extractThought(head: string): string {
  // Under /m, $ matches every line end. Use a true end-of-input assertion
  // so a text-only response survives intact for the bounded Answer repair.
  const m = head.match(/^Thought:[ \t]*([\s\S]*?)(?=\nAction:[ \t]*(?:\n|$)|(?![\s\S]))/m);
  return m ? m[1].trim() : "";
}

/** That one call's own outcome, first line only — errors keep their message. */
function ownOutcome(step: ReActStep | undefined, toolCallId: string, hasObservation: boolean): string {
  const r = step?.toolResults?.find(x => x.toolCallId === toolCallId);
  if (!r) return "";
  // Per-action Markdown already reports completion or failure for this call.
  if (r.output?.kind === "dataflow-actions") return hasObservation ? "" : `dataflow-actions: ${r.output.status}`;
  const out = typeof r.output === "string" ? r.output : JSON.stringify(r.output ?? "");
  const first = out.trim().split("\n")[0]?.trim() ?? "";
  return first.slice(0, 300);
}

/**
 * OPERATOR SPLIT — the LATEST-mode analogue of the append-only transcript.
 *
 * A DELTA render is append-only, so cutting it at step boundaries gives a
 * growing stable prefix. A LATEST render has no history to append: it is a
 * fresh snapshot of the CURRENT graph each step. Measured on luna LATEST arms
 * (C3 578 step-pairs, C4 495), that snapshot is nonetheless highly stable —
 * median 100% of the previous render is a byte-identical prefix, mean 85%,
 * because most steps only add or touch one operator. What kills the cache is
 * that it all ships as ONE message, so a provider matching whole messages
 * (gpt-5.6-*) or anchoring breakpoints (claude-*) can reuse none of it, and
 * when the render does change it changes at the FIRST operator: the p10 cases
 * are `probe_precip_amherst` -> `precip_amherst` and a rewritten
 * `omni_spec_probe`, each invalidating the whole remainder.
 *
 * Splitting per operator localises that: revising one operator invalidates its
 * own message and the ones after it, not the entire context. Operator ORDER is
 * left exactly as the renderer produced it — reordering (e.g. by last-modified,
 * to push churn to the tail) would cache better still, but it breaks dataflow
 * reading order on a graph-building task and is a separate, riskier experiment.
 */
/**
 * turnSplit — one user message per catalog / session entry and per step of the
 * live turn, so finished turns are byte-stable messages and each step of the
 * current turn APPENDS a message. Boundaries: `## Turn N`, `#### Step k`, and
 * any top-level `# ` section. Returns [] when there is nothing to split.
 */
export function splitTurns(text: string): string[] {
  const RE = /^(?:## Turn \d+[^\n]*|### Steps|#### Step \d+[^\n]*|# [^\n]+)\s*$/gm;
  const marks: number[] = [];
  for (let m = RE.exec(text); m !== null; m = RE.exec(text)) marks.push(m.index);
  if (marks.length < 1) return [];
  const parts: string[] = [];
  const head = text.slice(0, marks[0]).trimEnd();
  if (head) parts.push(head);
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1] : text.length;
    const chunk = text.slice(marks[i], end).trimEnd();
    if (chunk) parts.push(chunk);
  }
  return parts;
}

export function splitOperators(text: string): string[] {
  const marks: number[] = [];
  // Code-mode blocks read `### Operator \`id\` (Type)`, native ones `### filter operator \`id\``.
  const RE = /^(?:### (?:Operator |\w+ operator )|- \*\*[A-Za-z_][A-Za-z0-9_]*\*\* \()/gm;
  for (let m = RE.exec(text); m !== null; m = RE.exec(text)) marks.push(m.index);
  // One operator is split too: the first message must be the same bytes at
  // every step (task + `# Current Dataflow` header), or the prefix cache
  // restarts at steps 2 and 3 of every run.
  if (marks.length < 1) return [];

  const parts: string[] = [];
  const head = text.slice(0, marks[0]).trimEnd();
  if (head) parts.push(head);

  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1] : text.length;
    let chunk = text.slice(marks[i], end);
    // A trailing top-level section after the last operator is CURRENT state
    // re-rendered every step; it must sit last or it breaks the stable prefix.
    if (i === marks.length - 1) {
      const nl = chunk.indexOf("\n") + 1;
      const t = chunk.slice(nl).search(TRAILING_SECTION_RE);
      if (t >= 0) {
        parts.push(chunk.slice(0, nl + t).trimEnd());
        parts.push(chunk.slice(nl + t).trimEnd());
        continue;
      }
    }
    parts.push(chunk.trimEnd());
  }
  return parts.filter(p => p.length > 0);
}
