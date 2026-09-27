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

import { HISTORY_REFERENCE, taskInputId, type TaskInput } from "./task-reference";

/**
 * NATIVE operator catalog — the operators of `agentMode: "native"`.
 *
 * The model writes a dataflow as a program of assignments,
 *
 *     large = filter(orders, lambda row: row["amount"] > 100)
 *
 * one per operator: the left name is the output table's id, the positional
 * arguments are the input tables (the DAG's edges are derived from them, never
 * declared separately), and the keyword arguments are the operator's
 * parameters. `program_parser.py` turns that text into a neutral syntax tree;
 * this file says which operators exist and how each call's arguments become the
 * runtime `properties` that `python/runtime.py` executes. The prompt's operator
 * signatures are generated from the same definitions, so what the model is told,
 * what the parser accepts and what the engine runs cannot drift apart.
 *
 * Three "custom" operators carry Python: `filter` (row → bool), `map` (row →
 * one value per declared output column) and `process` (tables → table). Their
 * row effect is fixed by the operator name, never inferred from the code.
 */

export type RowEffect =
  /** Scan: brings a table into existence. */
  | "create"
  /** Filter / Distinct / Limit: can only remove rows. */
  | "drop"
  /** Union / Unpivot: adds rows. */
  | "add"
  /** Aggregate / Pivot: collapses rows to one per group. */
  | "collapse"
  /** Join: can drop or multiply rows. */
  | "multiply"
  /** Project / Cast / Map / Sort / Window: row set untouched. */
  | "none"
  /** Process: anything. */
  | "unknown";

/** The typed view carried on an operator predicate (`OperatorPredicate.nativeOp`). */
export interface NativeOpView {
  /** Hash of type + inputs + properties; the identity a result is bound to. */
  revision?: string;
  /** Internal execution setting, never a model-authored operator argument. */
  profileCollection?: boolean;
  /** Runtime type (`Filter`, `Map`, `Process`, …). */
  type: string;
  properties: Record<string, unknown>;
  /** Upstream operator ids in port order (= positional operands). */
  inputs: string[];
  /** The assignment as the model wrote it (`x = filter(...)`), for rendering. */
  source?: string;
  /** Top-level `def` sources the statement refers to, by name. */
  functions?: Record<string, string>;
  /** A fork owns its callable definitions; later default-function edits cannot change them. */
  analysisBranch?: { root: string; origin: string; task?: number };
  /** Multi-task: inputs as written, in port order. A string is a current table;
   * `{operator, atTask}` is that table's output retained at the end of task N,
   * served by a runtime-owned source whose id stands in `inputs`. */
  taskInputs?: Array<string | { operator: string; atTask: number }>;
}

/* ----------------------------------------------------------------------------
 *  Parsed program values (mirror of program_parser.py's encoding)
 * ------------------------------------------------------------------------- */

export type ParsedValue =
  | { kind: "const"; value: string | number | boolean | null }
  | { kind: "list"; items: ParsedValue[]; tuple: boolean }
  | { kind: "dict"; entries: Array<[string, ParsedValue]> }
  | { kind: "name"; name: string }
  | { kind: "call"; name: string; args: ParsedValue[]; kwargs: Record<string, ParsedValue>; source: string }
  | { kind: "lambda"; params: string[]; body: string; source: string; references?: string[] };

export interface ParsedFunction {
  name: string;
  params: string[];
  source: string;
  line: number;
  /** Python global reads; missing only for legacy callers or invalid signatures. */
  references?: string[];
  /** The literal default of each parameter that has one; null marks a default that is not a literal. */
  defaults?: Record<string, ParsedValue | null>;
  /** Keyword-only parameters (after `*`), bindable by name like the others. */
  keywordOnly?: string[];
  /** The docstring, whitespace-collapsed: the doc of the operator the def is, written over its parameters. */
  doc?: string;
  /** `*args`, `**kwargs`, positional-only, or a keyword-only parameter without a default: not callable as an operator. */
  variadic?: boolean;
}

export interface ParsedStatement {
  id: string;
  op: string;
  line: number;
  endLine: number;
  source: string;
  args: ParsedValue[];
  kwargs: Record<string, ParsedValue>;
  /** Identifier arguments with their (line, column) spans in `source`, for
   * rewriting ids in place; not part of what identifies a submission. The
   * called name itself is included with `operator: true`. */
  names?: Array<{
    name: string;
    span: [number, number, number, number];
    argumentIndex?: number;
    operator?: boolean;
  }>;
}

/** A function slot: Python source defining exactly one entry function. */
export interface FunctionSlot {
  source: string;
  entry: string;
  params: string[];
  /** The `def` name when the slot referred to a top-level function. */
  ref?: string;
}

/** Thrown by a normalizer: the model's arguments do not fit the operator. */
export class NativeArgumentError extends Error {
  constructor(
    message: string,
    readonly field?: string
  ) {
    super(message);
  }
}

export interface NormalizeContext {
  functions: Record<string, ParsedFunction>;
  /** Names of the input tables already taken from the positional arguments. */
  inputs: string[];
  /** Records a top-level `def` the statement used, for rendering. */
  used(fn: FunctionSlot): void;
}

export interface NativeOperatorDef {
  /** Surface function name in the program: `filter`, `aggregate`, … */
  name: string;
  /** Runtime type in `python/runtime.py`: `Filter`, `Aggregate`, … */
  type: string;
  /** Number of input tables: 0 (source), 1, 2 (join) or "many" (union, process). */
  inputs: 0 | 1 | 2 | "many";
  rowEffect: RowEffect;
  /** Call signature shown in the system prompt, e.g. `filter(T, fn, doc="...")`. */
  signature: string;
  /** One-paragraph contract shown under the signature. */
  doc: string;
  /** JSON schema of the normalized `properties` (Ajv-validated in the tool). */
  schema: Record<string, unknown>;
  /** Positional arguments after the input tables plus the keyword arguments → runtime properties. */
  normalize(
    rest: ParsedValue[],
    kwargs: Record<string, ParsedValue>,
    context: NormalizeContext
  ): Record<string, unknown>;
}

/* ----------------------------------------------------------------------------
 *  Argument helpers
 * ------------------------------------------------------------------------- */

export const DTYPES = ["str", "int64", "float64", "bool", "datetime"] as const;
export type Dtype = (typeof DTYPES)[number];
export const AGGREGATE_FUNCTIONS = [
  "count",
  "count_distinct",
  "sum",
  "mean",
  "min",
  "max",
  "median",
  "stddev",
  "first",
] as const;
export const WINDOW_FUNCTIONS = ["lag", "lead", "row_number", "rank", "dense_rank"] as const;

const fail = (message: string, field?: string): never => {
  throw new NativeArgumentError(message, field);
};

export const show = (value: ParsedValue): string => {
  switch (value.kind) {
    case "const":
      return JSON.stringify(value.value);
    case "name":
      return value.name;
    case "call":
    case "lambda":
      return value.source;
    case "list":
      return `[${value.items.map(show).join(", ")}]`;
    case "dict":
      return `{${value.entries.map(([k, v]) => `${JSON.stringify(k)}: ${show(v)}`).join(", ")}}`;
  }
};

