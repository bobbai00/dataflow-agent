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
import type { ModelMessage } from "ai";
import type { ContextAssembler, ContextAssemblerInput } from "../llm-drivers/types";
import type { OperatorPredicate } from "../../types/workflow";
import type { TaskHistory } from "./task-history";
import { writtenInputs } from "./task-reference";

/** The operator as the model wrote it, on one line: its own program statement
 * (`name = op(...)`), which the model already reads fluently and which changes
 * only when the operator is redefined. A catalog line built from it is stable
 * across calls, which is what lets a prompt cache reuse it. */
export function operatorSignature(op: OperatorPredicate): string {
  const view = op.nativeOp;
  if (!view) return `${op.operatorID} = ${op.operatorType}`;
  // Without a written statement, name inputs as the model would write them.
  const statement = (view.source ?? `${op.operatorID} = ${view.type}(${writtenInputs(view).join(", ")})`)
    .replace(/\s+/g, " ")
    .trim();
  return statement.length <= 240 ? statement : statement.slice(0, 237) + "...";
}

function ranges(numbers: number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const result: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const first = sorted[i]!;
    let last = first;
    while (sorted[i + 1] === last + 1) last = sorted[++i]!;
    result.push(first === last ? String(first) : `${first}-${last}`);
  }
  return result.join(",");
}

/** Completed questions and answers preserve inherited requirements. The
 * catalog replaces completed action traces, not the active task's ReAct.
 * Complete definitions and observed evidence use the shared context assembler. */
export function taskCatalogMemory(input: ContextAssemblerInput, history?: TaskHistory): ModelMessage[] {
  const parts = taskCatalogParts(input, history);
  return [...parts.completed, parts.catalog];
}

/** The completed question/answer pairs and the operator catalog, kept apart
 * because they cache differently: the pairs are append-only and belong in the
 * prefix, the catalog is rewritten whenever the graph changes and belongs last. */
export function taskCatalogParts(
  input: ContextAssemblerInput,
  history?: TaskHistory
): { completed: ModelMessage[]; catalog: ModelMessage } {
  const tasks = input.visibleSteps.filter(step => step.role === "user" && step.isBegin);
  const number = (messageId: string) =>
    input.turnNumberByMessageId?.get(messageId) ?? tasks.findIndex(step => step.messageId === messageId) + 1;
  const messages: ModelMessage[] = [];
  for (const task of tasks.slice(0, -1)) {
    messages.push({ role: "user", content: `# Task ${number(task.messageId)}\n${task.content}` });
    const answer = input.visibleSteps.findLast(s => s.messageId === task.messageId && s.role === "agent" && s.isEnd);
    if (answer?.content) messages.push({ role: "assistant", content: answer.content });
  }
  const head = input.visibleSteps.at(-1)?.id;
  const provenance = history?.provenance() ?? new Map();
  const catalog = input.workflowState
    .getAllOperators()
    .filter(op => !op.taskSource)
    .map(op => {
      const info = input.snapshotStorage.getOperatorResult(head, op.operatorID);
      const schema = info?.resultSchema?.map(f => `${f.name}:${f.type}`).join(",") ?? "unknown";
      const status = info?.error ? "current result unavailable" : (info?.state ?? "not executed");
      const event = provenance.get(op.operatorID);
      const saved = event
        ? `; created@${event.created}${event.edited.length ? ` edited@${event.edited.join(",")}` : ""}${
            event.gaps.length ? ` not saved@${event.gaps.join(",")}` : ""
          }`
        : "";
      return `${operatorSignature(op)}; schema=${schema}; ${status}${info?.totalRowCount !== undefined ? `; rows=${info.totalRowCount}` : ""}${saved}`;
    });
  // An operator that has left the graph keeps its retained outputs, so it stays
  // referenceable by task. Its line is final once it is gone.
  for (const [id, event] of provenance) {
    if (input.workflowState.getOperator(id)) continue;
    catalog.push(
      `${id} = no longer in the graph; created@${event.created}${
        event.edited.length ? ` edited@${event.edited.join(",")}` : ""
      }${event.gaps.length ? ` not saved@${event.gaps.join(",")}` : ""}; last saved@${event.lastSaved}`
    );
  }
  return {
    completed: messages,
    catalog: { role: "user", content: `# Current operator catalog\n${catalog.join("\n") || "Empty."}` },
  };
}

/** Compose catalog memory with the configured synchronous or async assembler.
 * There is one driver, one prompt, one execution path and one observation
 * renderer. Switching context changes only what completed work is replayed. */
export function withTaskCatalog(assemble: ContextAssembler, history?: TaskHistory): ContextAssembler {
  return input => {
    if (!input.settings.nativeTaskContext) return assemble(input);
    const current = input.visibleSteps.findLast(step => step.role === "user" && step.isBegin);
    if (!current) return assemble(input);
    const parts = taskCatalogParts(input, input.settings.nativeTaskHistory ? history : undefined);
    const active = assemble({
      ...input,
      visibleSteps: input.visibleSteps.filter(step => step.messageId === current.messageId),
      offBranchTurns: [],
    });
    // Everything append-only first, the rewritten catalog last: a prompt cache
    // matches a prefix, so a block that changes each call must not sit in front
    // of the tool results, which do not change once returned.
    const order = (messages: ModelMessage[]) => [...parts.completed, ...messages, parts.catalog];
    return active instanceof Promise ? active.then(order) : order(active);
  };
}
