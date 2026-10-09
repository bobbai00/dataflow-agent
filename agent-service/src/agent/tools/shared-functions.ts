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
 * Shared functions: a `def` at the margin of an edit, with a docstring, is
 * called by name like an operator (`scores = score(orders, weight=0.7)`). Its
 * leading parameters without defaults are the input tables, in order; the
 * parameters with defaults are settings, passed by name and shown in the
 * operator's definition. Each call compiles to a process carrying the
 * function and every margin helper it mentions, so the engine runs it alone.
 *
 * The graph is the registry: a function exists while some operator calls it.
 * Redefining it in a later edit rebuilds every caller, which then recomputes
 * on the next execute, exactly like an in-place operator update. One name
 * has one definition at a time; a saved version keeps the old one.
 *
 * A setting belongs to the operator that calls the function: its full name is
 * `operator.setting`. The call stores only the values it passes, so a value
 * it leaves out follows the function's default, as in Python; the definition
 * shown for the operator lists every setting with its current value.
 */
import { functionClosure, type NativeOpView, type ParsedFunction, type ParsedValue } from "../native/catalog";

/** A shared function as python/graph_parser.py describes it. */
export interface SharedFunction {
  name: string;
  /** Input-table parameters, in order. */
  tables: string[];
  /** Settings and their defaults. */
  settings: Record<string, unknown>;
  doc: string | null;
  source: string;
  line: number;
}

/** The shared function an operator calls, if it calls one. */
export function sharedEntry(view: NativeOpView | undefined): string | undefined {
  return view?.type === "Process" && view.properties.shared === true && typeof view.properties.entry === "string"
    ? view.properties.entry
    : undefined;
}

/** Every shared function and margin helper the graph's callers carry, by name. */
export function sharedSources(views: Iterable<NativeOpView | undefined>): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const view of views) {
    if (!sharedEntry(view)) continue;
    for (const [name, source] of Object.entries(view!.functions ?? {})) sources[name] ??= source;
  }
  return sources;
}

/** The parser's view of a function, for closures. */
export function parsedFunction(fn: SharedFunction): ParsedFunction {
  return { name: fn.name, params: [...fn.tables, ...Object.keys(fn.settings)], source: fn.source, line: fn.line };
}

/** A setting's value: literals only, so it can be shown, stored and compared. */
export function literalSetting(value: ParsedValue, field: string): unknown {
  switch (value.kind) {
    case "const":
      return value.value;
    case "list":
      return value.items.map((item, i) => literalSetting(item, `${field}[${i}]`));
    case "dict":
      return Object.fromEntries(value.entries.map(([key, item]) => [key, literalSetting(item, `${field}.${key}`)]));
    default:
      throw new Error(
        `Setting \`${field}\` must be a literal value (a number, string, boolean, list or dict); input tables come first, by name.`
      );
  }
}

/** A JSON value written as a Python literal. */
export function pyLiteral(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pyLiteral).join(", ")}]`;
  return `{${Object.entries(value as Record<string, unknown>).map(([k, v]) => `${JSON.stringify(k)}: ${pyLiteral(v)}`).join(", ")}}`;
}

/** Every setting of a call, in signature order: the passed value or the default. */
export function effectiveSettings(fn: SharedFunction, passed: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fn.settings).map(([name, value]) => [name, name in passed ? passed[name] : value]));
}

/** The docstring's first paragraph with each `{setting}` filled in. */
export function renderDoc(template: string, values: Record<string, unknown>): string {
  const summary = template.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
  return summary.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? (typeof values[name] === "string" ? String(values[name]) : JSON.stringify(values[name])) : whole
  );
}

/** One call: a process running the function with these inputs and the
 * settings the call passes; the definition shows every setting's value. */
export function sharedCallView(
  fn: SharedFunction,
  functions: Record<string, ParsedFunction>,
  inputs: string[],
  settings: Record<string, unknown>
): NativeOpView {
  const closure = functionClosure(parsedFunction(fn), functions);
  const effective = effectiveSettings(fn, settings);
  return {
    type: "Process",
    properties: {
      code: closure.map(f => f.source).join("\n\n"),
      entry: fn.name,
      doc: renderDoc(fn.doc ?? "", effective),
      params: settings,
      shared: true,
    },
    inputs,
    source: `${fn.name}(${Object.entries(effective).map(([name, value]) => `${name}=${pyLiteral(value)}`).join(", ")})`,
    functions: Object.fromEntries(closure.map(f => [f.name, f.source])),
    settings: effective,
  };
}

/** Rebuild a caller after one of its functions was redefined, keeping its
 * inputs and settings. Throws when the new definition no longer fits it. */
export function rebuildCaller(
  id: string,
  view: NativeOpView,
  table: ReadonlyMap<string, SharedFunction>,
  functions: Record<string, ParsedFunction>
): NativeOpView {
  const entry = sharedEntry(view)!;
  const fn = table.get(entry);
  if (!fn) throw new Error(`${id} calls ${entry}, which is not defined.`);
  const settings = (view.properties.params ?? {}) as Record<string, unknown>;
  const missing = Object.keys(settings).filter(name => !(name in fn.settings));
  if (missing.length)
    throw new Error(
      `${entry} no longer has the setting(s) ${missing.join(", ")} that ${id} passes; keep them, or restate ${id}.`
    );
  if (fn.tables.length !== view.inputs.length)
    throw new Error(`${entry} now takes ${fn.tables.length} table(s), but ${id} has ${view.inputs.length}; restate ${id}.`);
  const rebuilt = sharedCallView(fn, functions, view.inputs, settings);
  return { ...view, properties: rebuilt.properties, functions: rebuilt.functions, source: rebuilt.source, settings: rebuilt.settings };
}

const lines = (source: string) =>
  source
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"));

/** Share of identical lines, 2·LCS / (|a| + |b|), ignoring indentation and comments. */
export function similarity(a: string, b: string): number {
  const x = lines(a),
    y = lines(b);
  if (!x.length || !y.length) return 0;
  let previous = new Array<number>(y.length + 1).fill(0);
  for (const left of x) {
    const row = new Array<number>(y.length + 1).fill(0);
    for (let j = 0; j < y.length; j++) row[j + 1] = left === y[j] ? previous[j] + 1 : Math.max(previous[j + 1], row[j]);
    previous = row;
  }
  return (2 * previous[y.length]) / (x.length + y.length);
}

/** Rename a function inside its source, its callers' references included. */
export function renameFunction(source: string, from: string, to: string): string {
  return source.replace(new RegExp(`\\b${from}\\b`, "g"), to);
}
