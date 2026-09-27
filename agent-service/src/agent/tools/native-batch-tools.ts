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
 * The `dataflow` tool of native mode: one program, many operators.
 *
 *   dataflow({ edits: "large = filter(orders, lambda row: ...)\n...", observe: ["greece"] })
 *
 * Every assignment in the program is an upsert by name. Statements may appear
 * in any order and refer to each other or to existing operators; the shared
 * `ToolCallScheduler` applies them in dependency order, one post-step
 * execution follows, and only the tables named in `observe` show their
 * contents. A batch is not atomic: a rejected statement fails alone and its
 * dependents are blocked, while independent statements still land.
 */

import { jsonSchema, tool } from "ai";
import type { ReActStep } from "../../types/agent";
import { NATIVE_BY_NAME, NATIVE_OPERATOR_NAMES, type NativeOpView } from "../native/catalog";
import { compileProgram, type ProgramStatement } from "../native/program";
import type { WorkflowState } from "../workflow-state";
import type { ToolContext } from "./workflow-crud-tools";
import { TASK_SOURCE_PREFIX } from "../native/task-reference";
import { describeRestoreRequest, planRestores, type RestorePlan, type RestoreRequest } from "../native/task-restore";
import { createErrorResult } from "./tools-utility";
import { ToolCallScheduler } from "./tool-call-scheduler";
import { parseNativeDiagnostic, formatNativeDiagnostic, type NativeDiagnostic } from "../native/diagnostics";
import { NativeValidationRepair } from "../native/validation-repair";
import { applyNativeOperator, deleteNativeOperator } from "./native-upsert";
import {
  compileAnalysisProgram,
  inspectAnalysis,
  planAnalysisForks,
  type AnalysisFork,
} from "../native/analysis-state";
import { renderTaskEntry } from "../native/task-entries";
import type { BindRequest } from "../native/definition-registry";
import type { Expectation } from "../native/flags";
import { isRegisteredCall } from "../native/registered-operators";
import { liftDefinition, nearDuplicates, nearDuplicateNote, pythonLiteral, type LiftRequest } from "../native/lift";
import { signatureOfSource } from "../native/catalog";
import { parseDefinitions, workflowFunctions } from "../native/analysis-state";
import { parseAnswerFrom, type AnswerShape } from "../native/answer";

export const TOOL_NAME_DATAFLOW = "dataflow";

export interface NativeBatchOutcome {
  id: string;
  /** Surface operator name (`filter`), or whatever was written when unknown. */
  op: string;
  status: "added" | "modified" | "deleted" | "error" | "blocked";
  message: string;
  diagnostic?: NativeDiagnostic;
  /** For error/blocked outcomes: the definition as written, for diagnostics. */
  attempted?: NativeOpView;
}

/** Stored as the tool result on the owning ReAct event. Observation choices
 * are event facts, never mutable preferences on an operator. */
export interface NativeBatchResult {
  kind: "native-batch";
  operators: NativeBatchOutcome[];
  observe: string[];
  observationErrors: string[];
  /** Restores whose target landed: what they created and what they reused. */
  restored?: Array<RestoreRequest & { created: string[]; shared: string[] }>;
  /** Exact read-only definitions / completed entries requested by this call. */
  inspection?: string[];
  /** Registry facts of this call: what a bind resolved to, what was superseded, what a lift made, near-duplicate defs. */
  notes?: string[];
  /** `lift`: the operators it made, with the call that reproduces the original. */
  lifts?: Array<{ name: string; source: string; call: string }>;
  /** `answer_from`: the table the runtime composes the final answer from, once it exists. */
  answerFrom?: string;
  /** `answer_from`'s projection: the answer's keys, their columns and rounding. */
  answerShape?: AnswerShape[];
  /** `observe: ["t[a,b]"]`: the columns each projected table shows in this event. */
  observeColumns?: Record<string, string[]>;
  /** `expect`: the declared contracts, checked after execution. */
  expect?: Record<string, Expectation>;
}

export function asNativeBatchResult(output: unknown): NativeBatchResult | undefined {
  if (!output || typeof output !== "object") return undefined;
  const r = output as NativeBatchResult;
  return r.kind === "native-batch" && Array.isArray(r.operators) && Array.isArray(r.observe) ? r : undefined;
}

export function nativeBatchResults(step: Pick<ReActStep, "toolCalls" | "toolResults">): NativeBatchResult[] {
  return (step.toolCalls ?? []).flatMap(tc => {
    if (tc.toolName !== TOOL_NAME_DATAFLOW) return [];
    const result = asNativeBatchResult(step.toolResults?.find(tr => tr.toolCallId === tc.toolCallId)?.output);
    return result ? [result] : [];
  });
}

export function batchObservedIds(step: Pick<ReActStep, "toolCalls" | "toolResults">): Set<string> | undefined {
  const calls = (step.toolCalls ?? []).filter(call => call.toolName === TOOL_NAME_DATAFLOW);
  if (!calls.length) return undefined;
  return new Set(
    calls.flatMap(call => {
      const result = asNativeBatchResult(step.toolResults?.find(r => r.toolCallId === call.toolCallId)?.output);
      if (result) return result.observe;
      // A rejected request or SDK exception must not fall back to showing all
      // successful tables. Explicit scope survives every failure path.
      const requested = call.input?.observe;
      return Array.isArray(requested) ? requested.filter((id): id is string => typeof id === "string") : [];
    })
  );
}

export interface DataflowInput {
  /** With `dataflowReasoning` on: why this call and what the observed tables should show. */
  reasoning?: string;
  /** Statements that create or modify operators, plus the `def`s they use. */
  edits: string;
  /** Ids of operators to remove, applied before the edits. */
  delete?: string[];
  /** Saved versions to rebuild, applied with the edits. */
  restore?: RestoreRequest[];
  fork?: AnalysisFork[];
  inspect?: string[];
  recall?: number[];
  /** Registered operators: turn an existing def's literals into parameters. */
  lift?: LiftRequest[];
  /** Definition registry: evaluate a target under chosen versions of definitions. */
  bind?: BindRequest[];
  /** Definition registry: `{new_table: old_table}` declares the successor version. */
  supersede?: Record<string, string>;
  /** Definition registry: lineage of a table with the version of each definition it read. */
  explain?: string[];
  observe?: string[];
  /** The table whose complete contents are the answer; the runtime ends the turn with it. */
  answer_from?: string;
  /** What tables must satisfy after this call; failures become ⚠ lines on those tables. */
  expect?: Record<string, Expectation>;
}