function str(value: ParsedValue, field: string): string {
  if (value.kind === "const" && typeof value.value === "string" && value.value.length > 0) return value.value;
  return fail(`${field} must be a nonempty string, got ${show(value)}.`, field);
}

function bool(value: ParsedValue, field: string): boolean {
  if (value.kind === "const" && typeof value.value === "boolean") return value.value;
  return fail(`${field} must be True or False, got ${show(value)}.`, field);
}

function int(value: ParsedValue, field: string, minimum = Number.NEGATIVE_INFINITY): number {
  if (
    value.kind === "const" &&
    typeof value.value === "number" &&
    Number.isInteger(value.value) &&
    value.value >= minimum
  )
    return value.value;
  return fail(
    `${field} must be an integer${Number.isFinite(minimum) ? ` >= ${minimum}` : ""}, got ${show(value)}.`,
    field
  );
}

function strList(value: ParsedValue, field: string, minItems = 0): string[] {
  const items =
    value.kind === "list" ? value.items : value.kind === "const" && typeof value.value === "string" ? [value] : null;
  if (!items) return fail(`${field} must be a list of column names, got ${show(value)}.`, field);
  const names = items.map(item => str(item, field));
  if (names.length < minItems) return fail(`${field} needs at least ${minItems} name(s).`, field);
  if (new Set(names).size !== names.length) return fail(`${field} repeats a column name.`, field);
  return names;
}

function oneOf<T extends string>(value: ParsedValue, field: string, allowed: readonly T[]): T {
  const text = str(value, field);
  if ((allowed as readonly string[]).includes(text)) return text as T;
  return fail(
    `${field} must be one of ${allowed.map(a => JSON.stringify(a)).join(", ")}, got ${JSON.stringify(text)}.`,
    field
  );
}

function dtypeName(value: ParsedValue, field: string): Dtype {
  const name = value.kind === "name" ? value.name : value.kind === "call" && value.args.length === 0 ? value.name : "";
  if ((DTYPES as readonly string[]).includes(name)) return name as Dtype;
  return fail(`${field} must be a dtype (${DTYPES.join(", ")}), got ${show(value)}.`, field);
}

/** `"col"` or `("col", "desc")` → `{col, desc?}`; lists of them for sort/order keys. */
function sortKeys(value: ParsedValue, field: string): Array<{ col: string; desc?: boolean }> {
  const items = value.kind === "list" && !value.tuple ? value.items : [value];
  if (!items.length) return fail(`${field} needs at least one key.`, field);
  return items.map(item => {
    if (item.kind === "const") return { col: str(item, field) };
    if (item.kind === "list" && item.items.length === 2) {
      const direction = oneOf(item.items[1], field, ["asc", "desc"]);
      return direction === "desc" ? { col: str(item.items[0], field), desc: true } : { col: str(item.items[0], field) };
    }
    return fail(`${field} items are "col" or ("col", "desc"), got ${show(item)}.`, field);
  });
}

/** Resolve a function slot: a lambda (synthesized `def apply`) or a `def` name. */
function functionSlot(value: ParsedValue, field: string, context: NormalizeContext): FunctionSlot {
  if (value.kind === "lambda") {
    // Parenthesize so a lambda body that spans lines stays one return expression.
    // Program functions the body calls travel with it, as they do for a `def`.
    const body = value.body.includes("\n") ? `(\n${value.body}\n    )` : value.body;
    const helpers = referencedFunctions(value.body, context.functions, value.references);
    for (const helper of helpers)
      context.used({ source: helper.source, entry: helper.name, params: helper.params, ref: helper.name });
    return {
      source: [...helpers.map(f => f.source), `def apply(${value.params.join(", ")}):\n    return ${body}`].join(
        "\n\n"
      ),
      entry: "apply",
      params: value.params,
    };
  }
  if (value.kind === "name") {
    const fn = context.functions[value.name];
    if (!fn)
      return fail(
        `${field} refers to ${value.name}, which is not a function defined in this program. Define it with \`def ${value.name}(...)\` above the operator, or pass a lambda.`,
        field
      );
    // The slot's source must run on its own in the engine, so it carries every
    // other top-level `def` the function mentions (transitively), helpers first.
    const closure = functionClosure(fn, context.functions);
    const slot: FunctionSlot = {
      source: closure.map(f => f.source).join("\n\n"),
      entry: fn.name,
      params: fn.params,
      ref: fn.name,
    };
    context.used(slot);
    return slot;
  }
  return fail(
    `${field} must be a lambda or the name of a function defined in this program, got ${show(value)}.`,
    field
  );
}

/** The program functions a piece of source names, transitively, dependencies first. */
export function referencedFunctions(
  source: string,
  functions: Record<string, ParsedFunction>,
  references?: string[]
): ParsedFunction[] {
  const ordered: ParsedFunction[] = [];
  const seen = new Set<string>();
  const visit = (text: string, self?: string, names?: string[]) => {
    for (const [name, other] of Object.entries(functions)) {
      if (name === self || seen.has(name) || !(names ? names.includes(name) : new RegExp(`\\b${name}\\b`).test(text)))
        continue;
      seen.add(name);
      visit(other.source, name, other.references);
      ordered.push(other);
    }
  };
  visit(source, undefined, references);
  return ordered;
}

/** `fn` plus the program functions its source names, dependencies first. */
export function functionClosure(fn: ParsedFunction, functions: Record<string, ParsedFunction>): ParsedFunction[] {
  return [
    ...referencedFunctions(fn.source, { ...functions, [fn.name]: fn }, fn.references).filter(f => f.name !== fn.name),
    fn,
  ];
}

/** Reject unknown keywords with the list of accepted ones. */
function keywords(op: string, kwargs: Record<string, ParsedValue>, allowed: readonly string[]): void {
  for (const key of Object.keys(kwargs))
    if (!allowed.includes(key))
      fail(`${op} does not take a keyword \`${key}\`; accepted keywords: ${allowed.join(", ")}.`, key);
}

/** The required `doc="..."` of a custom operator: one constant sentence stating the function's logical semantics. */
function docText(op: string, value: ParsedValue | undefined, meaning: string): string {
  const text = value && value.kind === "const" && typeof value.value === "string" ? value.value.trim() : "";
  if (!text) fail(`${op} needs doc="one sentence stating ${meaning}".`, "doc");
  return text;
}

function noPositional(op: string, rest: ParsedValue[], expected: string): void {
  if (rest.length) fail(`${op} takes ${expected}; the extra positional argument ${show(rest[0])} is not allowed.`);
}

/* ----------------------------------------------------------------------------
 *  Registered operators: a `def` called by name
 * ------------------------------------------------------------------------- */

/** `band_report(T, band_column, value, top=5)`: the def's parameters with their defaults. */
export function registeredSignature(fn: ParsedFunction): string {
  const defaults = fn.defaults ?? {};
  const render = (name: string) =>
    Object.hasOwn(defaults, name) ? `${name}=${defaults[name] ? show(defaults[name]!) : "…"}` : name;
  return `${fn.name}(${[...fn.params, ...(fn.keywordOnly ?? [])].map(render).join(", ")})`;
}

/** A value a call may pass as a setting, as JSON: a constant, or a list or
 * dict of such values. Undefined for a name, a call or a lambda. */
