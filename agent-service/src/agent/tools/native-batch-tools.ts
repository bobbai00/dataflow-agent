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

import Ajv from "ajv";
import { jsonSchema, tool } from "ai";
import type { ReActStep } from "../../types/agent";
import { nativeOperators, type NativeCatalogVersion } from "../native/catalog";
import type { WorkflowState } from "../workflow-state";
import type { ToolContext } from "./workflow-crud-tools";
import { createErrorResult } from "./tools-utility";
import { ToolCallScheduler } from "./tool-call-scheduler";
import { parseNativeDiagnostic, formatNativeDiagnostic, type NativeDiagnostic } from "../native/diagnostics";
import { NativeValidationRepair } from "../native/validation-repair";
import { resolveTaskInputs, type TaskInput } from "../native/task-history";
import { directReturnSchema, type DirectReturn } from "../native/direct-return";
import {
  createNativeTypedTools,
  nativeInputsOf,
  nativeToolDescription,
  nativeToolName,
  nativeToolSchema,
  rejectedNativeViewOf,
  TOOL_NAME_NATIVE_DELETE,
} from "./native-typed-tools";

export const TOOL_NAME_DATAFLOW = "dataflow";

export interface NativeBatchOutcome {
  id: string;
  op: string;
  status: "added" | "modified" | "error" | "blocked";
  message: string;
  diagnostic?: NativeDiagnostic;
}

/** Stored as the tool result on the owning ReAct event. Observation choices
 * are event facts, never mutable preferences on an operator. */
export interface NativeBatchResult {
  kind: "native-batch";
  operators: NativeBatchOutcome[];
  observe: string[];
  observationErrors: string[];
  return?: DirectReturn;
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
  const results = nativeBatchResults(step);
  return results.length ? new Set(results.flatMap(r => r.observe)) : undefined;
}

/** Schematic object signatures, generated from the same catalog as validation.
 * The deprecated scan.columns field only exists to issue a migration error;
 * don't advertise it as an available scan operation. */
export function nativeBatchCatalogText(version: NativeCatalogVersion = "v1"): string {
  return nativeOperators(version)
    .map(def => {
      const schema = nativeToolSchema(def) as { properties: Record<string, unknown>; required: string[] };
      const fields = Object.keys(schema.properties)
        .filter(name => !(def.type === "Scan" && name === "columns"))
        .map(name => (schema.required.includes(name) ? name : `${name}?`));
      // Full semantics are already attached to the tool schema. Keep only the
      // field index here instead of paying for the same descriptions twice.
      return `{op: "${nativeToolName(def.type)}", ${fields.join(", ")}}`;
    })
    .join("\n");
}

/** `op` discriminates catalog variants; `type` remains available for join kind. */
export function nativeBatchSchema(
  version: NativeCatalogVersion = "v1",
  options: { taskHistory?: boolean; directReturn?: boolean; compact?: boolean } = {}
): Record<string, unknown> {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      operators: {
        type: "array",
        description:
          "One stage of the dataflow. Each item is an upsert by id, using the parameters of its op. Batch whole dependent chains and branches: input ids can reference existing operators or any item in this batch, regardless of array order. Use [] to request already-computed results without edits.",
        items: {
          anyOf: nativeOperators(version).map(def => {
            const schema = nativeToolSchema(def, options.taskHistory) as any;
            return {
              ...schema,
              description: nativeToolDescription(def),
              properties: { op: { type: "string", const: nativeToolName(def.type) }, ...schema.properties },
              required: ["op", ...schema.required],
            };
          }),
        },
      },
      observe: {
        type: "array",
        items: { type: "string" },
        description:
          "Explicitly list every operator id whose result content you want to see, including existing or re-executed downstream operators. Omitted or [] returns compact receipts only, with no successful table bodies. All edits still execute; errors always appear. Use operators:[] with observe to retrieve cached results later.",
      },
      ...(options.directReturn ? { return: directReturnSchema } : {}),
    },
    required: ["operators"],
  };
  // Keep the complete discriminated type contract. Real runs with a loose
  // schema put trailing JSON inside Python callbacks and arrays.
  // Compact only prose already covered by the generated catalog prompt.
  const compact = (value: any): any =>
    Array.isArray(value)
      ? value.map(compact)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => !["description", "title", "$comment", "examples"].includes(key))
              .map(([key, item]) => [key, compact(item)])
          )
        : value;
  return options.compact ? compact(schema) : schema;
}

