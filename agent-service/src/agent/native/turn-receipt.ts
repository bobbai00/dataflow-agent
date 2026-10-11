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
 * The receipt of a `dataflow` call: one Markdown message, one section per
 * statement, in the order written.
 *
 *   ## edits applied            (or ## edits rejected, with the line)
 *   ## execute a, b             executed operators with their evidence
 *   ## show result x            executed, upstream evidence, then the result:
 *                               shape, records (full or sample), statistics
 *   ## show schema | operator | function | builtin
 *
 * The underlying action outputs come from tools/dataflow-action-runtime.ts;
 * this renderer groups them by statement.
 */
import type { DataflowActionsResult } from "../tools/dataflow-actions";
import type { GraphChangeReceipt } from "../tools/graph-edits";
import { nativeDiagnosticIssue, parseNativeDiagnostic } from "./diagnostics";
import { FlowReceiptMemo } from "./evidence-compaction";
import { operatorBlock, type OperatorBlock } from "./observation-format";
import type { TurnReceiptInfo, TurnStatement } from "./turn-syntax";

type ActionItem = DataflowActionsResult["actions"][number];

/** A fallback for validation and pre-execution errors. Structured native
 * diagnostics are rendered by the owner before entering this function. */
export function issueText(message: string, fallback = "ACTION_FAILED"): string {
  const diagnostic = parseNativeDiagnostic(message);
  if (diagnostic) return nativeDiagnosticIssue(diagnostic);
  if (message.startsWith("- error ") || message.startsWith("- not run:")) return message;
  const code =
    /\b(?:MISSING_COLUMN|INVALID_ARGUMENTS|PYTHON_SYNTAX|EXECUTION_TIMEOUT|EDIT_REJECTED|UNKNOWN_OPERATOR|UNKNOWN_COLUMN|UNKNOWN_TARGET|UNCONNECTED_INPUTS|RESULT_STALE|RESULT_NOT_RUN|RESULT_FAILED|EMPTY_DATAFLOW)\b/.exec(
      message
    )?.[0] ??
    (/does not exist|no table `/.test(message)
      ? "UNKNOWN_OPERATOR"
      : /Unconnected required/.test(message)
        ? "UNCONNECTED_INPUTS"
        : /dataflow is empty/.test(message)
          ? "EMPTY_DATAFLOW"
          : /Unknown or disabled execution/.test(message)
            ? "UNKNOWN_TARGET"
            : fallback);
  const [first, ...rest] = message
    .replace(/^\[ERROR\]\s*/, "")
    .replace(/\[([A-Z_]+);[^\]]+\]/g, "$1")
    .replace(/^Diagnostic:.*\n?/gm, "")
    .replace(new RegExp(`^${code}:\\s*`), "")
    .trim()
    .split("\n");
  // Continuation lines (a nested diagnostic, a hint) become sub-items.
  return [
    `- error ${code}: ${first}`,
    ...rest
      .filter(line => line.trim())
      .map(line => {
        const text = line.trim();
        if (text.startsWith("- ")) return `  ${text}`;
        const hint = /^Hint:\s*(.*)$/.exec(text);
        if (hint) return `  - fix: ${hint[1]}`;
        const field = /^Field:\s*(.*)$/.exec(text);
        if (field) return `  - at: ${field[1]}`;
        return `  - ${text}`;
      }),
  ].join("\n");
}

function inputsOf(block: OperatorBlock): string {
  const inputs = (block.inputs ?? []).map(input => input.id).filter(id => id && id !== "unconnected");
  return inputs.length ? ` of ${inputs.join(", ")}` : "";
}

/** Share measurements only while emitting the block that contains them. */
function blockIssues(block: OperatorBlock, memo: FlowReceiptMemo): string[] {
  if (!block.flow_observation) return [...(block.issues ?? [])];
  const flowLines = new Set(block.flow_observation.chunks.flatMap(chunk => chunk.text.split("\n")));
  return [
    ...(block.issues ?? []).filter(line => !flowLines.has(line)),
    ...memo.render(block.flow_observation, block.id, `\`${block.id}\` above`).split("\n").filter(Boolean),
  ];
}

/** A scan's own facts: workbook sheet names and preview budgets. Ancestry
 * facts of other operators repeat the shapes the receipt already lists. */
function scanScope(block: OperatorBlock): string[] {
  return block.kind === "scan" ? (block.scope ?? []).filter(line => !line.startsWith("Further input")) : [];
}