export function literalOf(value: ParsedValue): unknown {
  switch (value.kind) {
    case "const":
      return typeof value.value === "number" && !Number.isFinite(value.value) ? undefined : value.value;
    case "list": {
      const items = value.items.map(literalOf);
      return items.some(item => item === undefined) ? undefined : items;
    }
    case "dict": {
      const entries = value.entries.map(([key, item]) => [key, literalOf(item)] as const);
      return entries.some(([, item]) => item === undefined) ? undefined : Object.fromEntries(entries);
    }
    default:
      return undefined;
  }
}

/** A setting as it reads in a sentence: the string itself, a number as
 * written, True/False/None, a list as its items. */
export function plainText(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(plainText).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** The docstring rendered for a call: `{name}` becomes the argument bound to
 * that parameter (a table by its name, a setting as plain text). A placeholder
 * that names no parameter stays as written. */
export function renderOperatorDoc(template: string, values: ReadonlyMap<string, string>): string {
  return template.replace(/\{([A-Za-z_]\w*)\}/g, (whole, name: string) => values.get(name) ?? whole);
}

/** A table argument: a name that is not a function of the program, or
 * `at(name, task=N)`. Undefined for anything else. */
export function tableReference(
  value: ParsedValue | undefined,
  functions: Record<string, ParsedFunction>,
  tableNames?: ReadonlySet<string>
): TaskInput | undefined {
  const saved = historyReferenceOf(value);
  if (saved) return saved;
  return value && value.kind === "name" && (tableNames?.has(value.name) || !(value.name in functions))
    ? value.name
    : undefined;
}

export interface RegisteredCall {
  /** The process the call compiles to: code, entry, the rendered doc, `params` (the settings) and `tables` (the parameters bound to inputs, in input order). */
  properties: Record<string, unknown>;
  inputs: string[];
  references: TaskInput[];
}

/** Bind a call to the def's parameters the way Python does (positional
 * arguments in order, then keywords, then defaults). A parameter bound to a
 * table is an input; one bound to a literal is a setting; every parameter
 * without a default must be bound. The docstring rendered with the bound
 * values is the doc. */
export function bindRegisteredCall(
  fn: ParsedFunction,
  args: ParsedValue[],
  kwargs: Record<string, ParsedValue>,
  context: NormalizeContext,
  tableNames?: ReadonlySet<string>
): RegisteredCall {
  const names = [...fn.params, ...(fn.keywordOnly ?? [])];
  const defaults = fn.defaults ?? {};
  if (fn.variadic)
    fail(
      `${fn.name} cannot be called as an operator: its parameters must be plain named parameters (no *args, **kwargs, positional-only or keyword-only parameters without a default).`,
      "fn"
    );
  for (const [key, value] of Object.entries(defaults))
    if (value === null)
      fail(
        `The default of ${fn.name}'s parameter ${key} must be a literal (a string, number, True/False, None, or a list of those).`,
        key
      );
  if (!fn.doc)
    fail(
      `${fn.name} needs a docstring to be an operator: one sentence over its parameters stating what its output holds, e.g. """One row per {${names[1] ?? names[0] ?? "group"}} with ...""".`,
      "doc"
    );
  const bound = new Map<string, ParsedValue>();
  if (args.length > fn.params.length)
    fail(
      `${fn.name} takes ${fn.params.length} positional parameter(s) (${fn.params.join(", ") || "none"}); got ${args.length}. Pass the rest as keywords.`,
      "inputs"
    );
  args.forEach((value, index) => bound.set(fn.params[index]!, value));
  for (const [key, value] of Object.entries(kwargs)) {
    if (!names.includes(key))
      fail(`${fn.name} does not take a keyword \`${key}\`; its parameters are ${names.join(", ") || "none"}.`, key);
    if (bound.has(key)) fail(`${fn.name}'s parameter ${key} is given twice.`, key);
    bound.set(key, value);
  }
  const inputs: string[] = [];
  const references: TaskInput[] = [];
  const tables: string[] = [];
  const params: Record<string, unknown> = {};
  const values = new Map<string, string>();
  for (const name of names) {
    const value = bound.get(name);
    if (value === undefined) {
      if (!Object.hasOwn(defaults, name)) fail(`${fn.name} needs an argument for ${name}.`, name);
      values.set(name, plainText(literalOf(defaults[name]!)));
      continue;
    }
    const table = tableReference(value, context.functions, tableNames);
    if (table !== undefined) {
      const id = typeof table === "string" ? table : taskInputId(table);
      if (inputs.includes(id)) fail(`${fn.name} binds the table ${id} to two parameters; pass distinct tables.`, name);
      inputs.push(id);
      references.push(table);
      tables.push(name);
      values.set(name, show(value));
      continue;
    }
    const literal = literalOf(value);
    if (literal === undefined)
      fail(
        `${name} must name a table or be a literal (a string, number, True/False, None, or a list of those), got ${show(value)}.`,
        name
      );
    params[name] = literal;
    values.set(name, plainText(literal));
  }
  const doc = renderOperatorDoc(fn.doc!, values);
  const closure = functionClosure(fn, context.functions);
  const source = closure.map(f => f.source).join("\n\n");
  context.used({ source, entry: fn.name, params: fn.params, ref: fn.name });
  return { properties: { code: source, entry: fn.name, doc, params, tables }, inputs, references };
}

/** The docstring of the entry function in a code slot, for indexes that list
 * registered operators without re-parsing the program. */
export function docstringOf(source: string, entry: string): string | undefined {
  const match = new RegExp(`^\\s*def\\s+${entry}\\s*\\([^)]*\\)\\s*(?:->[^:]+)?:\\s*\\n\\s*(?:r|u)?("""|''')([\\s\\S]*?)\\1`, "m").exec(
    source
  );
  const text = match?.[2].replace(/\s+/g, " ").trim();
  return text || undefined;
}

/** The signature line of a def in a code slot: `rank_by_score(scores, top=10)`. */
export function signatureOfSource(source: string, entry: string): string {
  const match = new RegExp(`^\\s*def\\s+${entry}\\s*\\(([^)]*)\\)`, "m").exec(source);
  return `${entry}(${(match?.[1] ?? "").replace(/\s+/g, " ").trim()})`;
}

/* ----------------------------------------------------------------------------
 *  JSON schemas of the normalized properties (Ajv safety net after normalize)
 * ------------------------------------------------------------------------- */

const S = { type: "string", minLength: 1 };
const NAMES = { type: "array", items: S, uniqueItems: true };
const SCALAR = { type: ["string", "number", "boolean", "null"] };
/** A setting: a scalar, or a list or dict of scalars (one level of nesting inside). */
const LITERAL = {
  anyOf: [
    SCALAR,
    { type: "array", items: { anyOf: [SCALAR, { type: "array", items: SCALAR }, { type: "object", additionalProperties: SCALAR }] } },
    { type: "object", additionalProperties: { anyOf: [SCALAR, { type: "array", items: SCALAR }] } },
  ],
};
const NONEMPTY_NAMES = { ...NAMES, minItems: 1 };
const DTYPE = { type: "string", enum: [...DTYPES] };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const list = (items: Record<string, unknown>) => ({ type: "array", items, minItems: 1 });

/* ----------------------------------------------------------------------------
 *  The catalog
 * ------------------------------------------------------------------------- */

const SCAN_KEYWORDS: Record<string, string> = {
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
};

export const NATIVE_OPERATORS: readonly NativeOperatorDef[] = [
  {
    name: "scan",
    type: "Scan",
    inputs: 0,
    rowEffect: "create",
    signature:
      'scan(files, format="auto", skip_lines=0, header=True, names=None, all_text=False, delim=None, comment=None, widths=None, sheet=None, encoding=None, file_column=None, preview=None)',
    doc: 'Reads a file or glob (csv, tsv, txt, xlsx, html, json, parquet; format=lines/fwf/whitespace for non-delimited text) into a table. `preview=n` shows the first n RAW lines (or sheet rows) from `skip_lines` instead of parsing: use it on an unfamiliar file, then scan for real. A CSV preview numbers the `record` of each line: lines that share one are a single row whose quoted field holds line breaks, and `skip_lines` counts lines, not records. Cells read as pandas.read_csv reads them: "NA", "N/A", "null", "nan" and the other pandas missing-value tokens are missing (the observation counts them) while "None" stays a value, as before pandas 2.0; a blank header is `Unnamed: <i>`, and a repeated header gets `.1`, `.2`. `all_text=True` keeps every cell as text, codes like 001 and those tokens included; `names` requires header=False and one name per column; `sheet` picks an Excel sheet or HTML table index; `file_column` records each row\'s source file. Example: `orders = scan("data/orders.csv")`.',
    schema: object(
      {
        files: { oneOf: [S, list(S)] },
        format: {
          type: "string",
          enum: ["auto", "csv", "lines", "fwf", "whitespace", "excel", "html", "json", "parquet"],
        },
        skipLines: { type: "integer", minimum: 0 },
        header: { type: "boolean" },
        names: NONEMPTY_NAMES,
        allText: { type: "boolean" },
        delim: S,
        comment: { type: "string", minLength: 1, maxLength: 1 },
        widths: list({ type: "integer", minimum: 1 }),
        sheet: { oneOf: [S, { type: "integer", minimum: 0 }] },
        encoding: S,
        fileColumn: S,
        preview: { type: "integer", minimum: 1, maximum: 200 },
      },
      ["files"]
    ),
    normalize(rest, kwargs) {
      const props: Record<string, unknown> = {};
      if (rest.length > 1) fail("scan takes the file path (or list of paths) as its only positional argument.");
      const files = rest[0] ?? kwargs.files;
      if (!files) fail('scan needs the file path or glob: scan("data/dir/file.csv").', "files");
      props.files = files.kind === "list" ? strList(files, "files", 1) : str(files, "files");
      const { files: _f, ...options } = kwargs;
      keywords(
        "scan",
        options,
        Object.keys(SCAN_KEYWORDS).filter(k => k !== "files")
      );
      for (const [key, value] of Object.entries(options)) {
        const target = SCAN_KEYWORDS[key];
        switch (key) {
          case "format":
            props.format = oneOf(value, key, [
              "auto",
              "csv",
              "lines",
              "fwf",
              "whitespace",
              "excel",
              "html",
              "json",
              "parquet",
            ]);
            break;
          case "skip_lines":
            props.skipLines = int(value, key, 0);
            break;
          case "header":
          case "all_text":
            props[target] = bool(value, key);
            break;
          case "names":
            props.names = strList(value, key, 1);
            break;
          case "widths":
            if (value.kind !== "list" || !value.items.length) fail("widths must be a list of positive integers.", key);
            else props.widths = value.items.map(item => int(item, key, 1));
            break;
          case "sheet":
            props.sheet =
              value.kind === "const" && typeof value.value === "number" ? int(value, key, 0) : str(value, key);
            break;
          case "preview":
            props.preview = int(value, key, 1);
            if ((props.preview as number) > 200) fail("preview shows at most 200 lines.", key);
            break;
          case "comment":
            props.comment = str(value, key);
            if ((props.comment as string).length !== 1) fail("comment must be a single character.", key);
            break;
          default:
            props[target] = str(value, key);
        }
      }
      return props;
    },
  },
  {
    name: "project",
    type: "Project",
    inputs: 1,
    rowEffect: "none",
    signature: "project(T, keep=None, drop=None, rename=None)",
    doc: 'Keeps (in the given order) or drops the listed columns, then renames with a {old: new} mapping. At least one of the three. Rows are unchanged; a missing column or a name collision fails. Example: `trimmed = project(orders, keep=["region", "amount"], rename={"amount": "total"})`.',
    schema: {
      ...object({
        keep: NONEMPTY_NAMES,
        drop: NONEMPTY_NAMES,
        rename: { type: "object", additionalProperties: S, minProperties: 1 },
      }),
      anyOf: [{ required: ["keep"] }, { required: ["drop"] }, { required: ["rename"] }],
    },
    normalize(rest, kwargs) {
      noPositional("project", rest, "one input table");
      keywords("project", kwargs, ["keep", "drop", "rename"]);
      const props: Record<string, unknown> = {};
      if (kwargs.keep) props.keep = strList(kwargs.keep, "keep", 1);
      if (kwargs.drop) props.drop = strList(kwargs.drop, "drop", 1);
      if (kwargs.keep && kwargs.drop) fail("project takes keep or drop, not both.");
      if (kwargs.rename) {
        if (kwargs.rename.kind !== "dict" || !kwargs.rename.entries.length)
          fail("rename must be a {old: new} dictionary.", "rename");
        else props.rename = Object.fromEntries(kwargs.rename.entries.map(([k, v]) => [k, str(v, "rename")]));
      }
      if (!Object.keys(props).length) fail("project needs keep=, drop= or rename=.");
      return props;
    },
  },
  {
    name: "cast",
    type: "Cast",
    inputs: 1,
    rowEffect: "none",
    signature: 'cast(T, column=dtype, ..., errors="raise")',
    doc: 'Changes column types: `cast(t, amount=float64, year=int64)`; a column whose name is not an identifier goes through `**{"Unit Price": float64}`. dtypes are str, int64, float64, bool, datetime; `datetime(format="%Y-%m-%d", tz="UTC")` takes an explicit format and timezone (naive values need tz). A value that does not convert fails the operator, or becomes missing with errors="null". Normalize text (thousands separators, percent signs) with map first.',
    schema: object(
      {
        columns: list(object({ column: S, dtype: DTYPE, format: S, timezone: S }, ["column", "dtype"])),
        errors: { type: "string", enum: ["raise", "null"] },
      },
      ["columns"]
    ),
    normalize(rest, kwargs) {
      noPositional("cast", rest, "one input table");
      const columns: Array<Record<string, unknown>> = [];
      const props: Record<string, unknown> = { columns };
      for (const [key, value] of Object.entries(kwargs)) {
        if (key === "errors") {
          props.errors = oneOf(value, key, ["raise", "null"]);
          continue;
        }
        const column: Record<string, unknown> = { column: key };
        if (value.kind === "call" && value.name === "datetime") {
          column.dtype = "datetime";
          keywords("datetime()", value.kwargs, ["format", "tz"]);
          if (value.args.length) fail("datetime(...) takes keywords only: format=, tz=.", key);
          if (value.kwargs.format) column.format = str(value.kwargs.format, `${key}.format`);
          if (value.kwargs.tz) column.timezone = str(value.kwargs.tz, `${key}.tz`);
        } else column.dtype = dtypeName(value, key);
        columns.push(column);
      }
      if (!columns.length) fail("cast needs at least one column=dtype argument.");
      return props;
    },
  },
  {
    name: "filter",
    type: "Filter",
    inputs: 1,
    rowEffect: "drop",
    signature: 'filter(T, fn, doc="what the predicate keeps")',
    doc: 'Keeps the rows for which `fn(row)` returns True: `big = filter(orders, lambda row: row["amount"] is not None and row["amount"] > 100, doc="Keeps orders with an amount above 100")`. `row` is a read-only mapping of the input columns (`row["col"]`; a missing value is None). Return True to keep, False or None to drop; anything else, including a truthy string, is a contract error. Row order is preserved; the columns the function reads are measured, not declared. `doc` is one sentence stating the logical semantics of the predicate (which rows survive); it is shown with the results.',
    schema: object({ func: S, entry: S, doc: S }, ["func", "entry", "doc"]),
    normalize(rest, kwargs, context) {
      keywords("filter", kwargs, ["fn", "doc"]);
      if (rest.length > 1) fail("filter takes the input table, one predicate function and doc=.");
      const fnValue = rest[0] ?? kwargs.fn;
      if (!fnValue)
        fail(
          'filter needs a predicate: filter(t, lambda row: ..., doc="...") or filter(t, fn=my_function, doc="...").',
          "fn"
        );
      const slot = functionSlot(fnValue!, "fn", context);
      if (slot.params.length !== 1)
        fail(
          `filter's function takes exactly one parameter (the row); ${slot.entry} takes ${slot.params.length}.`,
          "fn"
        );
      return {
        func: slot.source,
        entry: slot.entry,
        doc: docText("filter", kwargs.doc, "which rows the predicate keeps"),
      };
    },
  },
  {
    name: "map",
    type: "Map",
    inputs: 1,
    rowEffect: "none",
    signature: 'map(T, fn, doc="what the new row holds")',
    doc: 'Transforms every row: `fn(row)` returns the new row as a dict and those dicts are the output table: `priced = map(orders, lambda row: {**row, "unit_price": None if row["quantity"] in (None, 0) else row["amount"] / row["quantity"]}, doc="Adds unit_price = amount / quantity, None when quantity is missing or zero")`. `{**row, ...}` keeps the input columns; a dict without it keeps only the keys you return (rename or drop columns that way). One row out per row in, in the same order; every row must return the same keys; values are scalars or None; column types are inferred from the values (ints and floats mix to float64, one type per column otherwise). Missing values arrive as None; handle them explicitly. `doc` is one sentence stating the logical semantics of the function (which columns it adds, changes or drops, and how); it is shown with the results.',
    schema: object({ func: S, entry: S, doc: S }, ["func", "entry", "doc"]),
    normalize(rest, kwargs, context) {
      keywords("map", kwargs, ["fn", "doc"]);
      if (rest.length > 1) fail("map takes the input table, one row function and doc=.");
      const fnValue = rest[0] ?? kwargs.fn;
      if (!fnValue)
        fail(
          'map needs a row function: map(t, lambda row: {**row, "new": ...}, doc="...") or map(t, fn=my_function, doc="...").',
          "fn"
        );
      const slot = functionSlot(fnValue!, "fn", context);
      if (slot.params.length !== 1)
        fail(`map's function takes exactly one parameter (the row); ${slot.entry} takes ${slot.params.length}.`, "fn");
      return { func: slot.source, entry: slot.entry, doc: docText("map", kwargs.doc, "what the returned row holds") };
    },
  },
  {
    name: "aggregate",
    type: "Aggregate",
    inputs: 1,
    rowEffect: "collapse",
    signature: 'aggregate(T, by=[], name=reducer("col"), ..., dropna=True)',
    doc: 'One output row per distinct combination of the `by` columns (no `by` gives one row). As in pandas groupby, a row with a null in any `by` column belongs to no group and the observation counts those rows; dropna=False keeps null keys as their own group. Each other keyword is an output column: count() counts rows, count("col") non-null values, and count_distinct, sum, mean, min, max, median, stddev, first reduce a column. Reductions ignore nulls (first keeps them); an all-null sum is null; stddev is the sample standard deviation. Numeric reducers need numeric columns: cast first. Example: `by_region = aggregate(orders, by=["region"], total=sum("amount"), n=count())`.',
    schema: object(
      {
        groupBy: NAMES,
        dropna: { type: "boolean" },
        aggregations: list(
          object({ fn: { type: "string", enum: [...AGGREGATE_FUNCTIONS] }, col: S, as: S }, ["fn", "as"])
        ),
      },
      ["aggregations"]
    ),
    normalize(rest, kwargs) {
      noPositional("aggregate", rest, "one input table");
      const props: Record<string, unknown> = {};
      const aggregations: Array<Record<string, unknown>> = [];
      for (const [key, value] of Object.entries(kwargs)) {
        if (key === "by") {
          props.groupBy = strList(value, "by");
          continue;
        }
        if (key === "dropna" && value.kind !== "call") {
          if (!bool(value, "dropna")) props.dropna = false;
          continue;
        }
        if (value.kind !== "call" || !(AGGREGATE_FUNCTIONS as readonly string[]).includes(value.name))
          fail(
            `aggregate output \`${key}\` must be a reducer call such as ${key}=mean("col"); reducers: ${AGGREGATE_FUNCTIONS.join(", ")}.`,
            key
          );
        const call = value as Extract<ParsedValue, { kind: "call" }>;
        if (Object.keys(call.kwargs).length || call.args.length > 1)
          fail(`${call.name}() takes at most one column name.`, key);
        if (call.name !== "count" && call.args.length !== 1)
          fail(`${call.name}() needs the column to reduce: ${key}=${call.name}("col").`, key);
        const item: Record<string, unknown> = { fn: call.name, as: key };
        if (call.args.length) item.col = str(call.args[0], key);
        aggregations.push(item);
      }
      if (!aggregations.length) fail('aggregate needs at least one output such as total=sum("amount").');
      props.aggregations = aggregations;
      return props;
    },
  },
  {
    name: "join",
    type: "Join",
    inputs: 2,
    rowEffect: "multiply",
    signature: 'join(L, R, on, how="inner", nulls_equal=False, suffix="_right", validate="many_to_many")',
    doc: 'Joins on explicit keys: `on="id"`, `on=["a", "b"]`, or `on=[("left_col", "right_col")]` when the names differ. how is inner, left, right, full, or cross (no keys). Null keys do not match unless nulls_equal=True. validate (one_to_one, one_to_many, many_to_one) fails the operator when the keys are not unique on the required side. Right-side columns that collide get `suffix`. No output order is promised: sort afterwards.',
    schema: object({
      type: { type: "string", enum: ["inner", "left", "right", "full", "cross"] },
      on: {
        oneOf: [
          S,
          NONEMPTY_NAMES,
          {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "array", minItems: 2, maxItems: 2, items: S },
          },
        ],
      },
      nullsEqual: { type: "boolean" },
      rightSuffix: { type: "string" },
      validate: { type: "string", enum: ["one_to_one", "one_to_many", "many_to_one", "many_to_many"] },
    }),
    normalize(rest, kwargs) {
      keywords("join", kwargs, ["on", "how", "nulls_equal", "suffix", "validate"]);
      if (rest.length > 1) fail("join takes the left and right tables, then keywords.");
      const props: Record<string, unknown> = {};
      const on = rest[0] ?? kwargs.on;
      if (on) {
        if (on.kind === "const") props.on = str(on, "on");
        else if (on.kind === "list" && on.items.every(item => item.kind === "const")) props.on = strList(on, "on", 1);
        else if (on.kind === "list" && on.items.every(item => item.kind === "list" && item.items.length === 2))
          props.on = on.items.map(item =>
            (item as Extract<ParsedValue, { kind: "list" }>).items.map(v => str(v, "on"))
          );
        else fail('on must be "key", ["k1", "k2"] or [("left_key", "right_key")].', "on");
      }
      if (kwargs.how) props.type = oneOf(kwargs.how, "how", ["inner", "left", "right", "full", "cross"]);
      if (kwargs.nulls_equal) props.nullsEqual = bool(kwargs.nulls_equal, "nulls_equal");
      if (kwargs.suffix) props.rightSuffix = str(kwargs.suffix, "suffix");
      if (kwargs.validate)
        props.validate = oneOf(kwargs.validate, "validate", [
          "one_to_one",
          "one_to_many",
          "many_to_one",
          "many_to_many",
        ]);
      if (props.type === "cross" && props.on) fail("a cross join has no keys; drop on= or choose another how.", "on");
      if (props.type !== "cross" && !props.on) fail('join needs on= (or how="cross").', "on");
      return props;
    },
  },
  {
    name: "union",
    type: "Union",
    inputs: "many",
    rowEffect: "add",
    signature: 'union(T1, T2, ..., schema="strict")',
    doc: 'Stacks two or more tables, keeping every row in input order. schema="strict" requires identical column names and types; "align" takes the union of columns in first-seen order and fills absent cells with null. Type mismatches need an explicit cast; nothing is deduplicated. Example: `all_orders = union(orders_2024, orders_2025, schema="strict")`.',
    schema: object({ schema: { type: "string", enum: ["strict", "align"] } }),
    normalize(rest, kwargs) {
      noPositional("union", rest, "input tables only");
      keywords("union", kwargs, ["schema"]);
      const props: Record<string, unknown> = {};
      if (kwargs.schema) props.schema = oneOf(kwargs.schema, "schema", ["strict", "align"]);
      return props;
    },
  },
  {
    name: "distinct",
    type: "Distinct",
    inputs: 1,
    rowEffect: "drop",
    signature: 'distinct(T, columns=None, keep="first")',
    doc: 'Removes duplicate rows by the listed key columns (or the whole row). Missing values compare equal. keep decides which whole row survives; relative order is preserved. Example: `one_per_customer = distinct(orders, columns=["customer_id"], keep="first")`.',
    schema: object({ columns: NONEMPTY_NAMES, keep: { type: "string", enum: ["first", "last"] } }),
    normalize(rest, kwargs) {
      noPositional("distinct", rest, "one input table");
      keywords("distinct", kwargs, ["columns", "keep"]);
      const props: Record<string, unknown> = {};
      if (kwargs.columns) props.columns = strList(kwargs.columns, "columns", 1);
      if (kwargs.keep) props.keep = oneOf(kwargs.keep, "keep", ["first", "last"]);
      return props;
    },
  },
  {
    name: "sort",
    type: "Sort",
    inputs: 1,
    rowEffect: "none",
    signature: 'sort(T, by, nulls="last")',
    doc: 'Stable sort by one or more keys: by=["total"] ascending, or by=[("total", "desc"), "name"]. Ties keep their input order; nulls go last unless nulls="first". Example: `ranked = sort(by_region, by=[("total", "desc"), "region"])`.',
    schema: object(
      {
        by: list(object({ col: S, desc: { type: "boolean" } }, ["col"])),
        nulls: { type: "string", enum: ["first", "last"] },
      },
      ["by"]
    ),
    normalize(rest, kwargs) {
      keywords("sort", kwargs, ["by", "nulls"]);
      if (rest.length > 1) fail("sort takes the input table and by=.");
      const by = rest[0] ?? kwargs.by;
      if (!by) fail('sort needs by=["col"] or by=[("col", "desc")].', "by");
      const props: Record<string, unknown> = { by: sortKeys(by!, "by") };
      if (kwargs.nulls) props.nulls = oneOf(kwargs.nulls, "nulls", ["first", "last"]);
      return props;
    },
  },
  {
    name: "limit",
    type: "Limit",
    inputs: 1,
    rowEffect: "drop",
    signature: "limit(T, n, offset=0)",
    doc: "Keeps n rows starting at offset, in the current order. Sort first for a meaningful top-k; past the end you get an empty table with the same columns. Example: `top_three = limit(ranked, 3)`.",
    schema: object({ n: { type: "integer", minimum: 1 }, offset: { type: "integer", minimum: 0 } }, ["n"]),
    normalize(rest, kwargs) {
      keywords("limit", kwargs, ["n", "offset"]);
      if (rest.length > 1) fail("limit takes the input table and n.");
      const n = rest[0] ?? kwargs.n;
      if (!n) fail("limit needs n: limit(t, 10).", "n");
      const props: Record<string, unknown> = { n: int(n!, "n", 1) };
      if (kwargs.offset) props.offset = int(kwargs.offset, "offset", 0);
      return props;
    },
  },
  {
    name: "window",
    type: "Window",
    inputs: 1,
    rowEffect: "none",
    signature: "window(T, partition_by=[], order_by=[...], name=fn, ...)",
    doc: 'Adds columns computed within partitions in the given order, then restores the input row order: `window(t, partition_by=["team"], order_by=["date"], prev=lag("score", 1), rank=dense_rank())`. Functions: lag(col, offset=1), lead(col, offset=1), row_number(), rank(), dense_rank(). row_number(), rank() and dense_rank() count from 1, as in SQL; pandas positions (cumcount(), a reset index) count from 0, so subtract 1 for those. Ties follow the order keys, so add a tie-break key when it matters. Null partition keys form one partition; null order values sort last.',
    schema: object(
      {
        partitionBy: NAMES,
        orderBy: list(object({ col: S, desc: { type: "boolean" } }, ["col"])),
        columns: list(
          object(
            {
              fn: { type: "string", enum: [...WINDOW_FUNCTIONS] },
              col: S,
              as: S,
              offset: { type: "integer", minimum: 1 },
            },
            ["fn", "as"]
          )
        ),
      },
      ["orderBy", "columns"]
    ),
    normalize(rest, kwargs) {
      noPositional("window", rest, "one input table");
      const props: Record<string, unknown> = {};
      const columns: Array<Record<string, unknown>> = [];
      for (const [key, value] of Object.entries(kwargs)) {
        if (key === "partition_by") {
          props.partitionBy = strList(value, key);
          continue;
        }
        if (key === "order_by") {
          props.orderBy = sortKeys(value, key);
          continue;
        }
        if (value.kind !== "call" || !(WINDOW_FUNCTIONS as readonly string[]).includes(value.name))
          fail(
            `window output \`${key}\` must be a window function call; functions: ${WINDOW_FUNCTIONS.join(", ")}.`,
            key
          );
        const call = value as Extract<ParsedValue, { kind: "call" }>;
        const item: Record<string, unknown> = { fn: call.name, as: key };
        if (call.name === "lag" || call.name === "lead") {
          if (!call.args.length) fail(`${call.name}() needs the column: ${key}=${call.name}("col", 1).`, key);
          item.col = str(call.args[0], key);
          const offset = call.args[1] ?? call.kwargs.offset;
          if (offset) item.offset = int(offset, `${key}.offset`, 1);
          keywords(`${call.name}()`, call.kwargs, ["offset"]);
          if (call.args.length > 2) fail(`${call.name}() takes a column and an offset.`, key);
        } else if (call.args.length || Object.keys(call.kwargs).length) fail(`${call.name}() takes no arguments.`, key);
        columns.push(item);
      }
      if (!props.orderBy) fail('window needs order_by=["col"].', "order_by");
      if (!columns.length) fail('window needs at least one output such as prev=lag("value", 1).');
      props.columns = columns;
      return props;
    },
  },
  {
    name: "unpivot",
    type: "Unpivot",
    inputs: 1,
    rowEffect: "add",
    signature: 'unpivot(T, columns, name="variable", value="value")',
    doc: 'Wide to long: one output row per input row and listed column, keeping the other columns as keys and adding `name` (the column\'s name) and `value` (its value, nulls included). The listed columns need compatible types; cast first on mismatch. Example: `monthly = unpivot(wide, columns=["Jan", "Feb", "Mar"], name="month", value="rainfall")`.',
    schema: object({ columns: NONEMPTY_NAMES, nameColumn: S, valueColumn: S }, ["columns"]),
    normalize(rest, kwargs) {
      keywords("unpivot", kwargs, ["columns", "name", "value"]);
      if (rest.length > 1) fail("unpivot takes the input table and columns=.");
      const props: Record<string, unknown> = {
        columns: strList(rest[0] ?? kwargs.columns ?? fail("unpivot needs columns=[...].", "columns"), "columns", 1),
      };
      if (kwargs.name) props.nameColumn = str(kwargs.name, "name");
      if (kwargs.value) props.valueColumn = str(kwargs.value, "value");
      return props;
    },
  },
  {
    name: "pivot",
    type: "Pivot",
    inputs: 1,
    rowEffect: "collapse",
    signature: "pivot(T, index, columns, values)",
    doc: 'Long to wide: one row per distinct index combination, one column per distinct value of `columns`, cells from `values`. Each (index, columns) pair must occur once: aggregate first if combining is intended. Absent cells are null; null pivot keys fail. The output schema depends on the data: observe it before naming its columns downstream. Example: `wide = pivot(by_region_year, index=["region"], columns="year", values="total")`.',
    schema: object({ index: NAMES, columns: S, values: S }, ["index", "columns", "values"]),
    normalize(rest, kwargs) {
      keywords("pivot", kwargs, ["index", "columns", "values"]);
      const [index, columns, values] = rest;
      if (rest.length > 3) fail("pivot takes index, columns and values.");
      return {
        index: strList(index ?? kwargs.index ?? fail("pivot needs index=[...] (may be []).", "index"), "index"),
        columns: str(columns ?? kwargs.columns ?? fail("pivot needs columns=.", "columns"), "columns"),
        values: str(values ?? kwargs.values ?? fail("pivot needs values=.", "values"), "values"),
      };
    },
  },
  {
    name: "process",
    type: "Process",
    inputs: "many",
    rowEffect: "unknown",
    signature: 'process(T1, ..., Tn, fn=function, doc="what it does")   or   process(fn=loader, doc="...")',
    doc: 'Table in, table out, in Python: `summary = process(orders, customers, fn=summarize, doc="Joins orders to customers and fits a linear trend per region")`. `fn` is a `def` from this program taking one pandas DataFrame per input table, in order (parameter names are yours), and returning one DataFrame with unique string column names, scalar cells and timezone-aware datetimes; with no input tables it takes no parameters and loads data itself. Each DataFrame arrives with its pandas row labels as the index, kept as pandas keeps them through filter, sort, distinct and head, so `full.loc[cleaned.index]` picks the cleaned rows of `full`; aggregate, join, union and pivot number their rows from 0. The index you return is kept the same way, and a named index, such as the keys of a groupby you did not reset, comes back as columns. `doc` is one sentence stating the logical semantics of the function (what the output table holds and how it is derived); it is shown with the results because nothing else about a process can be measured. Import packages inside the function. Use it for what no other operator expresses (custom parsers, binary formats, statistics, fitting, report layouts), not for filtering, deriving columns, grouping or joining.',
    schema: object(
      {
        code: S,
        entry: S,
        doc: S,
        // A registered operator: its settings and the parameters bound to its input tables.
        params: { type: "object", additionalProperties: LITERAL },
        tables: NAMES,
      },
      ["code", "entry", "doc"]
    ),
    normalize(rest, kwargs, context) {
      keywords("process", kwargs, ["fn", "doc"]);
      if (rest.length > 1) fail("process takes its input tables, then fn= and doc=.");
      const fnValue = rest[0] ?? kwargs.fn;
      if (!fnValue) fail("process needs fn=<function defined in this program>.", "fn");
      const slot = functionSlot(fnValue!, "fn", context);
      if (slot.params.length !== context.inputs.length)
        fail(
          `process(${context.inputs.join(", ") || ""}) has ${context.inputs.length} input table(s) but ${slot.entry} takes ${slot.params.length} parameter(s); define one parameter per input table, in order.`,
          "fn"
        );
      return { code: slot.source, entry: slot.entry, doc: docText("process", kwargs.doc, "what the function does") };
    },
  },
  {
    name: "parameters",
    type: "Parameters",
    inputs: 0,
    rowEffect: "create",
    signature: 'parameters(weight=0.5, threshold=10, unit="fraction", ...)',
    doc: 'One row of named scalar parameters (numbers, strings, booleans or null). Pass this table to process alongside the data; read values with params.iloc[0]["weight"]. Reassign the same table to update dependent analyses. Use another parameter table for a temporary scenario. Store adjustable assumptions here instead of copying constants into several functions.',
    schema: object(
      {
        values: {
          type: "object",
          minProperties: 1,
          additionalProperties: { type: ["string", "number", "boolean", "null"] },
        },
      },
      ["values"]
    ),
    normalize(rest, kwargs) {
      noPositional("parameters", rest, "named scalar keyword arguments");
      if (!Object.keys(kwargs).length) fail("parameters needs at least one named scalar value.");
      return {
        values: Object.fromEntries(
          Object.entries(kwargs).map(([name, value]) => {
            if (value.kind !== "const" || (typeof value.value === "number" && !Number.isFinite(value.value)))
              return fail(`Parameter ${name} must be a finite scalar literal.`, name);
            return [name, value.value];
          })
        ),
      };
    },
  },
  {
    name: "compare",
    type: "Compare",
    inputs: 2,
    rowEffect: "unknown",
    signature: 'compare(A, B, keys=["col", ...])',
    doc: 'Row-level difference of two tables with the same meaning, such as two versions of a ranking, a cohort or a score table. Rows are matched on `keys` (default: the shared text and boolean columns; with no such column, by row position). The output has one row per matched or unmatched key with `in_a`, `in_b`, and for every other shared column `<col>_a`, `<col>_b` and, when numeric, `<col>_delta` = B minus A. Aggregate it for counts (rows in both, only in A, only in B, changed) or filter it for the rows that moved. Use it instead of writing a comparison function, so the two sides stay the exact tables they are.',
    schema: object({ keys: NONEMPTY_NAMES }),
    normalize(rest, kwargs) {
      keywords("compare", kwargs, ["keys"]);
      if (rest.length > 1) fail("compare takes the two tables, then keys=[...].");
      const keys = rest[0] ?? kwargs.keys;
      return keys ? { keys: strList(keys, "keys", 1) } : {};
    },
  },
];

