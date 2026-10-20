/**
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Ajv from "ajv";
import {
  AGGREGATE_FUNCTIONS,
  DTYPES,
  NATIVE_BY_NAME,
  NATIVE_ID_RE,
  NATIVE_OPERATORS,
  WINDOW_FUNCTIONS,
  type NativeOpView,
} from "./catalog";
import { nativeRevision, runNativePython } from "./codegen";

/** A complete replacement definition. Ordered inputs are physical graph ports. */
export interface StructuredOperatorDefinition {
  id: string;
  operator: string;
  inputs: string[];
  params: Record<string, unknown>;
}

type Schema = Record<string, any>;
const text: Schema = { type: "string", minLength: 1, pattern: "[\\s\\S]*\\S[\\s\\S]*" };
const identifier: Schema = { type: "string", pattern: NATIVE_ID_RE.source };
const enumeration = (values: readonly string[]): Schema => ({ type: "string", enum: [...values] });
const integer = (minimum: number, maximum?: number): Schema => ({
  type: "integer",
  minimum,
  ...(maximum === undefined ? {} : { maximum }),
});
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: "null" }] });
const object = (properties: Record<string, Schema>): Schema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const array = (items: Schema, minItems = 1): Schema => ({ type: "array", items, minItems });
const names = (minimum = 1): Schema => ({ ...array(text, minimum), uniqueItems: true });
const defaulted = (schema: Schema, value: unknown, description?: string): Schema => ({
  ...schema,
  default: value,
  ...(description ? { description } : {}),
});
const sortKey = object({ col: text, direction: enumeration(["asc", "desc"]) });
const callback = object({
  code: {
    ...text,
    description:
      "Ordinary Python module source or a lambda. Imports, helpers, defaults and variadic arguments are supported. The selected entry must accept one positional argument per input (one row for filter/map) and be synchronous.",
  },
  entry: {
    type: "string",
    default: "",
    description:
      "Top-level function to call. Empty string infers the sole top-level function, or uses apply for a lambda; several helper functions require an explicit entry.",
  },
  doc: defaulted({ type: "string" }, "", "Empty string uses a generic description; other text is preserved verbatim."),
});
const joinOptions = {
  nulls_equal: defaulted({ type: "boolean" }, false),
  suffix: defaulted(text, "_right"),
  validate: defaulted(enumeration(["one_to_one", "one_to_many", "many_to_one", "many_to_many"]), "many_to_many"),
};

