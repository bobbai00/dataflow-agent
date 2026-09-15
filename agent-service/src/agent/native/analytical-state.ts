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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { NATIVE_ID_RE, type NativeOpView } from "./catalog";
import { nativeViewOf } from "../tools/native-typed-tools";
import type { OperatorInfo } from "../../types/execution";

type Graph = Map<string, NativeOpView>;
type Binding = string | { operator: string; membership?: { operator: string; keys: string[] } };
export interface StateRequest {
  publish?: { name: string; inputs?: Record<string, string>; outputs: Record<string, string> };
  revise?: {
    analysis: string;
    base?: string;
    scope: "active" | "temporary";
    bindings?: Record<string, Binding>;
    overrides?: Record<string, Record<string, unknown>>;
  };
}
export interface StateReceipt {
  version: string;
  status: "pending" | "committed" | "failed";
  scope: "active" | "temporary";
  outputs: Record<string, string>;
  created: string[];
  reused: string[];
  error?: string;
  opaqueOperators: string[];
}
interface AnalysisVersion {
  name: string;
  version: string;
  definitions: Graph;
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  physical: Map<string, string>;
  boundaries: Map<string, string>;
  actual: Graph;
  sources: Map<string, string>;
}
const clone = <T>(value: T): T => structuredClone(value);
const semantics = (v: NativeOpView) =>
  JSON.stringify({ type: v.type, version: v.version ?? "v1", inputs: v.inputs, properties: v.properties });
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function ancestors(graph: Graph, targets: string[]): Graph {
  const result: Graph = new Map(),
    active = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) throw new Error(`State dependency cycle at '${id}'`);
    if (result.has(id)) return;
    const node = graph.get(id);
    if (!node) throw new Error(`Unknown state input '${id}'`);
    active.add(id);
    node.inputs.forEach(visit);
    active.delete(id);
    result.set(id, clone(node));
  };
  targets.forEach(visit);
  return result;
}

function sourceHashes(graph: Graph): Map<string, string> {
  const sources = new Map<string, string>();
  for (const node of graph.values())
    if (node.type === "Scan") {
      const files = node.properties.files;
      for (const file of Array.isArray(files) ? files : [files]) {
        if (typeof file !== "string" || !file || /[*?{}]/.test(file))
          throw new Error("Managed analyses currently require explicit local Scan files, not globs or remote sources");
        const path = isAbsolute(file)
          ? file
          : resolve(process.env.TEXERA_HOME ?? resolve(import.meta.dir, "../../../.."), file);
        sources.set(path, hash(path));
      }
    }
  return sources;
}

/** Experimental in-session state. Definitions and physical node IDs are pinned;
 * active references are promoted only after version-bound results succeed.
 * Local Scan content is checked, while arbitrary UDF side effects remain opaque.
 */
export class AnalyticalStateStore {
  private versions = new Map<string, AnalysisVersion>();
  private active = new Map<string, string>();
  private locked = new Set<string>();
  private counts = new Map<string, number>();
  private sequence = 0;
  private pending = new Map<string, { version: AnalysisVersion; planned: Graph; receipt: StateReceipt }>();

  hasState() {
    return this.versions.size > 0 || this.pending.size > 0;
  }
  clear() {
    this.versions.clear();
    this.active.clear();
    this.locked.clear();
    this.counts.clear();
    this.pending.clear();
    this.sequence = 0;
  }
  assertWritable(ids: string[]) {
    for (const id of ids)
      if (this.locked.has(id))
        throw new Error(
          `Operator '${id}' belongs to immutable analytical state; use revise with a binding or override`
        );
  }
  catalog() {
    return {
      active: Object.fromEntries(this.active),
      versions: [...this.versions.values()].map(v => ({
        version: v.version,
        inputs: v.inputs,
        outputs: Object.fromEntries(
          Object.entries(v.outputs).map(([name, logical]) => [name, v.physical.get(logical)!])
        ),
        nodes: Object.fromEntries([...v.definitions].map(([id, node]) => [id, node.type])),
      })),
    };
  }

