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

import type { DataflowActionsResult, DataflowAction } from "../tools/dataflow-actions";
import type { GraphChangeReceipt } from "../tools/graph-edits";
import { parseNativeDiagnostic, nativeDiagnosticIssue } from "./diagnostics";
import { renderTaskIndex, type TaskRecord } from "../task-history";
import {
  countOf,
  observationFormat,
  operatorBlock,
  renderTable,
  tableCell,
  type OperatorBlock,
} from "./observation-format";

/** A fallback for validation and pre-execution errors. Structured native
 * diagnostics are rendered by the owner before entering this function. */
export function issueText(message: string, fallback = "ACTION_FAILED"): string {
  const diagnostic = parseNativeDiagnostic(message);
  if (diagnostic) return nativeDiagnosticIssue(diagnostic);
  if (message.startsWith("- error ") || message.startsWith("- not run:")) return message;
  const code =
    /\b(?:MISSING_COLUMN|INVALID_ARGUMENTS|PYTHON_SYNTAX|EXECUTION_TIMEOUT|EDIT_REJECTED|ANSWER_REFUSED|UNKNOWN_OPERATOR|UNKNOWN_COLUMN|UNKNOWN_TARGET|UNCONNECTED_INPUTS|HISTORY_DISABLED|RESULT_STALE|RESULT_NOT_RUN|RESULT_FAILED|EMPTY_DATAFLOW)\b/.exec(
      message
    )?.[0] ??
    (/does not exist|no table `/.test(message)
      ? "UNKNOWN_OPERATOR"
      : /Unconnected required/.test(message)
        ? "UNCONNECTED_INPUTS"
        : /historical state|Historical state tools/.test(message)
          ? "HISTORY_DISABLED"
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

/** What distinguishes a listed version from the ones before it. */
function versionChange(versions: any[], index: number): string {
  const version = versions[index];
  const previous = versions[index - 1];
  if (version.deleted) return "deleted";
  if (!previous || previous.deleted) return "created";
  if (version.revision !== previous.revision) {
    // A definition that held before was restored from the last task it held in.
    const restored = versions
      .slice(0, index - 1)
      .reverse()
      .find(earlier => !earlier.deleted && earlier.revision === version.revision);
    return restored ? `restored from task ${restored.through_task_id ?? restored.task_id}` : "updated";
  }
  if (version.subgraph_hash !== previous.subgraph_hash) return "inputs changed";
  return "recomputed";
}

function target(action: DataflowAction): string {
  if (action.type === "inspect") {
    if (action.target === "reference")
      return ` reference ${action.topic === "operators" ? action.operator_names.join(", ") : action.example}`;
    if (action.target === "graph") return " graph";
    if (action.target === "namespace") return ` namespace${action.names ? ` ${action.names.join(", ")}` : ""}`;
    if (action.target === "schema" || action.target === "source") return ` ${action.target} ${action.operator_id}`;
    if (action.target === "task") return ` task ${action.task_id}`;
    if (action.target === "state")
      return ` ${Array.isArray(action.operator_id) ? action.operator_id.join(", ") : action.operator_id}${action.task_id === null ? " versions" : ` at task ${action.task_id}`}`;
    return ` ${action.operator_id}`;
  }
  if (action.type === "retrieve")
    return ` ${"operator_ids" in action ? action.operator_ids.join(", ") : action.operator_id}`;
  if (action.type === "execute" && action.operator_ids) return ` ${action.operator_ids.join(", ")}`;
  return "";
}

/** The retrieved view owns its column selection; do not repeat the operator's
 * summary schema when the view already supplies one. Keep structured blocks intact. */
function retrievedResultLines(blocks: OperatorBlock[], text = ""): string[] {
  const hasSchema = text.startsWith("columns: ");
  const lines = blocks.map(block => operatorBlock(hasSchema ? { ...block, columns: [] } : block));
  if (hasSchema) {
    const newline = text.indexOf("\n");
    lines.push(`  - ${newline < 0 ? text : text.slice(0, newline)}`);
    if (newline >= 0) lines.push(text.slice(newline + 1));
  } else if (text) lines.push(text);
  return lines;
}

export function renderActionObservations(result: DataflowActionsResult): string {
  const config = observationFormat(result.format);
  if (!result.actions.length)
    return `### dataflow call rejected\n${issueText(result.error ?? "No actions ran.", "CALL_REJECTED")}`;
  return result.actions
    .map(item => {
      const title = `### ${item.index}. ${item.action.type}${target(item.action)}: ${item.status}`;
      // A call still running has no output yet (a trace read mid-call).
      if (item.status === "pending") return `${title} (running)`;
      if (item.status === "skipped") {
        const failed = result.actions.find(other => other.index < item.index && other.status === "error");
        return `${title} (${failed ? `action ${failed.index} failed` : "an earlier action failed"})`;
      }
      const output = item.output as any;
      if (item.status === "ok" && item.action.type === "inspect" && item.action.target === "reference")
        return `${title}\n${output.text}`;
      if (item.action.type === "retrieve" && Array.isArray(output?.results)) {
        const lines = output.results.flatMap((entry: any) =>
          entry.status === "error"
            ? [`- **${entry.operator_id}**: unavailable`, issueText(entry.error, "RESULT_UNAVAILABLE")]
            : [
                ...retrievedResultLines(entry.operator_blocks ?? [], entry.text),
                ...(entry.superseded_in_call ? ["- note: this result was superseded later in the call."] : []),
              ]
        );
        return [title, ...lines].filter(Boolean).join("\n");
      }
      if (item.status === "error" && !(output && typeof output === "object" && Array.isArray(output.operators)))
        return [
          title,
          ...(item.action.type === "edit" ? ["No changes were applied."] : []),
          issueText(
            // The line above already says that nothing was applied.
            String(typeof output === "string" ? output : (output?.error ?? "Action failed.")).replace(
              item.action.type === "edit" ? /\s*No changes were applied\.(?=\n|$)/ : /$^/,
              ""
            ),
            item.action.type === "edit"
              ? "EDIT_REJECTED"
              : item.action.type === "answer"
                ? "ANSWER_REFUSED"
                : "ACTION_FAILED"
          ),
        ].join("\n");
      const blocks: OperatorBlock[] =
        output?.operator_blocks ??
        (item.action.type === "execute"
          ? (output?.operators ?? []).map((op: any) => ({
              id: op.id,
              kind: op.type ?? op.op ?? "operator",
              state: op.state ?? (op.status === "ok" ? "executed" : op.status === "error" ? "failed" : "not run"),
              result:
                op.status === "ok"
                  ? `${op.rows ?? "unknown"} rows × unknown columns`
                  : op.status === "error"
                    ? "failed"
                    : "not run",
              issues: [
                ...(op.message
                  ? [op.status === "error" ? issueText(op.message, "EXECUTION_FAILED") : `- note: ${op.message}`]
                  : []),
                ...(op.checks ?? []).map((line: string) => (line.startsWith("- ") ? line : `- ${line}`)),
              ],
            }))
          : []);
      let lines: string[] = [];
      if (item.action.type === "inspect" && item.action.target === "namespace")
        return [title, output.text ?? "No registered Python definitions."].join("\n");
      if (item.action.type === "inspect" && (item.action.target === "schema" || item.action.target === "source"))
        return [title, output.text ?? "No retained metadata."].join("\n");
      if (item.action.type === "inspect" && item.action.target === "task") {
        const task = output as TaskRecord;
        const body = [
          renderTaskIndex([task], Infinity),
          `Answer roots: ${output.selection_basis ?? "unknown"}. Recorded dependencies and sources establish provenance, not correctness.`,
          ...(output.note ? [output.note] : []),
          ...(output.selection_basis === "observed_reads"
            ? [
                `Result-read candidates (not confirmed answer sources): ${task.output_roots?.roots.map(root => root.operator_id).join(", ") || "none"}.`,
              ]
            : []),
          ...(output.dataflows ?? []).flatMap((graph: any) => [
            `Saved task computation: task ${graph.task_id}; roots ${graph.roots.join(", ")}; ${countOf(graph.operators.length, "local operator")}; ${countOf(graph.boundary_inputs?.length ?? 0, "saved input reference")}. Full upstream lineage: ${countOf(graph.upstream_operator_count ?? graph.operators.length, "operator")}; expand selected inputs when needed.`,
            ...graph.operator_blocks.map(operatorBlock),
            ...(graph.boundary_inputs?.length
              ? [
                  renderTable(
                    ["saved input", "task", "revision", "result"],
                    graph.boundary_inputs.map((input: any) => [
                      tableCell(input.operator_id, config.tableFormat),
                      String(input.task_id),
                      tableCell(input.revision?.slice(0, 12) ?? "unknown", config.tableFormat),
                      input.result.available
                        ? `${input.result.rows ?? "unknown"} rows`
                        : "unavailable; expand and execute to recompute",
                    ]),
                    config.tableFormat
                  ),
                  ...graph.boundary_inputs.flatMap((input: any) =>
                    (input.scope ?? []).map((scope: string) => `Input ${input.operator_id}: ${scope}`)
                  ),
                  "Expand a saved input with inspect target=task, its task_id and operator_id; target=state reads its definition and direct inputs. Input references contain no table records or Python.",
                ]
              : []),
            ...(graph.observations ?? []).map(
              (observation: any) => `Result ${observation.operator_id}:\n${observation.text}`
            ),
          ]),
          ...(!output.dataflows?.length
            ? [
                renderTable(
                  ["operator", "kind", "inputs", "revision", "result"],
                  task.operators.map(op => [
                    tableCell(op.operator_id, config.tableFormat),
                    tableCell(op.kind, config.tableFormat),
                    tableCell(op.inputs.join(", "), config.tableFormat),
                    tableCell(op.revision?.slice(0, 12) ?? "unknown", config.tableFormat),
                    op.available ? `${op.rows ?? "unknown"} rows` : "unavailable",
                  ]),
                  config.tableFormat
                ),
              ]
            : []),
        ].join("\n");
        return [
          title,
          // Saved questions/answers can contain Markdown headings. Quote the
          // whole record so the native frame parser keeps it inside this tool
          // result rather than mistaking it for a trailing context section.
          body
            .split("\n")
            .map(line => `> ${line}`)
            .join("\n"),
        ].join("\n");
      }
      if (item.action.type === "inspect" && item.action.target === "graph") {
        lines.push(
          blocks.length
            ? `${countOf(blocks.length, "operator")}; ${output.unconnected_inputs?.length ? `unconnected inputs: ${output.unconnected_inputs.join(", ")}` : "no unconnected inputs"}.`
            : "The dataflow is empty."
        );
        if (blocks.length)
          lines.push(
            renderTable(
              ["operator", "kind", "inputs", "result", "task", "columns"],
              blocks.map(block =>
                [
                  block.id,
                  block.kind,
                  (block.inputs ?? []).map(input => `${input.port ? input.port + " " : ""}${input.id}`).join(", "),
                  (block.result ?? "not run")
                    .replace(/ rows? × /, " × ")
                    .replace(/ columns?(?= \(|$)/, "")
                    .replace(/stale \(.*\)/, "stale"),
                  block.origin?.replace(/^task /, "") ?? "",
                  (block.columns ?? [])
                    .map(column => column.replace(/ (?:str|int64|float64|bool|datetime|unknown)$/, ""))
                    .join(", "),
                ].map(value => tableCell(value, config.tableFormat))
              ),
              config.tableFormat
            )
          );
      } else if (item.action.type === "inspect" && item.action.target === "state" && item.action.task_id === null) {
        for (const history of output.operators ?? [output]) {
          lines.push(`versions: ${history.operator_id}`);
          lines.push(
            renderTable(
              ["tasks", "change", "definition"],
              (history.versions ?? []).map((version: any, index: number) => [
                version.through_task_id > version.task_id
                  ? `${version.task_id}-${version.through_task_id}`
                  : String(version.task_id),
                versionChange(history.versions, index),
                tableCell(version.expression ? `\`${version.expression}\`` : "", config.tableFormat),
              ]),
              config.tableFormat
            )
          );
        }
      } else if (item.action.type === "edit") {
        for (const registration of output.registrations ?? [])
          lines.push(`function ${registration.name} ${registration.kind}`);
        // One line per change: `operator x created (filter)`, `edge a -> x created`.
        for (const change of (output.changes ?? []) as GraphChangeReceipt[])
          lines.push(
            change.change === "edge"
              ? `edge ${change.edge} ${change.action}`
              : `operator ${change.operator_id} ${change.action}${change.action === "created" || change.action === "updated" ? ` (${change.operator})` : ""}`
          );
        lines.push(...blocks.map(operatorBlock));
        if (output.invalidated_results?.length)
          lines.push(`results invalidated: ${output.invalidated_results.join(", ")}`);
        const unconnected = new Map<string, string[]>();
        for (const input of (output.unconnected_inputs ?? []) as string[]) {
          const id = input.slice(0, input.lastIndexOf("."));
          unconnected.set(id, [...(unconnected.get(id) ?? []), input]);
        }
        for (const [id, inputs] of unconnected)
          lines.push(
            `${inputs.join(", ")} ${inputs.length > 1 ? "are" : "is"} unconnected; restate ${id} with its inputs or delete it before executing.`
          );
        if (output.version_notes?.length) lines.push(...output.version_notes.map((note: string) => `note: ${note}`));
        if (output.provenance?.length) lines.push(...output.provenance);
      } else if (item.action.type === "execute") {
        const all = output.operators ?? [];
        const counts = [
          `${all.filter((op: any) => op.status === "ok" && op.state !== "cached").length} executed`,
          `${all.filter((op: any) => op.status === "ok" && op.state === "cached").length} cached`,
          ...(all.some((op: any) => op.state === "failed")
            ? [`${all.filter((op: any) => op.state === "failed").length} failed`]
            : []),
          ...(all.some((op: any) => op.state === "not run")
            ? [`${all.filter((op: any) => op.state === "not run").length} not run`]
            : []),
        ];
        lines.push(
          `${countOf(all.length, "operator")}${item.action.operator_ids ? " in scope" : ""}: ${counts.join(", ")}.`
        );
        lines.push(
          ...blocks
            .filter(block => block.scope?.length || block.issues?.length || block.state === "failed")
            .map(operatorBlock)
        );
        if (output.blocked?.length)
          lines.push(`- not run: ${output.blocked.map((op: any) => `${op.id} (${op.message})`).join(", ")}`);
        // Operators that did not run, grouped by cause, in graph order.
        const causes = new Map<string, string[]>();
        for (const op of all.filter((op: any) => op.state === "not run"))
          causes.set(op.cause ?? "not run", [...(causes.get(op.cause ?? "not run") ?? []), op.id]);
        for (const [cause, ids] of causes) lines.push(`- not run: ${ids.join(", ")} (${cause})`);
        // An engine error is shown only when no operator carries the failure.
        if (output.error && !all.some((op: any) => op.state === "failed"))
          lines.push(issueText(output.error, "EXECUTION_FAILED"));
      } else if (item.action.type === "answer") {
        lines.push(output?.composed ? `Answer composed from ${output.answer_from}.` : "Answer recorded.");
        if (output?.composed) lines.push(`answer: ${output.answer}`);
        else if (config.answerEcho && "content" in item.action)
          lines.push(
            `answer: ${item.action.content.includes("\n") ? JSON.stringify(item.action.content) : item.action.content}`
          );
        if (output?.text) lines.push(output.text);
      } else {
        if (item.action.type === "retrieve") lines.push(...retrievedResultLines(blocks, output?.text));
        else lines.push(...blocks.map(operatorBlock));
        if (output?.text && item.action.type !== "retrieve") {
          const text: string = output.text;
          if (item.action.type === "inspect")
            // A saved result: its operator block above already lists the columns.
            lines.push(text.replace(/(^|\n\n)columns: [^\n]*\n/g, "$1"));
          else lines.push(text);
        }
        if (output?.superseded_in_call) lines.push("- note: this result was superseded later in the call.");
      }
      return [title, ...lines].filter(Boolean).join("\n");
    })
    .join("\n\n");
}
