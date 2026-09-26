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
 * The definition registry: the graph presented as versioned analytical
 * definitions instead of as a transcript of operators.
 *
 * LongDS requests are written in this vocabulary ("the equal-weight form
 * introduced earlier, not the currently active weighted form"; "roll back only
 * the adopter side to the AutoML-only view"), and the saved graphs already hold
 * every version they name: an id reassigned in place (`age_grouped_data` five
 * bands, then four) and a new name beside an old one (`composite_scored_data`,
 * then `weighted_composite_data`). Nothing named them as versions of one
 * definition, so the agent rebuilt them or copied numbers. Here a version is a
 * runtime fact: an in-place revision comes from task provenance, a new-name
 * version from an explicit `supersede` declaration. A `bind` evaluates an
 * existing computation under chosen versions through the existing restore and
 * fork planners; `explain` reads a result's lineage with the version of each
 * definition it consumed.
 */
import type { OperatorInfo } from "../../types/execution";
import type { OperatorPredicate } from "../../types/workflow";
import type { WorkflowState } from "../workflow-state";
import { NATIVE_ID_RE } from "./catalog";
import type { TaskHistory } from "./task-history";
import type { AnalysisFork } from "./analysis-state";
import type { RestoreRequest } from "./task-restore";
import { TASK_SOURCE_PREFIX } from "./task-reference";
import { renderRegisteredOperators } from "./registered-operators";
import { flagAlerts } from "./task-entries";

export interface DefinitionVersion {
  /** 1-based, in creation order. */
  k: number;
  /** The table holding this version: the definition's id for in-place revisions, another id for a superseding table. */
  table: string;
  /** The task in which this version was established. */
  task: number;
  /** For an in-place revision that is no longer current: the last completed task whose retained output is this version. */
  savedAt?: number;
  /** The one-sentence doc of the operator, when it has one. */
  doc?: string;
  /** Whether current consumers read this version (the newest one). */
  active: boolean;
  /** An in-place revision of the same id (true) or a distinct table (false). */
  sameId: boolean;
}

export interface Definition {
  name: string;
  versions: DefinitionVersion[];
}

export interface BindRequest {
  target: string;
  as: string;
  /** definition name → version choice: `v2`, `t11` (the version active at task 11), or a table id. */
  versions: Record<string, string>;
}

export interface BindPlan {
  restores: RestoreRequest[];
  forks: AnalysisFork[];
  errors: Array<{ id: string; message: string }>;
  /** What each bind resolved to, for the receipt. */
  notes: string[];
}

interface Supersede {
  of: string;
  task: number;
}

const docOf = (op: OperatorPredicate | undefined): string | undefined => {
  const doc = op?.nativeOp?.properties?.doc;
  return typeof doc === "string" && doc.trim() ? doc.trim() : undefined;
};

/** Session state: the explicit supersede declarations. Everything else about
 * versions is read from the graph and the task history when rendered. */
export class DefinitionRegistry {
  private readonly supersedes = new Map<string, Supersede>();
  /** Registered operators: one version per distinct body a name has had. */
  private readonly operators = new Map<string, Array<{ source: string; task: number }>>();
  /** Operators made by `lift`: kept here until a table calls them, so the name resolves. */
  private readonly lifted = new Map<string, { source: string; task: number; from: string }>();

  /** A def called as an operator landed with this body in this task. */
  recordOperator(name: string, source: string, task: number): void {
    const versions = this.operators.get(name) ?? [];
    if (versions.at(-1)?.source !== source) versions.push({ source, task });
    this.operators.set(name, versions);
    const lifted = this.lifted.get(name);
    if (lifted && lifted.source !== source) this.lifted.set(name, { ...lifted, source });
  }

  /** `lift` made `name` from the def `from` in this task. */
  recordLift(name: string, source: string, task: number, from: string): void {
    this.lifted.set(name, { source, task, from });
    this.recordOperator(name, source, task);
  }

  liftedOperators(): Array<{ name: string; source: string; task: number; from: string }> {
    return [...this.lifted].map(([name, item]) => ({ name, ...item }));
  }

  /** The lifted defs by name, for a compile to resolve calls to them. */
  libraryFunctions(): Record<string, string> {
    return Object.fromEntries([...this.lifted].map(([name, item]) => [name, item.source]));
  }

  /** How many distinct bodies the name has had (1 for a never-revised one). */
  operatorVersion(name: string): number {
    return this.operators.get(name)?.length ?? 1;
  }

  /** Declare `table` the active version of the definition `of` belongs to. */
  supersede(table: string, of: string, task: number): void {
    if (table === of) throw new Error(`\`${table}\` cannot supersede itself; reassign it to revise it in place.`);
    if (this.supersedes.has(table))
      throw new Error(`\`${table}\` already supersedes \`${this.supersedes.get(table)!.of}\`.`);
    // A chain a → b → a would make the definition unnameable.
    let cursor: string | undefined = of;
    while (cursor) {
      if (cursor === table) throw new Error(`\`${table}\` is already an earlier version of \`${of}\`.`);
      cursor = this.supersedes.get(cursor)?.of;
    }
    this.supersedes.set(table, { of, task });
  }

  declarations(): Array<{ table: string; of: string; task: number }> {
    return [...this.supersedes].map(([table, s]) => ({ table, ...s }));
  }

  /** The root id of the definition a table belongs to. */
  definitionOf(table: string): string {
    let cursor = table;
    const seen = new Set<string>();
    while (this.supersedes.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = this.supersedes.get(cursor)!.of;
    }
    return cursor;
  }

  /** Every definition with at least one version, in creation order. A table
   * that is neither revised nor superseded is a definition with one version. */
  definitions(state: WorkflowState, history?: TaskHistory): Map<string, Definition> {
    const provenance = history?.provenance() ?? new Map();
    const result = new Map<string, Definition>();
    const operators = state.getAllOperators().filter(op => !op.taskSource);
    const byId = new Map(operators.map(op => [op.operatorID, op]));
    const ordered = [...operators].sort(
      (a, b) => (provenance.get(a.operatorID)?.created ?? Infinity) - (provenance.get(b.operatorID)?.created ?? Infinity)
    );
    // In-place revisions first: one definition per id, one version per revision.
    for (const op of ordered) {
      const id = op.operatorID;
      const event = provenance.get(id);
      const doc = docOf(op);
      const tasks = event ? [event.created, ...event.edited] : [];
      const versions: DefinitionVersion[] = tasks.length
        ? tasks.map((task, i) => ({
            k: i + 1,
            table: id,
            task,
            active: i === tasks.length - 1,
            sameId: true,
            ...(i < tasks.length - 1 ? { savedAt: lastSaved(history, id, task, tasks[i + 1]) } : {}),
            ...(i === tasks.length - 1 && doc ? { doc } : {}),
          }))
        : [{ k: 1, table: id, task: 0, active: true, sameId: true, ...(doc ? { doc } : {}) }];
      result.set(id, { name: id, versions });
    }
    // Superseding tables fold into the root definition, in declaration order.
    const declarations = [...this.supersedes].sort((a, b) => a[1].task - b[1].task);
    for (const [table, { of, task }] of declarations) {
      const root = this.definitionOf(table);
      const own = result.get(table);
      const definition = result.get(root);
      if (!own || !definition || root === table || !byId.has(table)) continue;
      for (const version of definition.versions) version.active = false;
      // The superseding table keeps its own in-place revisions as further versions.
      for (const version of own.versions) {
        definition.versions.push({
          ...version,
          k: definition.versions.length + 1,
          task: Math.max(version.task, task),
          sameId: false,
          active: version.active,
        });
      }
      result.delete(table);
      void of;
    }
    return result;
  }

  /** The version a live table holds: for an id revised in place, its latest revision. */
  versionOf(table: string, definitions: Map<string, Definition>): { definition: Definition; version: DefinitionVersion } | undefined {
    for (const definition of definitions.values()) {
      const held = definition.versions.filter(version => version.table === table);
      if (held.length) return { definition, version: held[held.length - 1] };
    }
    return undefined;
  }

  /** The `# Definitions` block a task starts from: every definition with its
   * versions, then the remaining current tables, then probe tables no table
   * reads. Frozen for a task; small because it names things, not code. */
  render(state: WorkflowState, results: ReadonlyMap<string, OperatorInfo>, history?: TaskHistory): string {
    const definitions = this.definitions(state, history);
    const operators = state.getAllOperators().filter(op => !op.taskSource);
    if (!operators.length) return "# Definitions\n(none yet)";
    const consumers = new Map<string, number>();
    for (const op of operators)
      for (const input of op.nativeOp?.inputs ?? []) consumers.set(input, (consumers.get(input) ?? 0) + 1);
    const answered = new Set((history?.entries() ?? []).flatMap(entry => entry.from));
    const shape = (id: string) => {
      const info = results.get(id);
      if (!info) return "";
      if (info.error) return "; FAILED";
      const rows = info.totalRowCount;
      return rows === undefined ? "" : rows === 0 ? "; ⚠ 0 rows" : `; rows=${rows}`;
    };
    const versioned: string[] = [];
    const hubs: string[] = [];
    const others: string[] = [];
    const probes: string[] = [];
    for (const definition of definitions.values()) {
      if (definition.versions.length > 1) {
        const parts = definition.versions.map(v => {
          const where = v.sameId ? `t${v.task}` : `${v.table} t${v.task}`;
          const saved = overwritten(definition, v) && v.savedAt !== undefined ? ` [values: at(${v.table}, task=${v.savedAt})]` : "";
          const doc = v.doc ? ` "${clip(v.doc, 110)}"` : "";
          return `v${v.k} ${where}${v.active ? " ACTIVE" : ""}${doc}${saved}${v.active ? shape(v.table) : ""}`;
        });
        versioned.push(`${definition.name}: ${parts.join(" | ")}`);
        continue;
      }
      const [v] = definition.versions;
      const id = v.table;
      const op = state.getOperator(id);
      const reads = consumers.get(id) ?? 0;
      const used = reads > 0 || answered.has(id) || op?.nativeOp?.type === "Parameters";
      if (!used) {
        probes.push(id);
        continue;
      }
      // Docs are what a request phrase is matched against, so they are kept
      // for the tables the analysis stands on: read by several tables, read
      // for an answer, or a parameter table. A table with one reader is named
      // with its task; its entry still holds its statement and doc.
      const hub = reads >= 2 || answered.has(id) || op?.nativeOp?.type === "Parameters";
      if (hub) {
        const doc = v.doc ? ` "${clip(v.doc, 110)}"` : "";
        hubs.push(`${id} (t${v.task}${reads ? `, read by ${reads}` : ""})${doc}${shape(id)}`);
      } else others.push(`${id} (t${v.task})${shape(id)}`);
    }
    const lines = [
      "# Definitions at the start of this task",
      "A definition is a table with versions; ACTIVE is what current tables read. Every version is a table you can bind to or read; a superseded in-place version keeps its saved values.",
    ];
    if (versioned.length) lines.push("Versioned:", ...versioned);
    lines.push(...renderRegisteredOperators(state, name => this.operatorVersion(name), this));
    if (hubs.length) lines.push("Tables the analysis stands on:", hubs.join("\n"));
    if (others.length) lines.push(`Other current tables (their entries hold the definitions): ${others.join(" · ")}`);
    if (probes.length) lines.push(`Not read by any table (probes and reports; observe by name): ${probes.join(", ")}`);
    const alerts = operators.flatMap(op => {
      const info = results.get(op.operatorID);
      if (info?.error) return [`⚠ ${op.operatorID} failed; its dependents have no current result`];
      return [];
    });
    return [...lines, ...alerts, ...flagAlerts(operators, results)].join("\n");
  }

  /** `explain`: a result's lineage with the version of each definition it read. */
  explain(state: WorkflowState, id: string, history?: TaskHistory): string {
    const op = state.getOperator(id);
    if (!op || op.taskSource) return `No current table \`${id}\`.`;
    const definitions = this.definitions(state, history);
    const lines: string[] = [`Lineage of ${id}:`];
    const seen = new Set<string>();
    const visit = (table: string, depth: number) => {
      if (seen.has(table) || depth > 12) return;
      seen.add(table);
      const node = state.getOperator(table);
      const found = this.versionOf(table, definitions);
      const view = node?.nativeOp;
      const head = (view?.source ?? `${table} = ${view?.type ?? "?"}`).split("\n").find(l => /^\s*[A-Za-z_]\w*\s*=/.test(l)) ?? table;
      const tag = found
        ? found.definition.versions.length > 1
          ? ` [${found.definition.name} v${found.version.k}${found.version.active ? ", active" : `, superseded by v${found.definition.versions.find(v => v.active)?.k ?? "?"}`}]`
          : ""
        : node?.taskSource
          ? ` [saved values of ${node.taskSource.operator} at task ${node.taskSource.atTask}]`
          : "";
      lines.push(`${"  ".repeat(depth)}${clip(head, 160)}${tag}`);
      for (const input of view?.inputs ?? []) visit(input, depth + 1);
    };
    visit(id, 0);
    const stale = lines.filter(l => l.includes(", superseded by"));
    if (stale.length) lines.push(`Note: ${stale.length} ancestor(s) read a superseded version; bind or reassign if the current version was intended.`);
    return lines.join("\n");
  }

  /** Turn `bind` requests into the restore and fork requests that realize them. */
  plan(requests: BindRequest[], state: WorkflowState, history?: TaskHistory): BindPlan {
    const plan: BindPlan = { restores: [], forks: [], errors: [], notes: [] };
    const definitions = this.definitions(state, history);
    const occupied = new Set(state.getAllOperators().map(op => op.operatorID));
    for (const request of requests) {
      try {
        if (!NATIVE_ID_RE.test(request.as) || request.as.startsWith(TASK_SOURCE_PREFIX) || occupied.has(request.as))
          throw new Error(`\`${request.as}\` must be a new valid table name.`);
        const target = state.getOperator(request.target);
        if (!target?.nativeOp) throw new Error(`No current table \`${request.target}\` to bind.`);
        if (!request.versions || !Object.keys(request.versions).length)
          throw new Error("bind needs versions: {definition: version}.");
        const ancestors = new Set<string>();
        const walk = (table: string) => {
          for (const input of state.getOperator(table)?.nativeOp?.inputs ?? []) {
            if (ancestors.has(input)) continue;
            ancestors.add(input);
            walk(input);
          }
        };
        walk(request.target);
        const bindings: Record<string, string> = {};
        for (const [name, choice] of Object.entries(request.versions)) {
          const definition = definitions.get(name) ?? definitions.get(this.definitionOf(name));
          if (!definition) throw new Error(`No definition \`${name}\`; definitions are named by their first table.`);
          // A live table holds its latest revision, so among the versions the
          // target reads, the one it actually consumes is the newest per table.
          const read = definition.versions.filter(v => ancestors.has(v.table));
          const consumed = read.length ? read.reduce((a, b) => (b.table === a.table ? b : a.active ? a : b.active ? b : b)) : undefined;
          if (!consumed)
            throw new Error(`\`${request.target}\` does not read any version of \`${definition.name}\`; it reads ${[...ancestors].join(", ") || "nothing"}.`);
          const chosen = resolveVersion(definition, choice);
          if (!chosen) {
            // Not a declared version: an existing table can still stand in for
            // the consumed one (the model built a successor without declaring
            // it). Bind it as a plain replacement and say how to declare it.
            const table = String(choice).trim();
            if (state.getOperator(table) && !table.startsWith(TASK_SOURCE_PREFIX) && table !== consumed.table) {
              bindings[consumed.table] = table;
              plan.notes.push(
                `${request.as}: ${definition.name} v${consumed.k} → table ${table} (not a declared version; supersede={"${table}": "${consumed.table}"} would make it v${definition.versions.length + 1})`
              );
              continue;
            }
            throw new Error(
              `\`${definition.name}\` has no version ${JSON.stringify(choice)}; versions: ${definition.versions.map(v => `v${v.k} (${v.sameId ? "t" + v.task : v.table})`).join(", ")}.`
            );
          }
          if (chosen.k === consumed.k) {
            plan.notes.push(`${request.as}: \`${request.target}\` already reads ${definition.name} v${chosen.k}`);
            continue;
          }
          let replacement: string;
          if (overwritten(definition, chosen)) {
            // An earlier in-place revision: rebuild that definition on the current
            // inputs under its own name, then bind the target to it.
            const restoreTask = chosen.savedAt ?? chosen.task;
            const saved = history?.definition(chosen.table, restoreTask);
            if (!saved)
              throw new Error(`\`${definition.name}\` v${chosen.k} has no saved definition to rebuild (task ${restoreTask}).`);
            replacement = `${chosen.table}__v${chosen.k}`;
            if (!occupied.has(replacement)) {
              plan.restores.push({ operator: chosen.table, task: restoreTask, as: replacement });
              occupied.add(replacement);
            }
          } else replacement = chosen.table;
          bindings[consumed.table] = replacement;
          plan.notes.push(`${request.as}: ${definition.name} v${consumed.k} → v${chosen.k} (${replacement})`);
        }
        if (!Object.keys(bindings).length)
          throw new Error(`\`${request.target}\` already reads every requested version; observe it instead.`);
        plan.forks.push({ operator: request.target, as: request.as, bindings });
        occupied.add(request.as);
      } catch (error) {
        plan.errors.push({ id: request.as, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return plan;
  }
}

/** A version whose table id a later revision reused: its live table no longer holds it. */
function overwritten(definition: Definition, version: DefinitionVersion): boolean {
  return definition.versions.some(later => later.k > version.k && later.table === version.table);
}

function resolveVersion(definition: Definition, choice: string): DefinitionVersion | undefined {
  const text = String(choice).trim();
  const byNumber = /^v(\d+)$/i.exec(text);
  if (byNumber) return definition.versions.find(v => v.k === Number(byNumber[1]));
  const byTask = /^t(\d+)$/i.exec(text);
  if (byTask) {
    const task = Number(byTask[1]);
    return [...definition.versions].reverse().find(v => v.task <= task);
  }
  if (/^(active|current|latest)$/i.test(text)) return definition.versions.find(v => v.active);
  return definition.versions.find(v => v.table === text);
}

/** The last completed task before `until` (exclusive) holding a retained output of `id`. */
function lastSaved(history: TaskHistory | undefined, id: string, from: number, until: number | undefined): number | undefined {
  if (!history) return undefined;
  const tasks = history.available(id).filter(task => task >= from && (until === undefined || task < until));
  return tasks.length ? Math.max(...tasks) : undefined;
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : flat.slice(0, limit - 1) + "…";
}
