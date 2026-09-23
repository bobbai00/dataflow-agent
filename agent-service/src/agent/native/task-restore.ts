/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * `restore`: rebuild a table as it was defined at the end of a completed task.
 *
 * LongDS's Rollback turns answer "under an earlier anchored version of the
 * analysis"; in a dataflow that version is the operator's sealed definition,
 * so restoring it is ordinary statements: the sealed statement under the new
 * id, with each input re-pointed at either the live table (unchanged since that
 * task) or a copy of its own sealed definition (`<name>_t<task>`). The copies
 * are written by the same compiler and executed by the same engine as the
 * model's edits, and the result is then compared with the retained output.
 */
import { NATIVE_ID_RE } from "./catalog";
import { parseNativeProgram } from "./program";
import type { TaskHistory, TaskOutput } from "./task-history";
import { TASK_SOURCE_PREFIX } from "./task-reference";
import type { OperatorInfo } from "../../types/execution";
import type { WorkflowState } from "../workflow-state";

export interface RestoreRequest {
  operator: string;
  task: number;
  as: string;
}

export interface RestorePlan {
  request: RestoreRequest;
  /** Statements and `def`s to compile with the call's edits. */
  program: string;
  /** Ids this restore defines, the target first, then copied ancestors. */
  created: string[];
  /** Live tables reused because their definition is unchanged since the task. */
  shared: string[];
}

export interface RestoreRefusal {
  request: RestoreRequest;
  message: string;
}

export function describeRestoreRequest(request: RestoreRequest): string {
  return `restore ${request.operator} as saved at task ${request.task} as \`${request.as}\``;
}

type NameSpan = { name: string; span: [number, number, number, number] };

/** Replace identifier arguments by their parsed spans, last to first, so
 * earlier offsets stay valid. Spans are relative to the statement text. */
function rewrite(source: string, mapping: Map<string, string>, names: NameSpan[]): string {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  const at = (line: number, col: number) => (starts[line - 1] ?? 0) + col;
  let text = source;
  for (const { name, span } of [...names].sort((a, b) => at(b.span[0], b.span[1]) - at(a.span[0], a.span[1]))) {
    const target = mapping.get(name);
    if (target === undefined) continue;
    text = text.slice(0, at(span[0], span[1])) + target + text.slice(at(span[2], span[3]));
  }
  return text;
}

function renameTarget(statement: string, as: string): string {
  return statement.replace(/^(\s*)[A-Za-z_]\w*(\s*=)/, `$1${as}$2`);
}

/** Plan every restore of a call. Refusals never touch the graph; a plan only
 * becomes operators when its statements land like any other edit. */