export interface DataflowToolOptions {
  reasoning?: boolean;
  analysisState?: boolean;
  restore?: boolean;
  definitionRegistry?: boolean;
  /** The `answer_from` field. */
  answerFrom?: boolean;
  /** The `expect` field (contract flags are on). */
  contractFlags?: boolean;
  /** Column projections in `observe` are documented. */
  leanContext?: boolean;
  /** A `def` may be called by name as an operator. */
  registeredOperators?: boolean;
}

const ANSWER_FROM_PROPERTY = {
  type: "string",
  description:
    'Step 5, after the tables are shown: the id of a table whose complete contents are the answer to the current request, with a projection that states the precision of its numbers: `table[:4]` rounds every number to 4 decimals; `table[key=column:digits, other_column]` names the answer\'s keys, picks the columns and rounds per column (e.g. "python_mean[imputation_mean=mean_python:4, imputed_rows]"); `:full` keeps a number as computed. The runtime then ends the task with `Final Answer: <single-line JSON>` composed from that table (one row → an object of its keys; several rows → a list of row objects under the table\'s name, in the table\'s order; one column → a list of its values) and makes no further call. It rounds as Python\'s round() does. If the table is empty, not completely held, too large, lacks a named column, has numbers with decimals and no stated precision, or holds only nulls, the observation says why and you answer in text or set answer_from again.',
};

const LIFT_PROPERTY = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      from: { type: "string", description: "The def to lift, by name." },
      as: { type: "string", description: "The operator's name. Omitted, the def is revised in place and its tables recompute unchanged." },
      params: {
        type: "object",
        additionalProperties: { type: ["string", "number", "boolean", "null"] },
        description: "New parameter name → the literal in the body it replaces; the literal becomes the default.",
      },
      doc: { type: "string", description: "The docstring, when the def has none: one sentence over the parameters." },
    },
    required: ["from", "params"],
  },
  description:
    'Step 2 as well, before the edits: turn a def you already wrote into an operator with parameters, e.g. [{"from": "age_group_report", "as": "band_report", "params": {"band_column": "age_band", "value": "composite"}}]: each literal becomes a parameter with that literal as its default, the docstring says {band_column} where it said the literal, and the result is listed under `Your operators` and callable in this call\'s edits (`t = band_report(cleaned, band_column="prevEducation")`).',
};

const EXPECT_PROPERTY = {
  type: "object",
  additionalProperties: {
    type: "object",
    additionalProperties: false,
    properties: {
      rows: {
        anyOf: [
          { type: "integer" },
          { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 },
        ],
        description: "Exact row count, or [min, max].",
      },
      nonempty: { type: "boolean" },
      unique: { type: "array", items: { type: "string" }, description: "Columns whose values must be unique and non-null." },
      nonnull: { type: "array", items: { type: "string" }, description: "Columns that must hold no null." },
      columns: { type: "array", items: { type: "string" }, description: "Columns the table must have." },
    },
  },
  description:
    'What tables must satisfy after this call, e.g. {"cohort": {"rows": [700, 800], "unique": ["id"], "nonnull": ["score"], "columns": ["region"]}}. Each named table gets a ✓ line when every expectation is met and a ⚠ line naming what failed.',
};

/** Written first when enabled, so the edits follow the stated intent. */
const REASONING_PROPERTY = {
  type: "string",
  description:
    "Written first: one or two sentences on why this call and what you expect the observed tables to show (row count, columns, a value you can check). It is replayed with the call, so compare the next observation against it.",
};

export function nativeBatchSchema(options: DataflowToolOptions = {}): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      ...(options.reasoning ? { reasoning: REASONING_PROPERTY } : {}),
      edits: {
        type: "string",
        description:
          "Step 2, applied after the deletes: statements that create or modify operators, one `id = operator(input_id, ..., parameter=value)` per line, plus any `def` functions they use. Reusing an id modifies that operator and keeps its consumers. Statements may reference each other in any order. Empty when you only delete or re-read cached results.",
      },
      delete: {
        type: "array",
        items: { type: "string" },
        description:
          "Step 1, applied before the edits: ids of operators to remove. Refused for an operator that another surviving operator still reads (deleting or re-pointing that consumer in the same call counts).",
      },
      ...(options.restore !== false
        ? {
            restore: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  operator: { type: "string", description: "The table to rebuild, by the id it had." },
                  task: { type: "integer", description: "The completed task at whose end that version was saved." },
                  as: {
                    type: "string",
                    description:
                      "The id the rebuilt table gets. The same id as `operator` makes that version current again (its consumers recompute).",
                  },
                },
                required: ["operator", "task", "as"],
              },
              description:
                "Step 2 as well, with the edits: rebuild tables as they were defined at the end of a completed task. Each restore recreates that definition under `as`, shares upstream tables whose definition is unchanged since that task, copies the changed ones as `<name>_t<task>`, and its observation says whether the result matches the saved table. Requires task history.",
            },
          }
        : {}),
      observe: {
        type: "array",
        items: { type: "string" },
        description:
          "Step 4, after execution: ids of every operator whose table contents you want to see, including existing or re-executed ones. Omitted or [] returns compact receipts only, with no successful table bodies. Errors always appear." +
          (options.leanContext
            ? " `table[col1,col2]` shows only those columns of the table (all its rows when that projection is small): use it on a wide table instead of a project built only for reading."
            : ""),
      },
      ...(options.analysisState
        ? {
            fork: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  operator: { type: "string", description: "Existing output whose computation to reuse." },
                  as: { type: "string", description: "New output name; existing defaults are never overwritten." },
                  bindings: {
                    type: "object",
                    additionalProperties: { type: "string" },
                    description:
                      "Replace named upstream tables with current tables (including tables defined in edits). Only paths affected by these replacements are copied. Example: {policy: trial_policy}. Unknown or unused names are errors.",
                  },
                  task: {
                    type: "integer",
                    description:
                      "Optional completed task: reuse that definition with replaced inputs; other boundaries read immutable saved values.",
                  },
                },
                required: ["operator", "as", "bindings"],
              },
              description:
                "Reuse an existing analysis without copying its code. Create parameter tables in edits, then fork with explicit replacements and observe the new output in this same call. Current forks share unchanged live boundaries; historical forks pin unchanged boundary values. Copied functions are isolated from later shared-function edits.",
            },
            inspect: {
              type: "array",
              items: { type: "string" },
              maxItems: 6,
              description:
                "Read exact current table definitions or shared functions by name, including input bindings and branch provenance, without execution.",
            },
            recall: {
              type: "array",
              items: { type: "integer" },
              maxItems: 3,
              description:
                "Read archived requests, answers and change summaries for these completed task numbers, without execution. Code summaries may be shortened; inspect retrieves exact current definitions.",
            },
          }
        : {}),
      ...(options.definitionRegistry
        ? {
            bind: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  target: { type: "string", description: "An existing table whose computation to evaluate again." },
                  as: { type: "string", description: "New table name for the result; the target itself is untouched." },
                  versions: {
                    type: "object",
                    additionalProperties: { type: "string" },
                    description:
                      'definition → version, e.g. {"age_grouped_data": "v1", "size_composites": "narrow_size_composites"}. A version is v<k>, t<N> (the version active at task N), active, or a table id. Definitions are named in # Definitions by their first table.',
                  },
                },
                required: ["target", "as", "versions"],
              },
              description:
                "Step 2 as well: evaluate `target` under other versions of the definitions it reads, as a new table `as`. The runtime rebuilds only the affected paths (an earlier in-place version is rebuilt from its saved definition as <name>__v<k>) and reports the versions it bound. Use it for rollback, counterfactual and composed-version requests instead of rewriting the computation; observe `as` in the same call.",
            },
            supersede: {
              type: "object",
              additionalProperties: { type: "string" },
              description:
                'Step 5: {"new_table": "old_table"} declares that the new table (defined in this call or earlier) is the next version of old_table\'s definition and the active one from now on; old_table stays readable as an earlier version. Use it when an update is built as a new table rather than by reassigning the id.',
            },
            explain: {
              type: "array",
              items: { type: "string" },
              maxItems: 4,
              description:
                "Read-only: the lineage of each named table with the version of every definition it read, flagging ancestors that read a superseded version.",
            },
          }
        : {}),
      ...(options.registeredOperators ? { lift: LIFT_PROPERTY } : {}),
      ...(options.answerFrom ? { answer_from: ANSWER_FROM_PROPERTY } : {}),
      ...(options.contractFlags ? { expect: EXPECT_PROPERTY } : {}),
    },
    required: [...(options.reasoning ? ["reasoning"] : []), ...(options.analysisState ? [] : ["edits"])],
  };
}