const parameterSchemas: Record<string, Schema> = {
  scan: object({
    files: array(text),
    format: defaulted(
      enumeration(["auto", "csv", "lines", "fwf", "whitespace", "excel", "html", "json", "parquet"]),
      "auto"
    ),
    skip_lines: defaulted(integer(0), 0),
    header: defaulted({ type: "boolean" }, true),
    names: defaulted(names(0), [], "Empty array uses the existing header or generated column names."),
    all_text: defaulted({ type: "boolean" }, false),
    delim: nullable(text),
    comment: defaulted({ type: "string", maxLength: 1 }, "", "Empty string disables comment-prefix stripping."),
    widths: defaulted(
      array(integer(1), 0),
      [],
      "Empty array uses fixed-width inference; supplied widths require format fwf."
    ),
    sheet: nullable({ anyOf: [text, integer(0)] }),
    encoding: defaulted({ type: "string" }, "", "Empty string uses existing encoding inference."),
    file_column: defaulted({ type: "string" }, "", "Empty string adds no file-provenance column."),
    preview: defaulted(
      integer(0, 200),
      0,
      "Zero performs a full scan; a positive count previews raw lines or sheet rows."
    ),
  }),
  project: object({
    keep: defaulted(names(0), [], "Empty array applies no keep projection; keep and drop cannot both be nonempty."),
    drop: defaulted(names(0), [], "Empty array applies no drop projection."),
    rename: defaulted(
      array(object({ from: text, to: text }), 0),
      [],
      "Empty array applies no renaming. At least one project operation must be nonempty."
    ),
  }),
  cast: object({
    columns: array(
      object({ column: text, dtype: enumeration(DTYPES), format: nullable(text), timezone: nullable(text) })
    ),
    errors: defaulted(enumeration(["raise", "null"]), "raise"),
  }),
  filter: callback,
  map: callback,
  aggregate: object({
    by: defaulted(names(0), [], "Empty array produces one global group."),
    aggregations: array({
      anyOf: [
        object({ fn: enumeration(["count"]), col: nullable(text), as: text }),
        object({ fn: enumeration(AGGREGATE_FUNCTIONS.filter(fn => fn !== "count")), col: text, as: text }),
      ],
    }),
  }),
  join: {
    anyOf: [
      object({ on: { type: "null" }, how: enumeration(["cross"]), ...joinOptions }),
      object({
        on: array(object({ left: text, right: text })),
        how: defaulted(enumeration(["inner", "left", "right", "full", "semi", "anti"]), "inner"),
        ...joinOptions,
      }),
    ],
  },
  union: object({ schema: defaulted(enumeration(["strict", "align"]), "strict") }),
  distinct: object({
    columns: defaulted(names(0), [], "Empty array compares all columns."),
    keep: defaulted(enumeration(["first", "last"]), "first"),
  }),
  sort: object({ by: array(sortKey), nulls: defaulted(enumeration(["first", "last"]), "last") }),
  limit: object({ n: integer(1), offset: defaulted(integer(0), 0) }),
  window: object({
    partition_by: defaulted(names(0), [], "Empty array uses one partition."),
    order_by: array(sortKey),
    columns: array({
      anyOf: [
        object({ fn: enumeration(["lag", "lead"]), col: text, as: text, offset: defaulted(integer(1), 1) }),
        object({
          fn: enumeration(WINDOW_FUNCTIONS.filter(fn => fn !== "lag" && fn !== "lead")),
          col: { type: "null" },
          as: text,
          offset: { type: "null" },
        }),
      ],
    }),
  }),
  unpivot: object({ columns: names(), name: defaulted(text, "variable"), value: defaulted(text, "value") }),
  pivot: object({ index: names(0), columns: text, values: text }),
  process: callback,
};

/** Provider-facing strict schemas: each branch fixes one catalog operator. */
export function structuredSetSchemas(): Schema[] {
  return NATIVE_OPERATORS.map(def =>
    object({
      type: { type: "string", const: "set" },
      id: identifier,
      operator: { type: "string", const: def.name },
      inputs: {
        type: "array",
        items: identifier,
        minItems: def.inputs === "many" ? (def.name === "union" ? 2 : 0) : def.inputs,
        ...(def.inputs === "many" ? {} : { maxItems: def.inputs }),
      },
      params: parameterSchemas[def.name],
    })
  ).map(schema => structuredClone(schema));
}

const ajv = new Ajv({ allErrors: true, strict: false });
const setValidators = new Map(
  structuredSetSchemas().map(schema => [schema.properties.operator.const as string, ajv.compile(schema)])
);
const runtimeValidators = new Map(NATIVE_OPERATORS.map(def => [def.name, ajv.compile(def.schema)]));

