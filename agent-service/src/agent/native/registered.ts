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
import { DTYPES, NATIVE_BY_NAME, NATIVE_OPERATORS, type NativeOpView, type ParsedValue } from "./catalog";
import { nativeRevision, runNativePython, validateNativeOperators } from "./codegen";
import { normalizeStatement } from "./program";

export interface RegisteredFunction {
  name: string;
  signature: string;
  doc: string;
  source: string;
  exported: boolean;
}
export interface RegisteredBinding {
  name: string;
  kind: "function" | "class" | "constant" | "import";
  source: string;
  cell: number;
  /** Declared names this binding uses (over-approximated). */
  references?: string[];
}
export interface RegisteredNamespace {
  cells: string[];
  functions: Record<string, RegisteredFunction>;
  bindings: Record<string, RegisteredBinding>;
  revision: string;
}
export interface RegisteredStageInput {
  python: string;
  changes: string;
  namespace?: RegisteredNamespace;
  operators: Record<string, NativeOpView>;
  profileCollection?: boolean;
  profileScope?: "full";
}
export interface RegisteredStageResult {
  namespace: RegisteredNamespace;
  operators: Record<string, NativeOpView>;
  changedIds: string[];
  deletedIds: string[];
  registrations: Array<{ name: string; kind: "registered" | "updated" }>;
  pythonChanged: boolean;
}
interface SetStatement {
  kind: "set";
  id: string;
  op: string;
  line: number;
  source: string;
  inputs: string[];
  kwargs: Record<string, ParsedValue>;
}
function declarationError(statement: { id: string; line: number }, error: unknown): Error {
  return new Error(
    `Changes line ${statement.line}, operator ${statement.id}: ${error instanceof Error ? error.message : error}`
  );
}
const retired = new Set(["process"]);
export const REGISTERED_OPERATOR_NAMES = NATIVE_OPERATORS.filter(d => !retired.has(d.name)).map(d => d.name);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/** The definitions an operator's function depends on: the sources of its entry
 * (or a filter's lambda) and of every binding it reaches by name, in name order. A new or changed
 * definition outside this set leaves the fingerprint, and so the operator's
 * cells, revision and stored result, unchanged. */
function dependencyRevision(
  registration: Record<string, unknown>,
  declared: Record<string, RegisteredBinding>
): string {
  const reached = new Set<string>();
  // A filter's lambda is its own source; it reaches the definitions it names.
  const inline = typeof registration.lambda === "string" ? registration.lambda : undefined;
  const pending = inline ? ((registration.names as string[] | undefined) ?? []).slice() : [String(registration.entry)];
  while (pending.length) {
    const name = pending.pop()!;
    if (reached.has(name) || !Object.hasOwn(declared, name)) continue;
    reached.add(name);
    pending.push(...(declared[name].references ?? []));
  }
  const sources = [...reached].sort().map(name => [name, declared[name].source]);
  return hash(inline === undefined ? sources : [inline, sources]);
}

function literal(value: ParsedValue): unknown {
  if (value.kind === "const") {
    if (typeof value.value === "number" && !Number.isFinite(value.value))
      throw new Error("Numeric settings must be finite and faithfully representable.");
    return value.value;
  }
  if (value.kind === "list" && !value.tuple) return value.items.map(literal);
  if (value.kind === "dict") {
    const entries = value.entries.map(([key, item]) => [key, literal(item)] as const);
    if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error("Duplicate dictionary key.");
    return Object.fromEntries(entries);
  }
  throw new Error("Custom settings must be Python literals; names, calls, and expressions are not evaluated.");
}

