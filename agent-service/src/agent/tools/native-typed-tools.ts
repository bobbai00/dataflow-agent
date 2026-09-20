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
 * One tool per native operator type (`scan`, `filter`, `project`, `compute`,
 * `aggregate`, `join`, `union`, `distinct`, `sort`, `limit`, `udf`) plus a
 * consumer-aware `deleteOperator`. Generated from the catalog so the tool
 * schemas, the validator and the prompt can never disagree.
 *
 * Every tool is an UPSERT keyed by `id`: a new id adds the operator, an
 * existing id replaces its parameters and inputs (the modify), keeping the id
 * and every outgoing link. A chain is several tool calls in one turn; the
 * scheduler orders them by their input references and the post-step
 * execution runs the workflow once.
 *
 * Arguments are the operator's parameters at top level, plus `id` and the
 * input reference(s): `input` (one input), `left`/`right` (join), `inputs`
 * (union, udf). There is no summary argument — the type and the parameters
 * are the summary.
 */

import Ajv from "ajv";
import { jsonSchema, tool } from "ai";
import { WorkflowState } from "../workflow-state";
import { autoLayoutWorkflow } from "../util/auto-layout";
import { WorkflowUtilService } from "../util/workflow-utils";
import type { OperatorLink, OperatorPredicate } from "../../types/workflow";
import { createToolResult, createErrorResult } from "./tools-utility";
import type { ToolContext } from "./workflow-crud-tools";
import {
  NATIVE_BY_TYPE,
  NATIVE_ID_RE,
  NATIVE_OPERATORS,
  nativeOperators,
  type NativeCatalogVersion,
  type NativeOperatorDef,
  type NativeOpView,
} from "../native/catalog";
import { compileNativeOp } from "../native/codegen";
import { nativeRevision, validateNativeV2 } from "../native/codegen-v2";
import { taskInputId, taskInputSchema, taskInputSchemaWithFrames, TASK_SOURCE_PREFIX } from "../native/task-history";

/** Tool name for a native type: `Filter` → `filter`. */
export function nativeToolName(type: string): string {
  return type.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}

const allOperators = [...NATIVE_OPERATORS, ...nativeOperators("v2")];
export const NATIVE_TOOL_NAMES: ReadonlySet<string> = new Set(allOperators.map(d => nativeToolName(d.type)));
const TYPE_BY_TOOL: ReadonlyMap<string, NativeOperatorDef> = new Map(
  allOperators.map(d => [nativeToolName(d.type), d])
);

/** The native type behind a tool name, or undefined for non-native tools. */
export function nativeTypeForTool(toolName: string): string | undefined {
  return TYPE_BY_TOOL.get(toolName)?.type;
}

/** Input operator ids referenced by a native tool call, in port order. */
export function nativeInputsOf(toolName: string, input: unknown): string[] {
  const def = TYPE_BY_TOOL.get(toolName);
  if (!def || !input || typeof input !== "object") return [];
  const a = input as Record<string, unknown>;
  const id = (value: any): string[] =>
    typeof value === "string"
      ? [value]
      : value && typeof value.operator === "string" && Number.isSafeInteger(value.atTask) && value.atTask > 0
        ? [taskInputId(value)]
        : [];
  if (def.inputs === 1) return id(a.input);
  if (def.inputs === 2) return [a.left, a.right].flatMap(id);
  if (def.inputs === "many") return Array.isArray(a.inputs) ? a.inputs.flatMap(id) : [];
  return [];
}

/** The typed view (type, parameters, inputs) a native tool call describes. */
export function nativeViewOf(
  toolName: string,
  input: Record<string, unknown>,
  version: NativeCatalogVersion = "v1"
): NativeOpView | undefined {
  const def = nativeOperators(version).find(def => nativeToolName(def.type) === toolName);
  if (!def) return undefined;
  const { id: _id, input: _in, left: _l, right: _r, inputs: _ins, ...rest } = input;
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) if (v !== undefined && v !== null) properties[k] = v;
  const view: NativeOpView = { type: def.type, properties, inputs: nativeInputsOf(toolName, input) };
  if (version === "v2") {
    view.version = version;
    view.revision = nativeRevision(view);
  }
  return view;
}

/** Diagnostic-only identity for a rejected submission, including unknown ops.
 * The fallback has no claimed operator semantics and is never compiled or
 * inserted in the DAG. Known ops use exactly the normal revision calculation. */
