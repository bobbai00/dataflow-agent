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

// Output uses plain markdown rather than XML-like tags to reduce format
// mimicry, where the model echoes the context shape into its output instead
// of calling tools via the native protocol.

import type { ModelMessage } from "ai";
import type { WorkflowState } from "../workflow-state";
import type { OperatorPredicate, OperatorPortSchemaMap, PortSchema } from "../../types/workflow";
import type { ReActStep } from "../../types/agent";
import { AgentMode } from "../../types/agent";
import type { WorkflowCompilationResponse, WorkflowFatalError } from "../../api/compile-api";
import { extractOperatorInputPortSchemaMap } from "./workflow-utils";
import { createLogger } from "../../logger";

const log = createLogger("ContextAssembler");

export function assembleContext(
  visibleSteps: ReActStep[],
  workflowState: WorkflowState,
  operatorExecutionResults: Map<string, string>,
  useRedact: boolean = false,
  compilationResult?: WorkflowCompilationResponse | null,
  agentMode: AgentMode = AgentMode.CODE
): ModelMessage[] {
  const messageIds: string[] = [];
  const stepsByMessage = new Map<string, ReActStep[]>();
  for (const step of visibleSteps) {
    let group = stepsByMessage.get(step.messageId);
    if (!group) {
      group = [];
      stepsByMessage.set(step.messageId, group);
      messageIds.push(step.messageId);
    }
    group.push(step);
  }

  const sections: string[] = [];
  let completedCount = 0;
  let hasOngoing = false;

  for (const msgId of messageIds) {
    const steps = stepsByMessage.get(msgId)!;
    // A task is completed only when an *agent* step has isEnd=true; user steps
    // always have isEnd=true because they are single-step messages.
    const isCompleted = steps.some(s => s.role === "agent" && s.isEnd);

    if (isCompleted) {
      if (completedCount === 0) {
        sections.push("# Completed Tasks");
      }
      sections.push("");
      sections.push(serializeTask(steps, "completed"));
      completedCount++;
    } else {
      hasOngoing = true;
      sections.push("");
      sections.push("# Ongoing Task");
      sections.push(serializeTask(steps, "ongoing"));
      sections.push("");
      sections.push(
        "Above is user's request and the steps you already took. You as an assistant please keep working on solving user's request based on the progress of current workflow."
      );
    }
  }

  const dagSection = serializeDag(
    workflowState,
    operatorExecutionResults,
    useRedact,
    compilationResult,
    agentMode
  );
  if (dagSection) {
    sections.push("");
    sections.push("# Current Dataflow");
    sections.push(dagSection);
  }

  const content = sections.join("\n");

  log.debug(
    {
      completed: completedCount,
      ongoing: hasOngoing ? 1 : 0,
      operatorResults: operatorExecutionResults.size,
      useRedact,
    },
    "built context"
  );

  return [{ role: "user", content }];
}

