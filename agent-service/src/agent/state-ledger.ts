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
 * System-verified reuse of earlier state (`stateLedger`).
 *
 * The graph knows three things about every table that a transcript does not
 * carry: its shape, its definition in force, and what it was derived from. This
 * module turns them into text at the three moments they matter:
 *
 *   - the ledger, written once into the Answer receipt when a task seals: one
 *     line per table the task created, changed or deleted;
 *   - the provenance card, written into an edit receipt for every input that
 *     predates the current task (an earlier task's table or loaded state);
 *   - execution notes, written under an executed operator when one of its
 *     inputs is empty, is a limited (top-k) table, or is a filtered subset of a
 *     table that also exists unfiltered and the join dropped rows.
 *
 * Everything here is derived from snapshots and results; nothing is written by
 * a model, and a line, once written into a receipt, is never rewritten.
 */
import type { OperatorInfo } from "../types/execution";
import type { OperatorPredicate, WorkflowContent } from "../types/workflow";
import type { WorkflowSnapshotStorage } from "./workflow-snapshot-storage";
import { nativeOperatorName, type NativeOpView } from "./native/catalog";
import { readForkResult, type HistoricalTask } from "./state-history";
import type { GraphEditPlan } from "./tools/graph-edits";
import {
  countOf,
  describeOperator,
  operatorBlock,
  topologicalOperators,
  observationFormat,
  restrictRecords,
  type ObservationFormatOptions,
} from "./native/observation-format";

export interface LedgerContext {
  storage: WorkflowSnapshotStorage;
  /** HEAD when the current request arrived: the state the task started from. */
  baseStepId?: string;
  historicalTasks: readonly HistoricalTask[];
  /** Tasks completed before this conversation (loaded state); numbering continues after them. */
  taskNumberOffset?: number;
  /** HEAD when the first request arrived: the loaded state, if any. */
  loadedStepId?: string;
  settings?: ObservationFormatOptions;
  currentStepId?: string;
  taskChanges?: ReadonlyMap<string, string>;
}

type ResultLookup = (id: string) => OperatorInfo | undefined;

const completed = (info: OperatorInfo | undefined) =>
  !!info && !info.error && ["Completed", "CompletedFromCache"].includes(info.state);

export function shapeOf(info: OperatorInfo | undefined): string {
  if (!completed(info)) return "not executed";
  const rows = info!.totalRowCount ?? info!.outputTuples;
  const cols = info!.resultSchema?.length ?? info!.tableProfile?.columnCount ?? undefined;
  return `${rows.toLocaleString("en-US")}×${cols ?? "?"}`;
}

export function rowsOf(info: OperatorInfo | undefined): number | undefined {
  return completed(info) ? (info!.totalRowCount ?? info!.outputTuples) : undefined;
}

const collapse = (text: string | undefined, max: number) => {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** A scan's definition is its file: keep the basename, drop the directory. */
const definitionText = (view: NativeOpView | undefined) => {
  if (view?.type === "Scan") {
    const files = (view.properties as { files?: unknown }).files;
    const names = (Array.isArray(files) ? files : [files])
      .filter((f): f is string => typeof f === "string")
      .map(f => f.split("/").pop());
    if (names.length) return `scan(${names.join(", ")})`;
  }
  return view?.source;
};

/** `a:int, b:str, …` from a completed result's schema, within `chars`; the
 * rest is counted. Empty when the result carries no schema. */
export function schemaText(info: OperatorInfo | undefined, chars = 120): string {
  const schema = completed(info) ? (info!.resultSchema ?? []) : [];
  if (!schema.length) return "";
  const parts: string[] = [];
  let length = 0;
  for (const column of schema) {
    const part = `${column.name}:${column.type}`;
    const next = length + part.length + (parts.length ? 2 : 0);
    if (next > chars && parts.length) break;
    parts.push(part);
    length = next;
  }
  const more = schema.length - parts.length;
  return parts.join(", ") + (more > 0 ? `, +${more} more` : "");
}

/** `name  rows×cols  kind ← inputs · definition · columns: …`. */
export function operatorLine(
  op: OperatorPredicate,
  info: OperatorInfo | undefined,
  options: { width?: number; marker?: string; definitionChars?: number; schemaChars?: number } = {}
): string {
  const view = op.nativeOp;
  const kind = view ? nativeOperatorName(view.type) : op.operatorType;
  const inputs = (view?.inputs ?? []).filter(Boolean);
  const rows = rowsOf(info);
  const tags: string[] = [];
  if (view?.type === "Limit") tags.push("limited table");
  if (view?.type === "Aggregate" && rows === 1) tags.push("1-row constant");
  if (rows === 0) tags.push("EMPTY");
  const id = options.width ? op.operatorID.padEnd(options.width) : op.operatorID;
  const marker = options.marker ? ` ${options.marker}` : "";
  const columns = options.schemaChars === 0 ? "" : schemaText(info, options.schemaChars ?? 120);
  return [
    `  ${id}  ${shapeOf(info)}  ${kind}${marker}`,
    inputs.length ? ` ← ${inputs.join(", ")}` : "",
    ` · ${collapse(definitionText(view), options.definitionChars ?? 110)}`,
    columns ? ` · columns: ${columns}` : "",
    tags.length ? `  [${tags.join("; ")}]` : "",
  ].join("");
}

/** The definition of an operator in the loaded state, if it was loaded. */
export function loadedRevision(ctx: LedgerContext, operatorId: string): string | undefined {
  if (!ctx.loadedStepId || !ctx.storage.hasSnapshotFor(ctx.loadedStepId)) return undefined;
  return ctx.storage.getWorkflow(ctx.loadedStepId).operators.find(o => o.operatorID === operatorId)?.nativeOp
    ?.revision;
}

/** The most recent task that changed this definition to the current revision;
 * undefined when the revision is still the loaded one or is not sealed yet. */
export function originTask(
  ctx: LedgerContext,
  operatorId: string,
  revision: string | undefined
): HistoricalTask | undefined {
  let origin: HistoricalTask | undefined;
  let previous = loadedRevision(ctx, operatorId);
  for (const task of ctx.historicalTasks) {
    const op = ctx.storage.getWorkflow(task.stepId).operators.find(o => o.operatorID === operatorId);
    const current = op?.nativeOp?.revision;
    if (op && current === revision && current !== previous) origin = task;
    previous = current;
  }
  return origin;
}

function baseWorkflow(ctx: LedgerContext): WorkflowContent | undefined {
  if (!ctx.baseStepId || !ctx.storage.hasSnapshotFor(ctx.baseStepId)) return undefined;
  return ctx.storage.getWorkflow(ctx.baseStepId);
}

/**
 * The ledger of one sealed task: tables it created, changed or deleted, with
 * their final shapes. Returned as text for the Answer receipt.
 */
export function taskLedger(
  ctx: LedgerContext,
  current: WorkflowContent,
  currentResult: ResultLookup,
  taskNumber: number
): string {
  const config = observationFormat(ctx.settings);
  const base = baseWorkflow(ctx);
  const before = new Map((base?.operators ?? []).map(op => [op.operatorID, op]));
  const changes = new Map<string, string>();
  for (const op of current.operators) {
    const old = before.get(op.operatorID);
    const oldInfo = ctx.baseStepId ? ctx.storage.getOperatorResult(ctx.baseStepId, op.operatorID) : undefined;
    const info = currentResult(op.operatorID);
    if (!old) changes.set(op.operatorID, "created");
    else if (old.nativeOp?.revision !== op.nativeOp?.revision || old.nativeOp?.source !== op.nativeOp?.source)
      changes.set(op.operatorID, "updated");
    else if (JSON.stringify(old.nativeOp?.inputs) !== JSON.stringify(op.nativeOp?.inputs))
      changes.set(op.operatorID, "reconnected");
    else if (!info && oldInfo) changes.set(op.operatorID, "stale");
    else if (
      (info?.resultVersion?.id ?? null) !== (oldInfo?.resultVersion?.id ?? null) ||
      (!info?.resultVersion && JSON.stringify(info) !== JSON.stringify(oldInfo))
    )
      changes.set(op.operatorID, "recomputed");
  }
  const deleted = [...before.values()].filter(op => !current.operators.some(item => item.operatorID === op.operatorID));
  const label = (id: string) => {
    const recorded = ctx.taskChanges?.get(id);
    return recorded?.startsWith("restored from") || recorded?.startsWith("forked from") ? recorded : changes.get(id)!;
  };
  const tally = new Map<string, number>();
  for (const id of changes.keys()) {
    const word = label(id).replace(/ from task \d+$/, "");
    tally.set(word, (tally.get(word) ?? 0) + 1);
  }
  if (deleted.length) tally.set("deleted", deleted.length);
  const lines = [`#### Task ${taskNumber}`];
  if (!changes.size && !deleted.length) return [...lines, "No tables created, changed or deleted."].join("\n");
  lines.push(
    `${[...tally].map(([word, n], i) => (i ? `${n} ${word}` : `${countOf(n, "table")} ${word}`)).join("; ")}.`
  );
  for (const op of topologicalOperators(current.operators).filter(op => changes.has(op.operatorID))) {
    // A fork of an earlier task's version shows that task's saved result until it runs.
    const saved = currentResult(op.operatorID)
      ? undefined
      : readForkResult(current, ctx.storage, op.operatorID, ctx.currentStepId);
    const info = currentResult(op.operatorID) ?? saved?.info;
    const tags = [
      op.nativeOp?.type === "Limit" ? "limited table" : "",
      rowsOf(info) === 0 ? "empty table" : "",
      op.nativeOp?.type === "Aggregate" && rowsOf(info) === 1 ? "one-row constant" : "",
    ].filter(Boolean);
    const state = label(op.operatorID);
    lines.push(
      operatorBlock(
        describeOperator(op, info, {
          ...config,
          state,
          definitionLimit: true,
          stale:
            !!before.get(op.operatorID) &&
            !info &&
            !!(ctx.baseStepId && ctx.storage.getOperatorResult(ctx.baseStepId, op.operatorID)),
          issues: tags.map(tag => `- note: ${tag}.`),
          ...(saved ? { savedBy: saved.taskId } : {}),
        })
      )
    );
    if (config.catalogRecords > 0 && ctx.currentStepId) {
      let snapshot = ctx.storage.getAssociatedSnapshot(ctx.currentStepId);
      const baseId = ctx.baseStepId ? ctx.storage.getAssociatedSnapshot(ctx.baseStepId).id : undefined;
      while (snapshot && snapshot.id !== baseId) {
        const observation = snapshot.nativeObservations?.[op.operatorID];
        if (observation?.records && observation.resultVersion === (info?.resultVersion?.id ?? null)) {
          // The block above already lists the columns; keep only the
          // caption and the rows, indented under the block.
          lines.push(
            ...restrictRecords(observation.records, {
              maxChars: observation.options.maxChars,
              maxRows: config.catalogRecords,
            })
              .text.split("\n")
              .filter(line => !line.startsWith("columns: "))
              .map(line => `  ${line}`)
          );
          break;
        }
        if (!snapshot.parentId) break;
        const parent = ctx.storage.getSnapshotById(snapshot.parentId);
        if (!parent) break;
        snapshot = parent;
      }
    }
  }
  for (const op of deleted)
    lines.push(
      operatorBlock({
        id: op.operatorID,
        kind: op.nativeOp ? nativeOperatorName(op.nativeOp.type) : op.operatorType,
        state: "deleted",
      })
    );
  return lines.join("\n");
}

/**
 * Provenance cards for an edit: every input of a created or updated operator
 * that already existed when the task started, with where it came from.
 */
export function provenanceLines(ctx: LedgerContext, plan: GraphEditPlan, currentResult: ResultLookup): string[] {
  const base = baseWorkflow(ctx);
  if (!base) return [];
  const baseOps = new Set(base.operators.map(op => op.operatorID));
  const touched = new Set(plan.operators.filter(o => o.status === "added" || o.status === "modified").map(o => o.id));
  const used = new Map<string, Set<string>>();
  for (const op of plan.workflow.operators) {
    if (!touched.has(op.operatorID)) continue;
    for (const input of op.nativeOp?.inputs ?? []) {
      if (!input || !baseOps.has(input) || touched.has(input)) continue;
      if (!used.has(input)) used.set(input, new Set());
      used.get(input)!.add(op.operatorID);
    }
  }
  if (!used.size) return [];
  const lines = ["inputs from earlier tasks:"];
  for (const op of topologicalOperators(plan.workflow.operators).filter(op => used.has(op.operatorID))) {
    const info = currentResult(op.operatorID);
    const origin = originTask(ctx, op.operatorID, op.nativeOp?.revision);
    lines.push(
      operatorBlock(
        describeOperator(op, info, {
          ...ctx.settings,
          origin: origin ? `task ${origin.taskId}` : "loaded",
          definitionLimit: true,
          usedBy: [...used.get(op.operatorID)!],
        })
      )
    );
  }
  return lines;
}

/** Consumers for which a limited (top-k) input changes the computation; a
 * projection, sort or display of a top-k is report shaping and gets no note. */
const LIMITED_CONSUMERS = new Set(["Join", "Filter", "Aggregate", "Map", "Process"]);
/** Operators whose output rows are a subset of their (left) input's rows. */
const isSubsetOp = (view: NativeOpView | undefined): boolean =>
  !!view &&
  (["Filter", "Limit", "Distinct"].includes(view.type) ||
    (view.type === "Join" && ["semi", "anti"].includes(String(view.properties.type ?? "inner"))));
/** Operators that reduce or rank a table: the ones for which a smaller current
 * pool of the same table is the thing to check. */
const POOL_READERS = new Set(["Aggregate", "Window"]);
const MAX_POOLS = 4;

/** The string literals of every `[...]` list of two or more quoted strings in
 * a function's source, as sets. */
export function literalLists(source: string | undefined): string[][] {
  if (!source) return [];
  const lists: string[][] = [];
  const list =
    /\[\s*(?:(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*,\s*)+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*,?\s*\]/g;
  for (const match of source.match(list) ?? []) {
    const items = [...match.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)].map(m =>
      (m[1] ?? m[2]).replace(/\\(.)/g, "$1")
    );
    if (new Set(items).size >= 2) lists.push([...new Set(items)]);
  }
  return lists;
}

/**
 * Notes for executed operators whose inputs deserve a second look: an empty
 * input; a limited (top-k) table consumed by a join, filter, aggregate, map
 * or process; a join side that is a filtered subset of a table that also
 * exists unfiltered; an aggregate or ranking that reads a table of which
 * smaller tables are derived in state (a current pool); a filter or map whose
 * literal list equals a column of a table in state.
 */
export function executionNotes(
  workflow: WorkflowContent,
  result: ResultLookup,
  executed: readonly string[]
): Map<string, string[]> {
  const byId = new Map(workflow.operators.map(op => [op.operatorID, op]));
  const notes = new Map<string, string[]>();
  const add = (id: string, line: string) => notes.set(id, [...(notes.get(id) ?? []), line]);
  const subsetOf = (id: string): { parent: string; kind: string } | undefined => {
    const view = byId.get(id)?.nativeOp;
    if (!view || !["Filter", "Limit"].includes(view.type)) return undefined;
    const parent = view.inputs.find(Boolean);
    return parent ? { parent, kind: nativeOperatorName(view.type) } : undefined;
  };
  const consumersOf = (id: string) =>
    workflow.operators.filter(op => (op.nativeOp?.inputs ?? []).includes(id)).map(op => op.operatorID);
  /** Tables derived from `source` through row-subset operators only (a semi
   * or anti join counts for its left side). */
  const subsetsOf = (source: string): string[] => {
    const found: string[] = [];
    const pending = [source];
    const seen = new Set<string>([source]);
    while (pending.length) {
      const current = pending.shift()!;
      for (const next of consumersOf(current)) {
        const view = byId.get(next)?.nativeOp;
        if (seen.has(next) || !isSubsetOp(view) || view!.inputs[0] !== current) continue;
        seen.add(next);
        found.push(next);
        pending.push(next);
      }
    }
    return found;
  };
  const ancestorsOf = (id: string): Set<string> => {
    const seen = new Set<string>();
    const pending = [...(byId.get(id)?.nativeOp?.inputs ?? [])].filter(Boolean);
    while (pending.length) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      pending.push(...(byId.get(current)?.nativeOp?.inputs ?? []).filter(Boolean));
    }
    return seen;
  };
  /** Small tables held in full, with the values of each text column that is
   * a key of the table (one row per value, no nulls): the tables that are a
   * membership list of something. */
  const heldColumns = (id: string): Map<string, Set<string>> | undefined => {
    const info = result(id);
    const rows = (info?.result ?? []) as Array<Record<string, unknown>>;
    if (!completed(info) || !rows.length || rows.length !== rowsOf(info) || rows.length > 1000) return undefined;
    const columns = new Map<string, Set<string>>();
    for (const name of Object.keys(rows[0] ?? {})) {
      if (name.startsWith("__")) continue;
      const values = rows.map(row => row[name]);
      if (!values.every(v => typeof v === "string")) continue;
      const distinct = new Set(values as string[]);
      if (distinct.size === rows.length) columns.set(name, distinct);
    }
    return columns;
  };
  for (const id of executed) {
    const op = byId.get(id);
    const view = op?.nativeOp;
    if (!view || !completed(result(id))) continue;
    const inputs = view.inputs.filter(Boolean);
    const ports = view.type === "Join" ? ["left", "right"] : inputs.map((_, i) => `in[${i}]`);
    inputs.forEach((input, i) => {
      const rows = rowsOf(result(input));
      if (rows === 0) add(id, `note: input ${input} (${ports[i]}) has 0 rows.`);
      if (byId.get(input)?.nativeOp?.type === "Limit" && LIMITED_CONSUMERS.has(view.type)) {
        const parent = byId.get(input)!.nativeOp!.inputs.find(Boolean);
        const parentRows = parent ? rowsOf(result(parent)) : undefined;
        add(
          id,
          `note: input ${input} (${ports[i]}) is a limited table (${rows ?? "?"} rows)${parent ? `; its unlimited parent is ${parent} (${parentRows ?? "?"} rows)` : ""}.`
        );
      }
    });
    if (POOL_READERS.has(view.type) && inputs.length === 1) {
      const source = inputs[0];
      const sourceRows = rowsOf(result(source));
      const pools = subsetsOf(source)
        .filter(pool => pool !== id)
        .map(pool => ({ pool, rows: rowsOf(result(pool)) }))
        .filter(({ rows }) => sourceRows !== undefined && rows !== undefined && rows < sourceRows);
      if (pools.length)
        add(
          id,
          `note: ${id} reads ${source} (${sourceRows} rows); smaller tables derived from it in state: ${pools
            .slice(0, MAX_POOLS)
            .map(({ pool, rows }) => `${pool} (${rows} rows)`)
            .join(", ")}${pools.length > MAX_POOLS ? ` and ${pools.length - MAX_POOLS} more` : ""}.`
        );
    }
    if (view.type === "Filter" || view.type === "Map") {
      const lists = literalLists(String(view.properties.func ?? ""));
      if (lists.length) {
        const excluded = ancestorsOf(id);
        excluded.add(id);
        for (const literals of lists) {
          const wanted = new Set(literals);
          const matches: string[] = [];
          for (const other of workflow.operators) {
            if (excluded.has(other.operatorID)) continue;
            const columns = heldColumns(other.operatorID);
            if (!columns) continue;
            for (const [column, values] of columns)
              if (values.size === wanted.size && [...wanted].every(v => values.has(v))) {
                matches.push(`${other.operatorID}.${column}`);
                break;
              }
            if (matches.length === 2) break;
          }
          if (matches.length)
            add(
              id,
              `note: the ${wanted.size} literals in ${id} equal ${matches.join(" and ")}; join(how="semi") on that table keeps the dependency explicit.`
            );
        }
      }
    }
    if (view.type === "Join" && inputs.length === 2) {
      const [left, right] = inputs;
      const l = rowsOf(result(left)),
        r = rowsOf(result(right)),
        out = rowsOf(result(id));
      const how = String(view.properties.type ?? "inner");
      for (const [side, input] of [
        ["left", left],
        ["right", right],
      ] as const) {
        const subset = subsetOf(input);
        if (!subset || byId.get(input)?.nativeOp?.type === "Limit") continue;
        const parentRows = rowsOf(result(subset.parent));
        const own = rowsOf(result(input));
        if (parentRows !== undefined && own !== undefined && own < parentRows)
          add(
            id,
            `note: ${side} input ${input} is a ${subset.kind} of ${subset.parent} (${own} of ${parentRows} rows).`
          );
      }
      if (l !== undefined && r !== undefined && out !== undefined) {
        if (how === "semi" || how === "anti")
          add(
            id,
            `note: ${how} join kept ${out} of ${l} left rows, those with ${how === "semi" ? "a" : "no"} match among ${r} right rows.`
          );
        else {
          const dropped = how === "inner" && out < l ? ` ${l - out} left rows found no match.` : "";
          add(id, `note: ${how} join of ${l} left and ${r} right rows produced ${out} rows.${dropped}`);
        }
      }
    }
  }
  return notes;
}

/* ---------------------------------------------------------------------------
 * Saved versions in an edit:
 *   `update operator <id> from task <N>`            restore that definition in place
 *   `fork operator <id> from task <N> as <new_id>`  copy it with its task-N inputs
 * ------------------------------------------------------------------------- */

export interface VersionCommand {
  line: number;
  id: string;
  task: number;
  /** Set for a fork: the copy's identifier. */
  as?: string;
}

const RESTORE_RE = /^update operator ([A-Za-z_]\w*) from task (\d+)\s*$/;
const FORK_RE = /^fork operator ([A-Za-z_]\w*) from task (\d+) as ([A-Za-z_]\w*)\s*$/;

/** Split the saved-version commands out of an edit program; the rest is the parser's. */
export function splitVersionCommands(changes: string): { rest: string; versions: VersionCommand[] } {
  const rest: string[] = [];
  const versions: VersionCommand[] = [];
  changes.split("\n").forEach((line, index) => {
    const restore = line.match(RESTORE_RE);
    const fork = line.match(FORK_RE);
    if (restore) versions.push({ line: index + 1, id: restore[1], task: Number(restore[2]) });
    else if (fork) versions.push({ line: index + 1, id: fork[1], task: Number(fork[2]), as: fork[3] });
    else rest.push(line);
  });
  return { rest: rest.join("\n"), versions };
}

/** The sealed definition of an operator as edit commands that restore it in
 * place (`update operator`) or re-create it with its sealed incoming edges. */
export function restoreCommands(
  storage: WorkflowSnapshotStorage,
  task: HistoricalTask,
  current: WorkflowContent,
  operatorId: string
): { commands: string; restoredInputs: string[]; existed: boolean } {
  const sealed = storage.getWorkflow(task.stepId);
  const op = sealed.operators.find(o => o.operatorID === operatorId);
  if (!op?.nativeOp?.source)
    throw new Error(`Operator ${operatorId} did not exist at task ${task.taskId}; nothing to restore.`);
  const view = op.nativeOp;
  const functions = Object.values(view.functions ?? {}).map(source =>
    source
      .split("\n")
      .map(line => (line.length ? `    ${line}` : line))
      .join("\n")
  );
  const existed = current.operators.some(o => o.operatorID === operatorId);
  const lines = [`${existed ? "update" : "create"} operator ${operatorId}: ${view.source}`, ...functions];
  const restoredInputs: string[] = [];
  if (!existed) {
    const ports = view.graph?.inputPorts ?? [];
    view.inputs.forEach((input, i) => {
      if (!input || !current.operators.some(o => o.operatorID === input)) return;
      const port = ports[i] ?? (view.inputs.length === 1 ? "in" : `in[${i}]`);
      lines.push(`create edge ${input}.out -> ${operatorId}.${port}`);
      restoredInputs.push(input);
    });
  }
  return { commands: lines.join("\n"), restoredInputs, existed };
}

/** Upstream operators whose current revision differs from the sealed task's. */
export function upstreamDrift(
  storage: WorkflowSnapshotStorage,
  task: HistoricalTask,
  current: WorkflowContent,
  operatorId: string
): string[] {
  const sealed = new Map(storage.getWorkflow(task.stepId).operators.map(o => [o.operatorID, o]));
  const byId = new Map(current.operators.map(o => [o.operatorID, o]));
  const drifted: string[] = [];
  const seen = new Set<string>();
  const pending = [...(byId.get(operatorId)?.nativeOp?.inputs ?? [])].filter(Boolean);
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const now = byId.get(id);
    const then = sealed.get(id);
    if (!then || then.nativeOp?.revision !== now?.nativeOp?.revision) drifted.push(id);
    pending.push(...(now?.nativeOp?.inputs ?? []).filter(Boolean));
  }
  return drifted;
}
