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
 * The dataflow's versions as the chat shows them. Every action of a `dataflow`
 * call makes a version (v0 is where the agent started): each `set` or
 * `delete`, each run and each result shown. A step's row lists what it changed
 * — its adds, modifies and deletes, each with the version it made — and the
 * version tree lists every version under its verb.
 */
import type { ReActStep } from "../../../../service/agent/agent-types";
import type { SnapshotTreeNode, VersionAction, VersionInfo } from "../../../../service/agent/agent.service";

/** One change a step made, as a chip in its row. */
export interface ActionChip {
  kind: "add" | "update" | "delete" | "define" | "edit" | "start" | "tool" | "pending";
  label: string;
  /** The version the change made. */
  version?: number;
  /** Tooltip text. */
  title?: string;
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

/** The verb a version's action reads as: an update is a modify. */
export function actionVerb(action: VersionAction): string {
  return action.kind === "update" ? "modify" : action.kind;
}

/** What an action did, in a few words: "add kept", "modify kept", "define make_table", "run all". */
export function actionLabel(action: VersionAction): string {
  const verb = actionVerb(action);
  if (action.kind === "define") return `define ${(action.functions ?? []).join(", ")}`.trim();
  if (action.kind === "start") return "start";
  if (action.kind === "run" && !action.operatorIds?.length) return "run all";
  const ids = action.operatorId ? [action.operatorId] : action.operatorIds ?? [];
  const target = action.kind === "edit" && ids.length > 1 ? `${ids.length} operators` : ids.join(", ");
  return `${verb} ${target}`.trim();
}

/** "v3: modify kept (filter) · by you" — a version's full description. */
function versionTitle(version: number, action: VersionAction): string {
  return [
    `v${version}: ${actionLabel(action)}${action.op && action.kind !== "define" ? ` (${action.op})` : ""}`,
    ...(action.functions?.length && action.kind !== "define" ? [`defines ${action.functions.join(", ")}`] : []),
    ...(action.author === "user" ? ["by you"] : []),
  ].join(" · ");
}

/** The chip for a version a change made. */
export function versionChip(version: VersionInfo): ActionChip {
  return {
    kind: version.kind === "run" || version.kind === "show" ? "tool" : version.kind,
    label: actionLabel(version),
    version: version.version,
    title: versionTitle(version.version, version),
  };
}

/** Every version a step's dataflow calls recorded, earliest first: each edit's, run's and show's. */
export function stepVersions(step: Pick<ReActStep, "toolResults">): VersionInfo[] {
  return (step.toolResults ?? []).flatMap(result => {
    const output: unknown = result.output;
    if (!isDataflowResult(output)) return [];
    return output.actions.flatMap(item => {
      const recorded = item.output as { versions?: VersionInfo[]; version?: VersionInfo } | undefined;
      return item.status === "pending" || item.status === "skipped" || typeof recorded !== "object"
        ? []
        : recorded?.versions ?? (recorded?.version ? [recorded.version] : []);
    });
  });
}

/** A step's dataflow calls as chips: what they changed, each edit with the
 * version it made. Runs and reads are not listed; a failure shows on the row
 * instead (`dataflowFailure`). Undefined when the step made no `dataflow` call. */
export function dataflowChips(step: Pick<ReActStep, "toolCalls" | "toolResults">): ActionChip[] | undefined {
  const calls = (step.toolCalls ?? []).filter(call => call?.toolName === "dataflow");
  if (!calls.length) return undefined;
  const chips: ActionChip[] = [];
  for (const call of calls) {
    const result = step.toolResults?.find(item => item.toolCallId === call.toolCallId)?.output;
    if (!isDataflowResult(result) || result.mergedInto) continue;
    for (const item of result.actions) {
      if (item.action.type !== "edit") continue;
      if (item.status === "pending") chips.push({ kind: "pending", label: "editing…" });
      if (item.status !== "ok") continue;
      const versions = (item.output as { versions?: VersionInfo[] } | undefined)?.versions ?? [];
      chips.push(...versions.map(versionChip));
    }
  }
  return chips;
}

/** Why a step's dataflow call failed, when it did: the call was rejected, or
 * one of its actions failed. Undefined when everything it ran succeeded. */
export function dataflowFailure(step: Pick<ReActStep, "toolCalls" | "toolResults">): string | undefined {
  for (const call of step.toolCalls ?? []) {
    if (call?.toolName !== "dataflow") continue;
    const result = step.toolResults?.find(item => item.toolCallId === call.toolCallId)?.output;
    if (!isDataflowResult(result) || result.mergedInto) continue;
    if (!result.actions.length && result.error) return result.error;
    const failed = result.actions.find(item => item.status === "error");
    if (failed) return failedActionText(failed);
  }
  return undefined;
}

function failedActionText(item: DataflowItem): string {
  const ids =
    item.action.operator_ids ??
    (item.action.operator_id ? [item.action.operator_id] : undefined) ??
    item.action.names ??
    [];
  const verb =
    item.action.type === "execute"
      ? "run"
      : item.action.type === "retrieve"
        ? "show"
        : item.action.type === "edit"
          ? "edit"
          : "inspect";
  const output = item.output as { results?: Array<{ status?: string; error?: string }>; error?: string } | string;
  const reason =
    typeof output === "object" && output
      ? output.error ?? output.results?.find(entry => entry.status === "error")?.error ?? text(output)
      : text(output);
  return `${verb}${ids.length ? ` ${ids.join(", ")}` : ""} failed: ${reason}`;
}

/**
 * The version tree: the versions only, each under its nearest version
 * ancestor (a snapshot that is no version, as a restore's, folds into the
 * version it shows). A service that reports no versions keeps every snapshot.
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

/** A version node's pill text ("v3 add kept", "v5 run kept") and tooltip ("v3: add kept (filter)"). */
export function versionLabel(node: SnapshotTreeNode): { label: string; title: string } {
  if (node.version === undefined || !node.action) return { label: node.id, title: node.id };
  const title = versionTitle(node.version, node.action);
  return { label: `v${node.version} ${actionLabel(node.action)}`, title: node.failed ? `${title} · failed` : title };
}

/** A node of the history tree: a version, or a message the user sent. */
export interface HistoryNode extends SnapshotTreeNode {
  /** Set on a user's message: the step that holds it and its text. */
  message?: { stepId: string; text: string };
}

type HistoryStep = Pick<
  ReActStep,
  "id" | "parentId" | "role" | "isBegin" | "messageSource" | "userAction" | "content"
> & {
  timestamp: Date | string | number;
};

/** A message the user wrote, in the chat or an operator's panel: not a canvas action or the service's note. */
export function isUserMessage(step: Pick<ReActStep, "role" | "isBegin" | "messageSource" | "userAction">): boolean {
  return (
    step.role === "user" &&
    step.isBegin &&
    !step.userAction &&
    step.messageSource !== "action" &&
    step.messageSource !== "correction"
  );
}

/** The history tree's id for the node of the message `stepId` holds. */
export const messageNodeId = (stepId: string): string => `message:${stepId}`;

/** Each step's own snapshot (its newest version, or a restore's), by step id. */
function ownedSnapshots(nodes: readonly SnapshotTreeNode[]): Map<string, string> {
  const owned = new Map<string, string>();
  for (const node of nodes) if (node.reactStepId && node.owned !== false) owned.set(node.reactStepId, node.id);
  return owned;
}

/**
 * The history tree: the versions (`versionNodes`) and the user's messages, so
 * it reads as the session went: a version, what the user asked, the versions
 * that answered it. A message hangs under the version it was sent at, or under
 * the message before it when nothing changed in between; the first version its
 * turn made hangs under it.
 */
export function historyNodes(nodes: readonly SnapshotTreeNode[], steps: readonly HistoryStep[]): HistoryNode[] {
  const versions: HistoryNode[] = versionNodes(nodes);
  const messages = steps.filter(isUserMessage);
  if (!messages.length) return versions;
  const stepById = new Map(steps.map(step => [step.id, step]));
  const owned = ownedSnapshots(nodes);
  // What a step's children follow: the nearest message, or the version shown, at or above it.
  const anchor = (stepId: string | undefined): string | undefined => {
    for (let cursor = stepId; cursor; cursor = stepById.get(cursor)?.parentId) {
      const step = stepById.get(cursor);
      if (step && isUserMessage(step)) return messageNodeId(step.id);
      const snapshot = owned.get(cursor);
      if (snapshot) return shownVersion(nodes, snapshot);
    }
    return undefined;
  };
  const stepOf = new Map(nodes.map(node => [node.id, node.reactStepId]));
  return [
    ...versions.map(version => {
      // A step's first version: the message its turn answers, when one came after the version before it.
      const step = version.reactStepId ? stepById.get(version.reactStepId) : undefined;
      const raw = nodes.find(node => node.id === version.id)?.parentId;
      if (!step || (raw !== undefined && stepOf.get(raw) === step.id)) return version;
      const parent = anchor(step.parentId);
      return parent?.startsWith("message:") ? { ...version, parentId: parent } : version;
    }),
    ...messages.map(
      (step): HistoryNode => ({
        id: messageNodeId(step.id),
        parentId: anchor(step.parentId),
        reactStepId: step.id,
        operatorCount: 0,
        resultCount: 0,
        timestamp: new Date(step.timestamp).getTime(),
        message: { stepId: step.id, text: step.content },
      })
    ),
  ];
}

/**
 * The history node HEAD is at: the message HEAD is on, or answers before its
 * turn made a version, else the version HEAD's snapshot shows.
 */
export function headNode(
  nodes: readonly SnapshotTreeNode[],
  steps: readonly HistoryStep[],
  headStepId: string | null | undefined,
  headSnapshotId: string | undefined
): string | undefined {
  const stepById = new Map(steps.map(step => [step.id, step]));
  const owned = ownedSnapshots(nodes);
  for (let cursor = headStepId ?? undefined; cursor; cursor = stepById.get(cursor)?.parentId) {
    const step = stepById.get(cursor);
    if (step && isUserMessage(step)) return messageNodeId(step.id);
    if (owned.has(cursor)) break;
  }
  return shownVersion(nodes, headSnapshotId);
}

/** A message's pill text: its first line, without markdown's backticks. */
export function messageLabel(text: string): string {
  return (text.split("\n").find(line => line.trim()) ?? "").replace(/`/g, "").trim();
}