// Internal callers may omit defaults. Provider schemas require every field;
// omission and explicitly supplied defaults normalize to the same definition.
function fillDefaults(schema: Schema, value: unknown): unknown {
  if (value === undefined && Object.hasOwn(schema, "default")) return structuredClone(schema.default);
  if (value === undefined && schema.type === "null") return null;
  if (value === undefined && schema.anyOf?.some((option: Schema) => option.type === "null")) return null;
  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const supplied = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(schema.properties)) {
      const normalized = fillDefaults(child as Schema, supplied[key]);
      if (normalized !== undefined) result[key] = normalized;
    }
    // Preserve unknown own keys for rejection, including __proto__; assignment
    // to that key would otherwise silently change the temporary prototype.
    return Object.fromEntries([
      ...Object.entries(result),
      ...Object.entries(supplied).filter(([key]) => !Object.hasOwn(schema.properties, key)),
    ]);
  }
  if (schema.type === "array" && Array.isArray(value)) return value.map(item => fillDefaults(schema.items, item));
  // Nullable arrays/objects keep their typed structure for nested defaults.
  if (value !== null && schema.anyOf) {
    const branch = schema.anyOf.find((option: Schema) => {
      if (option.type !== (Array.isArray(value) ? "array" : typeof value)) return false;
      if (option.type !== "object") return true;
      // Select discriminated object branches before filling optional fields.
      return Object.entries(option.properties).every(([key, child]) => {
        const s = child as Schema;
        if (!s.enum && !s.const && !s.anyOf?.some((item: Schema) => item.enum)) return true;
        const supplied = (value as Record<string, unknown>)[key];
        return ajv.compile(s)(supplied === undefined ? (s.default ?? null) : supplied);
      });
    });
    if (branch) return fillDefaults(branch, value);
  }
  return value;
}

