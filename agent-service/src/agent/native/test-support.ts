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
 * Test scaffolding for native mode. The behavioral suites describe operators as
 * small JSON objects (`{ op: "filter", id, input, ... }`); `programOf` writes
 * the equivalent program so those scenarios drive the real `dataflow` tool.
 * It covers only the argument shapes the tests use and is not a public API.
 */

import { WorkflowState } from "../workflow-state";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { createNativeTools, type DataflowInput } from "../tools/native-batch-tools";
import type { ToolContext } from "../tools/workflow-crud-tools";

export type LegacySpec = Record<string, unknown> & { op: string; id: string };

const py = (value: unknown): string => {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(py).join(", ")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${JSON.stringify(k)}: ${py(v)}`)
    .join(", ")}}`;
};

const keys = (value: unknown): string =>
  `[${(value as Array<Record<string, unknown> | string>)
    .map(item => (typeof item === "string" ? py(item) : item.desc ? `(${py(item.col)}, "desc")` : py(item.col)))
    .join(", ")}]`;

/** Rename a function's entry so several functions can share one program. */
function renamed(code: string, from: RegExp, to: string): string {
  return code.replace(from, `def ${to}(`);
}

/** A SQL-ish `col op value` predicate (the V1 test vocabulary) as a lambda. */
function predicateLambda(predicate: string): string {
  const match = /^\s*([A-Za-z_]\w*)\s*(>=|<=|==|!=|>|<|=)\s*(.+?)\s*$/.exec(predicate);
  if (!match) throw new Error(`test predicate not convertible: ${predicate}`);
  const op = match[2] === "=" ? "==" : match[2];
  return `lambda row: row[${JSON.stringify(match[1])}] is not None and row[${JSON.stringify(match[1])}] ${op} ${match[3]}`;
}

