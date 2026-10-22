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
 * The dataflow's versions as the chat shows them. Every edit of a `dataflow`
 * call makes a version (v1, v2, …; v0 is where the agent started): a step's
 * row lists its edits with the versions they made, then what it ran and read,
 * and the version tree shows versions only — a step that just ran or read the
 * dataflow made none.
 */
import type { ReActStep } from "../../../../service/agent/agent-types";
import type { SnapshotEdit, SnapshotTreeNode } from "../../../../service/agent/agent.service";

/** One action of a step, as a chip in its row. */
export interface ActionChip {
  kind:
    | "add"
    | "update"
    | "delete"
    | "define"
    | "edit"
    | "start"
    | "run"
    | "show"
    | "inspect"
    | "tool"
    | "error"
    | "pending";
  label: string;
  /** The version an edit made. */
  version?: number;
  /** Tooltip text. */
  title?: string;
}

/** A version an edit made, as the step's tool result reports it. */
export interface EditVersion extends SnapshotEdit {
  version: number;
  snapshotId: string;
}

interface DataflowItem {
  action: { type: string; operator_ids?: string[]; operator_id?: string; names?: string[]; operator_names?: string[] };
  status: "pending" | "ok" | "error" | "skipped";
  output?: unknown;
}
interface DataflowResult {
  kind: "dataflow-actions";
  actions: DataflowItem[];
  error?: string;
  mergedInto?: string;
}

const isDataflowResult = (output: unknown): output is DataflowResult =>
  !!output && typeof output === "object" && (output as DataflowResult).kind === "dataflow-actions";

const text = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value ?? ""));

/** What an edit did, in a few words: "add kept", "define make_table". */
export function editLabel(edit: SnapshotEdit): string {
  if (edit.kind === "define") return `define ${(edit.functions ?? []).join(", ")}`.trim();
  if (edit.kind === "start") return "start";
  const target = edit.operatorId ?? (edit.operatorIds ?? []).join(", ");
  return `${edit.kind} ${target}`.trim();
}

/** The chip for a version an edit made. */
export function versionChip(version: EditVersion): ActionChip {
  const label = editLabel(version);
  const parts = [
    `v${version.version}: ${label}${version.op && version.kind !== "define" ? ` (${version.op})` : ""}`,
    ...(version.functions?.length && version.kind !== "define" ? [`defines ${version.functions.join(", ")}`] : []),
    ...(version.author === "user" ? ["by you"] : []),
  ];
  return { kind: version.kind, label, version: version.version, title: parts.join(" · ") };
}

/** The versions a step's dataflow calls made, earliest first. */
export function stepVersions(step: Pick<ReActStep, "toolResults">): EditVersion[] {
  return (step.toolResults ?? []).flatMap(result => {
    const output: unknown = result.output;
    if (!isDataflowResult(output)) return [];
    return output.actions.flatMap(item =>
      item.action.type === "edit" && item.status === "ok"
        ? (item.output as { versions?: EditVersion[] } | undefined)?.versions ?? []
        : []
    );
  });
}

/** A step's dataflow calls as chips: each edit with the version it made, then
 * what the call ran, read and inspected. Undefined when the step made no
 * `dataflow` call. */
export function dataflowChips(step: Pick<ReActStep, "toolCalls" | "toolResults">): ActionChip[] | undefined {
  const calls = (step.toolCalls ?? []).filter(call => call?.toolName === "dataflow");
  if (!calls.length) return undefined;
  const chips: ActionChip[] = [];
  for (const call of calls) {
    const result = step.toolResults?.find(item => item.toolCallId === call.toolCallId)?.output;
    if (!isDataflowResult(result)) {
      chips.push({ kind: "pending", label: "working…" });
      continue;
    }
    // A later call of a response ran as part of the first one.
    if (result.mergedInto) continue;
    if (!result.actions.length && result.error)
      chips.push({ kind: "error", label: "call rejected", title: result.error });
    for (const item of result.actions) {
      const action = item.action;
      if (item.status === "skipped") continue;
      if (item.status === "pending") {
        chips.push({ kind: "pending", label: action.type === "edit" ? "editing…" : `${action.type}…` });
        continue;
      }
      if (action.type === "edit") {
        if (item.status === "error") {
          chips.push({ kind: "error", label: "edit failed", title: text(item.output) });
          continue;
        }
        const versions = (item.output as { versions?: EditVersion[] } | undefined)?.versions ?? [];
        if (!versions.length) chips.push({ kind: "edit", label: "no change" });
        chips.push(...versions.map(versionChip));
        continue;
      }
      const ids =
        action.operator_ids ??
        (action.operator_id ? [action.operator_id] : undefined) ??
        action.names ??
        action.operator_names ??
        [];
      const kind = action.type === "execute" ? "run" : action.type === "retrieve" ? "show" : "inspect";
      const label = `${kind} ${ids.length ? ids.join(", ") : kind === "run" ? "all" : ""}`.trim();
      chips.push(
        item.status === "error"
          ? { kind: "error", label: `${label} failed`, title: text(item.output) }
          : { kind, label }
      );
    }
  }
  return chips;
}

/**
 * The version tree: the versions only, each under its nearest version
 * ancestor (a step that ran or read the dataflow made no version, so its
 * snapshot folds into the version it ran). A service that reports no
 * versions keeps every snapshot.
 */
export function versionNodes(nodes: readonly SnapshotTreeNode[]): SnapshotTreeNode[] {
  if (!nodes.some(node => node.version !== undefined)) return [...nodes];
  return nodes
    .filter(node => node.version !== undefined)
    .map(node => ({ ...node, parentId: shownVersion(nodes, node.parentId) }));
}

/** The version a snapshot shows: itself when it is one, else its nearest version ancestor. */
export function shownVersion(nodes: readonly SnapshotTreeNode[], snapshotId: string | undefined): string | undefined {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const versioned = nodes.some(node => node.version !== undefined);
  for (let cursor = snapshotId; cursor; cursor = byId.get(cursor)?.parentId) {
    const node = byId.get(cursor);
    if (!node) return undefined;
    if (!versioned || node.version !== undefined) return node.id;
  }
  return undefined;
}

/** A version node's pill text ("v3 · kept") and tooltip ("v3: add kept (filter)"). */
export function versionLabel(node: SnapshotTreeNode): { label: string; title: string } {
  if (node.version === undefined || !node.edit) return { label: node.id, title: node.id };
  const edit = node.edit;
  const subject =
    edit.kind === "start"
      ? "start"
      : edit.kind === "define"
        ? (edit.functions ?? [])[0]
        : edit.operatorId ?? `${(edit.operatorIds ?? []).length} operators`;
  const title = `v${node.version}: ${editLabel(edit)}${edit.op && edit.kind !== "define" ? ` (${edit.op})` : ""}${
    edit.author === "user" ? " · by you" : ""
  }`;
  return { label: subject ? `v${node.version} · ${subject}` : `v${node.version}`, title };
}