export const DATAFLOW_TOOL_DESCRIPTION =
  "Build, modify, delete and observe the dataflow in one call. The call runs four steps in this order: (1) the operators listed in `delete` are removed (refused while a surviving operator still reads one); (2) the `edits` statements are applied, one `id = operator(input_id, ..., parameter=value)` per line plus the `def` functions they use (operators: " +
  NATIVE_OPERATOR_NAMES.join(", ") +
  "), where a new id creates an operator and an existing id modifies it and keeps its consumers; (3) new and modified operators execute, with everything downstream of them; (4) the tables of the ids in `observe` are shown (omitted/[] hides successful tables but never errors). Batch a whole dependent chain in one call; the scheduler orders it. A statement that fails alone blocks only its dependents; the rest lands. Empty `edits` with `observe` re-reads cached results without executing. With task history, `restore` rebuilds a table as it was defined at the end of an earlier task (see the field).";

/** The tool description for the agent's settings: with `reasoning`, one sentence says it comes first. */
export function dataflowToolDescription(options: DataflowToolOptions = {}): string {
  const description =
    options.restore === false
      ? DATAFLOW_TOOL_DESCRIPTION.replace(/ With task history, `restore`[\s\S]*$/, "")
      : DATAFLOW_TOOL_DESCRIPTION;
  const base = options.reasoning
    ? "Start with `reasoning`: why this call and what the observed tables should show. " + description
    : description;
  return (
    base +
    (options.analysisState
      ? " In analysis mode, omitted edits means no edits. Shared functions persist with their table consumers. Reuse a def by name in later calls. Redefining a shared function automatically revises all current consumers and recomputes descendants; no need to resend their code. Use parameters(...) tables for changing assumptions. fork reuses a computation with explicit replaced inputs; inspect reads exact table or shared-function definitions by name, and recall retrieves task history, without execution."
      : "") +
    (options.definitionRegistry
      ? " The task starts from `# Definitions`, the graph read as versioned definitions. `bind` evaluates an existing table under chosen versions of the definitions it reads (rollback, counterfactual, composition) as a new table; `supersede` declares a new table the active version of an old one; `explain` prints a table's lineage with the version of each definition it read; the `compare` operator diffs two versions row by row."
      : "") +
    (options.registeredOperators
      ? " A `def` with a docstring is an operator you call by name like any other (`top_edu = band_report(cleaned, band_column=\"prevEducation\")`): the arguments that name tables are its inputs, the literals its settings, and its docstring, written over the parameters, reads with the call's arguments as the table's doc. It persists with the tables that call it and is listed under `Your operators`; `lift` makes one from a def you already wrote by turning chosen literals into parameters."
      : "") +
    (options.contractFlags
      ? " Lines marked ⚠ under an operator are contract flags: facts the runtime established from the operator's contract and the table's whole-table profile, inherited by every table built on it; `expect` declares your own contracts on tables and reports whether they hold."
      : "") +
    (options.answerFrom
      ? " `answer_from` names a table whose complete contents are the answer, with the precision of its numbers (`table[:4]`): the runtime composes `Final Answer: <single-line JSON>` from it and the task ends without another call."
      : "")
  );
}

/**
 * The one tool of native mode: `dataflow` (edits, deletes, observations). The
 * existing upsert (`native-upsert.ts`) owns compilation and wiring; the normal
 * post-step path owns execution.
 */