/** `- id (kind of inputs): result`, then the operator's measured lines. */
function operatorLine(block: OperatorBlock, memo: FlowReceiptMemo): string[] {
  const state = block.state === "failed" ? "failed" : block.state === "not run" ? "not run" : undefined;
  const head = `- ${block.id} (${block.kind}${inputsOf(block)}): ${state ?? block.result ?? "no result"}`;
  const issues = [...scanScope(block), ...blockIssues(block, memo)].map(line =>
    line.startsWith("  ") ? line : `  ${line.startsWith("- ") ? line : `- ${line}`}`
  );
  return [head, ...issues];
}

function executeBlocks(item: ActionItem | undefined): OperatorBlock[] {
  const output = item?.output as any;
  if (!output || typeof output !== "object") return [];
  const blocks = (output.operator_blocks ?? []) as OperatorBlock[];
  return [
    ...blocks,
    ...((output.operators ?? []) as any[])
      .filter(op => !blocks.some(block => block.id === op.id))
      .map(op => ({
        id: op.id,
        kind: op.type ?? op.op ?? "operator",
        state: op.state ?? (op.status === "ok" ? "executed" : op.status === "error" ? "failed" : "not run"),
        result: op.status === "ok" ? `${op.rows ?? "unknown"} rows` : undefined,
        issues: op.message
          ? [op.status === "error" ? issueText(op.message, "EXECUTION_FAILED") : `- note: ${op.message}`]
          : [],
      })),
  ];
}

/** The execution part shared by `execute` and `show result`. */
function executionLines(
  item: ActionItem | undefined,
  targets: string[],
  upstreamOnly: boolean,
  memo: FlowReceiptMemo
): string[] {
  if (!item) return [];
  const output = item.output as any;
  const blocks = executeBlocks(item);
  const executed = blocks.filter(block => block.state === "executed");
  const failed = blocks.filter(block => block.state === "failed");
  const notRun = blocks.filter(block => block.state === "not run");
  const lines: string[] = [];
  if (item.status === "error" && !blocks.length) {
    lines.push(
      issueText(
        String(typeof output === "string" ? output : (output?.error ?? "Execution failed.")),
        "EXECUTION_FAILED"
      )
    );
    return lines;
  }
  const names = (list: OperatorBlock[]) => list.map(block => block.id).join(", ");
  const parts = [
    executed.length
      ? `executed: ${names(executed)}`
      : item.status === "ok"
        ? "executed: nothing (results were current)"
        : "executed: nothing",
  ];
  if (failed.length) parts.push(`failed: ${names(failed)}`);
  lines.push(parts.join("; "));
  const listed = upstreamOnly ? executed.filter(block => !targets.includes(block.id)) : executed;
  if (listed.length) {
    if (upstreamOnly) lines.push("upstream:");
    const shown = listed.slice(0, 8);
    for (const block of shown) lines.push(...operatorLine(block, memo));
    if (listed.length > shown.length) lines.push(`- +${listed.length - shown.length} more executed`);
  }
  for (const block of failed) lines.push(...operatorLine(block, memo));
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
    return [
      "## edits rejected",
      issueText(message, "EDIT_REJECTED").replace(/^- error EDIT_REJECTED: /, ""),
      "No edit applied; resend the corrected call.",
    ];
  }
  const lines = ["## edits applied"];
  const registrations = (output?.registrations ?? []) as Array<{ name: string; kind: string; signature?: string }>;
  const functions = registrations.map(r => `${r.name} ${r.kind}`);
  // With signatures (sessions with several requests), one line per function
  // says what a later call can vary; a function without settings says so.
  if (registrations.some(r => r.signature !== undefined))
    lines.push(
      "functions:",
      ...registrations.map(
        r => `- ${r.name}${r.signature ?? ""} ${r.kind}${/[*=]/.test(r.signature ?? "") ? "" : " (no settings)"}`
      )
    );
  else if (functions.length) lines.push(`functions: ${functions.join(", ")}`);
  const operators = ((output?.changes ?? []) as GraphChangeReceipt[])
    .filter(change => change.change === "operator")
    .map(
      change =>
        `${change.operator_id} ${change.action}${change.action === "created" || change.action === "updated" ? ` (${change.operator})` : ""}`
    );
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
  if (item.status !== "ok")
    return [
      title,
      issueText(String(typeof output === "string" ? output : (output?.error ?? "Lookup failed.")), "ACTION_FAILED"),
    ];
  if (typeof output?.text === "string") return [title, output.text];
  // `show operator` returns the operator's block rather than text.
  const blocks = Array.isArray(output?.operator_blocks) ? (output.operator_blocks as OperatorBlock[]) : [];
  return blocks.length ? [title, ...blocks.map(operatorBlock)] : [title, "No retained metadata."];
}