const ajv = new Ajv({ allErrors: true, strict: false });
const versionValidators = new Map<NativeCatalogVersion, Map<string, ReturnType<typeof ajv.compile>>>();
function validatorsFor(version: NativeCatalogVersion) {
  let validators = versionValidators.get(version);
  if (!validators) {
    validators = new Map(
      nativeOperators(version).map(def => [nativeToolName(def.type), ajv.compile(nativeToolSchema(def))])
    );
    versionValidators.set(version, validators);
  }
  return validators;
}

/** Explicit mixed-operator batching. The existing typed upsert implementation
 * owns compilation and wiring; the normal post-step path owns execution. */
export function createNativeBatchTools(
  state: WorkflowState,
  context?: ToolContext,
  version: NativeCatalogVersion = "v1"
): Record<string, any> {
  const nativeInputReferences = new Map<string, TaskInput[]>();
  const typed = createNativeTypedTools(state, { ...context, nativeInputReferences }, version);
  const validators = validatorsFor(version);
  const repair = version === "v2" ? (context?.nativeValidationRepair ?? new NativeValidationRepair()) : undefined;
  const schemas = new Map(nativeOperators(version).map(def => [nativeToolName(def.type), nativeToolSchema(def)]));
  const deleteTool = typed[TOOL_NAME_NATIVE_DELETE];
  return {
    [TOOL_NAME_NATIVE_DELETE]: {
      ...deleteTool,
      execute: async (args: { id: string }) => {
        const result = await deleteTool.execute(args);
        if (typeof result === "string" && !result.startsWith("[ERROR]")) repair?.clear(args.id);
        return result;
      },
    },
    [TOOL_NAME_DATAFLOW]: tool({
      description:
        version === "v2"
          ? "Build or revise a stage using the Python V2 catalog. Batch dependent chains, forward references and existing-DAG edits in one call; the shared scheduler resolves their order. Explicitly list result IDs in observe; omitted/[] hides successes but never errors. operators:[] observes cached data without execution. Independent valid edits can succeed when another edit fails; its dependents are blocked."
          : "Build or revise a whole dataflow stage in one call. operators is a heterogeneous array: {op:'scan',id,files,...}, {op:'filter',id,input,predicate}, {op:'aggregate',id,input,aggregations,...}, etc. Batch dependent chains and branches to avoid extra round trips when inputs and operations are known. The shared tool-call scheduler orders upserts by dependency, including forward references. Successful edits trigger one post-step execution phase; disconnected branches may use separate backend requests. Explicitly include ids in observe to receive result content; omitted or [] gives receipts only. Failures remain visible for all operators. Independent valid operators still land when another item fails; dependents of a refused edit are blocked. Use operators:[] with observe to read cached results without re-execution.",
      inputSchema: jsonSchema<{ operators: Array<Record<string, unknown>>; observe?: string[]; return?: DirectReturn }>(
        nativeBatchSchema(version, {
          taskHistory: !!context?.taskHistory,
          directReturn: context?.nativeDirectReturn,
          compact: context?.nativeCompactPrompt,
        }) as any
      ),
      execute: async args => {
        if (args.return && !context?.nativeDirectReturn) return createErrorResult("Direct result return is disabled");
        if (args.return && !ajv.validate(directReturnSchema, args.return))
          return createErrorResult("Invalid return specification");
        const repairEpoch = repair?.epoch;
        if (
          version === "v2" &&
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
        if (state.getAllOperators().some(op => (op.nativeOp?.version ?? "v1") !== version)) {
          return createErrorResult(
            `Cannot mix native catalog versions; this batch is ${version}. Use a separate workflow or an explicit migration.`
          );
        }
        if (
          !Array.isArray(args?.operators) ||
          (args.observe !== undefined &&
            (!Array.isArray(args.observe) || args.observe.some(id => typeof id !== "string")))
        ) {
          return createErrorResult("dataflow requires operators: array and optional observe: string[]");
        }
        nativeInputReferences.clear();
        const inputErrors = new Map<number, string>();
        const specs = args.operators.map((spec, index) => {
          const { op, ...params } = spec && typeof spec === "object" ? spec : {};
          let resolved = params;
          const def = nativeOperators(version).find(def => nativeToolName(def.type) === op);
          if (def && context?.taskHistory && context.metadataStore) {
            try {
              const input = resolveTaskInputs(
                params,
                def.inputs,
                context.taskHistory,
                state,
                context.metadataStore,
                context.settings?.nativeProfileCollection
              );
              resolved = input.params;
              if (typeof params.id === "string") nativeInputReferences.set(params.id, input.references);
            } catch (error) {
              inputErrors.set(index, error instanceof Error ? error.message : String(error));
            }
          }
          return {
            index,
            op: typeof op === "string" ? op : "",
            id: typeof params.id === "string" ? params.id : "",
            params: resolved,
          };
        });
        const outcomes: Array<NativeBatchOutcome | undefined> = specs.map(() => undefined);
        const fail = (
          index: number,
          message: string,
          status: "error" | "blocked" = "error",
          diagnostic = parseNativeDiagnostic(message)
        ) => {
          outcomes[index] = {
            id: specs[index].id,
            op: specs[index].op,
            status,
            message: diagnostic ? formatNativeDiagnostic(diagnostic) : message,
            ...(diagnostic ? { diagnostic } : {}),
          };
        };
        const byId = new Map<string, number>();
        for (const [index, message] of inputErrors) fail(index, message);
        for (const spec of specs) {
          if (byId.has(spec.id)) {
            fail(byId.get(spec.id)!, `Duplicate id '${spec.id}' in one batch; submit each id once.`);
            fail(spec.index, `Duplicate id '${spec.id}' in one batch; submit each id once.`);
          } else byId.set(spec.id, spec.index);
        }
        for (const spec of specs) {
          if (outcomes[spec.index]) continue;
          const paused = repair?.blocked(spec.op, spec.params);
          if (paused) {
            fail(spec.index, "", "error", {
              ...paused,
              operatorRevision: rejectedNativeViewOf(spec.op, spec.params).revision!,
            });
            continue;
          }
          const validate = validators.get(spec.op);
          if (!validate) fail(spec.index, `Unknown op '${spec.op}'. Available: ${[...validators.keys()].join(", ")}.`);
          else if (!validate(spec.params)) {
            const errors = validate.errors ?? [];
            const fieldOf = (error: (typeof errors)[number]) => {
              const name = error.params.missingProperty ?? error.params.additionalProperty;
              return `${error.instancePath}${name ? `/${name}` : ""}` || "parameters";
            };
            const message = `Invalid ${spec.op} parameters: ${errors
              .map(
                e =>
                  `${repair ? fieldOf(e) : e.instancePath || "parameters"} ${e.message}${repair && e.params.allowedValues ? `: ${JSON.stringify(e.params.allowedValues)}` : ""}`
              )
              .slice(0, 4)
              .join("; ")}`;
            const diagnostic = repair?.record(
              spec.op,
              spec.params,
              {
                version: 1,
                operatorId: spec.id,
                operatorRevision: rejectedNativeViewOf(spec.op, spec.params).revision!,
                code: "INVALID_ARGUMENTS",
                stage: "validate",
                message,
                field: errors[0] ? fieldOf(errors[0]) : "parameters",
                retryable: false,
              },
              schemas.get(spec.op)!,
              JSON.stringify(errors.map(e => [e.instancePath, e.keyword, e.params]).sort())
            );
            fail(spec.index, message, "error", diagnostic);
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
        for (const spec of specs) if (!outcomes[spec.index]) inputs.set(spec.id, nativeInputsOf(spec.op, spec.params));
        for (const spec of specs) {
          if (outcomes[spec.index]) continue;
          for (const id of inputs.get(spec.id) ?? []) {
            if (!inputs.has(id) && !byId.has(id))
              fail(spec.index, `Input operator '${id}' does not exist or appear in this batch.`);
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
        for (const spec of specs)
          if (cycle.has(spec.id) && !outcomes[spec.index])
            fail(spec.index, `Edit creates a dataflow cycle involving '${spec.id}'.`);

        // Resolve batch producers through unchanged existing nodes too. This
        // supplies edges to the SAME scheduler used for parallel tool calls;
        // it does not determine execution order itself. Keep the resolved edges
        // for failure propagation so an old upstream version cannot mask a
        // refused revision.
        const dependenciesById = new Map<string, string[]>();
        for (const spec of specs) {
          const seen = new Set<string>();
          const dependencies: string[] = [];
          const collect = (id: string) => {
            if (seen.has(id)) return;
            seen.add(id);
            if (byId.has(id)) dependencies.push(id);
            else for (const up of inputs.get(id) ?? []) collect(up);
          };
          for (const id of inputs.get(spec.id) ?? []) collect(id);
          dependenciesById.set(spec.id, dependencies);
        }
        const apply = async (index: number): Promise<void> => {
          if (outcomes[index]) return;
          const spec = specs[index];
          for (const id of dependenciesById.get(spec.id) ?? []) {
            const outcome = outcomes[byId.get(id)!];
            if (!outcome || outcome.status === "error" || outcome.status === "blocked") {
              fail(
                index,
                `Input '${id}' was not updated successfully in this batch; dependent edit skipped.`,
                "blocked"
              );
              return;
            }
          }
          try {
            const existed = !!state.getOperator(spec.id);
            const result = await typed[spec.op].execute(spec.params);
            const message = typeof result === "string" ? result : JSON.stringify(result);
            if (message.startsWith("[ERROR]")) {
              let diagnostic = parseNativeDiagnostic(message);
              if (
                repair?.epoch === repairEpoch &&
                diagnostic &&
                (diagnostic.stage === "validate" || diagnostic.stage === "compile")
              )
                diagnostic = repair?.record(spec.op, spec.params, diagnostic, schemas.get(spec.op)!) ?? diagnostic;
              fail(index, message.slice(8), "error", diagnostic);
            } else {
              if (repair?.epoch === repairEpoch) repair?.clear(spec.id);
              outcomes[index] = { id: spec.id, op: spec.op, status: existed ? "modified" : "added", message };
            }
          } catch (error: any) {
            fail(index, error?.message ?? String(error));
          }
        };
        const scheduler = new ToolCallScheduler({
          parseDeps: (_toolName, input) => dependenciesById.get(input.id) ?? [],
        });
        // Submit together, just like SDK parallel calls. The scheduler itself
        // serializes the actual mutations in stable topological order. This is
        // internal scheduling, not provider parallel tool calling or execution.
        await Promise.all(
          specs.map(spec =>
            scheduler
              .wrap(spec.op, {
                execute: (_input: unknown, _options: unknown) => apply(spec.index),
              })
              .execute(spec.params, undefined)
          )
        );
        const requested = [...(args.observe ?? []), ...(args.return ? [args.return.operator] : [])];
        const observationErrors: string[] = [];
        // An operator this batch failed to add is already reported, with its
        // actual cause, in the receipts above. Repeating it as "does not exist"
        // is a derived diagnostic that describes our own error handling rather
        // than the model's mistake.
        const failedHere = new Set(
          outcomes.flatMap(outcome =>
            outcome && (outcome.status === "error" || outcome.status === "blocked") ? [outcome.id] : []
          )
        );
        const observe = [...new Set(requested)].filter(id => {
          if (state.getOperator(id)) return true;
          if (!failedHere.has(id)) observationErrors.push(`Cannot observe '${id}': operator does not exist.`);
          return false;
        });
        return {
          kind: "native-batch",
          operators: outcomes as NativeBatchOutcome[],
          observe,
          observationErrors,
          ...(args.return ? { return: args.return } : {}),
        } satisfies NativeBatchResult;
      },
    }),
  };
}