export const NATIVE_BY_NAME: ReadonlyMap<string, NativeOperatorDef> = new Map(NATIVE_OPERATORS.map(d => [d.name, d]));
export const NATIVE_BY_TYPE: ReadonlyMap<string, NativeOperatorDef> = new Map(NATIVE_OPERATORS.map(d => [d.type, d]));
export const NATIVE_OPERATOR_NAMES: readonly string[] = NATIVE_OPERATORS.map(d => d.name);

/** Operator ids double as Python identifiers in the program and in generated code. */
export const NATIVE_ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Surface name for a runtime type: `Aggregate` → `aggregate`, `Process` → `process`. */
export function nativeOperatorName(type: string): string {
  return NATIVE_BY_TYPE.get(type)?.name ?? type.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}

/** With the model's own operators on, custom code is a def called by name;
 * this entry replaces `process` in the catalog (the operator still compiles,
 * so older programs and forks keep working). */
export const OWN_OPERATOR_CATALOG_ENTRY =
  'T2 = your_operator(T1, ..., setting=value, ...)   or   T = your_loader()\n' +
  '    Custom code in Python: a `def` with a docstring, called by name. `def band_report(T, band_column, value, top=5):` with the docstring `"""One row per {band_column} with the mean {value}, the {top} highest first."""`, then `top_edu = band_report(cleaned, band_column="prevEducation", value="composite")`. The function receives one pandas DataFrame per argument that names a table and the other arguments as its settings (literals: strings, numbers, True/False, None, lists), and returns one DataFrame with unique string column names, scalar cells and timezone-aware datetimes; a def with no table arguments loads data itself. Each DataFrame arrives with its pandas row labels as the index, kept as pandas keeps them through filter, sort, distinct and head, so `full.loc[cleaned.index]` picks the cleaned rows of `full`; aggregate, join, union and pivot number their rows from 0. The index you return is kept the same way, and a named index, such as the keys of a groupby you did not reset, comes back as columns. The docstring, rendered with the call\'s arguments, is the table\'s doc; every table needs one. Import packages inside the function. Use it for what no other operator expresses (custom parsers, binary formats, statistics, fitting, report layouts), not for filtering, deriving columns, grouping or joining. Make the columns, thresholds and limits it uses parameters, so the next request that changes one of them is a call with a new argument, not a new def; `Your operators` in the index lists the ones you have.';