function builtinArgumentError(statement: SetStatement, message: string, outputNames: string[] = []): Error {
  const legacySuffix = ` Signature: ${NATIVE_BY_NAME.get(statement.op)!.signature}`;
  let cause = message.endsWith(legacySuffix) ? message.slice(0, -legacySuffix.length) : message;
  const mapping = statement.op === "cast" ? "columns" : "outputs";
  // Translate generated field names and the legacy reducer/window examples in
  // one pass: a real column name may itself resemble another generated key.
  cause = cause.replace(/\b_registered_output_(\d+)\b(?:=([a-z_]+\("col"(?:, 1)?\)))?/g, (match, index, example) => {
    const name = outputNames[Number(index)];
    if (name === undefined) return match;
    return example ? `${mapping}={${JSON.stringify(name)}: ${example}}` : `${mapping}[${JSON.stringify(name)}]`;
  });
  if (statement.op === "scan") cause = cause.replace('scan("data/dir/file.csv")', 'scan(files="data/dir/file.csv")');
  if (statement.op === "cast" && cause.includes("must be a dtype")) cause += " Use unquoted dtype descriptors.";
  return new Error(`${cause} Signature: ${signatures[statement.op]}`);
}

/** Spellings models produce for a documented descriptor, accepted as that
 * descriptor: a quoted dtype name (`'float64'`) and `preview=True` (one row).
 * Each cost a repair call in the 2026-10-08 pilots (Opus, Sol). */
function acceptDescriptorSpellings(op: string, kwargs: Record<string, ParsedValue>): void {
  const columns = kwargs.columns;
  if (op === "cast" && columns?.kind === "dict")
    kwargs.columns = {
      kind: "dict",
      entries: columns.entries.map(([name, value]) => [
        name,
        value.kind === "const" && typeof value.value === "string" && (DTYPES as readonly string[]).includes(value.value)
          ? { kind: "name", name: value.value }
          : value,
      ]),
    };
  if (op === "scan" && kwargs.preview?.kind === "const" && kwargs.preview.value === true)
    kwargs.preview = { kind: "const", value: 1 };
}

function normalizeBuiltin(statement: SetStatement, options: RegisteredStageInput): NativeOpView {
  const definition = NATIVE_BY_NAME.get(statement.op)!;
  const kwargs = { ...statement.kwargs };
  acceptDescriptorSpellings(statement.op, kwargs);
  const inputCount = statement.inputs.length;
  if (
    (typeof definition.inputs === "number" && inputCount !== definition.inputs) ||
    (definition.name === "union" && inputCount < 2)
  )
    throw builtinArgumentError(statement, `${definition.name}: invalid number of input tables (${inputCount}).`);
  let outputNames: string[] | undefined;
  if (["cast", "aggregate", "window"].includes(statement.op)) {
    const mappingName = statement.op === "cast" ? "columns" : "outputs";
    const allowed =
      statement.op === "cast"
        ? ["columns", "errors"]
        : statement.op === "aggregate"
          ? ["by", "outputs"]
          : ["partition_by", "order_by", "outputs"];
    const unexpected = Object.keys(kwargs).filter(key => !allowed.includes(key));
    if (unexpected.length)
      throw builtinArgumentError(
        statement,
        `${statement.op}: unsupported settings ${unexpected.join(", ")}; use ${mappingName}={...}.`
      );
    const mapping = kwargs[mappingName];
    if (!mapping || mapping.kind !== "dict" || !mapping.entries.length)
      throw builtinArgumentError(statement, `${statement.op} requires nonempty ${mappingName}={...}.`);
    outputNames = mapping.entries.map(([name]) => name);
    if (new Set(outputNames).size !== outputNames.length)
      throw builtinArgumentError(statement, `Duplicate ${mappingName} name.`);
    delete kwargs[mappingName];
    mapping.entries.forEach(([, value], index) => {
      kwargs[`_registered_output_${index}`] = value;
    });
  }
  if (statement.op === "distinct" && kwargs.columns?.kind === "const" && kwargs.columns.value === null)
    delete kwargs.columns;
  const normalized = normalizeStatement(
    { ...statement, args: statement.inputs.map(name => ({ kind: "name", name })), kwargs, endLine: statement.line },
    Object.create(null),
    options
  );
  if (normalized.error || !normalized.view)
    throw builtinArgumentError(statement, normalized.error?.message ?? "Invalid operator definition.", outputNames);
  const view = normalized.view;
  if (outputNames) {
    const items = (statement.op === "aggregate" ? view.properties.aggregations : view.properties.columns) as Array<
      Record<string, unknown>
    >;
    items.forEach((item, index) => {
      item[statement.op === "cast" ? "column" : "as"] = outputNames![index];
    });
  }
  view.graph = { inputPorts: statement.inputs.map((_, index) => `input-${index}`) };
  view.source = statement.source;
  view.revision = nativeRevision(view);
  return view;
}

