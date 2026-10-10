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
import { createErrorResult } from "./tools-utility";
import { ToolCallScheduler } from "./tool-call-scheduler";
import { parseNativeDiagnostic, formatNativeDiagnostic, type NativeDiagnostic } from "../native/diagnostics";
import { NativeValidationRepair } from "../native/validation-repair";
import { applyNativeOperator, deleteNativeOperator } from "./native-upsert";
import { asDataflowActionsResult } from "./dataflow-actions";

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
  kind: "native-batch" | "dataflow-actions";
  operators: NativeBatchOutcome[];
  observe: string[];
  observationErrors: string[];
}

export function asNativeBatchResult(output: unknown): NativeBatchResult | undefined {
  if (!output || typeof output !== "object") return undefined;
  const r = output as NativeBatchResult;
  return (r.kind === "native-batch" || r.kind === "dataflow-actions") &&
    Array.isArray(r.operators) &&
    Array.isArray(r.observe)
    ? r
    : undefined;
}

export function nativeBatchResults(step: Pick<ReActStep, "toolCalls" | "toolResults">): NativeBatchResult[] {
  return (step.toolCalls ?? []).flatMap(tc => {
    if (tc.toolName !== TOOL_NAME_DATAFLOW) return [];
    const result = asNativeBatchResult(step.toolResults?.find(tr => tr.toolCallId === tc.toolCallId)?.output);
    return result ? [result] : [];
  });
}

export function batchObservedIds(step: Pick<ReActStep, "toolCalls" | "toolResults">): Set<string> | undefined {
  const results = nativeBatchResults(step).filter(result => {
    const actions = asDataflowActionsResult(result);
    // Structural inspection and answering do not change which tables were read.
    return !actions || actions.actions.some(item => ["edit", "fork", "execute", "retrieve"].includes(item.action.type));
  });
  return results.length ? new Set(results.flatMap(r => r.observe)) : undefined;
}

export interface DataflowInput {
  /** With `dataflowReasoning` on: why this call and what the observed tables should show. */
  reasoning?: string;
  /** Statements that create or modify operators, plus the `def`s they use. */
  edits: string;
  /** Ids of operators to remove, applied before the edits. */
  delete?: string[];
  observe?: string[];
}

/** Written first when enabled, so the edits follow the stated intent. */
const REASONING_PROPERTY = {
  type: "string",
  description:
    "Written first: one or two sentences on why this call and what you expect the observed tables to show (row count, columns, a value you can check). It is replayed with the call, so compare the next observation against it.",
};

export function nativeBatchSchema(options: { reasoning?: boolean } = {}): Record<string, unknown> {
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
      observe: {
        type: "array",
        items: { type: "string" },
        description:
          "Step 4, after execution: ids of every operator whose table contents you want to see, including existing or re-executed ones. Omitted or [] returns compact receipts only, with no successful table bodies. Errors always appear.",
      },
    },
    required: options.reasoning ? ["reasoning", "edits"] : ["edits"],
  };
}

export const DATAFLOW_TOOL_DESCRIPTION =
  "Build, modify, delete and observe the dataflow in one call. The call runs four steps in this order: (1) the operators listed in `delete` are removed (refused while a surviving operator still reads one); (2) the `edits` statements are applied, one `id = operator(input_id, ..., parameter=value)` per line plus the `def` functions they use (operators: " +
  NATIVE_OPERATOR_NAMES.join(", ") +
  "), where a new id creates an operator and an existing id modifies it and keeps its consumers; (3) new and modified operators execute, with everything downstream of them; (4) the tables of the ids in `observe` are shown (omitted/[] hides successful tables but never errors). Batch a whole dependent chain in one call; the scheduler orders it. A statement that fails alone blocks only its dependents; the rest lands. Empty `edits` with `observe` re-reads cached results without executing.";

/** The tool description for the agent's settings: with `reasoning`, one sentence says it comes first. */
export function dataflowToolDescription(options: { reasoning?: boolean } = {}): string {
  return options.reasoning
    ? "Start with `reasoning`: why this call and what the observed tables should show. " + DATAFLOW_TOOL_DESCRIPTION
    : DATAFLOW_TOOL_DESCRIPTION;
}

/**
 * The one tool of native mode: `dataflow` (edits, deletes, observations). The
 * existing upsert (`native-upsert.ts`) owns compilation and wiring; the normal
 * post-step path owns execution.
 */
export function createNativeTools(state: WorkflowState, context?: ToolContext): Record<string, any> {
  const repair = context?.nativeValidationRepair ?? new NativeValidationRepair();
  const reasoning = context?.settings?.dataflowReasoning === true;
  return {
    [TOOL_NAME_DATAFLOW]: tool({
      description: dataflowToolDescription({ reasoning }),
      inputSchema: jsonSchema<DataflowInput>(nativeBatchSchema({ reasoning }) as any),
      execute: async args => {
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
        if (
          typeof args?.edits !== "string" ||
          !isIds(args.observe) ||
          !isIds(args.delete) ||
          (args.reasoning !== undefined && typeof args.reasoning !== "string")
        ) {
          return createErrorResult(
            "dataflow requires edits: string, and optionally delete: string[], observe: string[] and reasoning: string"
          );
        }
        const compiled = await compileProgram(args.edits, {
          profileCollection: context?.settings?.nativeProfileCollection === true,
          profileScope: context?.settings?.nativeProfileScope === "full" ? "full" : undefined,
        });
        const statements: ProgramStatement[] = compiled.statements;
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
            const message = `\`${statement.id}\` is assigned twice in one edit; define each table once.`;
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
              fail(index, `Input \`${id}\` did not parse in this edit; dependent statement skipped.`, "blocked");
            else if (!inputs.has(id) && !byId.has(id))
              fail(index, `Input table \`${id}\` does not exist and is not defined in this edit.`);
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
                `Input \`${id}\` was not updated successfully in this edit; dependent statement skipped.`,
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
        const requested = args.observe ?? [];
        const observationErrors: string[] = [];
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
        return {
          kind: "native-batch",
          operators: [...deleteOutcomes, ...ordered],
          observe,
          observationErrors,
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
