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

/** Analysis maintenance is compiled into ordinary native edits. The workflow
 * owns every definition: checkout/export/clear therefore cannot leave a second
 * mutable function registry behind. No dataset-specific semantics live here. */
import { NATIVE_ID_RE, type NativeOpView, type ParsedFunction, type ParsedStatement } from "./catalog";
import { normalizeStatement, parseNativeProgram, type ProgramResult, type ProgramStatement } from "./program";
import type { WorkflowState } from "../workflow-state";
import type { TaskHistory } from "./task-history";
import { TASK_SOURCE_PREFIX } from "./task-reference";

export interface AnalysisFork {
  operator: string;
  as: string;
  /** Exact upstream table names to replace with current table names. */
  bindings: Record<string, string>;
  /** Optional historical definition; unreplaced boundaries use retained values. */
  task?: number;
}

type Options = {
  profileCollection?: boolean;
  sharedFunctions?: boolean;
  registeredOperators?: boolean;
  /** Defs held outside the graph (made by `lift`, not yet called), by name: a call resolves them like shared functions. */
  libraryFunctions?: Record<string, string>;
};

const definitionCache = new Map<string, ReturnType<typeof parseNativeProgram>>();
export function parseDefinitions(source: string) {
  let parsed = definitionCache.get(source);
  if (!parsed) {
    parsed = parseNativeProgram(source);
    definitionCache.set(source, parsed);
    if (definitionCache.size > 512) definitionCache.delete(definitionCache.keys().next().value!);
  }
  return parsed;
}

/** Flat function bodies are used by new analysis operators. For imported older
 * workflows, a body may include helper defs: parse it once as well. */
export async function workflowFunctions(state: WorkflowState): Promise<{
  functions: Record<string, ParsedFunction>;
  conflicts: Set<string>;
}> {
  const functions: Record<string, ParsedFunction> = {};
  const conflicts = new Set<string>();
  const sources = new Set<string>();
  for (const op of state.getAllOperators()) {
    if (op.nativeOp?.analysisBranch || op.taskSource) continue;
    for (const source of Object.values(op.nativeOp?.functions ?? {})) sources.add(source);
  }
  // Parser reports duplicate names; compare individual bodies from each source
  // so an imported conflicting definition is never silently selected.
  for (const source of sources) {
    const parsed = await parseDefinitions(source);
    for (const [name, fn] of Object.entries(parsed.functions)) {
      if (functions[name] && functions[name].source !== fn.source) conflicts.add(name);
      else functions[name] = fn;
    }
  }
  return { functions, conflicts };
}

export async function compileAnalysisProgram(
  program: string,
  state: WorkflowState,
  deleted: string[] = [],
  options: Options = {}
): Promise<ProgramResult> {
  const parsed = await parseNativeProgram(program);
  const saved = await workflowFunctions(state);
  const library: Record<string, ParsedFunction> = {};
  for (const source of Object.values(options.libraryFunctions ?? {}))
    for (const [name, fn] of Object.entries((await parseDefinitions(source)).functions)) library[name] = fn;
  const functions = { ...library, ...saved.functions, ...parsed.functions };
  const changed = new Set(
    Object.keys(parsed.functions).filter(
      name => saved.conflicts.has(name) || parsed.functions[name].source !== saved.functions[name]?.source
    )
  );
  const broken = new Set<string>();
  for (const error of parsed.errors) {
    const name = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(error.source ?? "")?.[1];
    if (name) {
      broken.add(name);
      changed.add(name);
    }
  }
  const conflicts = new Set([...saved.conflicts].filter(name => !parsed.functions[name]));
  const statements = [...parsed.statements];
  const explicit = new Set([...statements.map(s => s.id), ...deleted]);
  let line = program.split("\n").length + 1;
  for (const op of state.getAllOperators()) {
    const view = op.nativeOp;
    if (!view?.source || view.analysisBranch || explicit.has(op.operatorID) || op.taskSource) continue;
    // New definitions retain every transitive helper as a separate body.
    // Imported closure bodies are also checked conservatively by name.
    const used = new Set(Object.keys(view.functions ?? {}));
    for (const source of Object.values(view.functions ?? {}))
      for (const name of Object.keys((await parseDefinitions(source)).functions)) used.add(name);
    if (![...changed].some(name => used.has(name))) continue;
    const old = await parseNativeProgram(view.source);
    if (old.statements.length === 1) statements.push({ ...old.statements[0], line: line++ });
  }
  const normalized = statements.map(statement => {
    const result = normalizeStatement(statement, functions, {
      ...options,
      sharedFunctions: true,
      tableNames: new Set([...state.getAllOperators().map(op => op.operatorID), ...statements.map(s => s.id)]),
    });
    const used = Object.keys(result.view?.functions ?? {});
    const bad = used.filter(name => broken.has(name) || conflicts.has(name));
    if (bad.length) {
      result.error = {
        message: `Shared function ${bad.join(", ")} has an invalid or conflicting definition. Correct it before using its consumers.`,
        field: "fn",
      };
      result.view = undefined;
    }
    const branch = state.getOperator(statement.id)?.nativeOp?.analysisBranch;
    if (result.view && branch) result.view.analysisBranch = branch;
    return result;
  });
  for (const [name, fn] of Object.entries(parsed.functions)) {
    const retainedUnchanged =
      !changed.has(name) &&
      state
        .getAllOperators()
        .some(
          op =>
            !explicit.has(op.operatorID) &&
            !op.taskSource &&
            !op.nativeOp?.analysisBranch &&
            Object.values(op.nativeOp?.functions ?? {}).some(source => source.includes(fn.source))
        );
    if (retainedUnchanged) continue;
    if (!normalized.some(s => Object.hasOwn(s.view?.functions ?? s.attempted.functions ?? {}, name))) {
      // Definitions are owned by consumers, not a process-global registry.
      parsed.errors.push({
        line: fn.line,
        id: name,
        source: fn.source,
        message: `Function ${name} has no table consumer. Define or revise a table using it in this call; unused functions are not retained.`,
      });
    }
  }
  return { ok: true, statements: normalized, functions, errors: parsed.errors };
}

