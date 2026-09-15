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
import { nativeOperators, NATIVE_ID_RE, type NativeOpView } from "./catalog";

export interface RecipeReuse {
  recipe: string;
  targets: string[];
  bind: Record<string, string>;
  prefix: string;
}

/** Definition snapshots, not snapshots of file bytes or promises of successful
 * execution. Binding a node cuts off its saved ancestors. Unbound definitions
 * are restored where live ancestry changed, and shared where it still matches.
 * Execution/cache validity remains the engine's responsibility.
 */
export class NativeRecipeStore {
  private recipes = new Map<string, Map<string, NativeOpView>>();
  clear() { this.recipes.clear(); }
  has(name: string) { return this.recipes.has(name); }
  save(name: string, graph: Map<string, NativeOpView>) {
    if (!NATIVE_ID_RE.test(name)) throw new Error("Recipe name must be a valid operator-style identifier");
    if (this.has(name)) throw new Error(`Recipe '${name}' already exists; choose a new name.`);
    const seen = new Set<string>(), active = new Set<string>();
    const visit = (id: string) => {
      if (active.has(id)) throw new Error(`Recipe cycle at '${id}'`);
      if (seen.has(id)) return;
      const view = graph.get(id);
      if (!view) throw new Error(`Recipe input '${id}' is missing`);
      active.add(id);
      view.inputs.forEach(visit);
      active.delete(id); seen.add(id);
    };
    graph.forEach((_, id) => visit(id));
    this.recipes.set(name, structuredClone(graph));
  }

  expand(request: RecipeReuse, live: Map<string, NativeOpView>) {
    const saved = this.recipes.get(request.recipe);
    if (!saved) throw new Error(`Unknown recipe '${request.recipe}'`);
    if (!NATIVE_ID_RE.test(request.prefix)) throw new Error("Invalid reuse prefix");
    if (!request.targets.length) throw new Error("reuse.targets must not be empty");
    for (const [old, fresh] of Object.entries(request.bind)) {
      if (!saved.has(old)) throw new Error(`Recipe has no node '${old}'`);
      if (!live.has(fresh)) throw new Error(`Binding target '${fresh}' is missing`);
      if ((saved.get(old)!.version ?? "v1") !== (live.get(fresh)!.version ?? "v1"))
        throw new Error("Cannot bind across native catalog versions");
    }
    const mapped = new Map<string, string>(), usedBindings = new Set<string>();
    const operators: Array<Record<string, unknown>> = [];
    const resolve = (id: string): string => {
      if (mapped.has(id)) return mapped.get(id)!;
      if (Object.hasOwn(request.bind, id)) {
        usedBindings.add(id); mapped.set(id, request.bind[id]); return request.bind[id];
      }
      const view = saved.get(id);
      if (!view) throw new Error(`Recipe has no node '${id}'`);
      const inputs = view.inputs.map(resolve);
      const current = live.get(id);
      if (current && JSON.stringify(current) === JSON.stringify(view) && inputs.every((up, i) => up === view.inputs[i])) {
        mapped.set(id, id); return id;
      }
      const fresh = `${request.prefix}_${id}`;
      if (!NATIVE_ID_RE.test(fresh) || live.has(fresh)) throw new Error(`Replay output '${fresh}' exists or is invalid; choose a fresh prefix.`);
      const properties = structuredClone(view.properties);
      if (view.type === "UDF" && inputs.some((up, i) => up !== view.inputs[i])) {
        // Preserve arbitrary Python source, including strings and nested scopes.
        // A positional adapter is safer than textual identifier substitution.
        properties.code = `def process(${inputs.join(", ")}):\n    _recipe_scope = dict(globals())\n    exec(${JSON.stringify(String(properties.code))}, _recipe_scope, _recipe_scope)\n    return _recipe_scope["process"](${inputs.join(", ")})`;
      }
      const def = nativeOperators(view.version ?? "v1").find(def => def.type === view.type);
      if (!def) throw new Error(`Unknown recipe operator type '${view.type}'`);
      const spec: Record<string, unknown> = {
        op: view.type.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase(), id: fresh, ...properties,
      };
      if (def.inputs === 1) spec.input = inputs[0];
      else if (def.inputs === 2) [spec.left, spec.right] = inputs;
      else if (def.inputs === "many") spec.inputs = inputs;
      operators.push(spec); mapped.set(id, fresh); return fresh;
    };
    const targets = request.targets.map(resolve);
    for (const old of Object.keys(request.bind)) {
      if (!usedBindings.has(old)) throw new Error(`Binding '${old}' is unused in the selected recipe slice`);
    }
    return { operators, targets, bindings: { ...request.bind } };
  }
}

export const RECIPE_GUIDANCE = `\n### Saved recipes (experimental)
dataflow can save immutable operator definitions with save_as: "name" alongside the ordinary operators/observe fields. Save useful definitions when first built; names cannot be overwritten. A recipe is a computation, not frozen file bytes or a certified result.
For a later counterfactual or changed data source, use reuse: {recipe: "name", targets: ["old_output_id"], bind: {old_boundary_id: "replacement_live_id"}, prefix: "fresh_name"}. Bindings explicitly declare which existing tables the new computation consumes. Unbound saved definitions are restored if changed. The service clones only the required slice and automatically observes its requested targets. Replacement tables may be created in operators in the same call; use operators:[] when they already exist. All generated IDs are prefix_old_id. Existing branches are preserved.
Keep data, cohort membership, computation definitions, and published baseline results distinct. A new table can replace a boundary without inheriting the old table's membership. Use native operations for relational steps and UDF for domain computations; recipes support both.\n`;
