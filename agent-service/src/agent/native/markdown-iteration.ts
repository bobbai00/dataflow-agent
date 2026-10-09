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

import type { ReActStep } from "../../types/agent";
import type { DataflowActionsResult } from "../tools/dataflow-actions";
import { actionObservationTitle, renderActionObservations } from "./action-observations";
import { observationFormat } from "./observation-format";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The delimiter is longer than every authored run, including runs in strings
 * and comments. Nothing inside the fence is interpreted as a context heading. */
function fence(text: string, language = "text"): string {
  const delimiter = "`".repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map(run => run.length + 1)));
  return `${delimiter}${language}\n${text}${text.endsWith("\n") ? "" : "\n"}${delimiter}`;
}
const quote = (text: string) =>
  text
    .split("\n")
    .map(line => `> ${line}`)
    .join("\n");
const json = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};
const raw = (value: unknown) => (typeof value === "string" ? fence(value) : fence(json(value), "json"));
const inline = (value: unknown) => JSON.stringify(value) ?? String(value);

function decode(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (!object(a) || !object(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
}
function receipt(value: unknown): value is DataflowActionsResult {
  return (
    object(value) &&
    value.kind === "dataflow-actions" &&
    ["pending", "completed", "error"].includes(String(value.status)) &&
    (value.error === undefined || typeof value.error === "string") &&
    Array.isArray(value.actions) &&
    value.actions.every(
      item =>
        object(item) &&
        Number.isInteger(item.index) &&
        object(item.action) &&
        ["inspect", "edit", "execute", "retrieve", "answer", "fork"].includes(String(item.action.type)) &&
        (item.action.type !== "inspect" ||
          ["graph", "operator", "reference", "namespace", "schema", "source", "task", "state"].includes(
            String(item.action.target)
          )) &&
        ["pending", "ok", "error", "skipped"].includes(String(item.status))
    )
  );
}

/** Request fields that the ordinary observation title already spells out. */
function titleFields(action: RecordValue): string[] {
  if (action.type === "retrieve" || action.type === "execute") return ["operator_id", "operator_ids"];
  if (action.type !== "inspect") return [];
  if (action.target === "reference") return ["target", "topic", "operator_names", "example"];
  if (action.target === "namespace") return ["target", "names"];
  if (action.target === "state") return ["target", "operator_id", "task_id"];
  if (action.target === "task") return ["target", "task_id"];
  return ["target", "operator_id"];
}

/** Source and parameters precede the outcome. Status comes only from the
 * matched receipt; retaining an attempted edit never claims it was applied. */
function submitted(action: RecordValue, status: string, finalAnswer?: string, includeTargets = false): string {
  const parts: string[] = [];
  const excluded = new Set(["type", ...(includeTargets ? [] : titleFields(action))]);
  if (action.type === "edit") {
    const state = status === "ok" ? "applied" : status === "pending" ? "outcome unconfirmed" : "not applied";
    for (const [field, label, language] of [
      ["python", "Python definitions", "python"],
      ["changes", "Graph declarations", "dataflow"],
    ]) {
      excluded.add(field);
      if (typeof action[field] === "string" && action[field] !== "")
        parts.push(`${label} (${state}):\n${fence(action[field], language)}`);
      else if (action[field] !== undefined && typeof action[field] !== "string")
        parts.push(`${label}:\n${raw(action[field])}`);
    }
  }
  if (action.type === "answer" && status === "ok" && action.content === finalAnswer) excluded.add("content");
  const parameters = Object.entries(action).filter(([key]) => !excluded.has(key));
  if (parameters.length)
    parts.push(`Request: ${parameters.map(([key, value]) => `${key}=${inline(value)}`).join("; ")}`);
  return parts.join("\n\n");
}

function unconfirmedActions(actions: unknown[]): string {
  return actions
    .map((action, i) =>
      object(action) && typeof action.type === "string"
        ? [`### ${i + 1}. ${inline(action.type)}: unconfirmed`, submitted(action, "pending", undefined, true)]
            .filter(Boolean)
            .join("\n\n")
        : raw(action)
    )
    .join("\n\n");
}

function actionReport(result: DataflowActionsResult, index: number, finalAnswer?: string): string {
  const item = result.actions[index];
  const action = item.action as unknown as RecordValue;
  const output =
    object(item.output) && item.action.type === "edit" && Array.isArray(item.output.operator_blocks)
      ? {
          ...item.output,
          operator_blocks: item.output.operator_blocks.map(block =>
            object(block)
              ? { ...block, definition: undefined, ...(action.python ? { functions: undefined } : {}) }
              : block
          ),
        }
      : item.output;
  const bodyResult: DataflowActionsResult = {
    ...result,
    actions: [{ ...item, output }],
    format: { ...observationFormat(result.format), answerEcho: false },
  };
  let body = renderActionObservations(bodyResult, { includeHeadings: false }).trim();
  if (item.status === "skipped") {
    // The single-item renderer cannot see the earlier action that failed.
    const failed = result.actions.find(other => other.index < item.index && other.status === "error");
    body = `Not run: ${failed ? `action ${failed.index} failed` : "an earlier action failed"}.`;
  }
  return [actionObservationTitle(item), submitted(action, item.status, finalAnswer), "#### Outcome", body]
    .filter(Boolean)
    .join("\n\n");
}

/** Render only a frozen iteration. No current graph, mutable settings, or
 * provider reasoningText is consulted. User requests and final answers retain
 * their actual roles in the context assembler, outside this environment report. */
export function renderMarkdownIteration(step: ReActStep, eventIndex: number): string {
  if (step.role !== "agent" || step.synthetic === "state") return "";
  const calls = step.toolCalls ?? [];
  const results = step.toolResults ?? [];
  const parts: string[] = [];
  const reasonings = new Set<string>();
  const addReasoning = (value: unknown) => {
    if (typeof value === "string" && value.trim() && !reasonings.has(value)) {
      reasonings.add(value);
      parts.push(`Reasoning:\n${quote(value)}`);
    }
  };
  if (!step.isEnd) addReasoning(step.content);
  const consumed = new Set<number>();
  calls.forEach((call, callIndex) => {
    if (calls.length > 1) parts.push(`### Call ${callIndex + 1}: ${inline(call.toolName)}`);
    const input = decode(call.input);
    if (object(input)) addReasoning(input.reasoning);
    const matches = results
      .map((result, i) => ({ result, i }))
      .filter(({ result }) => result.toolCallId === call.toolCallId);
    const unique = matches.length === 1 && calls.filter(other => other.toolCallId === call.toolCallId).length === 1;
    if (!unique) {
      parts.push(
        matches.length ? "Ambiguous receipt matching; outcome unconfirmed." : "No receipt; outcome unconfirmed."
      );
      if (call.toolName === "dataflow" && object(input) && Array.isArray(input.actions))
        parts.push(unconfirmedActions(input.actions));
      else parts.push("Submitted call:\n" + raw(call.input));
      return;
    }
    const { result: matched, i } = matches[0];
    consumed.add(i);
    const output = decode(matched.output);
    if (call.toolName !== "dataflow" || !object(input) || !Array.isArray(input.actions) || !receipt(output)) {
      parts.push(
        "Submitted call:\n" + raw(call.input),
        `#### Outcome${matched.isError ? " (error)" : ""}\n${raw(matched.output)}`
      );
      return;
    }
    const extra = Object.fromEntries(Object.entries(input).filter(([key]) => !["actions", "reasoning"].includes(key)));
    if (Object.keys(extra).length) parts.push("Additional request fields:\n" + raw(extra));
    if (matched.isError) parts.push("#### Outcome\nTool call reported an error; recorded action outcomes follow.");
    if (output.error && output.actions.length && !output.actions.some(item => item.status === "error"))
      parts.push("Call error:\n" + quote(output.error));
    if (!output.actions.length) {
      const rejected = output.status === "error" || !!output.error;
      parts.push(
        `Submitted actions (${rejected ? "not applied" : "outcome unconfirmed"}):\n` + raw(input.actions),
        "#### Outcome\n" +
          (rejected
            ? renderActionObservations(output)
            : `No action outcomes were recorded; receipt status: ${output.status}.`)
      );
      return;
    }
    if (
      !same(
        input.actions,
        output.actions.map(item => item.action)
      )
    ) {
      parts.push(
        "Receipt does not match the recorded request; application of this request is unconfirmed.",
        unconfirmedActions(input.actions),
        "#### Outcome\n" + raw(matched.output)
      );
      return;
    }
    try {
      parts.push(
        ...output.actions.map((_, index) => actionReport(output, index, step.isEnd ? step.content : undefined))
      );
    } catch {
      // Malformed archived/plugin receipts remain repairable instead of breaking
      // context assembly or silently losing the original request and response.
      parts.push(
        "Unrenderable receipt; see the recorded request and response.",
        "Submitted call:\n" + raw(call.input),
        "#### Outcome\n" + raw(matched.output)
      );
    }
  });
  results.forEach((result, i) => {
    if (!consumed.has(i))
      parts.push(
        `### Receipt without recorded call ${inline(result.toolCallId)}\n\n#### Outcome\n${raw(result.output)}`
      );
  });
  return parts.length ? [`## Iteration ${eventIndex}`, ...parts].join("\n\n") : "";
}
