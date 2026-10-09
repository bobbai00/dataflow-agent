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
const retired = new Set(["map", "process"]);
export const REGISTERED_OPERATOR_NAMES = NATIVE_OPERATORS.filter(d => !retired.has(d.name)).map(d => d.name);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

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
    invalid("filter accepts predicate, settings, and doc only; inline callbacks are not supported.");
  // The function may be named bare, as in a custom call, or quoted.
  const predicate =
    kwargs.predicate?.kind === "name" ? kwargs.predicate.name : kwargs.predicate && literal(kwargs.predicate);
  if (typeof predicate !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(predicate))
    invalid("filter predicate must name a registered public function, for example predicate='keep'.");
  const settings = kwargs.settings ? literal(kwargs.settings) : {};
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    invalid("filter settings must be a dictionary of keyword arguments.");
  return {
    type: "Filter",
    inputs: statement.inputs,
    source: statement.source,
    graph: { inputPorts: ["input-0"] },
    properties: { registered: { cells, entry: predicate, settings, namespaceRevision: hash(cells) } },
    ...(options.profileCollection
      ? { profileCollection: true, ...(options.profileScope ? { profileScope: options.profileScope } : {}) }
      : {}),
  };
}

/** Build and validate a complete candidate without mutating any session state. */
export async function stageRegisteredEdit(options: RegisteredStageInput): Promise<RegisteredStageResult> {
  const priorCells = options.namespace?.cells ?? [];
  if (!options.python.trim() && !options.changes.trim())
    throw new Error("An edit needs python definitions or graph changes.");
  // A cell identical to the last one replays to the same namespace, so it is
  // neither appended nor treated as a definition change: resending source
  // unchanged must not invalidate every custom result.
  const pythonChanged = options.python.trim().length > 0 && priorCells.at(-1) !== options.python;
  const cells = [...priorCells, ...(pythonChanged ? [options.python] : [])];
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
    registration.cells = cells;
    registration.namespaceRevision = hash(cells);
    view.revision = nativeRevision(view);
    if (pythonChanged) changedIds.add(id);
  }
  const checked = (await runNativePython({
    registered: true,
    phase: "validate",
    cells,
    operators: Object.entries(operators)
      .filter(([, view]) => view.properties.registered)
      .map(([id, view]) => ({ id, inputs: view.inputs, ...(view.properties.registered as object) })),
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
  filter: 'filter(t, predicate="name", settings={})',
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
    "Apply a registered predicate to each read-only row mapping, forwarding settings as keyword arguments. True keeps; False or null drops. Preserves columns and order; measures kept/rejected/null counts and bounded rejected-value frequencies.",
  cast: 'Convert named columns to str, int64, float64, bool, or datetime(format=..., tz=...). Failed conversions raise, or become null with errors="null"; naive timestamps require a timezone. Normalize text in a custom function before casting.',
  aggregate:
    "One row per group; by=[] gives one overall row. outputs maps names to reducers. count() counts rows, count(column) non-null values; reductions skip nulls except first, all-null sum is null, stddev is sample standard deviation.",
  window:
    "Add named outputs using lag, lead, row_number, rank, or dense_rank within ordered partitions; ranks start at 1 and output retains input row order.",
};
const fullExtras: Record<string, string> = {
  filter:
    ' Example: register def keep(row, *, minimum=18): return row["age"] is not None and row["age"] >= minimum; then set adults: filter(people, predicate="keep", settings={"minimum": 21}). Only bool or a scalar missing value is accepted; numbers, strings, arrays, and Series fail. Missing input values appear as None. Functions share authored definitions; one fresh namespace per operator invocation is shared across its rows. The predicate cannot mutate the row mapping. Rejected includes null verdicts. When profiles are collected, frequencies describe source values among all rejected rows for up to eight actually-read columns, with three first-encountered values each and an other count; they are not top frequencies or causal explanations. Updating Python definitions invalidates this filter and its descendants.',
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
          ' format: auto, csv, lines, fwf, whitespace, excel, html, json, parquet. TSV uses auto or csv with delim="\\t". Multiple sources are deduplicated, sorted by resolved path, and column-aligned. header=True takes column names from the first retained row; names supplies one name per column and requires header=False. skip_lines is a nonnegative count of initial physical lines/rows to skip. delim is one character or "whitespace"; omission sniffs comma, tab, semicolon, or pipe. widths is a list of positive field widths for fwf. encoding is a text codec name. sheet is an Excel sheet name or zero-based index, or an HTML table zero-based index; full reads default to the first sheet/table. file_column names a new provenance column containing each source basename. Optional None settings equal omission. preview=1..200 returns raw layout; Parquet and recognized binary/compressed files return metadata only. Full Parquet is supported; specialized binary/compressed sources need custom loaders. comment is a one-character reader setting, not documentation: delimited/whitespace and inferred-width readers ignore text from the marker onward; explicit-width fwf skips lines beginning with it after whitespace. Raw lines/previews preserve source text. Format-specific settings: csv/whitespace allow header,names,skip_lines,encoding,delim,comment; fwf substitutes widths for delim; lines allows skip_lines,encoding; excel allows header,names,skip_lines,sheet; html additionally allows encoding; json allows encoding; parquet has no additional reader settings. preview also accepts skip_lines except for binary/Parquet metadata. Inapplicable settings fail. JSON accepts records, one object, or column arrays; nested dictionaries flatten to dotted names.';
      const signature =
        name === "scan" && detail === "index"
          ? 'scan(files=..., format="auto", header=True, names=None, sheet=None, all_text=False, preview=None)'
          : signatures[name];
      return `${signature}\n    ${brief}${extra}`;
    })
    .join("\n\n");
}
