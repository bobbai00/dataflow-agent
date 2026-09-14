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
 * NATIVE operator catalog — the fixed-grain operator set for `agentMode:
 * "native"`.
 *
 * One operator is ONE relational operation, fully specified by a small JSON
 * `properties` object. The agent never writes code for these; the service
 * compiles the parameters into a Python `load()` / `process()` body (see
 * codegen.ts) and lands it as an ordinary `DataLoading` / `DataProcessing`
 * operator, so the engine, the stats pipeline (`_publish_column_stats`) and
 * the snapshot storage need no changes. The typed view (type + properties +
 * ordered inputs) rides on the operator predicate as `nativeOp` — a field the
 * execution payload never forwards — so the renderer can print `(Filter)` and
 * `Properties:` instead of generated code.
 *
 * Row-set effect is declared per type. It is what makes result selection
 * (selection.ts) decidable: the type says what the data CAN decide about the
 * output table, the measured statistics say whether it DID.
 */

export type RowEffect =
  /** Scan: brings a table into existence. */
  | "create"
  /** Filter / Distinct / Limit: can only remove rows. */
  | "drop"
  /** Union: adds rows. */
  | "add"
  /** Aggregate: collapses rows to one per group. */
  | "collapse"
  /** Join: can drop or multiply rows. */
  | "multiply"
  /** Project / Compute / Sort: row set untouched. */
  | "none"
  /** UDF: anything. */
  | "unknown";

export interface NativeOperatorDef {
  type: string;
  /** Number of inputs: 0 (source), 1, 2 (join) or "many" (union). */
  inputs: 0 | 1 | 2 | "many";
  rowEffect: RowEffect;
  /** One-line signature shown in the system prompt. */
  signature: string;
  /** JSON schema for `properties` (Ajv-validated in the tool). */
  schema: Record<string, unknown>;
}

const str = { type: "string" } as const;
const strList = { type: "array", items: { type: "string" }, minItems: 1 } as const;