/** The operator reference for the system prompt: signature + contract, one block per operator. */
export function nativeCatalogText(options: { analysisState?: boolean; registeredOperators?: boolean } = {}): string {
  return NATIVE_OPERATORS.map(d => {
    if (options.registeredOperators && d.name === "process") return OWN_OPERATOR_CATALOG_ENTRY;
    const doc =
      options.analysisState && d.name === "process"
        ? "A reusable Python analysis component. One pandas DataFrame per declared input, one returned DataFrame with unique string columns and scalar cells. Imports belong inside functions. Shared functions persist. Standard pandas transformations may be grouped into a coherent component, with inputs for data, membership and parameter tables. Keep revisable assumptions and useful intermediate outputs separate; return score components alongside totals."
        : d.doc;
    return `${d.inputs === 0 ? "T" : "T2"} = ${d.signature}\n    ${doc}`;
  }).join("\n\n");
}

/** Split a call's positional arguments into input tables (by arity) and the rest.
 * For "many"-input operators, every leading name that is not a program function
 * is a table. */
/** `at(name, task=N)` (or `at(name, N)`) as a reference, or undefined when the
 * value is not an `at` call. A malformed `at` call is an argument error, so the
 * statement is refused with the form spelled out instead of treated as a table. */
export function historyReferenceOf(value: ParsedValue | undefined): { operator: string; atTask: number } | undefined {
  if (!value || value.kind !== "call" || value.name !== HISTORY_REFERENCE) return undefined;
  const table = value.args[0];
  const task = value.kwargs.task ?? value.args[1];
  const extra = value.args.length > (value.kwargs.task ? 1 : 2) || Object.keys(value.kwargs).some(k => k !== "task");
  if (
    !table ||
    table.kind !== "name" ||
    !task ||
    task.kind !== "const" ||
    typeof task.value !== "number" ||
    !Number.isSafeInteger(task.value) ||
    task.value < 1 ||
    extra
  )
    throw new NativeArgumentError(
      `\`${value.source}\` is not a saved-table reference; write at(name, task=N) with a table name and a completed task number.`
    );
  return { operator: table.name, atTask: task.value };
}

