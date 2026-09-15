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

import type { NativeOperatorDef } from "./catalog";

const str = { type: "string", minLength: 1 };
const names = { type: "array", items: str, uniqueItems: true };
const nonemptyNames = { ...names, minItems: 1 };
const dtype = { type: "string", enum: ["str", "int64", "float64", "bool", "datetime"] };
const func = {
  ...str,
  description:
    "Python source defining def apply(value) for Transform, or def apply(row) for Derive/Filter. Missing inputs are None; import needed packages explicitly. Return one typed scalar (or bool/None for Filter), not a table.",
};
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const list = (items: Record<string, unknown>) => ({ type: "array", items, minItems: 1 });
const operator = (
  type: string,
  inputs: NativeOperatorDef["inputs"],
  rowEffect: NativeOperatorDef["rowEffect"],
  signature: string,
  schema: Record<string, unknown>
): NativeOperatorDef => ({
  type,
  inputs,
  rowEffect,
  signature,
  schema,
  catalogVersion: "v2",
});

/** Only execution-tested operators are exposed. The rest of the target catalog
 * enters in subsequent checkpoints together with its runtime and E2E tests. */
export const NATIVE_V2_OPERATORS: readonly NativeOperatorDef[] = [
  operator(
    "Scan",
    0,
    "create",
    "Scan reads files/globs with Python readers. allText preserves codes and null-like text; empty text cells are missing. names requires header:false and exact width. Preview is raw discovery, not a full parsed table: skipLines is a physical offset (HTML preview skips data rows). Duplicate headers, mismatched options and fileColumn collisions fail.",
    object(
      {
        files: { oneOf: [str, list(str)] },
        format: {
          type: "string",
          enum: ["auto", "csv", "lines", "fwf", "whitespace", "excel", "html", "json", "parquet"],
        },
        skipLines: { type: "integer", minimum: 0 },
        header: { type: "boolean" },
        names: nonemptyNames,
        allText: { type: "boolean" },
        delim: str,
        comment: { type: "string", minLength: 1, maxLength: 1 },
        widths: list({ type: "integer", minimum: 1 }),
        sheet: { oneOf: [str, { type: "integer", minimum: 0 }] },
        encoding: str,
        fileColumn: str,
        preview: { type: "integer", minimum: 1, maximum: 200 },
      },
      ["files"]
    )
  ),
  operator(
    "Project",
    1,
    "none",
    "Project selects keep (in order) OR drop, then rename. Rows unchanged. Missing columns and name collisions fail.",
    {
      ...object({
        keep: nonemptyNames,
        drop: nonemptyNames,
        rename: { type: "object", additionalProperties: str, minProperties: 1 },
      }),
      anyOf: [{ required: ["keep"] }, { required: ["drop"] }, { required: ["rename"] }],
    }
  ),
  operator(
    "Cast",
    1,
    "none",
    "Cast explicit column dtypes; errors defaults to raise, null explicitly permits failed conversions. Datetime format/timezone are optional; naive values require timezone. Normalize separators with Transform first.",
    object(
      {
        columns: list(object({ column: str, dtype, format: str, timezone: str }, ["column", "dtype"])),
        errors: { type: "string", enum: ["raise", "null"] },
      },
      ["columns"]
    )
  ),
  operator(
    "FillNull",
    1,
    "none",
    "FillNull replaces only missing cells with compatible scalar values. Rows unchanged; no implicit imputation.",
    object(
      {
        values: {
          type: "object",
          minProperties: 1,
          additionalProperties: { type: ["string", "number", "boolean", "null"] },
        },
      },
      ["values"]
    )
  ),
  operator(
    "Transform",
    1,
    "none",
    "Transform replaces existing columns using def apply(value), returning one scalar of dtype or None. Columns read the original input. Rows/order unchanged.",
    object(
      {
        columns: list(object({ column: str, dtype, func }, ["column", "dtype", "func"])),
      },
      ["columns"]
    )
  ),
  operator(
    "Derive",
    1,
    "none",
    "Derive adds declared columns using def apply(row); row is a read-only mapping of each specification's inputs. Return one typed scalar or None. replace defaults false. Dependent derived columns use separate operators in the same batch.",
    object(
      {
        columns: list(object({ as: str, inputs: names, dtype, func }, ["as", "inputs", "dtype", "func"])),
        replace: { type: "boolean" },
      },
      ["columns"]
    )
  ),
  operator(
    "Filter",
    1,
    "drop",
    "Filter evaluates def apply(row) over declared columns; bool keeps/drops rows, None follows nulls (default drop). No truthy strings or swallowed exceptions. Keeps input row order.",
    object(
      {
        columns: names,
        func,
        nulls: { type: "string", enum: ["drop", "keep", "error"] },
      },
      ["columns", "func"]
    )
  ),
  operator(
    "Aggregate",
    1,
    "collapse",
    "Aggregate by groupBy (default []), preserving first-seen groups including null keys. aggregations is [{fn,col?,as}]. Only count may omit col (row count); other reductions ignore nulls except first, which includes them. All-null sums are null; stddev is sample/ddof=1. Numeric reducers require numeric columns. No SQL or custom reducers.",
    object(
      {
        groupBy: names,
        aggregations: list(
          object(
            {
              fn: {
                type: "string",
                enum: ["count", "count_distinct", "sum", "mean", "min", "max", "median", "stddev", "first"],
              },
              col: str,
              as: str,
            },
            ["fn", "as"]
          )
        ),
      },
      ["aggregations"]
    )
  ),
  operator(
    "Join",
    2,
    "multiply",
    "Join left/right using shared key names or [left,right] pairs. Non-cross joins require on; cross forbids on and only accepts validate:many_to_many. nullsEqual defaults false. validate checks eligible-key cardinality and fails on violations. rightSuffix defaults _right; collisions/type mismatches fail. Equal-name paired keys coalesce; other right overlaps are suffixed. Sort if output order matters.",
    object({
      type: { type: "string", enum: ["inner", "left", "right", "full", "cross"] },
      on: {
        oneOf: [
          str,
          nonemptyNames,
          {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "array", minItems: 2, maxItems: 2, items: str },
          },
        ],
      },
      nullsEqual: { type: "boolean" },
      rightSuffix: { type: "string" },
      validate: { type: "string", enum: ["one_to_one", "one_to_many", "many_to_one", "many_to_many"] },
    })
  ),
  operator(
    "Union",
    "many",
    "add",
    "Union preserves all rows in input-port order. schema:strict (default) requires matching named schemas; align fills missing columns with null in first-seen column order. Incompatible logical types require explicit casts; there is no deduplication.",
    object({ schema: { type: "string", enum: ["strict", "align"] } })
  ),
  operator(
    "Distinct",
    1,
    "drop",
    "Distinct by columns or the whole row when omitted. Missing values compare equal. keep:first (default) or last retains the chosen whole row in relative input order.",
    object({ columns: nonemptyNames, keep: { type: "string", enum: ["first", "last"] } })
  ),
  operator(
    "Sort",
    1,
    "none",
    "Sort by [{col,desc?}] with stable ties; desc defaults false and nulls defaults last. Rows are unchanged.",
    object(
      {
        by: list(object({ col: str, desc: { type: "boolean" } }, ["col"])),
        nulls: { type: "string", enum: ["first", "last"] },
      },
      ["by"]
    )
  ),
  operator(
    "Limit",
    1,
    "drop",
    "Limit takes n rows after offset (default 0), preserving order/schema; an offset beyond EOF returns an empty table. Sort first for a meaningful top-k.",
    object({ n: { type: "integer", minimum: 1 }, offset: { type: "integer", minimum: 0 } }, ["n"])
  ),
  operator(
    "UDF",
    "many",
    "unknown",
    "UDF is the Python escape hatch for work outside the available catalog. Define load() with no inputs, or process(input_id, ...) with exact ordered input IDs. Return one pandas DataFrame with unique string columns and engine-compatible scalars. No semantic row-preservation guarantee.",
    object({ code: str }, ["code"])
  ),
];