/** One legacy spec → the `def`s it needs plus its assignment. */
export function statementOf(spec: LegacySpec): { defs: string[]; statement: string } {
  const { op, id, input, left, right, inputs, ...p } = spec as Record<string, any>;
  const defs: string[] = [];
  const args: string[] = [];
  const kw = (name: string, value: unknown) => {
    if (value !== undefined) args.push(`${name}=${py(value)}`);
  };
  switch (op) {
    case "scan": {
      args.push(py(p.files));
      kw("format", p.format);
      kw("skip_lines", p.skipLines);
      kw("header", p.header);
      kw("names", p.names);
      kw("all_text", p.allText);
      kw("delim", p.delim);
      kw("comment", p.comment);
      kw("widths", p.widths);
      kw("sheet", p.sheet);
      kw("encoding", p.encoding);
      kw("file_column", p.fileColumn);
      kw("preview", p.preview);
      break;
    }
    case "filter": {
      args.push(input);
      if (typeof p.predicate === "string") args.push(predicateLambda(p.predicate));
      else {
        defs.push(renamed(p.func, /def\s+apply\s*\(/, `${id}_predicate`));
        args.push(`${id}_predicate`);
      }
      args.push('doc="legacy fixture"');
      break;
    }
    case "derive":
    case "transform": {
      // Legacy per-column functions become one row function returning
      // `{**row, col: fn(row), ...}` (map is row-to-row now).
      args.push(input);
      const entries: string[] = [];
      for (const column of p.columns as Array<Record<string, any>>) {
        const name = op === "derive" ? column.as : column.column;
        const fn = `${id}_${name}`.replace(/\W/g, "_");
        if (op === "derive") defs.push(renamed(column.func, /def\s+apply\s*\(/, fn));
        else {
          defs.push(renamed(column.func, /def\s+apply\s*\(/, `${fn}_value`));
          defs.push(`def ${fn}(row):\n    return ${fn}_value(row[${JSON.stringify(name)}])`);
        }
        entries.push(`${JSON.stringify(name)}: ${fn}(row)`);
      }
      defs.push(`def ${id}_row(row):\n    return {**row, ${entries.join(", ")}}`);
      args.push(`${id}_row`);
      args.push('doc="legacy fixture"');
      break;
    }
    case "cast": {
      args.push(input);
      const spread: string[] = [];
      for (const column of p.columns as Array<Record<string, any>>) {
        const dtype =
          column.dtype === "datetime" && (column.format || column.timezone)
            ? `datetime(${[column.format ? `format=${py(column.format)}` : "", column.timezone ? `tz=${py(column.timezone)}` : ""].filter(Boolean).join(", ")})`
            : column.dtype;
        spread.push(`${JSON.stringify(column.column)}: ${dtype}`);
      }
      args.push(`**{${spread.join(", ")}}`);
      kw("errors", p.errors);
      break;
    }
    case "project": {
      args.push(input);
      kw("keep", p.keep);
      kw("drop", p.drop);
      kw("rename", p.rename);
      break;
    }
    case "aggregate": {
      args.push(input);
      kw("by", p.groupBy);
      for (const a of p.aggregations as Array<Record<string, any>>)
        args.push(`${a.as ?? (a.col ? `${a.fn}_${a.col}` : a.fn)}=${a.fn}(${a.col ? py(a.col) : ""})`);
      break;
    }
    case "join": {
      args.push(left, right);
      kw("on", p.on);
      kw("how", p.type);
      kw("nulls_equal", p.nullsEqual);
      kw("suffix", p.rightSuffix);
      kw("validate", p.validate);
      break;
    }
    case "union": {
      args.push(...(inputs as string[]));
      kw("schema", p.schema);
      break;
    }
    case "distinct": {
      args.push(input);
      kw("columns", p.columns);
      kw("keep", p.keep);
      break;
    }
    case "sort": {
      args.push(input, `by=${keys(p.by)}`);
      kw("nulls", p.nulls);
      break;
    }
    case "limit": {
      args.push(input, py(p.n));
      kw("offset", p.offset);
      break;
    }
    case "window": {
      args.push(input);
      kw("partition_by", p.partitionBy);
      if (p.orderBy) args.push(`order_by=${keys(p.orderBy)}`);
      for (const c of p.columns as Array<Record<string, any>>) {
        const inner = [c.col !== undefined ? py(c.col) : "", c.offset !== undefined ? py(c.offset) : ""].filter(
          Boolean
        );
        args.push(`${c.as}=${c.fn}(${inner.join(", ")})`);
      }
      break;
    }
    case "unpivot": {
      args.push(input);
      kw("columns", p.columns);
      kw("name", p.nameColumn);
      kw("value", p.valueColumn);
      break;
    }
    case "pivot": {
      args.push(input);
      kw("index", p.index);
      kw("columns", p.columns);
      kw("values", p.values);
      break;
    }
    case "udf":
    case "process": {
      const fn = `${id}_fn`;
      defs.push(renamed(p.code, /def\s+(load|process)\s*\(/, fn));
      args.push(...((inputs as string[] | undefined) ?? []));
      args.push(`fn=${fn}`);
      args.push('doc="legacy fixture"');
      break;
    }
    default:
      // Unknown operators are passed through so tests can exercise the rejection.
      args.push(...[input, left, right].filter((x): x is string => typeof x === "string"));
      for (const [k, v] of Object.entries(p)) kw(k, v);
  }
  const name = op === "udf" ? "process" : op === "derive" || op === "transform" ? "map" : op;
  return { defs, statement: `${id} = ${name}(${args.join(", ")})` };
}

/** Several legacy specs → one program. */
export function programOf(specs: LegacySpec[]): string {
  const defs: string[] = [];
  const statements: string[] = [];
  for (const spec of specs) {
    const s = statementOf(spec);
    defs.push(...s.defs);
    statements.push(s.statement);
  }
  return [...defs, ...statements].join("\n");
}

/** `{ operators, observe }` in the old shape → the tool's `{ program, observe }`. */
export function dataflowInput(args: { operators: LegacySpec[]; observe?: string[] }): DataflowInput {
  return { edits: programOf(args.operators), ...(args.observe !== undefined ? { observe: args.observe } : {}) };
}

/** The native tools over a fresh state with the code-mode operator metadata. */
export function nativeTestTools(state = new WorkflowState(), context: Partial<ToolContext> = {}) {
  const metadata = new WorkflowSystemMetadata();
  metadata.seedCodeModeDefaults();
  return { state, tools: createNativeTools(state, { metadataStore: metadata, ...context } as ToolContext) };
}