function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicate names.`);
}
function nonNull(value: Record<string, any>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null));
}
function ordered(keys: Array<{ col: string; direction: string }>) {
  unique(
    keys.map(key => key.col),
    "order columns"
  );
  return keys.map(key => ({ col: key.col, ...(key.direction === "desc" ? { desc: true } : {}) }));
}

/** Normalize JSON directly to the catalog runtime contract, without assignment
 * text or DSL parsing. Python is syntax-checked in a bounded compile-only helper. */
export async function normalizeStructuredOperator(
  definition: StructuredOperatorDefinition,
  options: { profileCollection?: boolean; profileScope?: "full" } = {}
): Promise<NativeOpView> {
  const def = NATIVE_BY_NAME.get(definition.operator);
  if (!def) throw new Error(`Unknown operator ${definition.operator}.`);
  const schema = parameterSchemas[def.name];
  const canonical = fillDefaults(schema, definition.params) as Record<string, any>;
  const validate = setValidators.get(def.name)!;
  if (!validate({ type: "set", ...definition, params: canonical }))
    throw new Error(`Invalid ${def.name} definition: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
  const p = canonical;
  const properties: Record<string, unknown> = {};
  const isDefault = (key: string) =>
    [schema, ...(schema.anyOf ?? [])].some(option => {
      const field = option.properties?.[key];
      return field && Object.hasOwn(field, "default") && JSON.stringify(p[key]) === JSON.stringify(field.default);
    });
  const copy = (mapping: Record<string, string>) => {
    for (const [from, to] of Object.entries(mapping))
      if (p[from] !== null && !isDefault(from)) properties[to] = p[from];
  };
  switch (def.name) {
    case "scan":
      copy({
        files: "files",
        format: "format",
        skip_lines: "skipLines",
        header: "header",
        names: "names",
        all_text: "allText",
        delim: "delim",
        comment: "comment",
        widths: "widths",
        sheet: "sheet",
        encoding: "encoding",
        file_column: "fileColumn",
        preview: "preview",
      });
      if (p.names.length && p.header !== false) throw new Error("scan names requires header=false.");
      break;
    case "project":
      if (p.keep.length && p.drop.length) throw new Error("project takes keep or drop, not both.");
      if (!p.keep.length && !p.drop.length && !p.rename.length) throw new Error("project needs keep, drop or rename.");
      copy({ keep: "keep", drop: "drop" });
      if (p.rename.length) {
        unique(
          p.rename.map((item: any) => item.from),
          "rename sources"
        );
        unique(
          p.rename.map((item: any) => item.to),
          "rename destinations"
        );
        properties.rename = Object.fromEntries(p.rename.map((item: any) => [item.from, item.to]));
      }
      break;
    case "cast":
      unique(
        p.columns.map((item: any) => item.column),
        "cast columns"
      );
      properties.columns = p.columns.map((item: any) => {
        if (item.dtype !== "datetime" && (item.format !== null || item.timezone !== null))
          throw new Error("format and timezone apply only to datetime casts.");
        return nonNull(item);
      });
      copy({ errors: "errors" });
      break;
    case "filter":
    case "map":
    case "process": {
      const parsed = (await runNativePython({ pythonFunction: { code: p.code, entry: p.entry || null } })) as {
        ok: boolean;
        code: string;
        entry: string;
        error?: string;
      };
      if (!parsed.ok) throw new Error(parsed.error);
      properties[def.name === "process" ? "code" : "func"] = parsed.code;
      properties.entry = parsed.entry;
      properties.doc = p.doc || `User-defined ${def.name}`;
      break;
    }
    case "aggregate":
      copy({ by: "groupBy" });
      unique(
        p.aggregations.map((item: any) => item.as),
        "aggregate outputs"
      );
      properties.aggregations = p.aggregations.map((item: any) => {
        if (item.fn !== "count" && item.col === null) throw new Error(`${item.fn} requires col.`);
        return nonNull(item);
      });
      break;
    case "join":
      if (p.how === "cross" ? p.on !== null : p.on === null)
        throw new Error("join requires on keys except cross joins, which have no keys.");
      if (p.on !== null) {
        unique(
          p.on.map((item: any) => JSON.stringify([item.left, item.right])),
          "join keys"
        );
        properties.on = p.on.map((item: any) => [item.left, item.right]);
      }
      copy({ how: "type", nulls_equal: "nullsEqual", suffix: "rightSuffix", validate: "validate" });
      break;
    case "union":
      copy({ schema: "schema" });
      break;
    case "distinct":
      copy({ columns: "columns", keep: "keep" });
      break;
    case "sort":
      properties.by = ordered(p.by);
      copy({ nulls: "nulls" });
      break;
    case "limit":
      copy({ n: "n", offset: "offset" });
      break;
    case "window":
      copy({ partition_by: "partitionBy" });
      properties.orderBy = ordered(p.order_by);
      unique(
        p.columns.map((item: any) => item.as),
        "window outputs"
      );
      properties.columns = p.columns.map((item: any) => {
        if (item.fn === "lag" || item.fn === "lead") {
          if (item.col === null) throw new Error(`${item.fn} requires col.`);
        } else if (item.col !== null || item.offset !== null) throw new Error(`${item.fn} takes no col or offset.`);
        const column = nonNull(item);
        if (column.offset === 1) delete column.offset;
        return column;
      });
      break;
    case "unpivot":
      copy({ columns: "columns", name: "nameColumn", value: "valueColumn" });
      break;
    case "pivot":
      copy({ index: "index", columns: "columns", values: "values" });
      break;
  }
  const runtimeValidate = runtimeValidators.get(def.name)!;
  if (!runtimeValidate(properties))
    throw new Error(`Invalid ${def.name} properties: ${ajv.errorsText(runtimeValidate.errors)}`);
  const view: NativeOpView = {
    type: def.type,
    inputs: [...definition.inputs],
    properties,
    graph: {
      inputPorts:
        def.inputs === 1 ? ["in"] : def.inputs === 2 ? ["left", "right"] : definition.inputs.map((_, i) => `in[${i}]`),
    },
    jsonDefinition: { operator: def.name, params: canonical },
    datetimePolicy: "preserve",
    ...(["filter", "map", "process"].includes(def.name) ? { functionValidation: "callable" as const } : {}),
    ...(options.profileCollection !== undefined ? { profileCollection: options.profileCollection } : {}),
    ...(options.profileScope !== undefined ? { profileScope: options.profileScope } : {}),
  };
  view.revision = nativeRevision(view);
  return view;
}