  prepare(request: StateRequest, live: Graph) {
    if (!!request.publish === !!request.revise) throw new Error("Choose exactly one of publish or revise");
    if (this.pending.size) throw new Error("An analytical-state operation is still pending execution");
    const pub = request.publish,
      revision = request.revise;
    let name: string, definitions: Graph, inputs: Record<string, string>, outputs: Record<string, string>;
    let base: AnalysisVersion | undefined;
    if (pub) {
      name = pub.name;
      if (!NATIVE_ID_RE.test(name) || this.active.has(name))
        throw new Error("Publish requires a fresh valid analysis name");
      if (!Object.keys(pub.outputs ?? {}).length) throw new Error("Publish requires named outputs");
      outputs = clone(pub.outputs);
      inputs = clone(pub.inputs ?? {});
      definitions = ancestors(live, Object.values(outputs));
      for (const id of Object.values(inputs))
        if (!definitions.has(id)) throw new Error(`Formal input '${id}' is outside the published outputs`);
    } else {
      name = revision!.analysis;
      const ref = revision!.base ?? this.active.get(name);
      base = ref ? this.versions.get(ref) : undefined;
      if (!base || base.name !== name) throw new Error(`Unknown analysis/version '${ref ?? name}'`);
      if (!["active", "temporary"].includes(revision!.scope))
        throw new Error("revise.scope must be active or temporary");
      for (const [path, expected] of base.sources)
        if (hash(path) !== expected)
          throw new Error(`Pinned source content changed: ${path}; restore it and use a new file version`);
      for (const [id, node] of base.actual)
        if (!live.has(id) || semantics(live.get(id)!) !== semantics(node))
          throw new Error(`Pinned graph changed at '${id}'`);
      definitions = clone(base.definitions);
      inputs = clone(base.inputs);
      outputs = clone(base.outputs);
    }
    const overrides = revision?.overrides ?? {},
      boundaries = clone(base?.boundaries ?? new Map<string, string>());
    for (const [id, properties] of Object.entries(overrides)) {
      const node = definitions.get(id);
      if (!node) throw new Error(`Unknown definition node '${id}'`);
      if (Object.keys(properties).some(k => ["id", "op", "input", "inputs", "left", "right"].includes(k)))
        throw new Error("Overrides change parameters, not operator identity or wiring; use bindings for inputs");
      node.properties = { ...node.properties, ...clone(properties) };
    }
    const serial = ++this.sequence,
      prefix = `state_${serial}`;
    const planned = clone(live),
      operators: Array<Record<string, unknown>> = [],
      physical = new Map<string, string>();
    const add = (spec: Record<string, unknown>) => {
      if (planned.has(String(spec.id))) throw new Error(`Generated state ID '${spec.id}' already exists`);
      const { op, ...params } = spec;
      const view = nativeViewOf(String(op), params, "v2");
      if (!view) throw new Error(`Unknown state operator '${op}'`);
      planned.set(String(spec.id), view);
      operators.push(spec);
    };
    for (const [role, binding] of Object.entries(revision?.bindings ?? {})) {
      const boundary = inputs[role];
      if (!boundary) throw new Error(`Unknown formal input '${role}'`);
      let id = typeof binding === "string" ? binding : binding.operator;
      if (!live.has(id)) throw new Error(`Unknown binding input '${id}'`);
      if (typeof binding !== "string" && binding.membership) {
        const { operator, keys } = binding.membership;
        if (
          !live.has(operator) ||
          !Array.isArray(keys) ||
          !keys.length ||
          keys.some(k => typeof k !== "string" || !k) ||
          new Set(keys).size !== keys.length
        )
          throw new Error("Membership requires an existing operator and distinct key column names");
        const keyId = `${prefix}_keys_${operators.length}`,
          distinct = `${keyId}_distinct`,
          filtered = `${keyId}_values`;
        add({ op: "project", id: keyId, input: operator, keep: keys });
        add({ op: "distinct", id: distinct, input: keyId, columns: keys });
        add({ op: "join", id: filtered, left: id, right: distinct, on: keys, type: "inner", validate: "many_to_one" });
        id = filtered;
      }
      boundaries.set(boundary, id);
    }
    for (const id of Object.keys(overrides))
      if (boundaries.has(id)) throw new Error(`Cannot override a bound input '${id}'`);
    const used = new Set<string>(),
      visiting = new Set<string>();
    const resolveNode = (id: string): string => {
      if (physical.has(id)) return physical.get(id)!;
      used.add(id);
      if (boundaries.has(id)) {
        physical.set(id, boundaries.get(id)!);
        return boundaries.get(id)!;
      }
      if (visiting.has(id)) throw new Error(`State cycle at '${id}'`);
      const node = definitions.get(id);
      if (!node) throw new Error(`Missing definition '${id}'`);
      visiting.add(id);
      const upstream = node.inputs.map(resolveNode);
      visiting.delete(id);
      const oldId = base?.physical.get(id) ?? id,
        old = live.get(oldId);
      const sameDefinition = !base || semantics(node) === semantics(base.definitions.get(id)!);
      if (old && sameDefinition && upstream.every((p, i) => p === old.inputs[i])) {
        physical.set(id, oldId);
        return oldId;
      }
      const newId = `${prefix}_${id}`,
        properties = clone(node.properties);
      if (node.type === "UDF" && upstream.some((p, i) => p !== node.inputs[i])) {
        properties.code = `def process(${upstream.join(", ")}):\n    _state_scope = dict(globals())\n    exec(${JSON.stringify(String(properties.code))}, _state_scope, _state_scope)\n    return _state_scope["process"](${upstream.join(", ")})`;
      }
      const spec: Record<string, unknown> = {
        op: node.type.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(),
        id: newId,
        ...properties,
      };
      if (node.type === "Join") [spec.left, spec.right] = upstream;
      else if (["UDF", "Union"].includes(node.type)) {
        if (upstream.length) spec.inputs = upstream;
      } else if (upstream.length) spec.input = upstream[0];
      add(spec);
      physical.set(id, newId);
      return newId;
    };
    const resolvedOutputs = Object.fromEntries(Object.entries(outputs).map(([label, id]) => [label, resolveNode(id)]));
    for (const role of Object.keys(revision?.bindings ?? {}))
      if (!used.has(inputs[role])) throw new Error(`Unused binding input '${role}'`);
    for (const id of Object.keys(overrides)) if (!used.has(id)) throw new Error(`Unused override '${id}'`);
    const actual = ancestors(planned, Object.values(resolvedOutputs));
    if ([...actual.values()].some(v => v.version !== "v2"))
      throw new Error("Managed analyses require the V2 native catalog");
    const number = (this.counts.get(name) ?? 0) + 1,
      version = `${name}@${number}`;
    const record: AnalysisVersion = {
      name,
      version,
      definitions,
      inputs,
      outputs,
      physical,
      boundaries,
      actual,
      sources: sourceHashes(actual),
    };
    const created = operators.map(op => String(op.id));
    const receipt: StateReceipt = {
      version,
      scope: revision?.scope ?? "active",
      status: "pending",
      outputs: resolvedOutputs,
      created,
      reused: [...actual.keys()].filter(id => !created.includes(id)),
      opaqueOperators: [...actual].filter(([, v]) => v.type === "UDF").map(([id]) => id),
    };
    this.counts.set(name, number);
    this.pending.set(version, { version: record, planned: actual, receipt });
    return { operators, planned, receipt };
  }

