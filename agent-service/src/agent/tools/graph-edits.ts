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

import { WorkflowState } from "../workflow-state";
import { WorkflowUtilService } from "../util/workflow-utils";
import { autoLayoutWorkflow } from "../util/auto-layout";
import type { OperatorPredicate, WorkflowContent } from "../../types/workflow";
import type { ToolContext } from "./workflow-crud-tools";
import type { NativeBatchOutcome } from "./native-batch-tools";
import {
  NATIVE_BY_NAME,
  NATIVE_BY_TYPE,
  TWO_VERSIONS,
  nativeOperatorName,
  type NativeOpView,
  type ParsedFunction,
  type ParsedStatement,
  type ParsedValue,
  type VariantChange,
} from "../native/catalog";
import { normalizeStatement } from "../native/program";
import { compileNativeOp, nativeRevision, runNativePython, validateNativeOperators } from "../native/codegen";
import { computeStaleResultOps } from "../workflow-snapshot-storage";
import { nativeLineage } from "./native-upsert";
import type { VersionCommand } from "../state-ledger";
import {
  effectiveSettings,
  literalSetting,
  parsedFunction,
  pyLiteral,
  rebuildCaller,
  renameFunction,
  sharedCallView,
  sharedEntry,
  sharedSources,
  similarity,
  type SharedFunction,
} from "./shared-functions";

type Edge = { source: string; sourcePort: string; target: string; targetPort: string };
type Command = Edge & {
  operation: string;
  id: string;
  expression: string;
  statement: ParsedStatement;
  functions: Record<string, ParsedFunction>;
  line: number;
  /** Assignment syntax: argument source text and `name@N` placeholders. */
  positional?: string[];
  keywords?: string[];
  references?: Record<string, string>;
  sourceId?: string;
  task?: number;
  create?: boolean;
  /** `define_function`: the shared function's signature, docstring and source. */
  tables?: string[];
  settings?: Record<string, unknown>;
  doc?: string | null;
  /** `set_setting`: `id.setting = value`. */
  setting?: string;
  value?: unknown;
  /** `commit`: `id = other`. */
  other?: string;
};
export interface GraphChangeReceipt {
  operation: string;
  operator_id?: string;
  edge?: string;
  deleted_edges?: string[];
}
export interface GraphEditPlan {
  workflow: WorkflowContent;
  operators: NativeBatchOutcome[];
  changes: GraphChangeReceipt[];
  unconnected_inputs: string[];
  invalidated_results: string[];
  forks?: GraphForkReceipt[];
  versions?: Array<{ command: VersionCommand; state: string; note: string }>;
  /** Distinguishes command-order execution from older version-first traces. */
  ordered_versions?: true;
  applied?: number;
  /** Shared-function and version notes for the edit receipt. */
  notes?: string[];
  /** Statements held back with the reason; the rest of the edit applied. */
  held?: HeldStatement[];
}

export interface HeldStatement {
  line: number;
  statement: string;
  reason: string;
}

/** One statement of an edit, as python/graph_parser.py splits it. */
interface EditBlock {
  line: number;
  end: number;
  text: string;
  sets: string[];
  uses: string[];
}

export interface GraphForkReceipt {
  task_id: number;
  step_id: string;
  operator_id: string;
  new_operator_id: string;
  mapping: Record<string, string>;
}

export interface VersionEditResolution {
  fork?: GraphEditPlan & { mapping: Record<string, string>; task_id: number };
  restore?: string;
  definition?: OperatorPredicate;
  inputs?: string[];
  state: string;
  note: string;
}

const edgeText = (e: Edge) => `${e.source}.${e.sourcePort} -> ${e.target}.${e.targetPort}`;
const indexed = (count: number) => Array.from({ length: count }, (_, i) => `in[${i}]`);
function ports(view: NativeOpView): string[] {
  if (view.graph) return view.graph.inputPorts;
  const arity = NATIVE_BY_TYPE.get(view.type)?.inputs;
  return arity === 0 ? [] : arity === 1 ? ["in"] : arity === 2 ? ["left", "right"] : indexed(view.inputs.length);
}
function edgesOf(workflow: WorkflowContent): Edge[] {
  const result: Edge[] = [];
  for (const op of workflow.operators) {
    const view = op.nativeOp;
    if (!view) continue;
    const names = ports(view);
    if (!view.graph) {
      // Legacy self-joins shared a physical port. Preserve both logical slots
      // when an archived expression workflow first receives a graph edit.
      view.inputs.forEach((source, i) =>
        result.push({ source, sourcePort: "out", target: op.operatorID, targetPort: names[i] })
      );
    } else {
      for (const link of workflow.links.filter(l => l.target.operatorID === op.operatorID)) {
        const i = op.inputPorts.findIndex(p => p.portID === link.target.portID);
        result.push({
          source: link.source.operatorID,
          sourcePort: "out",
          target: op.operatorID,
          targetPort: names[i] ?? link.target.portID,
        });
      }
    }
  }
  return result;
}
export function inspectGraph(workflow: WorkflowContent) {
  const edges = edgesOf(workflow);
  return {
    operators: workflow.operators.map(op => ({
      id: op.operatorID,
      type: op.nativeOp ? nativeOperatorName(op.nativeOp.type) : op.operatorType,
      ports: { inputs: op.nativeOp ? ports(op.nativeOp) : op.inputPorts.map(p => p.portID), outputs: ["out"] },
    })),
    edges: edges.map(edgeText),
    unconnected_inputs: workflow.operators.flatMap(op =>
      op.nativeOp
        ? ports(op.nativeOp)
            .filter(port => !edges.some(e => e.target === op.operatorID && e.targetPort === port))
            .map(port => `${op.operatorID}.${port}`)
        : []
    ),
  };
}
export function missingGraphInputs(workflow: WorkflowContent): string[] {
  return inspectGraph(workflow).unconnected_inputs;
}

function definition(command: Command, profileCollection?: boolean): NativeOpView {
  const def = NATIVE_BY_NAME.get(command.statement.op);
  if (!def) throw new Error(`Unknown operator ${command.statement.op}. Use an operator from the catalog.`);
  let names = def.inputs === 0 ? [] : def.inputs === 1 ? ["in"] : def.inputs === 2 ? ["left", "right"] : indexed(2);
  if (TWO_VERSIONS.has(def.name)) names = indexed(2);
  if (def.name === "process") {
    const fn = command.statement.kwargs.fn ?? command.statement.args[0];
    const params =
      fn?.kind === "lambda" ? fn.params : fn?.kind === "name" ? command.functions[fn.name]?.params : undefined;
    names = indexed(params?.length ?? 0);
  }
  const normalized = normalizeStatement(command.statement, command.functions, {
    profileCollection,
    explicitInputs: names.map((_, i) => `_unconnected_${i}`),
  });
  if (!normalized.view) throw new Error(normalized.error?.message ?? "Invalid operator expression.");
  return { ...normalized.view, inputs: names.map(() => ""), source: command.expression, graph: { inputPorts: names } };
}