export function rejectedNativeViewOf(toolName: unknown, input: Record<string, unknown>): NativeOpView {
  const known = typeof toolName === "string" ? nativeViewOf(toolName, input, "v2") : undefined;
  if (known) return known;
  const { id: _id, ...submitted } = input;
  const view: NativeOpView = { version: "v2", type: "Unknown", properties: { op: toolName, ...submitted }, inputs: [] };
  view.revision = nativeRevision(view);
  return view;
}

/** `inputs: a` / `inputs: left = a, right = b` — the phrase used in receipts and renders. */
export function describeInputs(type: string, inputs: string[]): string {
  if (inputs.length === 0) return "";
  if (type === "Join" && inputs.length === 2) return `inputs: left = ${inputs[0]}, right = ${inputs[1]}`;
  return `inputs: ${inputs.join(", ")}`;
}

/** Display name for the GUI and any summary-style render: `filter: <first parameter>`. */
export function nativeDisplayName(view: NativeOpView): string {
  const first = Object.values(view.properties)[0];
  const text = typeof first === "string" ? first : JSON.stringify(first ?? "");
  const s = `${nativeToolName(view.type)}: ${text}`;
  return s.length > 120 ? s.slice(0, 117) + "..." : s;
}

/* ----------------------------------------------------------------------------
 *  Schemas
 * ------------------------------------------------------------------------- */

const ID_SCHEMA = {
  type: "string",
  description:
    "Operator id: a short snake_case name for what the output table IS (e.g. `orders_2023`, `total_by_state`). " +
    "Downstream operators reference this table by id. Calling again with an existing id replaces that operator's parameters and inputs.",
};

function inputArgSchema(def: NativeOperatorDef): { properties: Record<string, unknown>; required: string[] } {
  if (def.inputs === 1)
    return {
      properties: { input: { type: "string", description: "Id of the operator whose output table this reads." } },
      required: ["input"],
    };
  if (def.inputs === 2) {
    return {
      properties: {
        left: { type: "string", description: "Id of the left input operator." },
        right: { type: "string", description: "Id of the right input operator (same id as left for a self-join)." },
      },
      required: ["left", "right"],
    };
  }
  if (def.inputs === "many") {
    const req = def.type === "Union";
    return {
      properties: {
        inputs: {
          type: "array",
          items: { type: "string" },
          ...(req ? { minItems: 2 } : {}),
          description: req
            ? "Ids of the operators to stack, two or more."
            : "Ids of the input operators, in the order of the process() parameters. Omit for a `def load()` loader.",
        },
      },
      required: req ? ["inputs"] : [],
    };
  }
  return { properties: {}, required: [] };
}

const TOOL_NOTES: Record<string, string> = {
  Scan: "csv/tsv/txt, xlsx, html, json, parquet; delim whitespace, comment, format lines|fwf for non-delimited text; a glob unions files by column name; `preview: n` shows the first n raw lines / sheet rows",
  Filter: "keeps rows where the SQL boolean predicate is true",
  Project: "keep / drop / rename columns; rows untouched",
  Compute: "columns: {name: SQL scalar expression}; adds or replaces columns; cannot add or drop rows",
  Aggregate:
    "aggregations: [{fn, col?, as?}], fn ∈ sum count avg min max median count_distinct string_agg first stddev; no groupBy = one row",
  Join: "on: shared key names [col, …], or [[leftCol, rightCol]] pairs when the names differ; type inner|left|right|full|cross; omit `on` for a cross join; left = right for a self-join",
  Union: "stacks two or more tables by column name",
  Unpivot: "wide → long: one row per (input row, column in `columns`); nameColumn/valueColumn name the two new columns",
  Distinct: "one row per distinct combination of columns (whole row when omitted)",
  Sort: "by: [{col, desc?}]",
  Limit: "first n rows after offset",
  UDF: "code: `def process(<input ids>)` returning pd.DataFrame, or `def load()`; only for what no other tool does",
};

/** `filter(id, input, predicate)   keeps rows where …` — one catalog line per tool. */
export function toolSignature(def: NativeOperatorDef): string {
  const ins = inputArgSchema(def);
  const base = def.schema as { properties?: Record<string, unknown>; required?: string[] };
  const req = new Set(base.required ?? []);
  const params = Object.keys(base.properties ?? {}).map(k => (req.has(k) ? k : `${k}?`));
  const inputNames = Object.keys(ins.properties).map(k => (ins.required.includes(k) ? k : `${k}?`));
  return `${nativeToolName(def.type)}(${["id", ...inputNames, ...params].join(", ")})   ${def.catalogVersion === "v2" ? def.signature : (TOOL_NOTES[def.type] ?? "")}`.trimEnd();
}

