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
import { NATIVE_OPERATORS } from "../native/catalog";
import type { WorkflowState } from "../workflow-state";
import type { ToolContext } from "./workflow-crud-tools";
import { createErrorResult } from "./tools-utility";
import {
  createNativeTypedTools,
  nativeInputsOf,
  nativeToolDescription,
  nativeToolName,
  nativeToolSchema,
  TOOL_NAME_NATIVE_DELETE,
} from "./native-typed-tools";

export const TOOL_NAME_DATAFLOW = "dataflow";

export interface NativeBatchOutcome {
  id: string;
  op: string;
  status: "added" | "modified" | "error" | "blocked";
  message: string;
}

/** Stored as the tool result on the owning ReAct event. Observation choices
 * are event facts, never mutable preferences on an operator. */
export interface NativeBatchResult {
  kind: "native-batch";
  operators: NativeBatchOutcome[];
  observe: string[];
  observationErrors: string[];
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
export function nativeBatchCatalogText(): string {
  return NATIVE_OPERATORS.map(def => {
    const schema = nativeToolSchema(def) as { properties: Record<string, unknown>; required: string[] };
    const fields = Object.keys(schema.properties)
      .filter(name => !(def.type === "Scan" && name === "columns"))
      .map(name => (schema.required.includes(name) ? name : `${name}?`));
    return `{op: "${nativeToolName(def.type)}", ${fields.join(", ")}}`;
  }).join("\n");
}

/** `op` discriminates catalog variants; `type` remains available for join kind. */
export function nativeBatchSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      operators: {
        type: "array",
        description:
          "One stage of the dataflow. Each item is an upsert by id, using the parameters of its op. Input ids can reference another item in this batch. Use [] to request already-computed results without edits.",
        items: {
          anyOf: NATIVE_OPERATORS.map(def => {
            const schema = nativeToolSchema(def) as any;
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
          "Operator ids whose results you want to see after execution (including existing ids). Omit to show terminal outputs of this batch. [] requests only receipts. All edits still execute; errors always appear. Later use inspectResult for more cached sample rows.",
      },
    },
    required: ["operators"],
  };
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map(NATIVE_OPERATORS.map(def => [nativeToolName(def.type), ajv.compile(nativeToolSchema(def))]));

/** Explicit mixed-operator batching. The existing typed upsert implementation
 * owns compilation and wiring; the normal post-step path owns execution. */
export function createNativeBatchTools(state: WorkflowState, context?: ToolContext): Record<string, any> {
  const typed = createNativeTypedTools(state, context);
  return {
    [TOOL_NAME_NATIVE_DELETE]: typed[TOOL_NAME_NATIVE_DELETE],
    [TOOL_NAME_DATAFLOW]: tool({
      description:
        "Build or revise a whole dataflow stage in one call. operators is a heterogeneous array: {op:'scan',id,files,...}, {op:'filter',id,input,predicate}, {op:'aggregate',id,input,aggregations,...}, etc. The catalog schemas define every parameter. Operators are dependency ordered and upserted by id. Successful edits trigger one post-step execution phase; disconnected branches may use separate backend requests. observe chooses detailed result tables; omitted observe defaults to this batch's terminal outputs. Failures and compact receipts remain visible for all operators. Independent valid operators still land when another item fails; dependents of a refused edit are blocked. Use operators:[] with observe to read cached results without re-execution.",
      inputSchema: jsonSchema<{ operators: Array<Record<string, unknown>>; observe?: string[] }>(
        nativeBatchSchema() as any
      ),
      execute: async args => {
        if (
          !Array.isArray(args?.operators) ||
          (args.observe !== undefined &&
            (!Array.isArray(args.observe) || args.observe.some(id => typeof id !== "string")))
        ) {
          return createErrorResult("dataflow requires operators: array and optional observe: string[]");
        }
        const specs = args.operators.map((spec, index) => {
          const { op, ...params } = spec && typeof spec === "object" ? spec : {};
          return {
            index,
            op: typeof op === "string" ? op : "",
            id: typeof params.id === "string" ? params.id : "",
            params,
          };
        });
        const outcomes: Array<NativeBatchOutcome | undefined> = specs.map(() => undefined);
        const fail = (index: number, message: string, status: "error" | "blocked" = "error") => {
          outcomes[index] = { id: specs[index].id, op: specs[index].op, status, message };
        };
        const byId = new Map<string, number>();
        for (const spec of specs) {
          if (byId.has(spec.id)) {
            fail(byId.get(spec.id)!, `Duplicate id '${spec.id}' in one batch; submit each id once.`);
            fail(spec.index, `Duplicate id '${spec.id}' in one batch; submit each id once.`);
          } else byId.set(spec.id, spec.index);
          if (outcomes[spec.index]) continue;
          const validate = validators.get(spec.op);
          if (!validate) fail(spec.index, `Unknown op '${spec.op}'. Available: ${[...validators.keys()].join(", ")}.`);
          else if (!validate(spec.params)) {
            fail(
              spec.index,
              `Invalid ${spec.op} parameters: ${(validate.errors ?? [])
                .map(e => `${e.instancePath || "parameters"} ${e.message}`)
                .slice(0, 4)
                .join("; ")}`
            );
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

        // Walk through existing nodes as well: a dependent cannot silently use
        // an old upstream result after that upstream's requested revision failed.
        const apply = async (index: number): Promise<void> => {
          if (outcomes[index]) return;
          const spec = specs[index];
          const seen = new Set<string>();
          const dependencies: string[] = [];
          const collect = (id: string) => {
            if (seen.has(id)) return;
            seen.add(id);
            if (byId.has(id)) dependencies.push(id);
            else for (const up of inputs.get(id) ?? []) collect(up);
          };
          for (const id of inputs.get(spec.id) ?? []) collect(id);
          for (const id of dependencies) {
            const dependency = byId.get(id)!;
            await apply(dependency);
            const outcome = outcomes[dependency]!;
            if (outcome.status === "error" || outcome.status === "blocked") {
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
            if (message.startsWith("[ERROR]")) fail(index, message.slice(8));
            else outcomes[index] = { id: spec.id, op: spec.op, status: existed ? "modified" : "added", message };
          } catch (error: any) {
            fail(index, error?.message ?? String(error));
          }
        };
        for (const spec of specs) await apply(spec.index);
        const landed = outcomes.filter(
          (outcome): outcome is NativeBatchOutcome =>
            !!outcome && (outcome.status === "added" || outcome.status === "modified")
        );
        const used = new Set(
          landed.flatMap(outcome => nativeInputsOf(outcome.op, specs[byId.get(outcome.id)!].params))
        );
        const requested = args.observe ?? landed.filter(outcome => !used.has(outcome.id)).map(outcome => outcome.id);
        const observationErrors: string[] = [];
        const observe = [...new Set(requested)].filter(id => {
          if (state.getOperator(id)) return true;
          observationErrors.push(`Cannot observe '${id}': operator does not exist.`);
          return false;
        });
        return {
          kind: "native-batch",
          operators: outcomes as NativeBatchOutcome[],
          observe,
          observationErrors,
        } satisfies NativeBatchResult;
      },
    }),
  };
}