function normalizeRegisteredFilter(
  statement: SetStatement,
  cells: string[],
  options: RegisteredStageInput
): NativeOpView {
  const invalid = (message: string): never => {
    throw new Error(`${message} Signature: ${signatures.filter}`);
  };
  if (statement.inputs.length !== 1) invalid("filter requires exactly one input table.");
  const kwargs = statement.kwargs;
  if (Object.keys(kwargs).some(key => !["predicate", "settings"].includes(key)))
    invalid("filter takes its input and a lambda, or predicate= and settings= for a registered predicate.");
  const condition = kwargs.predicate;
  let registration: Record<string, unknown>;
  if (condition?.kind === "lambda") {
    // An inline condition runs over the same definitions as a registered
    // predicate, so its reads, measurements and diagnostics are the same.
    if (condition.params.length !== 1) invalid("A filter's lambda takes one parameter, the row: lambda row: ...");
    if (kwargs.settings) invalid("settings belong to a registered predicate; write the values into the lambda.");
    registration = { cells, lambda: condition.source, names: condition.names ?? [], settings: {} };
  } else {
    // The function may be named bare, as in a custom call, or quoted.
    const predicate = condition?.kind === "name" ? condition.name : condition && literal(condition);
    if (typeof predicate !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(predicate))
      invalid("filter needs a condition: lambda row: ..., or predicate='name' for a registered public function.");
    const settings = kwargs.settings ? literal(kwargs.settings) : {};
    if (!settings || typeof settings !== "object" || Array.isArray(settings))
      invalid("filter settings must be a dictionary of keyword arguments.");
    registration = { cells, entry: predicate, settings };
  }
  return {
    type: "Filter",
    inputs: statement.inputs,
    source: statement.source,
    graph: { inputPorts: ["input-0"] },
    properties: { registered: { ...registration, namespaceRevision: hash(cells) } },
    ...(options.profileCollection
      ? { profileCollection: true, ...(options.profileScope ? { profileScope: options.profileScope } : {}) }
      : {}),
  };
}

/** A map is one lambda from a row to its new row: the returned dict is that
 * row of the output table. It runs over the definitions, like a filter's
 * lambda, so it can call registered functions and its reads are measured. */
function normalizeRegisteredMap(statement: SetStatement, cells: string[], options: RegisteredStageInput): NativeOpView {
  const invalid = (message: string): never => {
    throw new Error(`${message} Signature: ${signatures.map}`);
  };
  if (statement.inputs.length !== 1) invalid("map requires exactly one input table.");
  const fn = statement.kwargs.fn;
  if (Object.keys(statement.kwargs).some(key => key !== "fn") || fn?.kind !== "lambda")
    return invalid("map takes its input and one lambda that returns the new row as a dict.");
  if (fn.params.length !== 1) invalid("A map's lambda takes one parameter, the row: lambda row: {...}");
  return {
    type: "Map",
    inputs: statement.inputs,
    source: statement.source,
    graph: { inputPorts: ["input-0"] },
    properties: {
      registered: { cells, lambda: fn.source, names: fn.names ?? [], settings: {}, namespaceRevision: hash(cells) },
    },
    ...(options.profileCollection
      ? { profileCollection: true, ...(options.profileScope ? { profileScope: options.profileScope } : {}) }
      : {}),
  };
}

/** `def load(*):` and `def summarize(df, *):` are syntax errors that mean "no
 * settings": a function with no table inputs or no keyword settings keeps the
 * `*` the settings convention puts before them. A parameter list that ends in
 * a bare `*` is never valid Python, so dropping it changes no valid source.
 * Qwen 3.8 lost 45 calls to this on 2026-10-11. */