  finish(receipt: StateReceipt, live: Graph, results: ReadonlyMap<string, OperatorInfo>, failure?: string) {
    const pending = this.pending.get(receipt.version);
    if (!pending || pending.receipt !== receipt) return;
    try {
      if (failure) throw new Error(failure);
      for (const [path, expected] of pending.version.sources)
        if (hash(path) !== expected) throw new Error("Source changed during execution");
      for (const [id, expected] of pending.planned) {
        const node = live.get(id);
        if (!node || semantics(node) !== semantics(expected))
          throw new Error(`Requested definition did not land: ${id}`);
      }
      for (const id of Object.values(receipt.outputs)) {
        const info = results.get(id),
          node = live.get(id);
        if (
          !info ||
          info.error ||
          !Array.isArray(info.result) ||
          !info.resultVersion?.complete ||
          info.resultVersion.operatorId !== id ||
          info.resultVersion.operatorRevision !== node?.revision
        )
          throw new Error(`Output '${id}' has no successful result bound to the requested version`);
      }
      pending.version.actual = ancestors(live, Object.values(receipt.outputs));
      for (const id of pending.version.actual.keys()) this.locked.add(id);
      this.versions.set(receipt.version, pending.version);
      if (receipt.scope === "active") this.active.set(pending.version.name, receipt.version);
      receipt.status = "committed";
    } catch (error: any) {
      receipt.status = "failed";
      receipt.error = error.message;
    } finally {
      this.pending.delete(receipt.version);
    }
  }
}

export const ANALYTICAL_STATE_GUIDANCE = `
### Versioned analyses
Use dataflow.publish:{name,inputs:{role:operator_id},outputs:{label:operator_id}} to register a reusable analysis after computing it. Published definitions and their ancestors become immutable; active references advance only after successful execution. Local Scan files must remain unchanged; use a new file path for a new data version. UDF side effects remain opaque.
Use dataflow.revise:{analysis,base?,scope:"active"|"temporary",bindings?:{role:operator_id},overrides?:{original_node_id:{property:value}}} to apply a change. base defaults to the active version; an explicit version such as report@1 restores its definition. All named outputs are maintained automatically; unchanged branches are shared. Overrides use the original logical node names shown in the catalog, not generated physical IDs. A temporary revision preserves the active version. Include operators:[] or create replacement inputs in the same call. Do not rewrite downstream operators.
For old membership with new values, use a binding {operator:"new_values",membership:{operator:"old_members",keys:["id"]}}. The runtime takes only distinct membership keys and joins them to the value table, so old metric columns cannot leak into the calculation. Bind at the analysis input boundary that already represents the cohort when membership is fixed; bind the raw source when eligibility should be recomputed.
Use dataflow with operators:[] and state_catalog:true to list active and historical versions and their output IDs. Observe those physical IDs normally. A failed publication/revision is not active; read its receipt and correct the request.\n`;