export async function planRestores(
  requests: RestoreRequest[],
  history: TaskHistory,
  state: WorkflowState
): Promise<{ plans: RestorePlan[]; refusals: RestoreRefusal[] }> {
  const plans: RestorePlan[] = [];
  const refusals: RestoreRefusal[] = [];
  const claimed = new Set<string>();
  for (const request of requests) {
    const refuse = (message: string) => refusals.push({ request, message });
    if (!NATIVE_ID_RE.test(request.as) || request.as.startsWith(TASK_SOURCE_PREFIX)) {
      refuse(`\`${request.as}\` is not a valid new id.`);
      continue;
    }
    if (!Number.isSafeInteger(request.task) || request.task < 1) {
      refuse(`task must be a completed task number, got ${JSON.stringify(request.task)}.`);
      continue;
    }
    const target = history.definition(request.operator, request.task);
    if (!target) {
      const saved = history.available(request.operator);
      refuse(
        saved.length
          ? `\`${request.operator}\` has no saved version at task ${request.task}; saved at task ${saved.join(", ")}.`
          : `\`${request.operator}\` has no saved version; nothing was retained under that name.`
      );
      continue;
    }
    const revert = request.as === request.operator;
    if (!revert && (state.getOperator(request.as) || claimed.has(request.as))) {
      refuse(`\`${request.as}\` already exists; choose a new id, or reassign it in edits.`);
      continue;
    }
    const created: string[] = [];
    const shared: string[] = [];
    const lines: string[] = [];
    const visiting = new Set<string>();
    let failure: string | undefined;
    // Rebuild `id` as sealed at the task under `as`; returns the id to read.
    const build = async (id: string, as: string, sealed: TaskOutput): Promise<string> => {
      if (visiting.has(id)) throw new Error(`\`${id}\` depends on itself in the saved definitions.`);
      visiting.add(id);
      const view = sealed.operator.nativeOp;
      if (!view?.source) throw new Error(`\`${id}\` at task ${request.task} has no statement to rebuild.`);
      const mapping = new Map<string, string>();
      for (const input of view.inputs) {
        if (input.startsWith(TASK_SOURCE_PREFIX)) continue; // an `at(...)` read: the text re-resolves itself
        const sealedInput = history.definition(input, request.task);
        const liveRevision = state.getOperator(input)?.nativeOp?.revision;
        if (sealedInput && liveRevision === sealedInput.operator.nativeOp?.revision) {
          shared.push(input);
          continue;
        }
        if (!sealedInput) {
          if (liveRevision) {
            shared.push(input);
            continue;
          }
          throw new Error(
            `\`${id}\` read \`${input}\`, which has no saved version at task ${request.task} and no current table.`
          );
        }
        const copy = `${input}_t${request.task}`;
        const existing = state.getOperator(copy)?.nativeOp?.revision;
        if (existing && existing === sealedInput.operator.nativeOp?.revision) shared.push(copy);
        else if (!created.includes(copy)) mapping.set(input, await build(input, copy, sealedInput));
        else mapping.set(input, copy);
        if (!mapping.has(input)) mapping.set(input, copy);
      }
      for (const fn of Object.keys(view.functions ?? {})) mapping.set(fn, `${fn}_t${request.task}`);
      const parsed = await parseNativeProgram(view.source);
      const statement = parsed.statements[0];
      if (!statement || parsed.errors.length) throw new Error(`\`${id}\`'s saved statement no longer parses.`);
      for (const [fn, body] of Object.entries(view.functions ?? {}))
        lines.push(body.replace(new RegExp(`^(\\s*)def\\s+${fn}\\s*\\(`), `$1def ${fn}_t${request.task}(`));
      lines.push(renameTarget(rewrite(view.source, mapping, statement.names ?? []), as));
      created.push(as);
      visiting.delete(id);
      return as;
    };
    try {
      await build(request.operator, request.as, target);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (failure) {
      refuse(failure);
      continue;
    }
    claimed.add(request.as);
    plans.push({
      request,
      program: lines.join("\n"),
      created: [request.as, ...created.filter(id => id !== request.as)],
      shared: [...new Set(shared)],
    });
  }
  return { plans, refusals };
}

/** After execution: does the rebuilt table match the retained one? Row count
 * and columns come from the same engine results the observation shows. */
export function verifyRestore(info: OperatorInfo | undefined, sealed: TaskOutput, request: RestoreRequest): string {
  const head = `restored from task ${request.task}`;
  if (!info || info.error)
    return `${head}: not executed successfully, so it could not be compared with the saved table`;
  const rows = info.totalRowCount;
  const saved = sealed.info.totalRowCount ?? sealed.artifact.rowCount;
  const columns = (info.resultSchema ?? []).map(f => f.name).join(",");
  const savedColumns = (sealed.info.resultSchema ?? []).map(f => f.name).join(",");
  if (rows === saved && (!savedColumns || columns === savedColumns))
    return `${head}: verified, ${rows} rows and the same columns as the saved table`;
  const parts: string[] = [];
  if (rows !== saved) parts.push(`rows ${rows} vs ${saved} saved`);
  if (savedColumns && columns !== savedColumns) parts.push("columns differ from the saved table");
  return `${head}: differs (${parts.join("; ")}); an input's data or a shared upstream table has changed since then`;
}