export function withoutTrailingBareStar(python: string): string {
  const header = /^[ \t]*(?:async[ \t]+)?def[ \t]+[A-Za-z_]\w*[ \t]*\(/gm;
  let result = "";
  let copied = 0;
  for (let match = header.exec(python); match; match = header.exec(python)) {
    const open = match.index + match[0].length;
    let depth = 1;
    let at = open;
    while (at < python.length && depth > 0) {
      const char = python[at];
      if (char === "#") {
        while (at < python.length && python[at] !== "\n") at++;
        continue;
      }
      if (char === "'" || char === '"') {
        const quote = python.startsWith(char.repeat(3), at) ? char.repeat(3) : char;
        at += quote.length;
        while (at < python.length && !python.startsWith(quote, at)) at += python[at] === "\\" ? 2 : 1;
        at += quote.length;
        continue;
      }
      if (char === "(" || char === "[" || char === "{") depth++;
      else if (char === ")" || char === "]" || char === "}") depth--;
      at++;
    }
    if (depth !== 0) break;
    const close = at - 1;
    const parameters = python.slice(open, close);
    const star = /(^|,)\s*\*(?:\s*,)?(?=\s*$)/.exec(parameters);
    if (!star) continue;
    result +=
      python.slice(copied, open) + parameters.slice(0, star.index) + parameters.slice(star.index + star[0].length);
    copied = close;
    header.lastIndex = close;
  }
  return copied ? result + python.slice(copied) : python;
}

/** Build and validate a complete candidate without mutating any session state. */
export async function stageRegisteredEdit(options: RegisteredStageInput): Promise<RegisteredStageResult> {
  const priorCells = options.namespace?.cells ?? [];
  if (!options.python.trim() && !options.changes.trim())
    throw new Error("An edit needs python definitions or graph changes.");
  // A cell identical to the last one replays to the same namespace, so it is
  // neither appended nor treated as a definition change: resending source
  // unchanged must not invalidate every custom result.
  const python = withoutTrailingBareStar(options.python);
  const pythonChanged = python.trim().length > 0 && priorCells.at(-1) !== python;
  const cells = [...priorCells, ...(pythonChanged ? [python] : [])];
  const parsed = (await runNativePython({ registered: true, phase: "parse", cells, changes: options.changes })) as {
    ok: boolean;
    error?: string;
    statements: Array<SetStatement | { kind: "delete"; id: string; line: number }>;
    declarations?: Record<string, RegisteredBinding>;
  };
  // A rejected edit registers nothing, so a later call that names one of its
  // functions fails again (archeology-hard-12 lost two calls this way). Name
  // them in the rejection. Diagnostic envelopes carry their own structure.
  const unregistered = (error: unknown): Error => {
    const message = error instanceof Error ? error.message : String(error);
    const names = pythonChanged
      ? Object.values(parsed.declarations ?? {})
          .filter(d => d.kind === "function" && d.cell === cells.length && !d.name.startsWith("_"))
          .map(d => d.name)
      : [];
    if (!names.length || message.startsWith("NATIVE_ERROR_V2:")) return error instanceof Error ? error : new Error(message);
    return new Error(
      `${message} Nothing from this edit was registered, including ${names.join(", ")}; resend the definitions with the corrected changes.`
    );
  };
  if (!parsed.ok) throw unregistered(parsed.error);
  const declared = parsed.declarations ?? {};
  // Graph IDs are Python identifiers, including names inherited by JS objects.
  const operators: Record<string, NativeOpView> = Object.assign(
    Object.create(null),
    structuredClone(options.operators)
  );
  const changedIds = new Set<string>();
  const deletedIds: string[] = [];
  for (const statement of parsed.statements) {
    try {
      if (statement.kind === "delete") {
        if (!operators[statement.id]) throw new Error(`Cannot delete missing operator ${statement.id}.`);
        delete operators[statement.id];
        deletedIds.push(statement.id);
        continue;
      }
      const kwargs = { ...statement.kwargs };
      let doc: string | undefined;
      if (kwargs.doc) {
        const value = literal(kwargs.doc);
        if (value !== null && typeof value !== "string") throw new Error("doc must be a string or None.");
        doc = value ?? undefined;
        delete kwargs.doc;
      }
      let view: NativeOpView;
      if (statement.op === "filter") {
        view = normalizeRegisteredFilter({ ...statement, kwargs }, cells, options);
      } else if (statement.op === "map") {
        view = normalizeRegisteredMap({ ...statement, kwargs }, cells, options);
      } else if (REGISTERED_OPERATOR_NAMES.includes(statement.op)) {
        view = normalizeBuiltin({ ...statement, kwargs }, options);
      } else {
        if (retired.has(statement.op))
          throw new Error(`${statement.op} is retired; call a registered table function directly.`);
        const binding = declared[statement.op];
        if (!binding || binding.kind !== "function" || statement.op.startsWith("_"))
          throw new Error(`Unknown operator type ${statement.op}. Register a public synchronous function first.`);
        view = {
          type: "Process",
          registeredName: statement.op,
          inputs: statement.inputs,
          source: statement.source,
          graph: { inputPorts: statement.inputs.map((_, index) => `input-${index}`) },
          properties: {
            registered: {
              cells,
              entry: statement.op,
              settings: Object.fromEntries(Object.entries(kwargs).map(([key, value]) => [key, literal(value)])),
              namespaceRevision: hash(cells),
            },
          },
          ...(options.profileCollection
            ? { profileCollection: true, ...(options.profileScope ? { profileScope: options.profileScope } : {}) }
            : {}),
        };
      }
      if (doc !== undefined) view.doc = doc;
      view.revision = nativeRevision(view);
      operators[statement.id] = view;
      changedIds.add(statement.id);
    } catch (error) {
      throw unregistered(declarationError(statement, error));
    }
  }
  const declarations = new Map(parsed.statements.map(statement => [statement.id, statement]));
  const visiting = new Set<string>(),
    visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error(`The final graph contains a cycle through ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const input of operators[id].inputs) {
      if (!operators[input]) {
        const message = `Input operator ${input} does not exist in the final graph; required by operator ${id}.`;
        const declaration = declarations.get(id) ?? declarations.get(input);
        throw declaration ? declarationError(declaration, message) : new Error(message);
      }
      visit(input);
    }
    visiting.delete(id);
    visited.add(id);
  }
  try {
    Object.keys(operators).forEach(visit);
  } catch (error) {
    throw unregistered(error);
  }
  for (const [id, view] of Object.entries(operators)) {
    if (!view.properties.registered) continue;
    const registration = view.properties.registered as Record<string, unknown>;
    const fingerprint = dependencyRevision(registration, declared);
    // An operator whose definitions are unchanged keeps its cells byte for
    // byte: its result stays current and the engine's cache still matches.
    // Otherwise a new definition re-ran every Python step, slow loaders too.
    if (!changedIds.has(id) && registration.namespaceRevision === fingerprint) continue;
    registration.cells = cells;
    registration.namespaceRevision = fingerprint;
    view.revision = nativeRevision(view);
    changedIds.add(id);
  }
  const checked = (await runNativePython({
    registered: true,
    phase: "validate",
    cells,
    operators: Object.entries(operators)
      .filter(([, view]) => view.properties.registered)
      .map(([id, view]) => ({
        id,
        kind: view.type.toLowerCase(),
        inputs: view.inputs,
        ...(view.properties.registered as object),
      })),
  })) as {
    ok: boolean;
    error?: string;
    functions: Record<string, RegisteredFunction>;
    bindings: Record<string, RegisteredBinding>;
  };
  if (!checked.ok) throw unregistered(checked.error);
  const diagnostics = await validateNativeOperators(Object.entries(operators).map(([id, view]) => ({ id, view })));
  const diagnostic = diagnostics.find(Boolean);
  if (diagnostic) throw new Error(`NATIVE_ERROR_V2:${JSON.stringify(diagnostic)}`);
  const namespace = { cells, functions: checked.functions, bindings: checked.bindings, revision: hash(cells) };
  const registrations: RegisteredStageResult["registrations"] = Object.values(checked.functions)
    .filter(fn => fn.exported && pythonChanged && declared[fn.name]?.cell === cells.length)
    .map(fn => ({
      name: fn.name,
      kind: options.namespace && Object.hasOwn(options.namespace.functions, fn.name) ? "updated" : "registered",
    }));
  return { namespace, operators, changedIds: [...changedIds], deletedIds, registrations, pythonChanged };
}

const signatures: Record<string, string> = {
  scan: 'scan(files=..., format="auto", skip_lines=0, header=True, names=None, all_text=False, delim=None, comment=None, widths=None, sheet=None, encoding=None, file_column=None, preview=None)',
  filter: "filter(t, lambda row: condition)",
  map: 'map(t, lambda row: {**row, "new": value})',
  project: "project(t, keep=None, drop=None, rename=None)",
  cast: 'cast(t, columns={"column": dtype}, errors="raise")',
  aggregate: 'aggregate(t, by=[], outputs={"output": reducer(...)})',
  join: 'join(left, right, on=None, how="inner", nulls_equal=False, suffix="_right", validate="many_to_many")',
  union: 'union(first, second, ..., schema="strict")',
  distinct: 'distinct(t, columns=None, keep="first")',
  sort: 'sort(t, by=[...], nulls="last")',
  limit: "limit(t, n=..., offset=0)",
  window: 'window(t, partition_by=[], order_by=[...], outputs={"output": window_spec(...)})',
  unpivot: 'unpivot(t, columns=[...], name="variable", value="value")',
  pivot: 'pivot(t, index=[...], columns="...", values="...")',
};
const briefOverrides: Record<string, string> = {
  scan: "Read local files/globs or lists: CSV/TSV, text, Excel, HTML tables, tabular JSON/JSONL, or Parquet. names requires header=False; all_text preserves codes; sheet selects a sheet/table. preview is an integer 1..200 for raw layout/metadata, not ordinary result samples.",
  filter:
    'Keep the rows for which the condition over a read-only row mapping returns True; False or null drops. A registered predicate with settings also works: filter(t, predicate="name", settings={...}). Preserves columns and order; measures kept/rejected/null counts and bounded rejected-value frequencies.',
  map: "Turn each row into a new row: the dict the lambda returns is that row of the output. {**row, ...} keeps the input columns; returning only some keys keeps only those. One row out per row in, in order.",
  cast: 'Convert named columns to str, int64, float64, bool, or datetime(format=..., tz=...). Failed conversions raise, or become null with errors="null"; naive timestamps require a timezone. Normalize text in a custom function before casting.',
  aggregate:
    "One row per group; by=[] gives one overall row. outputs maps names to reducers. count() counts rows, count(column) non-null values; reductions skip nulls except first, all-null sum is null, stddev is sample standard deviation.",
  window:
    "Add named outputs using lag, lead, row_number, rank, or dense_rank within ordered partitions; ranks start at 1 and output retains input row order.",
};
const fullExtras: Record<string, string> = {
  filter:
    ' Example: set adults: filter(people, lambda row: row["age"] is not None and row["age"] >= 21). The lambda can call registered functions. A condition reused with different values can be registered instead: def keep(row, *, minimum=18): return row["age"] is not None and row["age"] >= minimum, then set adults: filter(people, predicate="keep", settings={"minimum": 21}). Only bool or a scalar missing value is accepted; numbers, strings, arrays, and Series fail. Missing input values appear as None. Functions share authored definitions; one fresh namespace per operator invocation is shared across its rows. The predicate cannot mutate the row mapping. Rejected includes null verdicts. When profiles are collected, frequencies describe source values among all rejected rows for up to eight actually-read columns, with three first-encountered values each and an other count; they are not top frequencies or causal explanations. Updating a definition the condition uses invalidates this filter and its descendants.',
  map: ' Example: set priced: map(orders, lambda row: {**row, "unit_price": None if row["quantity"] in (None, 0) else row["amount"] / row["quantity"]}). Every row must return the same keys; values are scalars or None, and each column\'s type is inferred from them (ints and floats mix to float64; datetimes need a timezone). Missing input values appear as None. The lambda can call registered functions; logic across rows (grouping, differences between rows) belongs in aggregate, window, or a registered table function. The columns the lambda reads are measured, and the tool result lists added and dropped columns.',
  project:
    " Provide at least one of keep, drop, or rename; keep and drop are mutually exclusive. keep preserves the requested column order. Missing columns and name collisions fail.",
  cast: ' columns is a nonempty mapping from column names to unquoted dtype descriptors, including names such as doc or errors. datetime(format="%Y-%m-%d", tz="UTC") accepts an explicit format and timezone.',
  aggregate:
    " Reducers: count(), count(column), count_distinct(column), sum(column), mean(column), min(column), max(column), median(column), stddev(column), first(column). count_distinct excludes nulls; null group keys form a group. Output names must not duplicate group keys. Numeric reducers require numeric columns.",
  union:
    ' schema="strict" requires matching column names and types; schema="align" uses first-seen column order and fills absent cells with null. Incompatible types still require explicit conversion.',
  limit:
    " n must be an integer >= 1 and offset an integer >= 0. An offset past the end returns an empty table with the same schema.",
  window:
    " lag(column, offset=1), lead(column, offset=1), row_number(), rank(), dense_rank(). Null partition keys share a partition; null order values sort last. Add tie-break keys when required.",
};

/** Registered protocol reference from retained catalog contracts and fixed-map signatures. */
export function registeredCatalogText(
  names: readonly string[] = REGISTERED_OPERATOR_NAMES,
  detail: "index" | "full" = "index"
): string {
  return names
    .map(name => {
      if (!REGISTERED_OPERATOR_NAMES.includes(name)) throw new Error(`Unknown built-in operator ${name}.`);
      const definition = NATIVE_BY_NAME.get(name)!;
      // Legacy examples use a different constructor grammar. Their semantics are retained,
      // but new references only advertise the registered signature and safe contract text.
      const brief = briefOverrides[name] ?? definition.brief;
      let extra = detail === "full" ? (fullExtras[name] ?? "") : "";
      if (detail === "full" && name === "scan")
        extra =
          ' format: auto, csv, lines, fwf, whitespace, excel, html, json, parquet. TSV uses auto or csv with delim="\\t". Multiple sources are deduplicated, sorted by resolved path, and column-aligned. header=True takes column names from the first retained row; names supplies one name per column and requires header=False. skip_lines is a nonnegative count of initial physical lines/rows to skip. delim is one character or "whitespace"; omission sniffs comma, tab, semicolon, or pipe. widths is a list of positive field widths for fwf. encoding is a text codec name. sheet is an Excel sheet name or zero-based index, or an HTML table zero-based index; full reads default to the first sheet/table. file_column names a new provenance column containing each source basename. Optional None settings equal omission. preview=1..200 returns raw layout; Parquet and recognized binary/compressed files return metadata only. Full Parquet is supported; specialized binary/compressed sources need custom loaders. comment is a one-character reader setting, not documentation: delimited/whitespace and inferred-width readers ignore text from the marker onward; explicit-width fwf skips lines beginning with it after whitespace. Raw lines/previews preserve source text. Format-specific settings: csv/whitespace allow header,names,skip_lines,encoding,delim,comment; fwf substitutes widths for delim; lines allows skip_lines,encoding and yields line_no and line (header=False and names=["line"] restate that and are accepted); excel allows header,names,skip_lines,sheet; html additionally allows encoding; json allows encoding; parquet has no additional reader settings. preview also accepts skip_lines except for binary/Parquet metadata. Inapplicable settings fail. JSON accepts records, one object, or column arrays; nested dictionaries flatten to dotted names.';
      const signature =
        name === "scan" && detail === "index"
          ? 'scan(files=..., format="auto", header=True, names=None, sheet=None, all_text=False, preview=None)'
          : signatures[name];
      return `${signature}\n    ${brief}${extra}`;
    })
    .join("\n\n");
}
