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
 * The receipt of a text turn: one Markdown message, one section per
 * statement, in turn order.
 *
 *   ## edits applied            (or ## edits rejected, with the line)
 *   ## execute a, b             executed operators with their evidence
 *   ## show result x            executed, upstream evidence, then the result:
 *                               shape, records (full or sample), statistics
 *   ## show schema | operator | function | builtin
 *
 * The underlying action outputs are the ones the JSON tool produces; this
 * renderer only groups them by statement.
 */
import type { DataflowActionsResult } from "../tools/dataflow-actions";
import type { GraphChangeReceipt } from "../tools/graph-edits";
import { issueText } from "./action-observations";
import type { OperatorBlock } from "./observation-format";
import type { ParsedTurn, TurnStatement } from "./turn-syntax";

type ActionItem = DataflowActionsResult["actions"][number];

function inputsOf(block: OperatorBlock): string {
  const inputs = (block.inputs ?? []).map(input => input.id).filter(id => id && id !== "unconnected");
  return inputs.length ? ` of ${inputs.join(", ")}` : "";
}

/** `- id (kind of inputs): result`, then the operator's measured lines. */
function operatorLine(block: OperatorBlock, failed = false): string[] {
  const state = block.state === "failed" ? "failed" : block.state === "not run" ? "not run" : undefined;
  const head = `- ${block.id} (${block.kind}${inputsOf(block)}): ${state ?? block.result ?? "no result"}`;
  const issues = (block.issues ?? []).map(line => (line.startsWith("  ") ? line : `  ${line.startsWith("- ") ? line : `- ${line}`}`));
  return failed && !issues.length ? [head] : [head, ...issues];
}

function executeBlocks(item: ActionItem | undefined): OperatorBlock[] {
  const output = item?.output as any;
  if (!output || typeof output !== "object") return [];
  if (Array.isArray(output.operator_blocks)) return output.operator_blocks as OperatorBlock[];
  return ((output.operators ?? []) as any[]).map(op => ({
    id: op.id,
    kind: op.type ?? op.op ?? "operator",
    state: op.state ?? (op.status === "ok" ? "executed" : op.status === "error" ? "failed" : "not run"),
    result: op.status === "ok" ? `${op.rows ?? "unknown"} rows` : undefined,
    issues: op.message ? [op.status === "error" ? issueText(op.message, "EXECUTION_FAILED") : `- note: ${op.message}`] : [],
  }));
}

/** The execution part shared by `execute` and `show result`. */
function executionLines(item: ActionItem | undefined, targets: string[], upstreamOnly: boolean): string[] {
  if (!item) return [];
  const output = item.output as any;
  const blocks = executeBlocks(item);
  const executed = blocks.filter(block => block.state === "executed");
  const failed = blocks.filter(block => block.state === "failed");
  const notRun = blocks.filter(block => block.state === "not run");
  const lines: string[] = [];
  if (item.status === "error" && !blocks.length) {
    lines.push(issueText(String(typeof output === "string" ? output : (output?.error ?? "Execution failed.")), "EXECUTION_FAILED"));
    return lines;
  }
  const names = (list: OperatorBlock[]) => list.map(block => block.id).join(", ");
  const parts = [executed.length ? `executed: ${names(executed)}` : "executed: nothing (results were current)"];
  if (failed.length) parts.push(`failed: ${names(failed)}`);
  lines.push(parts.join("; "));
  const listed = upstreamOnly ? executed.filter(block => !targets.includes(block.id)) : executed;
  if (listed.length) {
    if (upstreamOnly) lines.push("upstream:");
    const shown = listed.slice(0, 8);
    for (const block of shown) lines.push(...operatorLine(block));
    if (listed.length > shown.length) lines.push(`- +${listed.length - shown.length} more executed`);
  }
  for (const block of failed) lines.push(...operatorLine(block, true));
  if (notRun.length) lines.push(`not run: ${names(notRun)}.`);
  if (output?.error && !failed.length) lines.push(issueText(String(output.error), "EXECUTION_FAILED"));
  return lines;
}

function editLines(item: ActionItem): string[] {
  const output = item.output as any;
  if (item.status !== "ok") {
    const message = String(typeof output === "string" ? output : (output?.error ?? "Edit rejected.")).replace(
      /\s*No changes were applied\.(?=\n|$)/,
      ""
    );
    return ["## edits rejected", issueText(message, "EDIT_REJECTED").replace(/^- error EDIT_REJECTED: /, ""), "No edit applied; resend the corrected turn."];
  }
  const lines = ["## edits applied"];
  const functions = ((output?.registrations ?? []) as Array<{ name: string; kind: string }>).map(r => `${r.name} ${r.kind}`);
  if (functions.length) lines.push(`functions: ${functions.join(", ")}`);
  const operators = ((output?.changes ?? []) as GraphChangeReceipt[])
    .filter(change => change.change === "operator")
    .map(change => `${change.operator_id} ${change.action}${change.action === "created" || change.action === "updated" ? ` (${change.operator})` : ""}`);
  if (operators.length) lines.push(`operators: ${operators.join(", ")}`);
  if (!functions.length && !operators.length) lines.push("nothing changed");
  if (output?.invalidated_results?.length) lines.push(`stale until executed: ${output.invalidated_results.join(", ")}`);
  for (const input of (output?.unconnected_inputs ?? []) as string[]) lines.push(`unconnected input: ${input}`);
  if (output?.version_notes?.length) lines.push(...output.version_notes.map((note: string) => `note: ${note}`));
  return lines;
}