export const NATIVE_OPERATORS: readonly NativeOperatorDef[] = [
  {
    type: "Scan",
    inputs: 0,
    rowEffect: "create",
    signature:
      'Scan {files: "path or glob (csv/tsv/txt/xlsx/html/json/parquet)", skipLines?: int, header?: bool (default true; ' +
      'with header=false the columns come back named column0, column1, …), names?: [name] (one per column, only with header=false; ' +
      'a wrong count is refused), ' +
      'allText?: bool (read every column as text), delim?: str ("whitespace" for space-aligned text), comment?: str (skip lines starting with this char), ' +
      'format?: auto|csv|lines|fwf|whitespace (lines: every line of the file becomes a row to parse with compute; fwf: fixed-width columns, with widths; whitespace = delim whitespace), widths?: [int], ' +
      'sheet?: str|int (xlsx sheet, or html table index), encoding?: str (detected when omitted), fileColumn?: str (add the source file name as this column), preview?: int (the first n RAW lines of each text file, or the first n rows of every sheet / html table with cells joined by " | " for display)}',
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["files"],
      properties: {
        files: { oneOf: [str, strList] },
        skipLines: { type: "integer", minimum: 0 },
        header: { type: "boolean" },
        // names for a header-less file, applied after the read with a count
        // check; `columns` stays in the schema only so the compiler can refuse
        // it with a message pointing at `names` and at `project.keep`.
        names: strList,
        columns: strList,
        allText: { type: "boolean" },
        delim: str,
        comment: { type: "string", minLength: 1, maxLength: 1 },
        format: { type: "string", enum: ["auto", "csv", "lines", "fwf", "whitespace"] },
        widths: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1 },
        sheet: { oneOf: [str, { type: "integer" }] },
        encoding: str,
        fileColumn: str,
        preview: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
  },
  {
    type: "Filter",
    inputs: 1,
    rowEffect: "drop",
    signature: 'Filter {predicate: "SQL boolean expression over the input columns"}   keeps rows where it is true',
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["predicate"],
      properties: { predicate: str },
    },
  },
  {
    type: "Project",
    inputs: 1,
    rowEffect: "none",
    signature: 'Project {keep?: [col], drop?: [col], rename?: {old: new}}   columns only; rows untouched',
    schema: {
      type: "object",
      additionalProperties: false,
      anyOf: [{ required: ["keep"] }, { required: ["drop"] }, { required: ["rename"] }],
      properties: {
        keep: strList,
        drop: strList,
        rename: { type: "object", additionalProperties: str, minProperties: 1 },
      },
    },
  },
  {
    type: "Compute",
    inputs: 1,
    rowEffect: "none",
    signature:
      'Compute {columns: {name: "SQL scalar expression"}}   adds a column, or replaces one that already exists; cannot add or drop rows',
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["columns"],
      properties: { columns: { type: "object", additionalProperties: str, minProperties: 1 } },
    },
  },
  {
    type: "Aggregate",
    inputs: 1,
    rowEffect: "collapse",
    signature:
      'Aggregate {groupBy?: [col], aggregations: [{fn, col?, as?}]}   fn: sum count avg min max median count_distinct string_agg first stddev; ' +
      "count without col counts rows; no groupBy = one output row; " +
      "sum/avg/median/stddev on a text column coerce it to numbers first (thousands separators and surrounding space removed, " +
      "unparseable values become null and show in the null count), so numbers stored as text need no separate cast",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["aggregations"],
      properties: {
        groupBy: { type: "array", items: str },
        aggregations: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["fn"],
            properties: {
              fn: {
                type: "string",
                enum: [
                  "sum",
                  "count",
                  "avg",
                  "mean",
                  "min",
                  "max",
                  "median",
                  "count_distinct",
                  "string_agg",
                  "first",
                  "stddev",
                ],
              },
              col: str,
              as: str,
            },
          },
        },
      },
    },
  },
  {
    type: "Join",
    inputs: 2,
    rowEffect: "multiply",
    signature:
      'Join {on?: [col] shared key names, or [[leftCol, rightCol]] pairs when the names differ, type?: inner|left|right|full|cross}   inputs = [left, right]; ' +
      "same-named non-key columns from the right get suffix _right; " +
      "omit `on` (or type cross) to pair every row with every row, e.g. to put two one-row results side by side before a Compute; " +
      "a self-join names the same operator twice in inputs (e.g. year against year-1)",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        on: {
          type: "array",
          items: {
            oneOf: [
              // a key both sides name the same way
              str,
              // an explicit [left, right] pair, for names that differ
              { type: "array", items: str, minItems: 2, maxItems: 2 },
            ],
          },
        },
        type: { type: "string", enum: ["inner", "left", "right", "full", "cross"] },
      },
    },
  },
  {
    type: "Union",
    inputs: "many",
    rowEffect: "add",
    signature: "Union {}   inputs = [a, b, ...]; stacks rows, matching columns by name",
    schema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    type: "Unpivot",
    inputs: 1,
    rowEffect: "add",
    signature:
      'Unpivot {columns: [col], nameColumn?: str (default "variable"), valueColumn?: str (default "value")}   wide → long: one output row per (input row, column in `columns`); the other columns are kept as keys',
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["columns"],
      properties: {
        columns: strList,
        nameColumn: str,
        valueColumn: str,
      },
    },
  },
  {
    type: "Distinct",
    inputs: 1,
    rowEffect: "drop",
    signature: "Distinct {columns?: [col]}   one row per distinct combination; whole row when omitted",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: { columns: strList },
    },
  },
  {
    type: "Sort",
    inputs: 1,
    rowEffect: "none",
    signature: "Sort {by: [{col, desc?: bool}]}",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["by"],
      properties: {
        by: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["col"],
            properties: { col: str, desc: { type: "boolean" } },
          },
        },
      },
    },
  },
  {
    type: "Limit",
    inputs: 1,
    rowEffect: "drop",
    signature: "Limit {n: int, offset?: int}",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["n"],
      properties: { n: { type: "integer", minimum: 1 }, offset: { type: "integer", minimum: 0 } },
    },
  },
  {
    type: "UDF",
    inputs: "many",
    rowEffect: "unknown",
    signature:
      'UDF {code: "def process(<input ids>): ... return <pd.DataFrame>"}   pandas/numpy/scipy; ONLY for what no operator above does (statistics, fitting, regex extraction, custom parsers, geospatial). ONE step per UDF. Parameter names must be the input operator ids, in order.',
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["code"],
      properties: { code: str },
    },
  },
];

export const NATIVE_BY_TYPE: ReadonlyMap<string, NativeOperatorDef> = new Map(NATIVE_OPERATORS.map(d => [d.type, d]));

/** The typed view carried on an operator predicate (`OperatorPredicate.nativeOp`). */
export interface NativeOpView {
  type: string;
  properties: Record<string, unknown>;
  /** Upstream operator ids in port order (= `process()` parameter order). */
  inputs: string[];
}

/** Operator ids double as Python parameter names in the generated `process()`. */
export const NATIVE_ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One line per operator for the system prompt. */
export function nativeCatalogText(): string {
  return NATIVE_OPERATORS.map(d => d.signature).join("\n");
}