function serializeTask(steps: ReActStep[], status: "completed" | "ongoing"): string {
  const lines: string[] = [];
  lines.push(`## Task (${status})`);
  lines.push("");

  const userStep = steps.find(s => s.role === "user");
  const assistantSteps = steps.filter(s => s.role === "agent");

  if (userStep) {
    lines.push("### User request");
    lines.push("");
    lines.push(userStep.content);
    lines.push("");
  }

  for (const step of assistantSteps) {
    lines.push(`### Turn ${step.stepId}`);
    if (step.content) {
      lines.push(`Thought: ${step.content}`);
    }
    if (step.toolCalls && step.toolCalls.length > 0) {
      for (let i = 0; i < step.toolCalls.length; i++) {
        const tc = step.toolCalls[i];
        const tr = step.toolResults?.[i];
        const outputStr = formatToolOutputString(tr?.output);
        // A tool returning `[ERROR] ...` is a failure regardless of the SDK's
        // structured-error flag. Pure string-based tool returns are how all
        // workflow tools in this repo report errors.
        const isFailure = !!tr?.isError || outputStr.startsWith("[ERROR]");
        const statusAttr = isFailure ? "failed" : "succeeded";
        const opIdParam = formatOperatorIdParam(tc.input);
        lines.push(`- ${tc.toolName}${opIdParam} (${statusAttr})`);
        if (isFailure && outputStr) {
          // Errors are always surfaced — strip the `[ERROR] ` prefix because the
          // `(failed)` status already carries that signal, then indent.
          const errorBody = outputStr.replace(/^\[ERROR\]\s*/, "");
          lines.push("  Error:");
          for (const errLine of errorBody.split("\n")) {
            lines.push(`    ${errLine}`);
          }
        }
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/**
 * Render the `operatorId=...` argument for a tool-call line in a turn. Other
 * arguments (code, properties, summary) are intentionally omitted: they are
 * either too long to fit inline or already discoverable from the live DAG, so
 * including them only inflates the prompt. Returns `""` if no operatorId.
 */
function formatOperatorIdParam(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const opId = (input as Record<string, unknown>).operatorId;
  if (typeof opId !== "string" || opId.length === 0) return "";
  return `(operatorId="${opId}")`;
}

/** Coerce a tool result `output` into a string for substring checks/printing. */
function formatToolOutputString(output: unknown): string {
  if (typeof output === "string") return output;
  if (output == null) return "";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function serializeDag(
  workflowState: WorkflowState,
  operatorExecutionResults: Map<string, string>,
  useRedact: boolean,
  compilationResult?: WorkflowCompilationResponse | null,
  agentMode: AgentMode = AgentMode.CODE
): string | null {
  const allOperators = workflowState.getAllOperators();
  if (allOperators.length === 0) return null;

  const lines: string[] = [];

  const allLinks = workflowState.getAllLinks();
  const opIds = new Set(allOperators.map(op => op.operatorID));
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const id of opIds) {
    inDegree.set(id, 0);
    children.set(id, []);
  }
  for (const link of allLinks) {
    children.get(link.source.operatorID)?.push(link.target.operatorID);
    inDegree.set(link.target.operatorID, (inDegree.get(link.target.operatorID) ?? 0) + 1);
  }
  const queue: string[] = [...opIds].filter(id => (inDegree.get(id) ?? 0) === 0);
  const topoOrder = new Map<string, number>();
  let rank = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    topoOrder.set(node, rank++);
    for (const child of children.get(node) ?? []) {
      const newDeg = (inDegree.get(child) ?? 1) - 1;
      inDegree.set(child, newDeg);
      if (newDeg === 0) queue.push(child);
    }
  }

  const sortedOps = [...allOperators].sort(
    (a, b) => (topoOrder.get(a.operatorID) ?? 0) - (topoOrder.get(b.operatorID) ?? 0)
  );

  const outputSchemas = compilationResult?.operatorOutputSchemas ?? {};
  const compilationErrors = compilationResult?.operatorErrors ?? {};

  lines.push("## Operators");
  lines.push("");

  // CODE mode operators are Python load()/process() blocks — their input/output
  // schema is implied by the function signature and pandas inference, and the
  // compiler frequently reports them as empty. Surfacing `Input Schema: []` in
  // every operator block adds noise without information, so suppress in CODE
  // mode. GENERAL mode keeps schemas because the agent picks typed operators
  // and uses the schema to validate connections.
  const showSchemas = agentMode === AgentMode.GENERAL;

  for (const op of sortedOps) {
    const inputSchemaMap = showSchemas
      ? extractOperatorInputPortSchemaMap(op.operatorID, op, outputSchemas, allLinks)
      : undefined;
    const outputSchemaMap = showSchemas ? outputSchemas[op.operatorID] : undefined;
    const compilationError = compilationErrors[op.operatorID];
    lines.push(
      serializeOperator(
        op,
        operatorExecutionResults.get(op.operatorID),
        useRedact,
        inputSchemaMap,
        outputSchemaMap,
        compilationError
      )
    );
    lines.push("");
  }

  if (allLinks.length > 0) {
    const sortedLinks = [...allLinks].sort((a, b) => {
      const srcA = topoOrder.get(a.source.operatorID) ?? 0;
      const srcB = topoOrder.get(b.source.operatorID) ?? 0;
      if (srcA !== srcB) return srcA - srcB;
      return (topoOrder.get(a.target.operatorID) ?? 0) - (topoOrder.get(b.target.operatorID) ?? 0);
    });

    lines.push("## Links");
    for (const link of sortedLinks) {
      lines.push(`- ${link.source.operatorID} → ${link.target.operatorID}`);
    }
  }

  return lines.join("\n").trimEnd();
}

function serializeOperator(
  op: OperatorPredicate,
  execResult: string | undefined,
  useRedact: boolean,
  inputSchemaMap?: OperatorPortSchemaMap,
  outputSchemaMap?: OperatorPortSchemaMap,
  compilationError?: WorkflowFatalError
): string {
  const hasError = execResult !== undefined && execResult.includes("[ERROR]");
  const status = execResult ? (hasError ? "failed" : "executed") : "not-executed";

  const summary = op.customDisplayName || op.operatorID;
  const showProperties = !useRedact || hasError;

  const lines: string[] = [];
  lines.push(`### Operator \`${op.operatorID}\` (${op.operatorType}, ${status})`);
  lines.push(`Summary: ${summary}`);

  if (inputSchemaMap) {
    for (const [portId, schema] of Object.entries(inputSchemaMap)) {
      if (schema) {
        lines.push(`Input Schema (port ${parsePortIndex(portId)}): ${formatSchema(schema)}`);
      }
    }
  }

  if (showProperties) {
    const props = op.operatorProperties;
    if (props && Object.keys(props).length > 0) {
      lines.push("Properties:");
      for (const [key, value] of Object.entries(props)) {
        if (value !== undefined && value !== null && value !== "") {
          const valueStr = typeof value === "string" ? value : JSON.stringify(value);
          lines.push(`  ${key}: ${valueStr}`);
        }
      }
    }
  }

  if (outputSchemaMap) {
    const firstSchema = Object.values(outputSchemaMap).find(s => s !== undefined);
    if (firstSchema) {
      lines.push(`Output Schema: ${formatSchema(firstSchema)}`);
    }
  }

  if (compilationError) {
    lines.push(`Compilation Error: ${compilationError.message}`);
  }

  if (execResult) {
    lines.push("Result:");
    const indented = execResult
      .split("\n")
      .map(l => "  " + l)
      .join("\n");
    lines.push(indented);
  }

  return lines.join("\n");
}

function formatSchema(schema: PortSchema): string {
  const attrs = schema.map(a => `${a.attributeName}: ${a.attributeType}`);
  return `[${attrs.join(", ")}]`;
}

function parsePortIndex(portId: string): string {
  const idx = portId.indexOf("_");
  return idx >= 0 ? portId.substring(0, idx) : portId;
}