/** The prompt catalog: one signature line per tool. */
export function nativeToolCatalogText(): string {
  return NATIVE_OPERATORS.map(toolSignature).join("\n");
}

/** JSON schema of one tool: id + input refs + the operator's own parameters. */
export function nativeToolSchema(
  def: NativeOperatorDef,
  taskHistory = false,
  keptFrames = false
): Record<string, unknown> {
  const base = def.schema as { properties?: Record<string, unknown>; required?: string[]; anyOf?: unknown[] };
  const ins = inputArgSchema(def);
  if (taskHistory) {
    const reference = keptFrames ? taskInputSchemaWithFrames : taskInputSchema;
    for (const key of Object.keys(ins.properties)) {
      ins.properties[key] = key === "inputs" ? { ...(ins.properties[key] as object), items: reference } : reference;
    }
  }
  return {
    type: "object",
    additionalProperties: false,
    properties: { id: ID_SCHEMA, ...ins.properties, ...(base.properties ?? {}) },
    required: ["id", ...ins.required, ...(base.required ?? [])],
    ...(base.anyOf ? { anyOf: base.anyOf } : {}),
  };
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<string, ReturnType<Ajv["compile"]>>();
for (const def of allOperators) validators.set(`${def.catalogVersion ?? "v1"}:${def.type}`, ajv.compile(def.schema));

function validateProps(def: NativeOperatorDef, props: unknown): string | undefined {
  const v = validators.get(`${def.catalogVersion ?? "v1"}:${def.type}`)!;
  if (v(props)) return undefined;
  const errs = (v.errors ?? [])
    .map(e => `${e.instancePath || "parameters"} ${e.message ?? ""}`.trim())
    .slice(0, 4)
    .join("; ");
  return `invalid parameters for ${nativeToolName(def.type)}: ${errs}. Expected: ${toolSignature(def)}`;
}

/* ----------------------------------------------------------------------------
 *  Wiring
 * ------------------------------------------------------------------------- */

function distinctInputs(inputs: string[]): string[] {
  return [...new Set(inputs)];
}

function wireInputs(workflowState: WorkflowState, operatorId: string, inputs: string[]): void {
  const ins = distinctInputs(inputs);
  for (let i = 0; i < ins.length; i++) {
    const src = workflowState.getOperator(ins[i]);
    if (!src) continue;
    const link: OperatorLink = {
      linkID: `${ins[i]}-->${operatorId}`,
      source: { operatorID: ins[i], portID: src.outputPorts[0]?.portID || "output-0" },
      target: { operatorID: operatorId, portID: `input-${i}` },
    };
    workflowState.addLink(link);
  }
}

function consumersOf(workflowState: WorkflowState, operatorId: string): string[] {
  return [
    ...new Set(
      workflowState
        .getAllLinks()
        .filter(l => l.source.operatorID === operatorId)
        .map(l => l.target.operatorID)
    ),
  ];
}

/* ----------------------------------------------------------------------------
 *  Tools
 * ------------------------------------------------------------------------- */

const TOOL_DESCRIPTIONS: Record<string, string> = {
  Scan: "Read a file or glob of files into a table: csv/tsv/txt, xlsx/xls (`sheet`), html tables (`sheet` = table index), json/jsonl, parquet. Several files matching a glob are unioned by column name; `fileColumn` records the source file per row. Encoding is detected (utf-8 or cp1252) unless given. Use `preview: n` first on a file you have not seen: the first n RAW lines of each text file, or the first n rows of every xlsx sheet / html table (cells joined by ` | ` for display only; sheets and html tables have no delimiter to pass). Text that is not a delimited table: `delim: whitespace` for space-aligned columns, `comment: '#'` to skip comment lines, `format: fwf` with `widths` for fixed-width columns, `format: lines` for one row per line (then parse with compute: split_part, regexp_extract, TRY_CAST). With `header: false` the columns come back named `column0`, `column1`, …; pass `names` (one per column) to name them as the file is read, or rename them later with a `project`. A `names` list whose length does not match the file is refused with both counts. Scan does not SELECT columns: use a `project` with `keep`. Binary formats (gpkg, shp, npz, cdf) need a `udf` loader.",
  Filter: "Keep the rows where the SQL boolean `predicate` is true. Only drops rows.",
  Project: "Keep, drop or rename columns. Rows untouched.",
  Compute:
    "Add columns, or replace existing ones, from SQL scalar expressions over the input columns (arithmetic, TRY_CAST, string and date functions, CASE WHEN). Cannot add or drop rows.",
  Aggregate:
    "Group by keys and aggregate (sum count avg min max median count_distinct string_agg first stddev). No groupBy = one output row. `count` without col counts rows. Conditional counts: sum over a Compute'd CASE WHEN column. `sum`/`avg`/`median`/`stddev` coerce a text column to numbers first (thousands separators and surrounding space removed; values that will not parse become null and show in the null count), so numbers stored as text need no separate cast.",
  Join: 'Join two tables. `on` is either the key names both sides share (`on: ["sat_id", "date_key"]` joins on both) or [leftColumn, rightColumn] pairs when the names differ; a key pair whose two columns have different types is refused with both types named. Type inner|left|right|full. Same-named non-key columns from the right get suffix _right. Omit `on` (or type cross) to pair every row with every row, e.g. two one-row aggregates before a Compute. Self-join: pass the same id as left and right (e.g. year against year-1).',
  Union: "Stack two or more tables, matching columns by name.",
  Unpivot:
    "Wide to long: for each input row and each column in `columns`, one output row with the other columns kept as keys plus `nameColumn` (the column's name, default `variable`) and `valueColumn` (its value, default `value`). Use it instead of one compute/project per column followed by a union.",
  Distinct: "One row per distinct combination of `columns` (whole row when omitted).",
  Sort: "Order rows by columns.",
  Limit: "Keep the first n rows (after an optional offset).",
  UDF: "Python for what no other tool does: statistics and fitting, regex extraction, custom parsers, geospatial (geopandas), unusual file formats. `def process(<input ids>): ... return pd.DataFrame` with parameter names equal to `inputs` in order, or `def load(): ...` (no inputs) to read files with any library. ONE step per udf; never filter, join, group or sort inside it.",
};

export const TOOL_NAME_NATIVE_DELETE = "deleteOperator";

/** Shared by a standalone tool and the matching variant in a batch schema. */
export function nativeToolDescription(def: NativeOperatorDef): string {
  if (def.catalogVersion === "v2") return def.signature;
  return `${TOOL_DESCRIPTIONS[def.type]} Signature: ${toolSignature(def)}`;
}

/** Build the eleven typed operator tools + the consumer-aware delete. */
export function createNativeTypedTools(
  workflowState: WorkflowState,
  context?: ToolContext,
  version: NativeCatalogVersion = "v1"
): Record<string, any> {
  const workflowUtil = context?.metadataStore ? new WorkflowUtilService(context.metadataStore, workflowState) : null;
  const tools: Record<string, any> = {};

  for (const def of nativeOperators(version)) {
    const name = nativeToolName(def.type);
    const schema = nativeToolSchema(def);
    tools[name] = tool({
      description: nativeToolDescription(def),
      inputSchema: jsonSchema<Record<string, unknown>>(schema as any),
      execute: async (args: Record<string, unknown>) => {
        if (!workflowUtil) return createErrorResult("Metadata store not available for operator creation");
        const id = typeof args.id === "string" ? args.id : "";
        if (!NATIVE_ID_RE.test(id)) {
          return createErrorResult(
            `Invalid operator id "${id}": use letters, digits and underscores, starting with a letter.`
          );
        }
        const view = nativeViewOf(name, args, version)!;
        if (context?.taskHistory && id.startsWith(TASK_SOURCE_PREFIX))
          return createErrorResult("Historical inputs are runtime-owned; reference them with {operator, atTask}.");
        const taskInputs = context?.nativeInputReferences?.get(id);
        if (taskInputs?.some(input => typeof input !== "string")) view.taskInputs = taskInputs;
        if (version === "v2" && context?.settings?.nativeProfileCollection === true) view.profileCollection = true;
        if (version === "v2" && def.type === "UDF" && context?.settings?.nativeKeptFrames === true)
          view.keepFrames = true;
        const frameOf = context?.nativeFrameViews?.get(id);
        if (frameOf) view.frameOf = frameOf;
        const bad = validateProps(def, view.properties);
        if (bad) return createErrorResult(`\`${id}\`: ${bad}`);
        for (const up of view.inputs) {
          if (up === id) return createErrorResult(`\`${id}\`: an operator cannot read its own output`);
          if (!workflowState.getOperator(up)) {
            return createErrorResult(
              `\`${id}\`: input operator "${up}" does not exist (inputs are ids of existing operators, or of operators created earlier in this turn).`
            );
          }
          if ((workflowState.getOperator(up)?.nativeOp?.version ?? "v1") !== version) {
            return createErrorResult(`\`${id}\`: cannot mix native catalog versions; input '${up}' is not ${version}.`);
          }
        }
        let compiled;
        try {
          if (version === "v2") await validateNativeV2(view, id);
          compiled = compileNativeOp(view, id);
        } catch (e: any) {
          return createErrorResult(`\`${id}\`: ${e?.message ?? String(e)}`);
        }
        const existing = workflowState.getOperator(id);
        const phrase = `${nativeToolName(def.type)} operator \`${id}\`${view.inputs.length ? "; " + describeInputs(def.type, view.inputs) : ""}`;

        if (existing) {
          // MODIFY: same id, new parameters/inputs. Keep the id and outgoing links.
          if (!existing.nativeOp) return createErrorResult(`\`${id}\` is not a typed operator; delete it first.`);
          if ((existing.nativeOp.version ?? "v1") !== version)
            return createErrorResult(`\`${id}\`: catalog version changes require an explicit migration.`);
          if (compiled.operatorType !== existing.operatorType) {
            return createErrorResult(
              `\`${id}\` is a ${existing.nativeOp.type} (a ${existing.operatorType}); it cannot become a ${def.type}. Delete it and add a new one.`
            );
          }
          const position = workflowState.getOperatorPosition(id);
          for (const l of workflowState.getLinksConnectedToOperator(id)) {
            if (l.target.operatorID === id) workflowState.deleteLink(l.linkID);
          }
          const next: OperatorPredicate = {
            ...existing,
            operatorProperties: { ...existing.operatorProperties, code: compiled.code },
            customDisplayName: nativeDisplayName(view),
            nativeOp: view,
          };
          workflowState.addOperator(next, position);
          if (compiled.operatorType === "DataProcessing" && distinctInputs(view.inputs).length >= 1) {
            workflowState.updateOperatorInputPorts(id, distinctInputs(view.inputs).length);
          }
          wireInputs(workflowState, id, view.inputs);
          autoLayoutWorkflow(workflowState);
          return createToolResult(`modified ${phrase}`);
        }

        // ADD
        let operator: OperatorPredicate;
        try {
          operator = workflowUtil.getNewOperatorPredicate(compiled.operatorType, nativeDisplayName(view));
        } catch (e: any) {
          return createErrorResult(`\`${id}\`: ${e?.message ?? String(e)}`);
        }
        operator = {
          ...operator,
          operatorID: id,
          operatorProperties: { ...operator.operatorProperties, code: compiled.code },
          nativeOp: view,
        };
        workflowState.addOperator(operator);
        if (compiled.operatorType === "DataProcessing" && distinctInputs(view.inputs).length > 1) {
          workflowState.updateOperatorInputPorts(id, distinctInputs(view.inputs).length);
        }
        wireInputs(workflowState, id, view.inputs);
        autoLayoutWorkflow(workflowState);
        return createToolResult(`added ${phrase}`);
      },
    });
  }

  tools[TOOL_NAME_NATIVE_DELETE] = tool({
    description:
      "Delete an operator (and its links). Refused while other operators still read its output — re-point or delete those first.",
    inputSchema: jsonSchema<{ id: string }>({
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string", description: "Id of the operator to delete." } },
      required: ["id"],
    } as any),
    execute: async (args: { id: string }) => {
      const op = workflowState.getOperator(args.id);
      if (!op) return createErrorResult(`Operator \`${args.id}\` not found`);
      if (op.taskSource) return createErrorResult("Historical inputs are runtime-owned.");
      const consumers = consumersOf(workflowState, args.id);
      if (consumers.length > 0) {
        return createErrorResult(
          `\`${args.id}\` still feeds ${consumers.map(c => `\`${c}\``).join(", ")}; re-point or delete those first.`
        );
      }
      workflowState.deleteOperator(args.id);
      return createToolResult(`deleted operator \`${args.id}\``);
    },
  });

  return tools;
}