/** What identifies a definition apart from its inputs. */
const definitionKey = (view: NativeOpView) =>
  JSON.stringify([view.type, view.properties, view.functions ?? {}, ports(view)]);

/** The statement a failure belongs to: by its line (mapped back to the full
 * edit), by the operator a graph check names, or by an unused function. */
function failingBlock(message: string, blocks: readonly EditBlock[], lineMap: readonly number[]): number | undefined {
  const line = /\(line (\d+)\)/.exec(message)?.[1] ?? /(?:^|: )Line (\d+):/.exec(message)?.[1];
  if (line) {
    const original = lineMap[Number(line) - 1] ?? Number(line);
    const found = blocks.findIndex(block => block.line <= original && original <= block.end);
    return found >= 0 ? found : undefined;
  }
  const named =
    /^Resulting graph: (\w+): /.exec(message)?.[1] ?? /^Shared functions: (\w+)(?:, \w+)* (?:is|are) defined but never used/.exec(message)?.[1];
  if (!named) return undefined;
  const found = blocks.map(block => block.sets.includes(named)).lastIndexOf(true);
  return found >= 0 ? found : undefined;
}

const reasonOf = (message: string) =>
  message
    .replace(/^(?:Change \d+ \(line \d+\): |Line \d+: |Resulting graph: |Shared functions: )/, "")
    .replace(/\s*No changes were applied\.$/, "");

/** Apply an edit statement by statement: when one statement fails, it and the
 * statements that use what it defines are held back with the reason, and the
 * rest applies. A failure that names no statement rejects the whole edit. */