/** Python AST columns count UTF-8 bytes, whereas JS indices count UTF-16.
 * Rewrite only the leading positional table inputs; function arguments, dtype
 * names and lambda locals may share their spelling and must stay untouched.
 * Replacements may be a retained-table expression such as at(x, 2). */
function rewriteStatement(
  statement: ParsedStatement,
  as: string,
  mapping: Map<string, string>,
  inputCount: number
): string {
  const lines = statement.source.split("\n");
  const offset = (line: number, column: number) =>
    lines.slice(0, line - 1).reduce((n, s) => n + s.length + 1, 0) +
    Buffer.from(lines[line - 1] ?? "")
      .subarray(0, column)
      .toString("utf8").length;
  let source = statement.source;
  const inputs = (statement.names ?? []).filter(
    name => name.argumentIndex !== undefined && name.argumentIndex < inputCount
  );
  for (const name of inputs.sort((a, b) => offset(b.span[0], b.span[1]) - offset(a.span[0], a.span[1]))) {
    const value = mapping.get(name.name);
    if (value !== undefined)
      source =
        source.slice(0, offset(name.span[0], name.span[1])) + value + source.slice(offset(name.span[2], name.span[3]));
  }
  return source.replace(/^\s*[A-Za-z_]\w*(\s*=)/, `${as}$1`);
}