function resultLines(item: ActionItem | undefined, memo: FlowReceiptMemo, execution?: ActionItem): string[] {
  if (!item) return [];
  const output = item.output as any;
  const targetBlocks = new Map(executeBlocks(execution).map(block => [block.id, block]));
  const readyTarget = (id: string) => {
    const block = targetBlocks.get(id);
    return block && block.state === "executed" ? operatorLine(block, memo) : [];
  };
  const requested = "operator_ids" in item.action ? (item.action.operator_ids ?? []) : [];
  if (item.status === "skipped") return [...requested.flatMap(readyTarget), `not shown: ${String(output)}`];
  if (!Array.isArray(output?.results))
    return [
      ...requested.flatMap(readyTarget),
      issueText(
        String(typeof output === "string" ? output : (output?.error ?? "Retrieval failed.")),
        "RESULT_UNAVAILABLE"
      ),
    ];
  const lines: string[] = [];
  for (const entry of output.results as any[]) {
    if (entry.status === "error") {
      lines.push(
        ...readyTarget(entry.operator_id),
        `result ${entry.operator_id}: unavailable`,
        issueText(String(entry.error), "RESULT_UNAVAILABLE")
      );
      continue;
    }
    const block = (entry.operator_blocks ?? [])[0] as OperatorBlock | undefined;
    const head = block
      ? `result ${block.id} (${block.kind}${inputsOf(block)}): ${block.result ?? "no result"}`
      : `result ${entry.operator_id}`;
    lines.push(head);
    const executed = targetBlocks.get(entry.operator_id);
    const issues = [
      ...(block ? scanScope(block) : []),
      ...(executed ? blockIssues(executed, memo) : []),
      ...(block ? blockIssues(block, memo) : []),
    ];
    for (const issue of new Set(issues)) lines.push(issue.startsWith("- ") ? issue : `- ${issue}`);
    const text = entry.observation
      ? memo.render(entry.observation, entry.operator_id, `\`${entry.operator_id}\` above`)
      : entry.text;
    if (typeof text === "string" && text) lines.push(text);
    if (entry.superseded_in_call) lines.push("note: this result was superseded later in the call.");
  }
  return lines;
}

/** Render the receipt of a `dataflow` call from the executed action list. */
export function renderTurnReceipt(result: DataflowActionsResult, turn?: TurnReceiptInfo): string {
  const sections: string[] = [];
  const flowMemo = new FlowReceiptMemo();
  if (turn?.ignoredProse?.length)
    sections.push(
      turn.ignoredProse.length > 1
        ? `note: lines ${turn.ignoredProse.join(", ")} of statements are not statements and were ignored.`
        : `note: line ${turn.ignoredProse[0]} of statements is not a statement and was ignored.`
    );
  if (result.mergedInto)
    return "note: this call ran together with the first dataflow call of the same response; that call's receipt covers its definitions and statements.";
  if (!result.actions.length) {
    const message = String(result.error ?? "No actions ran.").replace(/\s*No actions ran\.$/, "");
    return [...sections, "## call rejected", message].join("\n");
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
    if (items.every(item => item.status === "skipped")) {
      sections.push(`${title}: not run (an earlier statement failed)`);
      continue;
    }
    if (statement.kind === "execute") {
      sections.push([title, ...executionLines(items[0], statement.ids ?? [], false, flowMemo)].join("\n"));
      continue;
    }
    if (statement.resource === "result") {
      const [execute, retrieve] = items;
      sections.push(
        [
          title,
          ...executionLines(execute, statement.ids ?? [], true, flowMemo),
          ...resultLines(retrieve, flowMemo, execute),
        ].join("\n")
      );
      continue;
    }
    // A lookup of a computed result (schema) runs an execute first.
    const lookup = items[items.length - 1];
    const executed = items.length > 1 ? executionLines(items[0], statement.ids ?? [], false, flowMemo) : [];
    const lines = lookupLines(lookup, statement);
    if (executed.length)
      lines.splice(1, 0, ...executed.filter(line => line !== "executed: nothing (results were current)"));
    sections.push(lines.join("\n"));
  }
  // Actions without a statement (a result recorded without its turn).
  for (const item of result.actions) {
    if (covered.has(item.index)) continue;
    const statement: TurnStatement = {
      line: 0,
      text: `${item.action.type}`,
      kind: item.action.type === "execute" ? "execute" : "show",
      actionIndexes: [item.index],
    };
    if (item.action.type === "execute")
      sections.push([`## execute`, ...executionLines(item, [], false, flowMemo)].join("\n"));
    else if (item.action.type === "retrieve")
      sections.push([`## show result`, ...resultLines(item, flowMemo)].join("\n"));
    else sections.push(lookupLines(item, statement).join("\n"));
  }
  return sections.join("\n\n");
}