export async function planGraphEdit(
  original: WorkflowContent,
  changes: string,
  context: ToolContext,
  resolveVersion?: (command: VersionCommand, current: WorkflowContent) => VersionEditResolution,
  resolveInput?: (address: string) => OperatorPredicate
): Promise<GraphEditPlan> {
  try {
    return await planGraphEditOnce(original, changes, context, resolveVersion, resolveInput);
  } catch (error) {
    if (/^(create|update|modify|delete|fork) (operator|edge)\b/m.test(changes)) throw error;
    const blocks = (await runNativePython({ edit_blocks: changes })) as EditBlock[];
    if (!Array.isArray(blocks) || blocks.length < 2) throw error;
    const held = new Map<number, string>();
    let failure = error instanceof Error ? error : new Error(String(error));
    let lineMap: number[] = [];
    for (;;) {
      const at = failingBlock(failure.message, blocks, lineMap);
      if (at === undefined || held.has(at)) throw error;
      held.set(at, reasonOf(failure.message));
      for (let grown = true; grown; ) {
        grown = false;
        const names = new Set([...held.keys()].flatMap(i => blocks[i].sets));
        blocks.forEach((block, i) => {
          const used = block.uses.filter(name => names.has(name));
          if (held.has(i) || !used.length) return;
          held.set(i, `uses ${used.map(name => `\`${name}\``).join(", ")} from a statement held back`);
          grown = true;
        });
      }
      const kept = blocks.filter((_, i) => !held.has(i));
      if (!kept.length) throw error;
      lineMap = kept.flatMap(block => block.text.split("\n").map((_, k) => block.line + k));
      try {
        const plan = await planGraphEditOnce(original, kept.map(block => block.text).join("\n"), context, resolveVersion, resolveInput);
        return {
          ...plan,
          held: [...held]
            .sort(([a], [b]) => a - b)
            .map(([i, reason]) => ({ line: blocks[i].line, statement: blocks[i].text.split("\n")[0], reason })),
        };
      } catch (next) {
        failure = next instanceof Error ? next : new Error(String(next));
      }
    }
  }
}

/** Validate and compile against a private draft. The caller commits the returned
 * workflow only after checking cancellation/HEAD ownership. No mutation occurs here. */
async function planGraphEditOnce(
  original: WorkflowContent,
  changes: string,
  context: ToolContext,
  resolveVersion?: (command: VersionCommand, current: WorkflowContent) => VersionEditResolution,
  resolveInput?: (address: string) => OperatorPredicate
): Promise<GraphEditPlan> {
  const parsed = (await runNativePython({
    changes,
    shared: sharedSources(original.operators.map(op => op.nativeOp)),
  })) as { ok: boolean; commands?: Command[]; error?: string; shared_functions?: Record<string, SharedFunction> };
  if (!parsed.ok) throw new Error(`${parsed.error} No changes were applied.`);
  if (!context.metadataStore) throw new Error("Metadata store not available for graph editing.");
  const nodes = new Map<string, NativeOpView>();
  const templates = new Map<string, OperatorPredicate>(original.operators.map(op => [op.operatorID, op]));
  for (const op of original.operators) {
    if (!op.nativeOp) throw new Error(`Operator ${op.operatorID} is not a native operator.`);
    nodes.set(op.operatorID, { ...structuredClone(op.nativeOp), graph: { inputPorts: ports(op.nativeOp) } });
  }
  const edges = new Map(edgesOf(original).map(e => [edgeText(e), e]));
  const receipts: GraphChangeReceipt[] = [];
  const outcomes: NativeBatchOutcome[] = [];
  const changed = new Set<string>();
  const forks: NonNullable<GraphEditPlan["forks"]> = [];
  const versions: NonNullable<GraphEditPlan["versions"]> = [];
  let location = "";
  const required = (id: string) => {
    const node = nodes.get(id);
    if (!node) throw new Error(`Operator ${id} does not exist.`);
    return node;
  };
  const validateEdge = (edge: Edge, grow = false) => {
    required(edge.source);
    const target = required(edge.target);
    if (edge.sourcePort !== "out") throw new Error(`Unknown output port ${edge.source}.${edge.sourcePort}; use out.`);
    if (target.type === "Union" && /^in\[(0|[1-9]\d*)\]$/.test(edge.targetPort) && grow) {
      const i = Number(edge.targetPort.slice(3, -1));
      if (i >= 256) throw new Error("Union supports input indices 0 through 255.");
      if (i >= ports(target).length) target.graph = { inputPorts: indexed(i + 1) };
    }
    if (!ports(target).includes(edge.targetPort))
      throw new Error(
        `Unknown input port ${edge.target}.${edge.targetPort}; expected ${ports(target).join(", ") || "no inputs"}.`
      );
  };
  const inputId = (address: string): string => {
    if (!address.includes("@")) return address;
    if (!resolveInput) throw new Error("Saved input references require stateHistory.");
    const source = resolveInput(address);
    if (!nodes.has(source.operatorID)) {
      nodes.set(source.operatorID, structuredClone(source.nativeOp!));
      templates.set(source.operatorID, source);
    }
    return source.operatorID;
  };
  // Version resolution needs the current private draft's IDs and bindings,
  // including preceding edits. Compilation/validation still happen once,
  // after every command, so temporary draft states never commit or execute.
  const stagedWorkflow = (): WorkflowContent => ({
    ...original,
    operators: [...nodes].map(([id, view]) => ({
      ...templates.get(id)!,
      operatorID: id,
      inputPorts: ports(view).map((name, i) => ({
        portID: `input-${i}`,
        displayName: name,
        disallowMultiInputs: true,
      })),
      outputPorts: [{ portID: "output-0", displayName: "out" }],
      nativeOp: {
        ...view,
        inputs: ports(view).map(
          port => [...edges.values()].find(edge => edge.target === id && edge.targetPort === port)?.source ?? ""
        ),
      },
    })),
    links: [...edges].map(([id, edge]) => ({
      linkID: id,
      source: { operatorID: edge.source, portID: "output-0" },
      target: { operatorID: edge.target, portID: `input-${ports(required(edge.target)).indexOf(edge.targetPort)}` },
    })),
  });
  // Shared functions: those the graph's callers carry, and those this edit defines.
  const known = new Map<string, SharedFunction>(Object.entries(parsed.shared_functions ?? {}));
  const defined = new Map<string, SharedFunction>();
  const functionTable = () => new Map([...known, ...defined]);
  const parsedFunctions = (): Record<string, ParsedFunction> =>
    Object.fromEntries([...functionTable()].map(([name, fn]) => [name, parsedFunction(fn)]));
  // Assignments wire their inputs once every statement is known.
  const pendingInputs = new Map<string, { inputs: string[]; line: number }>();
  const notes: string[] = [];
  const portsFor = (view: NativeOpView, count: number): string[] => {
    const def = NATIVE_BY_TYPE.get(view.type);
    if (def && TWO_VERSIONS.has(def.name)) return indexed(2);
    if (def?.inputs === "many") return indexed(count);
    return def?.inputs === 0 ? [] : def?.inputs === 1 ? ["in"] : ["left", "right"];
  };
  try {
    for (const command of parsed.commands ?? []) {
      if (command.operation !== "define_function") continue;
      if (defined.has(command.id)) throw new Error(`Line ${command.line}: ${command.id} is defined twice in this edit.`);
      if (command.id === "variant")
        throw new Error(`Line ${command.line}: \`variant\` varies a table; give the function another name.`);
      defined.set(command.id, command as unknown as SharedFunction);
    }
    const commands = [...parsed.commands!];
    // Every name this edit assigns is a table, even one that shares a function's name.
    const assigned = commands
      .filter(command => command.operation === "assign_operator" || command.operation === "assign_version")
      .map(command => command.id);
    const incoming = (id: string) => [...edges.values()].filter(edge => edge.target === id);
    const reach = (id: string, step: (edge: Edge) => [string, string]) => {
      const seen = new Set<string>();
      for (const stack = [id]; stack.length; ) {
        const next = stack.pop()!;
        for (const edge of edges.values()) {
          const [from, to] = step(edge);
          if (from === next && !seen.has(to)) {
            seen.add(to);
            stack.push(to);
          }
        }
      }
      return seen;
    };
    const ancestors = (id: string) => reach(id, edge => [edge.target, edge.source]);
    const descendants = (id: string) => reach(id, edge => [edge.source, edge.target]);
    /** The variant a hidden copied step belongs to. */
    const partOf = (id: string) => {
      const variant = nodes.get(id)?.variant;
      return variant && variant.name !== id ? variant.name : undefined;
    };
    const notPart = (id: string) => {
      const owner = partOf(id);
      if (owner)
        throw new Error(
          `\`${id}\` is a step inside the variant \`${owner}\`; change the variant with \`${owner} = variant(...)\` or delete it with \`del ${owner}\`.`
        );
    };
    const removeNode = (id: string) => {
      for (const edge of [...edges.values()].filter(edge => edge.source === id || edge.target === id)) {
        edges.delete(edgeText(edge));
        if (edge.target !== id) changed.add(edge.target);
      }
      nodes.delete(id);
      templates.delete(id);
      changed.add(id);
    };
    const moveEdges = (edgesToMove: Edge[], change: Partial<Edge>) => {
      for (const edge of edgesToMove) {
        edges.delete(edgeText(edge));
        const moved = { ...edge, ...change };
        edges.set(edgeText(moved), moved);
        changed.add(moved.target);
      }
    };
    /** A variant table being redefined or replaced loses its hidden copies. */
    const dropCopies = (id: string) => {
      if (nodes.get(id)?.variant?.name !== id) return;
      for (const [part, view] of [...nodes]) if (part !== id && view.variant?.name === id) removeNode(part);
    };
    /** Readers of `from` read `to` instead. */
    const repoint = (from: string, to: string) =>
      moveEdges([...edges.values()].filter(edge => edge.source === from), { source: to });
    /** The name an earlier definition keeps when a step is inserted after it. */
    const keptName = (id: string) => {
      let k = 1;
      while (nodes.has(`${id}_v${k}`) || templates.has(`${id}_v${k}`)) k++;
      return `${id}_v${k}`;
    };
    /** Keep `id`'s current definition under a new name that takes its inputs. */
    const keepEarlier = (id: string) => {
      const kept = keptName(id);
      nodes.set(kept, nodes.get(id)!);
      const template = templates.get(id);
      if (template) templates.set(kept, { ...template, operatorID: kept });
      moveEdges(incoming(id), { target: kept });
      changed.add(kept);
      receipts.push({ operation: "create_operator", operator_id: kept });
      return kept;
    };
    const savedNames = (text: string) => text.replace(/\b__saved_(\w+?)__(\d+)\b/g, "$1@$2");
    /** The operator a call defines, with its input tables by name. */
    const callView = (
      id: string,
      statement: ParsedStatement,
      extraFunctions: Record<string, ParsedFunction>,
      references: Record<string, string>,
      profileCollection: boolean | undefined,
      written?: { positional: string[]; keywords: string[] }
    ): { view: NativeOpView; inputs: string[] } => {
      const op = statement.op;
      const fn = functionTable().get(op);
      const functions = { ...parsedFunctions(), ...extraFunctions };
      let view: NativeOpView;
      if (NATIVE_BY_NAME.has(op)) {
        const normalized = normalizeStatement(statement, functions, {
          profileCollection,
          tables: new Set([...nodes.keys(), ...assigned]),
        });
        if (!normalized.view) throw new Error(normalized.error?.message ?? "Invalid operator definition.");
        view = normalized.view;
        // Inputs live on edges; the stored definition names only the parameters.
        view.source = written
          ? `${op}(${[...written.positional.slice(view.inputs.length), ...written.keywords].join(", ")})`
          : savedNames(
              statement.source.replace(
                new RegExp(`^${op}\\(\\s*${view.inputs.map(name => `${name}\\s*`).join(",\\s*")}(,\\s*)?`),
                `${op}(`
              )
            );
      } else if (fn) {
        const args = statement.args;
        const named = args.filter((arg): arg is { kind: "name"; name: string } => arg.kind === "name");
        const settingNames = Object.keys(fn.settings);
        if (named.length !== args.length || named.length !== fn.tables.length)
          throw new Error(
            `${op} takes ${fn.tables.length} input table(s) by name (${fn.tables.join(", ") || "none"}), then settings by name: \`${id} = ${op}(${[...fn.tables, ...settingNames.slice(0, 1).map(name => `${name}=...`)].join(", ")})\`.`
          );
        const unknown = Object.keys(statement.kwargs).filter(name => !settingNames.includes(name));
        if (unknown.length)
          throw new Error(
            `${op} has no setting ${unknown.join(", ")}; its settings are ${settingNames.join(", ") || "none"}. A parameter with a default in the def is a setting.`
          );
        if (!fn.doc?.trim())
          throw new Error(`Give ${op} a one-sentence docstring: the row grain of the table it returns and its rule.`);
        const settings = Object.fromEntries(
          Object.entries(statement.kwargs).map(([name, value]) => [name, literalSetting(value, name)])
        );
        view = sharedCallView(fn, functions, named.map(arg => arg.name), settings);
        if (profileCollection === true) view.profileCollection = true;
      } else
        throw new Error(
          `Unknown operator or function \`${op}\`. Operators: ${[...NATIVE_BY_NAME.keys()].join(", ")}. For custom Python, define \`def ${op}(table, setting=default):\` with a docstring at the margin of the edit and call it by name.`
        );
      return { view, inputs: view.inputs.map(name => references[name] ?? name) };
    };
    /** Variants and commits apply after the edit's other statements. */
    const deferred: Array<{ command: Command; index: number }> = [];
    const describeChange = (change: VariantChange) =>
      change.settings
        ? Object.entries(change.settings).map(([name, value]) => `${change.step}.${name}=${pyLiteral(value)}`).join(", ")
        : `${change.step} = ${change.definition}`;
    /** `name = variant(table, step={"setting": value}, other=new_call(...))`:
     * copy the steps between the changed steps and the table, apply the
     * changes to the copies, and name the copy of the table. */
    const expandVariant = (command: Command) => {
      const name = command.id;
      const usage = `\`${name} = variant(table, step={"setting": value}, other_step=new_call(...))\``;
      const [targetArg, ...extra] = command.statement.args;
      if (!targetArg || targetArg.kind !== "name" || extra.length)
        throw new Error(`variant takes the table to vary, then the changes by step name: ${usage}.`);
      const target = targetArg.name;
      if (command.references?.[target])
        throw new Error(`variant varies a current table; \`${command.references[target]}\` is a saved version. Vary the current table.`);
      required(target);
      notPart(target);
      if (target === name)
        throw new Error(`A variant needs its own name, such as \`${name}_alt = variant(${name}, ...)\`; to change ${name} itself, set its setting or restate it.`);
      const requested = Object.entries(command.statement.kwargs);
      if (!requested.length) throw new Error(`variant needs at least one change: ${usage}.`);
      const previous = nodes.get(name);
      if (previous?.variant && previous.variant.name !== name) notPart(name);
      if (previous?.variant?.name === name)
        for (const [part, view] of [...nodes]) if (part !== name && view.variant?.name === name) removeNode(part);
      const upstream = ancestors(target);
      const changes: VariantChange[] = [];
      const replaced = new Map<string, { view: NativeOpView; inputs: string[] }>();
      for (const [step, value] of requested) {
        if (!nodes.has(step)) throw new Error(`variant changes \`${step}\`, which is not an operator.`);
        notPart(step);
        if (step !== target && !upstream.has(step))
          throw new Error(`\`${step}\` is not upstream of \`${target}\`, so changing it cannot change ${target}.`);
        if (value.kind === "dict") {
          const view = nodes.get(step)!;
          const entry = sharedEntry(view);
          if (!entry)
            throw new Error(
              `\`${step}\` is a ${nativeOperatorName(view.type)} step without settings; give the variant a new definition for it instead: \`${step}=${nativeOperatorName(view.type)}(...)\`.`
            );
          const fn = functionTable().get(entry)!;
          const settings: Record<string, unknown> = {};
          for (const [setting, item] of value.entries) {
            if (!(setting in fn.settings))
              throw new Error(`\`${step}\` has no setting \`${setting}\`; its settings are ${Object.keys(fn.settings).join(", ") || "none"}.`);
            settings[setting] = literalSetting(item, `${step}.${setting}`);
          }
          changes.push({ step, settings });
        } else if (value.kind === "call") {
          const statement: ParsedStatement = {
            id: step,
            op: value.name,
            line: command.line,
            endLine: command.line,
            source: value.source,
            args: value.args,
            kwargs: value.kwargs,
          };
          const built = callView(step, statement, command.functions, command.references ?? {}, nodes.get(step)!.profileCollection);
          replaced.set(step, built);
          changes.push({ step, definition: savedNames(value.source) });
        } else
          throw new Error(
            `\`${step}=...\` takes new setting values as a dict, such as ${step}={"weight": 0.5}, or a new call that defines the step.`
          );
      }
      const targetSide = new Set([...upstream, target]);
      const chain = new Set<string>();
      for (const { step } of changes) for (const id of [step, ...descendants(step)]) if (targetSide.has(id)) chain.add(id);
      const copyOf = (id: string) => (id === target ? name : `${name}__${id}`);
      for (const id of chain)
        if (id !== target && nodes.has(copyOf(id)) && partOf(copyOf(id)) !== name)
          throw new Error(`\`${copyOf(id)}\` already names an operator; give the variant another name.`);
      for (const id of topological([...chain])) {
        const original = nodes.get(id)!;
        const settings = changes.find(change => change.step === id)?.settings;
        let view: NativeOpView;
        let sources: string[];
        if (replaced.has(id)) {
          const built = replaced.get(id)!;
          const portNames = portsFor(built.view, built.inputs.length);
          view = { ...built.view, graph: { inputPorts: portNames } };
          sources = built.inputs.map(inputId);
        } else {
          view = structuredClone(original);
          sources = ports(original).map(port => incoming(id).find(edge => edge.targetPort === port)?.source ?? "");
          if (settings) {
            const fn = functionTable().get(sharedEntry(view)!)!;
            const passed = (view.properties.params ?? {}) as Record<string, unknown>;
            view = { ...view, ...sharedCallView(fn, parsedFunctions(), view.inputs, { ...passed, ...settings }), graph: view.graph };
          }
        }
        const copy = copyOf(id);
        view.variant = id === target ? { name, step: id, of: target, changes } : { name, step: id };
        if (id === target) view.source = savedNames(command.statement.source.replace(/^\w+\s*=\s*/, ""));
        for (const edge of incoming(copy)) edges.delete(edgeText(edge));
        nodes.set(copy, view);
        changed.add(copy);
        ports(view).forEach((port, i) => {
          if (!sources[i]) return;
          const edge: Edge = { source: chain.has(sources[i]) ? copyOf(sources[i]) : sources[i], sourcePort: "out", target: copy, targetPort: port };
          edges.set(edgeText(edge), edge);
        });
      }
      const copied = [...chain].filter(id => id !== target);
      notes.push(
        `${name} is a variant of ${target} with ${changes.map(describeChange).join("; ")}${copied.length ? `; it copies ${copied.join(", ")}` : ""}. ${target} and the steps it reads are unchanged.`
      );
      outcomes.push({
        id: name,
        op: nativeOperatorName(nodes.get(name)!.type),
        status: previous ? "modified" : "added",
        message: `${previous ? "updated" : "added"} variant \`${name}\` of \`${target}\` with ${changes.map(describeChange).join("; ")}${copied.length ? `; it copies ${copied.join(", ")}` : ""}`,
      });
      receipts.push({ operation: previous ? "update_operator" : "create_operator", operator_id: name });
    };
    /** Steps in input order. */
    const topological = (ids: string[]) => {
      const pending = new Set(ids);
      const ordered: string[] = [];
      while (pending.size) {
        const ready = [...pending].filter(id => !incoming(id).some(edge => pending.has(edge.source)));
        const next = ready.length ? ready : [...pending];
        for (const id of next) {
          pending.delete(id);
          ordered.push(id);
        }
      }
      return ordered;
    };
    /** `table = other`: from now on, table is what other is. */
    const commitTable = (command: Command) => {
      const table = command.id;
      const other = command.other!;
      if (!nodes.has(table))
        throw new Error(
          `\`${table}\` does not exist yet. \`${table} = ${other}\` makes an existing table take ${other}'s definition; to make a new table, write its call.`
        );
      if (!nodes.has(other)) throw new Error(`\`${other}\` is not an operator.`);
      notPart(table);
      notPart(other);
      if (templates.get(table)?.savedResult || templates.get(other)?.savedResult)
        throw new Error("Historical result handles are read-only; restore one with `name = name@N`.");
      const source = nodes.get(other)!;
      let note: string;
      if (source.variant?.of !== undefined) {
        if (source.variant.of !== table)
          throw new Error(`\`${other}\` is a variant of \`${source.variant.of}\`; make it current with \`${source.variant.of} = ${other}\`.`);
        const original = (id: string) => (nodes.get(id)?.variant?.name === other ? nodes.get(id)!.variant!.step : id);
        const applied: string[] = [];
        for (const change of source.variant.changes ?? []) {
          const real = required(change.step);
          if (change.settings) {
            const fn = functionTable().get(sharedEntry(real)!)!;
            const passed = (real.properties.params ?? {}) as Record<string, unknown>;
            const before = effectiveSettings(fn, passed);
            nodes.set(change.step, {
              ...real,
              ...sharedCallView(fn, parsedFunctions(), real.inputs, { ...passed, ...change.settings }),
              graph: real.graph,
            });
            applied.push(...Object.entries(change.settings).map(([name, value]) => `${change.step}.${name} ${pyLiteral(before[name])} to ${pyLiteral(value)}`));
          } else {
            const copy = change.step === table ? other : `${other}__${change.step}`;
            const view = structuredClone(nodes.get(copy)!);
            delete view.variant;
            if (change.step === table) view.source = nodes.get(copy)!.source;
            for (const edge of incoming(change.step)) edges.delete(edgeText(edge));
            for (const edge of incoming(copy)) {
              const moved: Edge = { ...edge, source: original(edge.source), target: change.step };
              edges.set(edgeText(moved), moved);
            }
            nodes.set(change.step, view);
            applied.push(`${change.step} = ${change.definition}`);
          }
          changed.add(change.step);
          receipts.push({ operation: "update_operator", operator_id: change.step });
        }
        repoint(other, table);
        for (const [part, view] of [...nodes]) if (view.variant?.name === other) removeNode(part);
        note = `${table} now has ${other}'s changes (${applied.join("; ")}); everything built on them recomputes on the next execute.`;
      } else if (ancestors(other).has(table)) {
        dropCopies(table);
        const kept = keepEarlier(table);
        const chain = new Set([...ancestors(other), other]);
        moveEdges([...edges.values()].filter(edge => edge.source === table && chain.has(edge.target)), { source: kept });
        nodes.set(table, structuredClone(nodes.get(other)!));
        for (const edge of incoming(other)) {
          const moved: Edge = { ...edge, target: table };
          edges.set(edgeText(moved), moved);
        }
        repoint(other, table);
        removeNode(other);
        note = `${table} now applies ${other}'s steps to the earlier ${table}, which continues as ${kept}; everything that read ${table} sees the new table.`;
      } else {
        // Not built on table, so nothing it reads can read table: no cycle.
        dropCopies(table);
        for (const edge of incoming(table)) edges.delete(edgeText(edge));
        nodes.set(table, structuredClone(nodes.get(other)!));
        for (const edge of incoming(other)) {
          const moved: Edge = { ...edge, target: table };
          edges.set(edgeText(moved), moved);
        }
        repoint(other, table);
        removeNode(other);
        note = `${table} now has ${other}'s definition and inputs; ${other} was folded into it, and tables that read ${other} read ${table}.`;
      }
      notes.push(`${note} The previous ${table} stays readable as ${table}@N.`);
      changed.add(table);
      outcomes.push({ id: table, op: nativeOperatorName(nodes.get(table)!.type), status: "modified", message: `updated \`${table}\` from \`${other}\`` });
      outcomes.push({ id: other, op: nativeOperatorName(source.type), status: "deleted", message: `folded \`${other}\` into \`${table}\`` });
      receipts.push({ operation: "update_operator", operator_id: table }, { operation: "delete_operator", operator_id: other });
    };
    for (let [index, command] of commands.entries()) {
      location = `Change ${index + 1} (line ${command.line}): `;
      // Functions and operators have separate names: `screen = screen(water)` is fine.
      if (command.operation === "define_function") continue;
      // `name = name@N` restores in place; `copy = name@N` copies with saved inputs.
      if (command.operation === "assign_version")
        command = { ...command, operation: "copy_definition", create: !nodes.has(command.id) };
      const { operation, id } = command;
      if (operation === "commit") {
        deferred.push({ command, index });
        continue;
      }
      if (operation === "set_setting") {
        notPart(id);
        if (templates.get(id)?.savedResult) throw new Error("Historical result handles are read-only.");
        const view = required(id);
        const setting = command.setting!;
        const entry = sharedEntry(view);
        const kind = nativeOperatorName(view.type);
        if (!entry)
          throw new Error(
            `\`${id}\` is a ${kind} step; only shared functions have settings. Restate the step to change it: \`${id} = ${kind}(...)\`.`
          );
        const fn = functionTable().get(entry);
        if (!fn) throw new Error(`${id} calls ${entry}, which is not defined.`);
        if (!(setting in fn.settings))
          throw new Error(`\`${id}\` has no setting \`${setting}\`; its settings are ${Object.keys(fn.settings).join(", ") || "none"}.`);
        const passed = (view.properties.params ?? {}) as Record<string, unknown>;
        const before = effectiveSettings(fn, passed)[setting];
        const rebuilt: NativeOpView = {
          ...view,
          ...sharedCallView(fn, parsedFunctions(), view.inputs, { ...passed, [setting]: command.value }),
          graph: view.graph,
        };
        if (definitionKey(rebuilt) === definitionKey(view)) continue;
        // On a variant whose copied step is this call, the change becomes part of the variant.
        if (view.variant?.name === id && view.variant.of) {
          const step = view.variant.step;
          const changes = [...(view.variant.changes ?? [])];
          const at = changes.findIndex(change => change.step === step && change.settings);
          if (at >= 0) changes[at] = { step, settings: { ...changes[at].settings, [setting]: command.value } };
          else changes.push({ step, settings: { [setting]: command.value } });
          rebuilt.variant = { ...view.variant, changes };
        }
        nodes.set(id, rebuilt);
        changed.add(id);
        outcomes.push({ id, op: kind, status: "modified", message: `updated \`${id}\`: ${setting} ${pyLiteral(before)} to ${pyLiteral(command.value)}` });
        receipts.push({ operation: "update_operator", operator_id: id });
        continue;
      }
      if (operation === "assign_operator") {
        notPart(id);
        if (templates.get(id)?.savedResult) throw new Error("Historical result handles are read-only.");
        if (command.statement.op === "variant") {
          deferred.push({ command, index });
          continue;
        }
        dropCopies(id);
        const existing = nodes.get(id);
        if (existing?.variant) delete existing.variant;
        const references = command.references ?? {};
        const profileCollection = existing?.profileCollection ?? context.settings?.nativeProfileCollection;
        const { view, inputs } = callView(id, command.statement, command.functions, references, profileCollection, {
          positional: command.positional ?? [],
          keywords: command.keywords ?? [],
        });
        const inserted = inputs.includes(id);
        const again = pendingInputs.has(id);
        if (again && !inserted)
          throw new Error(
            `${id} is assigned twice in this edit; write one definition, or build on the first with \`${id} = operator(${id}, ...)\`.`
          );
        if (inserted) {
          // `x = f(x)` inserts a step: the earlier x continues under a new
          // name, and everything that read x reads the new step. Within one
          // edit it builds on the statement that assigned x before.
          if (!existing) throw new Error(`${id} cannot read itself before it exists; build it first.`);
          const kept = keepEarlier(id);
          if (again) {
            pendingInputs.set(kept, pendingInputs.get(id)!);
            pendingInputs.delete(id);
          }
          inputs.forEach((name, i) => {
            if (name === id) inputs[i] = kept;
          });
          if (templates.has(id))
            notes.push(
              `${id} now applies ${command.statement.op} to the earlier ${id}, which continues as ${kept}; everything that read ${id} sees the new table. The previous ${id} stays readable as ${id}@N.`
            );
        }
        const portNames = portsFor(view, inputs.length);
        const draftView: NativeOpView = { ...view, inputs: portNames.map(() => ""), graph: { inputPorts: portNames } };
        pendingInputs.set(id, { inputs, line: command.line });
        // An unchanged definition is reported only if its inputs change.
        if (existing && !inserted && definitionKey(existing) === definitionKey(draftView)) continue;
        nodes.set(id, draftView);
        changed.add(id);
        const kind = nativeOperatorName(draftView.type);
        outcomes.push({
          id,
          op: kind,
          status: existing ? "modified" : "added",
          message: `${existing ? "updated" : "added"} ${kind} operator \`${id}\``,
        });
        receipts.push({ operation: existing ? "update_operator" : "create_operator", operator_id: id });
        continue;
      }
      if (operation === "fork_operator" || operation === "restore_operator" || operation === "copy_definition") {
        if (!resolveVersion) throw new Error("Saved-version commands require stateHistory.");
        const versionCommand = command as unknown as VersionCommand;
        // `fork … as …` and `update … from task N` were retired with the
        // saved-versions model; recorded edits still replay them.
        if ((operation === "fork_operator" || operation === "restore_operator") && !context.legacyVersionCommands)
          throw new Error(
            operation === "fork_operator"
              ? `Forks are not available. \`create operator ${versionCommand.as ?? "<new>"} from ${id}@${versionCommand.task}\` creates an editable copy with its saved direct inputs; \`create edge ${id}@${versionCommand.task}.out -> <target>.<port>\` connects the saved result.`
              : `Use \`update operator ${id} from ${id}@${versionCommand.task}\` to make the definition saved at the end of task ${versionCommand.task} current on today's inputs.`
          );
        const resolved = resolveVersion(versionCommand, stagedWorkflow());
        versions.push({
          command: {
            line: versionCommand.line,
            id,
            task: versionCommand.task,
            ...(versionCommand.sourceId ? { sourceId: versionCommand.sourceId, create: versionCommand.create } : {}),
            ...(versionCommand.as ? { as: versionCommand.as } : {}),
          },
          state: resolved.state,
          note: resolved.note,
        });
        if (resolved.definition) {
          if (versionCommand.create && nodes.has(id)) throw new Error(`Operator ${id} already exists.`);
          if (!versionCommand.create) required(id);
          if (templates.get(id)?.savedResult) throw new Error("Historical result handles are read-only.");
          const view = structuredClone(resolved.definition.nativeOp!);
          view.graph = { inputPorts: ports(view) };
          // One name has one definition: a restored call whose function changed
          // since that task keeps the old code under its own name.
          const entry = sharedEntry(view);
          const current = entry ? functionTable().get(entry) : undefined;
          const savedSource = entry ? view.functions?.[entry] : undefined;
          if (entry && current && savedSource && similarity(current.source, savedSource) < 1) {
            const renamed = `${entry}_t${versionCommand.task}`;
            view.functions = Object.fromEntries(
              Object.entries(view.functions ?? {}).map(([name, source]) => [
                name === entry ? renamed : name,
                renameFunction(source, entry, renamed),
              ])
            );
            view.properties = { ...view.properties, entry: renamed, code: renameFunction(String(view.properties.code), entry, renamed) };
            if (view.source) view.source = renameFunction(view.source, entry, renamed);
            notes.push(
              `${id} runs ${entry} as it was at the end of task ${versionCommand.task}, now named ${renamed}; ${entry} keeps its current definition.`
            );
          }
          nodes.set(id, view);
          if (versionCommand.create) templates.set(id, { ...resolved.definition, operatorID: id, savedResult: undefined, stateOrigin: undefined });
          changed.add(id);
          receipts.push({ operation: versionCommand.create ? "create_operator" : "update_operator", operator_id: id });
          outcomes.push({ id, op: nativeOperatorName(view.type), status: versionCommand.create ? "added" : "modified", message: resolved.note });
          if (resolved.inputs) {
            for (const [i, address] of resolved.inputs.entries()) {
              const edge: Edge = { source: inputId(address), sourcePort: "out", target: id, targetPort: ports(view)[i] };
              edges.set(edgeText(edge), edge);
            }
          }
        } else if (resolved.fork) {
          const fork = resolved.fork;
          const copied = new Set(Object.values(fork.mapping));
          for (const op of fork.workflow.operators.filter(op => copied.has(op.operatorID))) {
            nodes.set(op.operatorID, structuredClone(op.nativeOp!));
            templates.set(op.operatorID, op);
            changed.add(op.operatorID);
          }
          for (const edge of edgesOf(fork.workflow).filter(edge => copied.has(edge.target)))
            edges.set(edgeText(edge), edge);
          outcomes.push(...fork.operators);
          receipts.push(...fork.changes);
          forks.push({
            task_id: fork.task_id,
            step_id: fork.workflow.operators.find(op => op.operatorID === versionCommand.as)!.stateOrigin!.stepId,
            operator_id: id,
            new_operator_id: versionCommand.as!,
            mapping: { ...fork.mapping },
          });
        } else if (resolved.restore) {
          const expanded = (await runNativePython({ changes: resolved.restore })) as typeof parsed;
          if (!expanded.ok) throw new Error(expanded.error);
          commands.splice(index + 1, 0, ...expanded.commands!.map(part => ({ ...part, line: command.line })));
        } else throw new Error("Saved-version resolver returned no changes.");
        continue;
      }
      if (operation === "create_operator" || operation === "update_operator") {
        if (templates.get(id)?.savedResult) throw new Error("Historical result handles are read-only.");
        const existing = nodes.get(id);
        if (operation === "create_operator" && existing)
          throw new Error(`Operator ${id} already exists; use update operator.`);
        if (operation === "update_operator") required(id);
        const view = definition(command, existing?.profileCollection ?? context.settings?.nativeProfileCollection);
        nodes.set(id, view);
        changed.add(id);
        outcomes.push({
          id,
          op: command.statement.op,
          status: existing ? "modified" : "added",
          message: `${existing ? "updated" : "added"} ${command.statement.op} operator \`${id}\``,
        });
        receipts.push({ operation, operator_id: id });
      } else if (operation === "delete_operator") {
        notPart(id);
        const node = required(id);
        if (templates.get(id)?.savedResult) throw new Error("Historical result handles are read-only.");
        // A variant's hidden copies go with it.
        if (node.variant?.name === id)
          for (const [part, view] of [...nodes]) if (part !== id && view.variant?.name === id) removeNode(part);
        const removed = [...edges.values()].filter(e => e.source === id || e.target === id);
        for (const edge of removed) {
          edges.delete(edgeText(edge));
          if (edge.target !== id) changed.add(edge.target);
        }
        nodes.delete(id);
        templates.delete(id);
        changed.add(id);
        receipts.push({ operation, operator_id: id, deleted_edges: removed.map(edgeText) });
        outcomes.push({
          id,
          op: nativeOperatorName(node.type),
          status: "deleted",
          message: `deleted operator \`${id}\``,
        });
      } else {
        const edge: Edge = {
          source: command.source,
          sourcePort: command.sourcePort,
          target: command.target,
          targetPort: command.targetPort,
        };
        edge.source = inputId(command.source);
        // A one-parameter process has one unambiguous input. Store its
        // canonical name so aliases cannot bypass occupancy or deletion.
        const target = required(edge.target);
        if (edge.targetPort === "in" && target.type === "Process" && ports(target).length === 1) {
          edge.targetPort = ports(target)[0];
        }
        const key = edgeText(edge);
        if (operation === "delete_edge") {
          if (!edges.delete(key)) throw new Error(`Edge ${key} does not exist.`);
        } else {
          validateEdge(edge, true);
          if ([...edges.values()].some(e => e.target === edge.target && e.targetPort === edge.targetPort))
            throw new Error(
              `Input ${edge.target}.${edge.targetPort} is occupied. Delete its existing edge before creating a new one.`
            );
          edges.set(key, edge);
        }
        changed.add(edge.target);
        receipts.push({ operation, edge: edgeText({ ...edge, source: command.source }) });
      }
    }
    // A redefined function rebuilds every caller this edit did not restate;
    // they recompute on the next execute, like any in-place update.
    const redefined = [...defined.keys()].filter(name => known.has(name));
    if (redefined.length) {
      location = "Shared functions: ";
      const table = functionTable();
      const functions = parsedFunctions();
      const callers = new Map<string, string[]>();
      for (const [nodeId, view] of nodes) {
        if (pendingInputs.has(nodeId) || !sharedEntry(view)) continue;
        const touched = Object.keys(view.functions ?? {}).filter(name => defined.has(name));
        if (!touched.length) continue;
        const rebuilt = { ...rebuildCaller(nodeId, view, table, functions), graph: view.graph };
        if (definitionKey(rebuilt) === definitionKey(view)) continue;
        nodes.set(nodeId, rebuilt);
        changed.add(nodeId);
        outcomes.push({ id: nodeId, op: "process", status: "modified", message: `updated \`${nodeId}\`: ${touched.join(", ")} changed` });
        receipts.push({ operation: "update_operator", operator_id: nodeId });
        for (const name of touched) callers.set(name, [...(callers.get(name) ?? []), nodeId]);
      }
      for (const name of redefined)
        notes.push(
          `${name} redefined; ${callers.get(name)?.length ? `its callers ${callers.get(name)!.join(", ")} recompute on the next execute` : "no other operator calls it"}. Results saved by earlier tasks stay readable as name@N.`
        );
    }
    // Inputs become edges once every definition and deletion is known; a
    // statement that reads a variant of this edit is wired once it exists.
    const wire = (entries: Array<[string, { inputs: string[]; line: number }]>) => {
    for (const [id, { inputs, line }] of entries) {
      location = `Line ${line}: `;
      const view = required(id);
      const sources = inputs.map(address => {
        const source = inputId(address);
        if (!nodes.has(source))
          throw new Error(
            `${id}'s input \`${address}\` is not an operator. Operators: ${[...nodes.keys()].filter(key => !templates.get(key)?.savedResult).join(", ")}.`
          );
        return source;
      });
      const portNames = ports(view);
      const wanted: Edge[] = sources.map((source, i) => ({ source, sourcePort: "out", target: id, targetPort: portNames[i] }));
      const keys = new Set(wanted.map(edgeText));
      for (const [key, edge] of [...edges]) {
        if (edge.target !== id || keys.has(key)) continue;
        edges.delete(key);
        changed.add(id);
        receipts.push({ operation: "delete_edge", edge: key });
      }
      wanted.forEach((edge, i) => {
        if (edges.has(edgeText(edge))) return;
        edges.set(edgeText(edge), edge);
        changed.add(id);
        receipts.push({ operation: "create_edge", edge: edgeText({ ...edge, source: inputs[i] }) });
      });
    }
    };
    const variants = deferred.filter(({ command }) => command.operation !== "commit");
    const variantNames = new Set(variants.map(({ command }) => command.id));
    const readsVariant = ([, { inputs }]: [string, { inputs: string[] }]) => inputs.some(name => variantNames.has(name));
    wire([...pendingInputs].filter(entry => !readsVariant(entry)));
    for (const { command, index } of variants) {
      location = `Change ${index + 1} (line ${command.line}): `;
      expandVariant(command);
    }
    wire([...pendingInputs].filter(readsVariant));
    for (const { command, index } of deferred.filter(({ command }) => command.operation === "commit")) {
      location = `Change ${index + 1} (line ${command.line}): `;
      commitTable(command);
    }
    if (defined.size) {
      location = "Shared functions: ";
      const used = new Set<string>();
      for (const view of nodes.values()) for (const name of Object.keys(view.functions ?? {})) used.add(name);
      const unused = [...defined.keys()].filter(name => !used.has(name));
      if (unused.length)
        throw new Error(
          `${unused.join(", ")} ${unused.length > 1 ? "are" : "is"} defined but never used. Call a shared function as an operator, \`table = ${unused[0]}(input, ...)\`, or from another shared function.`
        );
      // A new function that mostly repeats an existing one: say which, so the
      // rule changes in one place instead of in copies.
      for (const [name, fn] of defined) {
        if (known.has(name)) continue;
        let best = { score: 0, other: "" };
        for (const [other, existing] of known) {
          const score = similarity(fn.source, existing.source);
          if (score > best.score) best = { score, other };
        }
        for (const op of original.operators) {
          const view = op.nativeOp;
          if (view?.type !== "Process" || sharedEntry(view)) continue;
          const score = similarity(fn.source, String(view.properties.code ?? ""));
          if (score > best.score) best = { score, other: `the function of ${op.operatorID}` };
        }
        if (best.score >= 0.8)
          notes.push(
            `${name} repeats ${best.other} (${Math.round(best.score * 100)}% identical lines). To change that rule from here on, redefine it in place; for a variant, give it a setting and call it with another value.`
          );
      }
    }
    // A saved-result handle exists only to feed an edge. One left without a
    // consumer (its edge or consumer was deleted) leaves the draft with it.
    for (const [id, template] of templates) {
      if (!template.savedResult || !nodes.has(id)) continue;
      if ([...edges.values()].some(edge => edge.source === id)) continue;
      nodes.delete(id);
      templates.delete(id);
    }
    location = "Resulting graph: ";
    for (const [id, view] of nodes) {
      if (view.type === "Union") {
        const indices = [...edges.values()]
          .filter(e => e.target === id)
          .map(e => Number(e.targetPort.match(/^in\[(\d+)\]$/)?.[1] ?? -1));
        view.graph = { inputPorts: indexed(Math.max(2, ...indices.map(i => i + 1))) };
      }
    }
    for (const edge of edges.values()) validateEdge(edge);
    const pending = new Set(nodes.keys());
    const ordered: string[] = [];
    while (pending.size) {
      const roots = [...pending].filter(id => ![...edges.values()].some(e => e.target === id && pending.has(e.source)));
      if (!roots.length) throw new Error(`Edges create a cycle involving ${[...pending].join(", ")}.`);
      roots.forEach(id => {
        pending.delete(id);
        ordered.push(id);
      });
    }
    for (const [id, view] of nodes) {
      view.inputs = ports(view).map(
        port => [...edges.values()].find(e => e.target === id && e.targetPort === port)?.source ?? ""
      );
      view.revision = nativeRevision(view);
    }
    // Missing inputs are permitted in an editable draft, never in execution.
    // Placeholders validate local parameter/Python contracts without pretending
    // that an unconnected node has a materialized upstream table.
    const validationViews = new Map(
      [...nodes].map(([id, view]) => [
        id,
        {
          ...view,
          inputs: view.inputs.map((up, i) => up || `_unconnected_${i}`),
        },
      ])
    );
    const validation = await validateNativeOperators([...validationViews].map(([id, view]) => ({ id, view })));
    const failure = validation.findIndex(d => d !== undefined);
    if (failure >= 0) throw new Error(`${[...nodes.keys()][failure]}: ${validation[failure]!.message}`);
    const draft = new WorkflowState();
    draft.setWorkflowContent(original);
    for (const old of draft.getAllOperators()) if (!nodes.has(old.operatorID)) draft.deleteOperator(old.operatorID);
    for (const link of draft.getAllLinks()) draft.deleteLink(link.linkID);
    const util = new WorkflowUtilService(context.metadataStore, draft);
    for (const id of ordered) {
      const view = nodes.get(id)!;
      if (context.settings?.nativeChecks) {
        view.lineage = nativeLineage(draft, view);
        validationViews.get(id)!.lineage = view.lineage;
      }
      const compiled = compileNativeOp(validationViews.get(id)!, id);
      const old = templates.get(id);
      const template =
        old?.operatorType === compiled.operatorType ? old : util.getNewOperatorPredicate(compiled.operatorType, id);
      draft.addOperator(
        {
          ...template,
          operatorID: id,
          nativeOp: view,
          customDisplayName: `${id}: ${view.source ?? nativeOperatorName(view.type)}`,
          operatorProperties: { ...template.operatorProperties, code: compiled.code },
          inputPorts: ports(view).map((name, i) => ({
            portID: `input-${i}`,
            displayName: name,
            disallowMultiInputs: true,
            isDynamicPort: i > 0,
          })),
          outputPorts: [{ portID: "output-0", displayName: "out" }],
        },
        draft.getOperatorPosition(id)
      );
    }
    for (const [id, edge] of edges)
      draft.addLink({
        linkID: id,
        source: { operatorID: edge.source, portID: "output-0" },
        target: { operatorID: edge.target, portID: `input-${ports(nodes.get(edge.target)!).indexOf(edge.targetPort)}` },
      });
    for (const id of changed) {
      if (nodes.has(id) && !outcomes.some(o => o.id === id) && !partOf(id))
        outcomes.push({
          id,
          op: nativeOperatorName(nodes.get(id)!.type),
          status: "modified",
          message: `changed input connections for \`${id}\``,
        });
    }
    autoLayoutWorkflow(draft);
    const workflow = draft.getWorkflowContent();
    return {
      workflow,
      operators: outcomes,
      changes: receipts,
      unconnected_inputs: missingGraphInputs(workflow),
      invalidated_results: [...computeStaleResultOps(original, workflow)].filter(id =>
        original.operators.some(o => o.operatorID === id)
      ),
      ...(versions.length
        ? { versions, forks, ordered_versions: true as const, applied: parsed.commands!.length }
        : {}),
      ...(notes.length ? { notes } : {}),
    };
  } catch (error) {
    throw new Error(
      `${location}${(error instanceof Error ? error.message : String(error))
        .replace(/\bprogram\b/gi, "operator definition")
        // Saved references are parsed as placeholders; show them as written.
        .replace(/\b__saved_(\w+?)__(\d+)\b/g, "$1@$2")} No changes were applied.`
    );
  }
}