export function createNativeTools(state: WorkflowState, context?: ToolContext): Record<string, any> {
  const repair = context?.nativeValidationRepair ?? new NativeValidationRepair();
  const reasoning = context?.settings?.dataflowReasoning === true;
  const analysisState = context?.settings?.nativeAnalysisState === true;
  const restore = analysisState ? context?.settings?.nativeTaskRestore !== false : undefined;
  const registry =
    context?.settings?.nativeDefinitionRegistry === true && context.definitionRegistry
      ? context.definitionRegistry
      : undefined;
  const definitionRegistry = !!registry;
  const answerFrom = context?.settings?.nativeAnswerFrom === true;
  const contractFlags = context?.settings?.nativeContractFlags === true;
  const leanContext = context?.settings?.nativeLeanContext === true;
  const registeredOperators = analysisState && context?.settings?.nativeRegisteredOperators === true;
  const toolOptions: DataflowToolOptions = {
    reasoning,
    analysisState,
    restore,
    definitionRegistry,
    answerFrom,
    contractFlags,
    leanContext,
    registeredOperators,
  };
  let inspectionTask: string | undefined;
  const shownInspections = new Set<string>();
  return {
    [TOOL_NAME_DATAFLOW]: tool({
      description: dataflowToolDescription(toolOptions),
      inputSchema: jsonSchema<DataflowInput>(nativeBatchSchema(toolOptions) as any),
      execute: async args => {
        if (analysisState && args && args.edits === undefined) args = { ...args, edits: "" };
        const repairEpoch = repair.epoch;
        if (
          state
            .getAllOperators()
            .some(
              op => (op.nativeOp?.profileCollection === true) !== (context?.settings?.nativeProfileCollection === true)
            )
        ) {
          return createErrorResult(
            "Profile collection differs from this workflow's compiled operators; use a fresh agent and workflow."
          );
        }
        const isIds = (value: unknown) =>
          value === undefined || (Array.isArray(value) && value.every(id => typeof id === "string"));
        const isRestore = (value: unknown) =>
          value === undefined ||
          (Array.isArray(value) &&
            value.every(
              item =>
                item &&
                typeof item === "object" &&
                typeof (item as RestoreRequest).operator === "string" &&
                typeof (item as RestoreRequest).task === "number" &&
                typeof (item as RestoreRequest).as === "string"
            ));
        if (
          typeof args?.edits !== "string" ||
          !isIds(args.observe) ||
          !isIds(args.delete) ||
          !isIds(args.inspect) ||
          (args.recall !== undefined &&
            (!Array.isArray(args.recall) || args.recall.some(n => !Number.isSafeInteger(n) || n < 1))) ||
          (args.fork !== undefined &&
            (!Array.isArray(args.fork) ||
              args.fork.some(
                f =>
                  !f ||
                  typeof f.operator !== "string" ||
                  typeof f.as !== "string" ||
                  !f.bindings ||
                  typeof f.bindings !== "object" ||
                  Array.isArray(f.bindings) ||
                  Object.values(f.bindings).some(v => typeof v !== "string")
              ))) ||
          !isRestore(args.restore) ||
          (args.reasoning !== undefined && typeof args.reasoning !== "string")
        ) {
          return createErrorResult(
            "dataflow requires edits: string, and optionally delete: string[], restore: [{operator, task, as}], observe: string[] and reasoning: string"
          );
        }
        if (!analysisState && (args.fork?.length || args.inspect?.length || args.recall?.length))
          return createErrorResult("fork, inspect and recall require nativeAnalysisState.");
        if ((args.inspect?.length ?? 0) > 6 || (args.recall?.length ?? 0) > 3)
          return createErrorResult("Inspect at most six definitions or recall three tasks per call.");
        const isBind = (value: unknown) =>
          value === undefined ||
          (Array.isArray(value) &&
            value.every(
              item =>
                item &&
                typeof item === "object" &&
                typeof (item as BindRequest).target === "string" &&
                typeof (item as BindRequest).as === "string" &&
                (item as BindRequest).versions &&
                typeof (item as BindRequest).versions === "object" &&
                !Array.isArray((item as BindRequest).versions) &&
                Object.values((item as BindRequest).versions).every(v => typeof v === "string")
            ));
        const isSupersede = (value: unknown) =>
          value === undefined ||
          (!!value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            Object.values(value as object).every(v => typeof v === "string"));
        if (!isBind(args.bind) || !isSupersede(args.supersede) || !isIds(args.explain))
          return createErrorResult(
            'bind takes [{target, as, versions: {definition: version}}], supersede takes {"new_table": "old_table"}, and explain takes table names.'
          );
        if (!registry && (args.bind?.length || args.explain?.length || (args.supersede && Object.keys(args.supersede).length)))
          return createErrorResult("bind, supersede and explain require nativeDefinitionRegistry.");
        if ((args.explain?.length ?? 0) > 4) return createErrorResult("Explain at most four tables per call.");
        if (args.answer_from !== undefined && typeof args.answer_from !== "string")
          return createErrorResult("answer_from takes the id of one table, optionally with a projection [key=column:digits, ...].");
        if (args.answer_from && !answerFrom) return createErrorResult("answer_from requires nativeAnswerFrom.");
        const isLift = (value: unknown) =>
          value === undefined ||
          (Array.isArray(value) &&
            value.every(item => {
              const lift = item as LiftRequest;
              return (
                !!lift &&
                typeof lift === "object" &&
                typeof lift.from === "string" &&
                (lift.as === undefined || typeof lift.as === "string") &&
                (lift.doc === undefined || typeof lift.doc === "string") &&
                !!lift.params &&
                typeof lift.params === "object" &&
                !Array.isArray(lift.params) &&
                Object.values(lift.params).every(v => v === null || ["string", "number", "boolean"].includes(typeof v))
              );
            }));
        if (!isLift(args.lift))
          return createErrorResult('lift takes [{"from": "def_name", "as": "operator_name", "params": {"parameter": literal}, "doc": "..."}].');
        if (args.lift?.length && !registeredOperators) return createErrorResult("lift requires nativeRegisteredOperators.");
        const answerRequest = args.answer_from ? parseAnswerFrom(args.answer_from) : undefined;
        if (answerRequest && "error" in answerRequest) return createErrorResult(answerRequest.error);
        const answerTable = answerRequest && "id" in answerRequest ? answerRequest.id : undefined;
        const isExpect = (value: unknown) =>
          value === undefined ||
          (!!value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            Object.values(value as object).every(item => item && typeof item === "object" && !Array.isArray(item)));
        if (!isExpect(args.expect))
          return createErrorResult(
            'expect takes {"table": {"rows": n | [min, max], "nonempty": true, "unique": [...], "nonnull": [...], "columns": [...]}}.'
          );
        if (args.expect && Object.keys(args.expect).length && !contractFlags)
          return createErrorResult("expect requires nativeContractFlags.");
        // A bind is realized by the existing planners: an earlier in-place
        // version becomes a restore of that definition, the target becomes a
        // fork bound to the chosen version tables.
        const bound = registry
          ? registry.plan(args.bind ?? [], state, context?.taskHistory)
          : { restores: [], forks: [], errors: [], notes: [] };
        const notes: string[] = [...bound.notes];
        // Restores are planned before compiling: each becomes the sealed
        // statements under new ids, compiled and executed exactly like edits.
        // A refused restore is an outcome; the rest of the call proceeds.
        const restoreOutcomes: NativeBatchOutcome[] = [];
        let restorePlans: RestorePlan[] = [];
        // The model's own restores follow the `restore` toggle; the restores a
        // bind plans are internal to the registry and need only task history.
        const modelRestores = args.restore ?? [];
        if (modelRestores.length && (!context?.taskHistory || context.settings?.nativeTaskRestore === false)) {
          for (const request of modelRestores)
            restoreOutcomes.push({
              id: request.as,
              op: "restore",
              status: "error",
              message: `Cannot ${describeRestoreRequest(request)}: this session keeps no task history to restore from.`,
            });
        }
        const restoreRequests = [
          ...(context?.taskHistory && context.settings?.nativeTaskRestore !== false ? modelRestores : []),
          ...(context?.taskHistory ? bound.restores : []),
        ];
        if (!context?.taskHistory)
          for (const request of bound.restores)
            restoreOutcomes.push({
              id: request.as,
              op: "bind",
              status: "error",
              message: `Cannot ${describeRestoreRequest(request)}: this session keeps no task history.`,
            });
        if (restoreRequests.length && context?.taskHistory) {
          const planned = await planRestores(restoreRequests, context.taskHistory, state);
          restorePlans = planned.plans;
          for (const refusal of planned.refusals)
            restoreOutcomes.push({
              id: refusal.request.as,
              op: "restore",
              status: "error",
              message: `Cannot ${describeRestoreRequest(refusal.request)}: ${refusal.message}`,
            });
        }
        const restoredIds = new Map<string, RestorePlan>();
        for (const plan of restorePlans) for (const id of plan.created) restoredIds.set(id, plan);
        // The defs of the graph before this call: what `lift` reads and what a
        // new def is compared with for the near-duplicate receipt.
        const knownBefore = registeredOperators ? await workflowFunctions(state) : undefined;
        const library = registeredOperators ? (context?.definitionRegistry?.libraryFunctions() ?? {}) : {};
        // Lifts run before the edits. A lifted def with a new name waits in
        // the registry for its first call; one lifted in place is a
        // redefinition appended to the program, so its tables recompute.
        const liftOutcomes: NativeBatchOutcome[] = [];
        const lifts: NonNullable<NativeBatchResult["lifts"]> = [];
        const liftedInPlace: string[] = [];
        for (const request of args.lift ?? []) {
          const name = request.as ?? request.from;
          const source = knownBefore?.functions[request.from]?.source ?? library[request.from];
          if (!source) {
            liftOutcomes.push({
              id: name,
              op: "lift",
              status: "error",
              message: `No def \`${request.from}\` in the current graph to lift; the entries and \`inspect\` show the shared functions by name.`,
            });
            continue;
          }
          const result = await liftDefinition(source, request);
          if (!result.ok) {
            liftOutcomes.push({ id: name, op: "lift", status: "error", message: `Cannot lift ${request.from}: ${result.message}` });
            continue;
          }
          const consumer = state
            .getAllOperators()
            .find(op => !op.taskSource && op.nativeOp?.source && Object.hasOwn(op.nativeOp.functions ?? {}, request.from));
          const call = `${name}(${[
            ...(consumer?.nativeOp?.inputs ?? ["T"]),
            ...Object.entries(request.params).map(([key, value]) => `${key}=${pythonLiteral(value)}`),
          ].join(", ")})`;
          const taskNumber = context?.activeTaskNumber?.() ?? 0;
          if (request.as && request.as !== request.from) {
            context?.definitionRegistry?.recordLift(request.as, result.source, taskNumber, request.from);
            library[request.as] = result.source;
            liftOutcomes.push({
              id: name,
              op: "lift",
              status: "added",
              message: `${signatureOfSource(result.source, name)} is now an operator (from ${request.from}); \`x = ${call}\` reproduces ${consumer ? `\`${consumer.operatorID}\`` : "the original"}.`,
            });
          } else {
            // In place: the tables that ran the def through process(fn=) now
            // call the operator, so they stay consumers with the same inputs.
            // A def used as a row function or a helper cannot be lifted in
            // place; a new name leaves those uses untouched.
            const consumers = state
              .getAllOperators()
              .filter(op => !op.taskSource && Object.hasOwn(op.nativeOp?.functions ?? {}, request.from));
            const blocked = consumers.find(
              op => !(op.nativeOp?.type === "Process" && op.nativeOp.properties.entry === request.from)
            );
            if (blocked) {
              liftOutcomes.push({
                id: name,
                op: "lift",
                status: "error",
                message: `Cannot lift ${request.from} in place: \`${blocked.operatorID}\` uses it as a row function or a helper; lift it under a new name with \`as\`.`,
              });
              continue;
            }
            if (!consumers.length) {
              context?.definitionRegistry?.recordLift(name, result.source, taskNumber, request.from);
              library[name] = result.source;
            } else {
              liftedInPlace.push(result.source);
              for (const op of consumers)
                if (!isRegisteredCall(op.nativeOp))
                  liftedInPlace.push(`${op.operatorID} = ${request.from}(${op.nativeOp!.inputs.join(", ")})`);
            }
            liftOutcomes.push({
              id: name,
              op: "lift",
              status: "modified",
              message: `${signatureOfSource(result.source, name)} now takes ${Object.keys(request.params).join(", ")} as parameters${consumers.length ? `; ${consumers.map(op => op.operatorID).join(", ")} now call${consumers.length === 1 ? "s" : ""} it and recompute${consumers.length === 1 ? "s" : ""} unchanged` : ""}.`,
            });
          }
          lifts.push({ name, source: result.source, call });
        }
        // Appended after the edits so the model's line numbers stay its own.
        const program = [args.edits, ...liftedInPlace, ...restorePlans.map(plan => plan.program)]
          .filter(part => part.length)
          .join("\n");
        const compileOptions = {
          profileCollection: context?.settings?.nativeProfileCollection === true,
          registeredOperators,
          ...(registeredOperators && Object.keys(library).length ? { libraryFunctions: library } : {}),
        };
        const compiled = analysisState
          ? await compileAnalysisProgram(program, state, args.delete, compileOptions)
          : await compileProgram(program, compileOptions);
        const statements: ProgramStatement[] = compiled.statements;
        const forked = await planAnalysisForks(
          [...(args.fork ?? []), ...bound.forks],
          state,
          statements,
          context?.taskHistory,
          compileOptions
        );
        statements.push(...forked.statements);
        // Deletes apply first. A delete is refused while a consumer survives the
        // call: one that is neither deleted here nor redefined in `edits` with
        // inputs that no longer include the deleted id.
        const deleteIds = [...new Set(args.delete ?? [])];
        const deleteSet = new Set(deleteIds);
        const deleteOutcomes: NativeBatchOutcome[] = [];
        for (const id of deleteIds) {
          const repointed = new Set(statements.filter(st => st.view && !st.view.inputs.includes(id)).map(st => st.id));
          const handled = new Set([...deleteSet, ...repointed]);
          const message = deleteNativeOperator(state, id, handled);
          const failed = message.startsWith("[ERROR]");
          if (!failed) repair.clear(id);
          deleteOutcomes.push({
            id,
            op: "delete",
            status: failed ? "error" : "deleted",
            message: failed ? message.slice(8) : message,
          });
        }
        const outcomes: Array<NativeBatchOutcome | undefined> = statements.map(() => undefined);
        // A statement that did not parse fails alone, at its line; the rest of
        // the program lands. Its dependents are blocked below like any other
        // failed input.
        const syntaxIds = new Set(compiled.errors.map(e => e.id).filter((id): id is string => !!id));
        const syntaxOutcomes: NativeBatchOutcome[] = compiled.errors.map(error => {
          const where = `line ${error.line}${error.column ? `, column ${error.column}` : ""}`;
          const diagnostic: NativeDiagnostic = {
            version: 1,
            operatorId: error.id ?? where,
            operatorRevision: "unversioned",
            code: "PROGRAM_SYNTAX",
            stage: "validate",
            message: `${where}: ${error.message.replace(/\.?$/, ".")} This statement was skipped; the other statements landed. Write one \`name = operator(...)\` per statement plus \`def\` functions; the operators are ${NATIVE_OPERATOR_NAMES.join(", ")}.`,
            field: "edits",
            retryable: false,
          };
          return {
            id: error.id ?? where,
            op: "edits",
            status: "error",
            message: formatNativeDiagnostic(diagnostic),
            diagnostic,
          };
        });
        const fail = (
          index: number,
          message: string,
          status: "error" | "blocked" = "error",
          diagnostic = parseNativeDiagnostic(message)
        ) => {
          const statement = statements[index];
          outcomes[index] = {
            id: statement.id,
            op: statement.op,
            status,
            message: diagnostic ? formatNativeDiagnostic(diagnostic) : message,
            attempted: statement.attempted,
            ...(diagnostic ? { diagnostic } : {}),
          };
        };
        const byId = new Map<string, number>();
        for (const [index, statement] of statements.entries()) {
          if (byId.has(statement.id)) {
            const message = `\`${statement.id}\` is assigned twice in one program; define each table once.`;
            fail(byId.get(statement.id)!, message);
            fail(index, message);
          } else byId.set(statement.id, index);
        }
        for (const [index, statement] of statements.entries()) {
          if (outcomes[index]) continue;
          const params = repairParams(statement);
          const paused = repair.blocked(statement.op, params);
          if (paused) {
            fail(index, "", "error", { ...paused, operatorRevision: statement.attempted.revision! });
            continue;
          }
          if (statement.error) {
            const diagnostic = repair.record(
              statement.op,
              params,
              {
                version: 1,
                operatorId: statement.id,
                operatorRevision: statement.attempted.revision!,
                code: "INVALID_ARGUMENTS",
                stage: "validate",
                message: statement.error.message,
                field: statement.error.field ?? "arguments",
                retryable: false,
              },
              NATIVE_BY_NAME.get(statement.op)?.signature ?? `one of ${NATIVE_OPERATOR_NAMES.join(", ")}`,
              JSON.stringify(["validate", "INVALID_ARGUMENTS", statement.error.field ?? "arguments"])
            );
            fail(index, statement.error.message, "error", diagnostic);
          }
        }

        // Multi-task: `at(name, task=N)` reads a table as saved at the end of a
        // completed task. Serve each reference with its runtime-owned source
        // before the graph is checked, so the reference is an ordinary input.
        // A reference to a task that holds no saved version fails its statement
        // alone, with the history's own reason.
        for (const [index, statement] of statements.entries()) {
          if (outcomes[index] || !statement.view) continue;
          if (statement.id.startsWith(TASK_SOURCE_PREFIX)) {
            fail(index, `\`${statement.id}\` is reserved for saved task outputs; choose another table name.`);
            continue;
          }
          const written = statement.view.taskInputs ?? statement.view.inputs;
          const internal = written.find(ref => typeof ref === "string" && ref.startsWith(TASK_SOURCE_PREFIX));
          if (internal) {
            fail(index, `\`${internal}\` is an internal name; read a saved table with at(name, task=N).`);
            continue;
          }
          const saved = written.filter(ref => typeof ref !== "string");
          if (!saved.length) continue;
          if (!context?.taskHistory || !context.metadataStore) {
            fail(
              index,
              "`at(name, task=N)` reads a table as saved at the end of a completed task, and this session keeps no task history. Refer to the current table by name."
            );
            continue;
          }
          try {
            for (const ref of saved)
              context.taskHistory.source(
                ref,
                state,
                context.metadataStore,
                context.settings?.nativeProfileCollection === true
              );
          } catch (error) {
            fail(index, error instanceof Error ? error.message : String(error));
          }
        }

        // Validate the resulting graph, including cycles closed through an old
        // operator. Do this before writes so a rejected edit leaves no damage.
        const inputs = new Map(
          state.getAllOperators().map(op => [
            op.operatorID,
            state
              .getAllLinks()
              .filter(l => l.target.operatorID === op.operatorID)
              .map(l => l.source.operatorID),
          ])
        );
        for (const [index, statement] of statements.entries())
          if (!outcomes[index]) inputs.set(statement.id, statement.view!.inputs);
        for (const [index, statement] of statements.entries()) {
          if (outcomes[index]) continue;
          for (const id of inputs.get(statement.id) ?? []) {
            if (syntaxIds.has(id) && !inputs.has(id))
              fail(index, `Input \`${id}\` did not parse in this program; dependent statement skipped.`, "blocked");
            else if (!inputs.has(id) && !byId.has(id))
              fail(index, `Input table \`${id}\` does not exist and is not defined in this program.`);
          }
        }
        const visited = new Set<string>();
        const stack: string[] = [];
        const cycle = new Set<string>();
        const checkCycle = (id: string) => {
          const start = stack.indexOf(id);
          if (start >= 0) {
            for (const member of stack.slice(start)) cycle.add(member);
            return;
          }
          if (visited.has(id)) return;
          visited.add(id);
          stack.push(id);
          for (const up of inputs.get(id) ?? []) checkCycle(up);
          stack.pop();
        };
        for (const id of inputs.keys()) checkCycle(id);
        for (const [index, statement] of statements.entries())
          if (cycle.has(statement.id) && !outcomes[index])
            fail(index, `Edit creates a dataflow cycle involving \`${statement.id}\`.`);

        // Resolve producers through unchanged existing nodes too. This supplies
        // edges to the SAME scheduler used for parallel tool calls; it does not
        // determine execution order itself. Keep the resolved edges for failure
        // propagation so an old upstream version cannot mask a refused revision.
        const dependenciesById = new Map<string, string[]>();
        for (const statement of statements) {
          const seen = new Set<string>();
          const dependencies: string[] = [];
          const collect = (id: string) => {
            if (seen.has(id)) return;
            seen.add(id);
            if (byId.has(id)) dependencies.push(id);
            else for (const up of inputs.get(id) ?? []) collect(up);
          };
          for (const id of inputs.get(statement.id) ?? []) collect(id);
          dependenciesById.set(statement.id, dependencies);
        }
        const apply = async (index: number): Promise<void> => {
          if (outcomes[index]) return;
          const statement = statements[index];
          for (const id of dependenciesById.get(statement.id) ?? []) {
            const outcome = outcomes[byId.get(id)!];
            if (!outcome || outcome.status === "error" || outcome.status === "blocked") {
              fail(
                index,
                `Input \`${id}\` was not updated successfully in this program; dependent statement skipped.`,
                "blocked"
              );
              return;
            }
          }
          try {
            const existed = !!state.getOperator(statement.id);
            const message = await applyNativeOperator(state, context, statement.id, statement.view!);
            if (message.startsWith("[ERROR]")) {
              let diagnostic = parseNativeDiagnostic(message);
              if (
                repair.epoch === repairEpoch &&
                diagnostic &&
                (diagnostic.stage === "validate" || diagnostic.stage === "compile")
              )
                diagnostic = repair.record(
                  statement.op,
                  repairParams(statement),
                  diagnostic,
                  NATIVE_BY_NAME.get(statement.op)?.signature ?? statement.op
                );
              fail(index, message.slice(8), "error", diagnostic);
            } else {
              if (repair.epoch === repairEpoch) repair.clear(statement.id);
              outcomes[index] = { id: statement.id, op: statement.op, status: existed ? "modified" : "added", message };
            }
          } catch (error: any) {
            fail(index, error?.message ?? String(error));
          }
        };
        const scheduler = new ToolCallScheduler({
          parseDeps: (_toolName, input) => dependenciesById.get(input.id) ?? [],
          producedOpId: (_toolName, input) => input.id,
        });
        // Submit together, just like SDK parallel calls. The scheduler itself
        // serializes the actual mutations in stable topological order.
        await Promise.all(
          statements.map((statement, index) =>
            scheduler
              .wrap(statement.op, {
                execute: (_input: unknown, _options: unknown) => apply(index),
              })
              .execute({ id: statement.id }, undefined)
          )
        );
        // Receipts of restored statements say what they are; a copied ancestor
        // names the restore it serves.
        for (const [index, statement] of statements.entries()) {
          const plan = restoredIds.get(statement.id);
          const outcome = outcomes[index];
          if (!plan || !outcome || (outcome.status !== "added" && outcome.status !== "modified")) continue;
          outcome.op = "restore";
          outcome.message =
            statement.id === plan.request.as
              ? `${describeRestoreRequest(plan.request)}: ${outcome.status}` +
                (plan.shared.length ? `; shares ${plan.shared.join(", ")}` : "") +
                (plan.created.length > 1 ? `; copies ${plan.created.slice(1).join(", ")}` : "")
              : `copied \`${statement.id}\` as saved at task ${plan.request.task}, for the restore of \`${plan.request.as}\``;
        }
        const restored = restorePlans
          .filter(plan => {
            const index = byId.get(plan.request.as);
            const outcome = index === undefined ? undefined : outcomes[index];
            return !!outcome && outcome.status !== "error" && outcome.status !== "blocked";
          })
          .map(plan => ({ ...plan.request, created: plan.created, shared: plan.shared }));
        // Registry: successors declared in this call, once their table exists.
        const supersedeOutcomes: NativeBatchOutcome[] = [];
        if (registry)
          for (const [table, of] of Object.entries(args.supersede ?? {})) {
            const index = byId.get(table);
            const landed = index === undefined ? !!state.getOperator(table) : outcomes[index]?.status === "added" || outcomes[index]?.status === "modified";
            try {
              if (!landed) throw new Error(`\`${table}\` did not land in this call and does not exist.`);
              if (!state.getOperator(of)) throw new Error(`\`${of}\` is not a current table.`);
              registry.supersede(table, of, context?.activeTaskNumber?.() ?? 0);
              notes.push(`supersede: \`${table}\` is now the active version of \`${registry.definitionOf(of)}\`; \`${of}\` stays readable as an earlier version`);
            } catch (error) {
              supersedeOutcomes.push({
                id: table,
                op: "supersede",
                status: "error",
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
        // Registered operators: a def called by name persists with its tables;
        // its versions (distinct bodies over time) are kept for the index.
        if (registeredOperators && context?.definitionRegistry)
          for (const [index, statement] of statements.entries()) {
            const outcome = outcomes[index];
            const view = statement.view;
            if (!view || !outcome || (outcome.status !== "added" && outcome.status !== "modified")) continue;
            if (!isRegisteredCall(view)) continue;
            const name = String(view.properties.entry);
            const source = view.functions?.[name];
            if (source) context.definitionRegistry.recordOperator(name, source, context.activeTaskNumber?.() ?? 0);
          }
        // Near duplicates: a new def mostly the same as an existing one gets
        // the call or the lift that would have replaced it, in this receipt.
        if (registeredOperators && knownBefore && args.edits.trim()) {
          const own = (await parseDefinitions(args.edits)).functions;
          const candidates = Object.fromEntries(
            Object.entries(own)
              .filter(([name]) => !knownBefore.functions[name] && !library[name])
              .map(([name, fn]) => [name, fn.source])
          );
          const existing = {
            ...library,
            ...Object.fromEntries(Object.entries(knownBefore.functions).map(([name, fn]) => [name, fn.source])),
          };
          try {
            for (const match of await nearDuplicates(candidates, existing)) notes.push(nearDuplicateNote(match));
          } catch {
            // The receipt never fails on advice.
          }
        }
        // Registry: contract hints on new custom code, once per kind per call.
        if (registry) {
          let fitted = false;
          let literals = false;
          for (const [index, statement] of statements.entries()) {
            const outcome = outcomes[index];
            if (!outcome || (outcome.status !== "added" && outcome.status !== "modified")) continue;
            if (statement.op !== "process" && statement.op !== "map") continue;
            const code = String(statement.view?.properties?.code ?? "");
            if (!fitted && /\b(sklearn|statsmodels|xgboost|lightgbm|scipy\.optimize)\b/.test(code)) {
              fitted = true;
              outcome.message +=
                " Hint: this fits a model; keep its row-level predictions or error flags as a table (one row per key) so later tasks reuse the exact fit instead of refitting.";
            }
            const inputs = statement.view?.inputs ?? [];
            const hasParameters = inputs.some(id => state.getOperator(id)?.nativeOp?.type === "Parameters");
            const numbers = code.match(/(?<![\w.])(?:\d+\.\d+|[1-9]\d{1,3})(?![\w.])/g) ?? [];
            if (!literals && !hasParameters && new Set(numbers).size >= 4) {
              literals = true;
              outcome.message += ` Hint: ${new Set(numbers).size} numeric assumptions are inside this code; adjustable ones belong in a parameters(...) table passed as an input, so a later task can version them.`;
            }
          }
        }
        // `t[a,b]` projects a table to those columns for this event's
        // observation; the id list stays plain ids. The answer table is always
        // observed, so its rows reach the entry and, on a refusal, the model.
        const observeColumns: Record<string, string[]> = {};
        const requested = (args.observe ?? []).map(item => {
          const match = /^\s*([A-Za-z_]\w*)\s*\[([^\]]*)\]\s*$/.exec(item);
          if (!match) return item.trim();
          const columns = match[2]
            .split(",")
            .map(name => name.trim().replace(/^["']|["']$/g, ""))
            .filter(Boolean);
          if (columns.length) observeColumns[match[1]] = [...new Set([...(observeColumns[match[1]] ?? []), ...columns])];
          return match[1];
        });
        const observationErrors: string[] = [];
        if (answerTable && !state.getOperator(answerTable))
          observationErrors.push(`answer_from: no table \`${answerTable}\`; write the final answer yourself.`);
        else if (answerTable && !requested.includes(answerTable)) requested.push(answerTable);
        const observe = [...new Set(requested)].filter(id => {
          if (state.getOperator(id)) return true;
          observationErrors.push(`Cannot observe \`${id}\`: no such table.`);
          return false;
        });
        const ordered = [
          ...statements.map((statement, index) => ({ line: statement.line, outcome: outcomes[index]! })),
          ...compiled.errors.map((error, index) => ({ line: error.line, outcome: syntaxOutcomes[index] })),
        ]
          .sort((a, b) => a.line - b.line)
          .map(entry => entry.outcome);
        const inspection = analysisState ? inspectAnalysis(state, args.inspect ?? []) : [];
        if (registry) for (const id of args.explain ?? []) inspection.push(registry.explain(state, id, context?.taskHistory));
        for (const task of args.recall ?? []) {
          const entry = context?.taskHistory?.entries().find(entry => entry.task === task);
          inspection.push(
            entry
              ? renderTaskEntry(entry, context?.settings?.nativeTaskEfficiency)
              : `No completed entry for task ${task}.`
          );
        }
        const task = context?.activeTaskId?.();
        if (
          context?.settings?.nativeTaskEfficiency &&
          task &&
          !context.settings.contextWindowTokens &&
          !context.settings.staticCompaction &&
          !context.settings.enableCompactTool
        ) {
          if (inspectionTask !== task) {
            inspectionTask = task;
            shownInspections.clear();
          }
          if (context.visibleInspections) {
            shownInspections.clear();
            for (const text of context.visibleInspections()) shownInspections.add(text);
          }
          for (let i = 0; i < inspection.length; i++) {
            const text = inspection[i];
            if (shownInspections.has(text)) inspection[i] = `Already shown in this task: ${text.split("\n")[0]}`;
            else shownInspections.add(text);
          }
        }
        return {
          kind: "native-batch",
          operators: [
            ...deleteOutcomes,
            ...liftOutcomes,
            ...restoreOutcomes,
            ...bound.errors.map(error => ({
              id: error.id,
              op: "bind",
              status: "error" as const,
              message: error.message,
            })),
            ...forked.errors.map(error => ({
              id: error.id,
              op: "fork",
              status: "error" as const,
              message: error.message,
            })),
            ...ordered,
            ...supersedeOutcomes,
          ],
          observe,
          observationErrors,
          ...(restored.length ? { restored } : {}),
          ...(inspection.length ? { inspection } : {}),
          ...(notes.length ? { notes } : {}),
          ...(lifts.length ? { lifts } : {}),
          ...(answerTable && state.getOperator(answerTable)
            ? {
                answerFrom: answerTable,
                ...(answerRequest && "shape" in answerRequest && answerRequest.shape ? { answerShape: answerRequest.shape } : {}),
              }
            : {}),
          ...(Object.keys(observeColumns).length ? { observeColumns } : {}),
          ...(args.expect && Object.keys(args.expect).length ? { expect: args.expect } : {}),
        } satisfies NativeBatchResult;
      },
    }),
  };
}

/** What identifies a submission for the repeat-failure throttle: the name, the
 * inputs and the normalized parameters (never the raw text, so whitespace does
 * not defeat the check). */
function repairParams(statement: ProgramStatement): Record<string, unknown> {
  return { id: statement.id, inputs: statement.attempted.inputs, ...statement.attempted.properties };
}