function lookupLines(item: ActionItem, statement: TurnStatement): string[] {
  const output = item.output as any;
  const title = `## ${statement.text}`;
  if (item.status === "skipped") return [`${title}: not run`];
  if (item.status !== "ok") return [title, issueText(String(typeof output === "string" ? output : (output?.error ?? "Lookup failed.")), "ACTION_FAILED")];
  const text = typeof output?.text === "string" ? output.text : undefined;
  return [title, text ?? "No retained metadata."];
}

function resultLines(item: ActionItem | undefined, statement: TurnStatement): string[] {
  if (!item) return [];
  const output = item.output as any;
  if (item.status === "skipped") return [`not shown: ${String(output)}`];
  if (!Array.isArray(output?.results))
    return [issueText(String(typeof output === "string" ? output : (output?.error ?? "Retrieval failed.")), "RESULT_UNAVAILABLE")];
  const lines: string[] = [];
  for (const entry of output.results as any[]) {
    if (entry.status === "error") {
      lines.push(`result ${entry.operator_id}: unavailable`, issueText(String(entry.error), "RESULT_UNAVAILABLE"));
      continue;
    }
    const block = (entry.operator_blocks ?? [])[0] as OperatorBlock | undefined;
    const head = block ? `result ${block.id} (${block.kind}${inputsOf(block)}): ${block.result ?? "no result"}` : `result ${entry.operator_id}`;
    lines.push(head);
    for (const issue of block?.issues ?? []) lines.push(issue.startsWith("- ") ? issue : `- ${issue}`);
    if (typeof entry.text === "string" && entry.text) lines.push(entry.text);
    if (entry.superseded_in_call) lines.push("note: this result was superseded later in the turn.");
  }
  return lines;
}

/** Render the receipt of a text turn from the executed action list. */
export function renderTurnReceipt(result: DataflowActionsResult, turn?: ParsedTurn): string {
  const sections: string[] = [];
  if (turn?.missingSummary) sections.push("note: start each turn with a summary: line.");
  if (turn?.ignoredProse?.length)
    sections.push(`note: line${turn.ignoredProse.length > 1 ? "s" : ""} ${turn.ignoredProse.join(", ")} ${turn.ignoredProse.length > 1 ? "are" : "is"} not statements and were ignored; a turn holds statements only.`);
  if (!result.actions.length) {
    const message = String(result.error ?? "No actions ran.").replace(/\s*No actions ran\.$/, "");
    return [...sections, "## turn rejected", message].join("\n");
  }
  const byIndex = new Map(result.actions.map(item => [item.index, item]));
  const statements = turn?.statements ?? [];
  const covered = new Set<number>();
  const editItem = result.actions.find(item => item.action.type === "edit");
  if (editItem) {
    covered.add(editItem.index);
    sections.push(editLines(editItem).join("\n"));
  }
  for (const statement of statements) {
    if (statement.kind === "edit") continue;
    const items = statement.actionIndexes.map(index => byIndex.get(index)).filter((item): item is ActionItem => !!item);
    for (const item of items) covered.add(item.index);
    if (!items.length) continue;
    const title = `## ${statement.text}`;
    if (statement.kind === "answer") continue;
    if (items.every(item => item.status === "skipped")) {
      sections.push(`${title}: not run (an earlier statement failed)`);
      continue;
    }
    if (statement.kind === "execute") {
      sections.push([title, ...executionLines(items[0], statement.ids ?? [], false)].join("\n"));
      continue;
    }
    if (statement.resource === "result") {
      const [execute, retrieve] = items;
      sections.push([title, ...executionLines(execute, statement.ids ?? [], true), ...resultLines(retrieve, statement)].join("\n"));
      continue;
    }
    sections.push(lookupLines(items[0], statement).join("\n"));
  }
  // Actions without a statement (a receipt rendered for a JSON-tool call).
  for (const item of result.actions) {
    if (covered.has(item.index) || item.action.type === "answer") continue;
    const statement: TurnStatement = { line: 0, text: `${item.action.type}`, kind: item.action.type === "execute" ? "execute" : "show", actionIndexes: [item.index] };
    if (item.action.type === "execute") sections.push([`## execute`, ...executionLines(item, [], false)].join("\n"));
    else if (item.action.type === "retrieve") sections.push([`## show result`, ...resultLines(item, statement)].join("\n"));
    else sections.push(lookupLines(item, statement).join("\n"));
  }
  const answer = result.actions.find(item => item.action.type === "answer");
  if (answer) sections.push(answer.status === "ok" ? "answer recorded" : ["## answer", issueText(String((answer.output as any)?.error ?? answer.output ?? "Answer refused."), "ANSWER_REFUSED")].join("\n"));
  return sections.join("\n\n");
}