export async function planAnalysisForks(
  requests: AnalysisFork[],
  state: WorkflowState,
  staged: ProgramStatement[],
  history?: TaskHistory,
  options: Options = {}
): Promise<{ statements: ProgramStatement[]; errors: Array<{ id: string; message: string }> }> {
  const result: ProgramStatement[] = [];
  const errors: Array<{ id: string; message: string }> = [];
  const occupied = new Set([...state.getAllOperators().map(op => op.operatorID), ...staged.map(s => s.id)]);
  const live = new Map(
    state
      .getAllOperators()
      .filter(op => op.nativeOp)
      .map(op => [op.operatorID, op.nativeOp!])
  );
  for (const item of staged) if (item.view) live.set(item.id, item.view);
  let nextLine = Math.max(0, ...staged.map(s => s.line)) + 1;
  for (const request of requests) {
    try {
      if (!NATIVE_ID_RE.test(request.as) || request.as.startsWith(TASK_SOURCE_PREFIX) || occupied.has(request.as))
        throw new Error(`Fork target ${request.as} must be a new valid table name.`);
      if (request.task !== undefined && (!Number.isSafeInteger(request.task) || request.task < 1 || !history))
        throw new Error("A historical fork requires a completed positive task number and task history.");
      if (Object.hasOwn(request.bindings, request.operator))
        throw new Error("Replace upstream inputs, not the fork target itself.");
      const viewOf = (id: string): NativeOpView | undefined =>
        request.task === undefined ? live.get(id) : history?.definition(id, request.task)?.operator.nativeOp;
      if (!viewOf(request.operator))
        throw new Error(
          `No definition for ${request.operator}${request.task === undefined ? "" : ` at task ${request.task}`}.`
        );
      const ancestors = new Set<string>();
      const visiting = new Set<string>();
      const walk = (id: string) => {
        if (visiting.has(id)) throw new Error(`Cycle through ${id}.`);
        if (ancestors.has(id)) return;
        ancestors.add(id);
        visiting.add(id);
        for (const input of viewOf(id)?.inputs ?? []) walk(input);
        visiting.delete(id);
      };
      walk(request.operator);
      for (const [from, to] of Object.entries(request.bindings)) {
        if (!ancestors.has(from))
          throw new Error(`Binding ${from} is not an ancestor of ${request.operator}; no branch was created.`);
        if (!NATIVE_ID_RE.test(to) || to.startsWith(TASK_SOURCE_PREFIX) || !occupied.has(to))
          throw new Error(`Replacement table ${to} does not exist in the workflow or this call.`);
      }
      const affected = new Map<string, boolean>();
      const changes = (id: string): boolean => {
        if (affected.has(id)) return affected.get(id)!;
        const yes = Object.hasOwn(request.bindings, id) || (viewOf(id)?.inputs ?? []).some(changes);
        affected.set(id, yes);
        return yes;
      };
      const planned: ProgramStatement[] = [];
      const copies = new Map<string, string>();
      const consumed = new Set<string>();
      const build = async (id: string): Promise<string> => {
        if (Object.hasOwn(request.bindings, id)) {
          consumed.add(id);
          return request.bindings[id];
        }
        if (copies.has(id)) return copies.get(id)!;
        const as = id === request.operator ? request.as : `${request.as}__${id}`;
        if (occupied.has(as)) throw new Error(`Fork internal name ${as} already exists; choose another target.`);
        const view = viewOf(id);
        if (!view?.source) throw new Error(`Table ${id} has no reusable source definition.`);
        const parsed = await parseNativeProgram(view.source);
        if (parsed.errors.length || parsed.statements.length !== 1)
          throw new Error(`Cannot parse saved definition of ${id}.`);
        const mapping = new Map<string, string>();
        for (const input of view.inputs) {
          if (input.startsWith(TASK_SOURCE_PREFIX)) continue; // original at(...) remains pinned
          if (Object.hasOwn(request.bindings, input)) {
            consumed.add(input);
            mapping.set(input, request.bindings[input]);
          } else if (changes(input)) mapping.set(input, await build(input));
          else if (request.task !== undefined) mapping.set(input, `at(${input}, task=${request.task})`);
        }
        const rewritten = await parseNativeProgram(
          rewriteStatement(parsed.statements[0], as, mapping, view.inputs.length)
        );
        if (rewritten.errors.length || rewritten.statements.length !== 1)
          throw new Error(`Cannot bind saved definition of ${id}.`);
        const functions = await parseDefinitions([...new Set(Object.values(view.functions ?? {}))].join("\n\n"));
        const compiled = normalizeStatement({ ...rewritten.statements[0], line: nextLine++ }, functions.functions, {
          ...options,
          sharedFunctions: true,
          tableNames: new Set([...occupied, ...copies.values(), as]),
        });
        if (!compiled.view) throw new Error(compiled.error?.message ?? `Cannot compile ${id}.`);
        compiled.view.analysisBranch = {
          root: request.as,
          origin: id,
          ...(request.task === undefined ? {} : { task: request.task }),
        };
        copies.set(id, as);
        planned.push(compiled);
        return as;
      };
      await build(request.operator);
      const unused = Object.keys(request.bindings).filter(id => !consumed.has(id));
      if (unused.length) throw new Error(`Bindings ${unused.join(", ")} are unused behind another replaced boundary.`);
      for (const item of planned) {
        occupied.add(item.id);
        live.set(item.id, item.view!);
      }
      result.push(...planned);
    } catch (error) {
      errors.push({ id: request.as, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { statements: result, errors };
}

export function inspectAnalysis(state: WorkflowState, ids: string[]): string[] {
  return ids.map(id => {
    const op = state.getOperator(id);
    const view = op?.nativeOp;
    if (!view) {
      const definitions = new Map<string, string[]>();
      for (const consumer of state.getAllOperators()) {
        if (consumer.taskSource) continue;
        const source = consumer.nativeOp?.functions?.[id];
        if (!source) continue;
        const label = consumer.operatorID + (consumer.nativeOp?.analysisBranch ? " (branch copy)" : " (shared)");
        definitions.set(source, [...(definitions.get(source) ?? []), label]);
      }
      if (!definitions.size) return `No current native table or retained function ${id}.`;
      return [...definitions]
        .map(([source, consumers]) => `Function ${id}; consumers: ${consumers.join(", ")}\n${source}`)
        .join("\n\n");
    }
    return [
      `Definition ${id} revision=${view.revision ?? "unknown"}`,
      `inputs=${JSON.stringify(view.taskInputs ?? view.inputs)}`,
      ...(view.analysisBranch ? [`branch=${JSON.stringify(view.analysisBranch)}`] : []),
      ...new Set(Object.values(view.functions ?? {})),
      view.source ?? JSON.stringify(view.properties),
    ].join("\n");
  });
}
