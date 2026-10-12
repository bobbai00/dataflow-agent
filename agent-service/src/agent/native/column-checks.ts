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
 * Column checks on a call's edits, before anything runs. An operator the
 * call set names columns of its inputs: a filter or map reads `row["name"]`,
 * an aggregate groups by and reduces columns, a sort, window, join, project,
 * cast, distinct, unpivot or pivot lists them. When an input's columns are
 * known, from its result or inferred through the built-ins from a known
 * table, every named column must be there. The execution would stop at the
 * first such operator; the checks name every one at once, so one repair
 * fixes them. A Python function's output, a scan without a result, and a
 * pivot are unknown, and nothing downstream of them is checked.
 */

import type { OperatorInfo } from "../../types/execution";
import type { WorkflowContent } from "../../types/workflow";
import type { NativeOpView } from "./catalog";

/** Columns listed when a check says what a table has. */
const LISTED_COLUMNS = 24;

const completed = (info: OperatorInfo | undefined): info is OperatorInfo =>
  !!info && !info.error && ["Completed", "CompletedFromCache"].includes(info.state) && !!info.resultSchema;

/** The columns a lambda or function source reads as `row["name"]` or `row.get("name")`. */
export function rowColumns(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/\brow\s*(?:\[\s*|\.get\(\s*)(['"])((?:\\.|(?!\1)[^\\])*)\1/g)) names.add(match[2]);
  return [...names];
}

/** The keys a map returns when its body is a dict literal: `{**row, "a": …}`
 * is the input's columns plus `a`; a dict without `**row` is its keys alone.
 * Anything else (a call, a computed key) leaves the output unknown. */
export function mapOutput(source: string, input: readonly string[]): string[] | undefined {
  const at = source.lastIndexOf("return ");
  if (at < 0) return undefined;
  let body = source.slice(at + 7).trim();
  if (body.startsWith("(")) body = body.slice(1, body.lastIndexOf(")")).trim();
  if (!body.startsWith("{")) return undefined;
  const entries: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 1;
  let closed = false;
  for (let i = 1; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) {
        entries.push(body.slice(start, i));
        if (body.slice(i + 1).trim()) return undefined;
        closed = true;
        break;
      }
      depth--;
    } else if (c === "," && depth === 0) {
      entries.push(body.slice(start, i));
      start = i + 1;
    }
  }
  if (!closed) return undefined;
  const output: string[] = [];
  const add = (name: string) => {
    if (!output.includes(name)) output.push(name);
  };
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    if (/^\*\*\s*row$/.test(entry)) {
      input.forEach(add);
      continue;
    }
    const key = /^(['"])((?:\\.|(?!\1)[^\\])*)\1\s*:/.exec(entry);
    if (!key) return undefined;
    add(key[2]);
  }
  return output;
}

interface Reference {
  column: string;
  input: number;
}

/** The columns an operator names in each input, and its output columns when they follow. */
function analyse(
  view: NativeOpView,
  inputs: readonly (string[] | undefined)[]
): { refs: Reference[]; output: string[] | undefined } {
  const p = view.properties as Record<string, any>;
  const first = inputs[0];
  const refs: Reference[] = [];
  const name = (column: unknown, input = 0) => {
    if (typeof column === "string") refs.push({ column, input });
  };
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter(v => typeof v === "string") : []);
  const withOutputs = (base: readonly string[] | undefined, added: string[]) => {
    if (!base) return undefined;
    const output = [...base];
    for (const column of added) if (!output.includes(column)) output.push(column);
    return output;
  };
  switch (view.type) {
    case "Filter":
      rowColumns(String(p.func ?? "")).forEach(c => name(c));
      return { refs, output: first };
    case "Map":
      rowColumns(String(p.func ?? "")).forEach(c => name(c));
      return { refs, output: first ? mapOutput(String(p.func ?? ""), first) : undefined };
    case "Sort":
      for (const key of p.by ?? []) name(key?.col);
      return { refs, output: first };
    case "Limit":
      return { refs, output: first };
    case "Cast":
      for (const column of p.columns ?? []) name(column?.column);
      return { refs, output: first };
    case "Distinct":
      list(p.columns).forEach(c => name(c));
      return { refs, output: first };
    case "Project": {
      list(p.keep).forEach(c => name(c));
      list(p.drop).forEach(c => name(c));
      const rename = (p.rename ?? {}) as Record<string, string>;
      Object.keys(rename).forEach(c => name(c));
      if (!first) return { refs, output: undefined };
      const kept = p.keep ? list(p.keep) : first.filter(c => !list(p.drop).includes(c));
      return { refs, output: kept.map(c => rename[c] ?? c) };
    }
    case "Aggregate": {
      list(p.groupBy).forEach(c => name(c));
      const aggregations = (p.aggregations ?? []) as Array<{ col?: string; as: string }>;
      aggregations.forEach(a => name(a.col));
      return { refs, output: withOutputs(list(p.groupBy), aggregations.map(a => a.as)) };
    }
    case "Window": {
      list(p.partitionBy).forEach(c => name(c));
      for (const key of p.orderBy ?? []) name(key?.col);
      const columns = (p.columns ?? []) as Array<{ col?: string; as: string }>;
      columns.forEach(c => name(c.col));
      return { refs, output: withOutputs(first, columns.map(c => c.as)) };
    }
    case "Join": {
      const [left, right] = inputs;
      const leftKeys: string[] = [];
      const rightKeys: string[] = [];
      if (typeof p.on === "string") leftKeys.push(p.on), rightKeys.push(p.on);
      else
        for (const key of Array.isArray(p.on) ? p.on : [])
          if (typeof key === "string") leftKeys.push(key), rightKeys.push(key);
          else if (Array.isArray(key) && key.length === 2) leftKeys.push(String(key[0])), rightKeys.push(String(key[1]));
      leftKeys.forEach(k => name(k, 0));
      rightKeys.forEach(k => name(k, 1));
      if (!left) return { refs, output: undefined };
      if (p.type === "semi" || p.type === "anti") return { refs, output: left };
      if (!right) return { refs, output: undefined };
      const suffix = typeof p.rightSuffix === "string" ? p.rightSuffix : "_right";
      // A key of the same name on both sides appears once; a colliding right
      // column takes the suffix until its name is free.
      const shared = new Set(leftKeys.filter((key, i) => rightKeys[i] === key));
      const output = [...left];
      for (const column of right) {
        if (shared.has(column)) continue;
        let renamed = column;
        while (output.includes(renamed)) renamed += suffix;
        output.push(renamed);
      }
      return { refs, output };
    }
    case "Union":
      return {
        refs,
        output:
          p.schema === "align"
            ? inputs.every(Boolean)
              ? [...new Set(inputs.flatMap(schema => schema!))]
              : undefined
            : first,
      };
    case "Unpivot": {
      const columns = list(p.columns);
      columns.forEach(c => name(c));
      return {
        refs,
        output: first
          ? [...first.filter(c => !columns.includes(c)), String(p.nameColumn ?? "variable"), String(p.valueColumn ?? "value")]
          : undefined,
      };
    }
    case "Pivot":
      list(p.index).forEach(c => name(c));
      name(p.columns);
      name(p.values);
      return { refs, output: undefined };
    default:
      return { refs, output: undefined };
  }
}

/**
 * One line per edited operator and input whose named columns are missing,
 * for the operators in `changed`. `result` gives an unchanged operator's
 * last result; an operator without one, or changed by this call, has the
 * columns its built-in derives from its inputs, when they are known.
 */
export function columnChecks(
  workflow: WorkflowContent,
  changed: ReadonlySet<string>,
  result: (id: string) => OperatorInfo | undefined
): string[] {
  const views = new Map(workflow.operators.filter(op => op.nativeOp).map(op => [op.operatorID, op.nativeOp!]));
  const memo = new Map<string, string[] | undefined>();
  const schemaOf = (id: string): string[] | undefined => {
    if (memo.has(id)) return memo.get(id);
    memo.set(id, undefined);
    const view = views.get(id);
    if (!view) return undefined;
    if (!changed.has(id)) {
      const info = result(id);
      if (completed(info)) {
        const names = info.resultSchema!.map(column => column.name);
        memo.set(id, names);
        return names;
      }
    }
    const { output } = analyse(
      view,
      view.inputs.map(input => (input ? schemaOf(input) : undefined))
    );
    memo.set(id, output);
    return output;
  };
  const lines: string[] = [];
  for (const op of workflow.operators) {
    const view = op.nativeOp;
    if (!view || !changed.has(op.operatorID)) continue;
    const inputs = view.inputs.map(input => (input ? schemaOf(input) : undefined));
    const missing = new Map<number, string[]>();
    for (const ref of analyse(view, inputs).refs) {
      const schema = inputs[ref.input];
      if (!schema || schema.includes(ref.column)) continue;
      const columns = missing.get(ref.input) ?? [];
      if (!columns.includes(ref.column)) columns.push(ref.column);
      missing.set(ref.input, columns);
    }
    for (const [input, columns] of missing) {
      const schema = inputs[input]!;
      const listed = schema.slice(0, LISTED_COLUMNS).join(", ") + (schema.length > LISTED_COLUMNS ? `, … +${schema.length - LISTED_COLUMNS} more` : "");
      lines.push(
        `\`${op.operatorID}\` names column${columns.length > 1 ? "s" : ""} ${columns.map(c => JSON.stringify(c)).join(", ")}, which \`${view.inputs[input]}\` does not have; its columns are ${listed}.`
      );
    }
  }
  return lines;
}
