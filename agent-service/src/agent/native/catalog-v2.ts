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
    "UDF",
    "many",
    "unknown",
    "UDF is the Python escape hatch for work outside the available catalog. Define load() with no inputs, or process(input_id, ...) with exact ordered input IDs. Return one pandas DataFrame with unique string columns and engine-compatible scalars. No semantic row-preservation guarantee.",
    object({ code: str }, ["code"])
  ),
];