export function splitInputs(
  def: NativeOperatorDef,
  args: ParsedValue[],
  functions: Record<string, ParsedFunction>,
  tableNames?: ReadonlySet<string>
): { inputs: string[]; rest: ParsedValue[]; references: TaskInput[] } {
  // A table is a name, or `at(name, task=N)` for that table as saved at a task.
  // Inputs carry the id that serves it; references keep what was written.
  const reference = (value: ParsedValue | undefined): TaskInput | undefined => {
    const saved = historyReferenceOf(value);
    if (saved) return saved;
    return value && value.kind === "name" && (tableNames?.has(value.name) || !(value.name in functions))
      ? value.name
      : undefined;
  };
  const idOf = (ref: TaskInput) => (typeof ref === "string" ? ref : taskInputId(ref));
  // An operator call where a table belongs gets the one-operator-per-statement rule spelled out.
  const nested = (value: ParsedValue | undefined) =>
    value?.kind === "call" && NATIVE_BY_NAME.has(value.name)
      ? ` Nested operator calls are not supported: assign ${show(value)} to its own name on a previous line and pass that name.`
      : "";
  if (def.inputs === 0) return { inputs: [], rest: args, references: [] };
  if (def.inputs === "many") {
    const references: TaskInput[] = [];
    let n = 0;
    for (; n < args.length; n++) {
      const ref = reference(args[n]);
      if (ref === undefined) break;
      references.push(ref);
    }
    const next = args[n];
    if (next?.kind === "call" && NATIVE_BY_NAME.has(next.name))
      throw new NativeArgumentError(`${def.name} takes input tables by name, got ${show(next)}.${nested(next)}`);
    return { inputs: references.map(idOf), rest: args.slice(n), references };
  }
  const count = def.inputs;
  const references: TaskInput[] = [];
  for (let i = 0; i < count; i++) {
    const value = args[i];
    const ref = reference(value);
    if (ref === undefined)
      throw new NativeArgumentError(
        `${def.name} takes ${count === 1 ? "the input table" : "the left and right tables"} as ${count === 1 ? "its first positional argument" : "its first two positional arguments"}${value ? `, got ${show(value)}` : ""}.` +
          nested(value)
      );
    references.push(ref);
  }
  return { inputs: references.map(idOf), rest: args.slice(count), references };
}
