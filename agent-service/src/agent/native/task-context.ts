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
import { taskReuseFacts } from "./task-reuse";
import type { ModelMessage } from "ai";
import type { ContextAssemblerInput } from "../llm-drivers/types";
import type { OperatorPredicate } from "../../types/workflow";
import { asNativeBatchResult } from "../tools/native-batch-tools";
import { formatNativeError } from "../tools/result-formatting";
import type { TaskHistory } from "./task-history";
import { nativeOperators } from "./catalog";
import { nativeToolName } from "../tools/native-typed-tools";

const clip = (value: string, limit: number) =>
  value.length <= limit ? value : value.slice(0, limit) + " …[details available via observe]";
function definition(op: OperatorPredicate) {
  const view = op.nativeOp;
  const inputs = view?.taskInputs ?? view?.inputs ?? [];
  const arity = nativeOperators(view?.version).find(def => def.type === view?.type)?.inputs;
  const references =
    arity === 1
      ? { input: inputs[0] }
      : arity === 2
        ? { left: inputs[0], right: inputs[1] }
        : arity === "many"
          ? { inputs }
          : {};
  return { id: op.operatorID, op: nativeToolName(view?.type ?? op.operatorType), ...references, ...view?.properties };
}
function ranges(numbers: number[]): string {
  const result: string[] = [];
  for (let i = 0; i < numbers.length; i++) {
    const first = numbers[i]!;
    let last = first;
    while (numbers[i + 1] === last + 1) last = numbers[++i]!;
    result.push(first === last ? String(first) : `${first}-${last}`);
  }
  return result.join(",");
}

/** Prior requests remain verbatim; graph state replaces past action replay.
 * Detailed definitions follow explicitly selected dependencies. Successful
 * values come only from the event's existing bounded observe payload. */
export function assembleTaskContext(input: ContextAssemblerInput, history?: TaskHistory): ModelMessage[] {
  const { visibleSteps, workflowState: state, snapshotStorage: storage } = input;
  const tasks = visibleSteps.filter(step => step.role === "user" && step.isBegin);
  const current = tasks.at(-1);
  if (!current) return [];
  const number = (messageId: string) =>
    input.turnNumberByMessageId?.get(messageId) ?? tasks.findIndex(step => step.messageId === messageId) + 1;
  const messages: ModelMessage[] = [];
  for (const step of tasks.slice(0, -1)) {
    const answer = visibleSteps.findLast(s => s.messageId === step.messageId && s.role === "agent" && s.isEnd)?.content;
    messages.push({
      role: "user",
      content: `# Task ${number(step.messageId)}\n${step.content}`,
      providerOptions: { texera: { taskHistory: true } },
    });
    if (answer) messages.push({ role: "assistant", content: answer });
  }
  // Stable completed-task messages can share a cache prefix. Current state
  // precedes the active request/actions so the last message is the actual
  // observation, rather than a new user message restating the graph.
  const active: ModelMessage[] = [{ role: "user", content: `# Task ${number(current.messageId)}\n${current.content}` }];
  const selected = new Set<string>();
  for (const step of visibleSteps.filter(s => s.messageId === current.messageId && s.role === "agent")) {
    if (!step.toolCalls?.length) {
      if (step.content) active.push({ role: "assistant", content: step.content });
      continue;
    }
    active.push({
      role: "assistant",
      content: [
        ...(step.content ? [{ type: "text" as const, text: step.content }] : []),
        ...step.toolCalls.map(call => ({
          type: "tool-call" as const,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
        })),
      ],
    });
    const snapshot = storage.getAssociatedSnapshot(step.id);
    const outputs = step.toolCalls.map(call => {
      const result = step.toolResults?.find(r => r.toolCallId === call.toolCallId);
      const batch = asNativeBatchResult(result?.output);
      let text: string;
      if (batch) {
        for (const id of [...batch.observe, ...batch.operators.map(op => op.id)]) selected.add(id);
        const receipts = batch.operators.map(({ id, status, message }) => ({
          id,
          status,
          ...(status === "error" || status === "blocked" ? { message } : {}),
        }));
        const observed = batch.observe.map(
          id =>
            `${id}:\n${snapshot.nativeObservations?.[id]?.text ?? "No successful result is available for this observation."}`
        );
        const errors = [...snapshot.results]
          .filter(([, entry]) => entry.sourceStepId === step.id && entry.info.error)
          .map(([id, entry]) =>
            formatNativeError(
              id,
              snapshot.workflow.operators.find(op => op.operatorID === id)?.nativeOp?.type ?? "",
              entry.info.error!
            )
          );
        text = [JSON.stringify(receipts), ...batch.observationErrors, ...observed, ...errors].join("\n");
      } else text = typeof result?.output === "string" ? result.output : JSON.stringify(result?.output ?? "No result");
      return {
        type: "tool-result" as const,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "text" as const, value: text },
      };
    });
    active.push({ role: "tool", content: outputs });
  }
  const head = visibleSteps.at(-1)?.id;
  const catalog = state
    .getAllOperators()
    .filter(op => !op.taskSource)
    .map(op => {
      const info = storage.getOperatorResult(head, op.operatorID);
      const saved = history?.available(op.operatorID) ?? [];
      const reuse = input.settings.nativeTaskReuse
        ? taskReuseFacts(op.operatorID, state.getAllOperators(), history)
        : "";
      return `${clip(JSON.stringify(definition(op)), 280)}; schema=${info?.resultSchema?.map(f => `${f.name}:${f.type}`).join(",") ?? "unknown"}; ${info?.error ? "current result unavailable" : (info?.state ?? "not executed")}${saved.length ? `; saved tasks=${ranges(saved)}` : ""}${input.settings.nativeTaskReuse && info?.totalRowCount !== undefined ? `; rows=${info.totalRowCount}` : ""}${reuse ? `; ancestry=${reuse}` : ""}`;
    });
  const deleted = new Map<string, number[]>();
  for (const task of history?.catalog() ?? [])
    for (const id of task.operators)
      if (!state.getOperator(id)) deleted.set(id, [...(deleted.get(id) ?? []), task.task]);
  for (const [id, tasks] of deleted) catalog.push(`${id}: no current operator; saved tasks=${ranges(tasks)}`);
  // Follow graph edges; retained sources terminate traversal. Never substitute
  // today's producer definition for a selected historical materialization.
  const dependencies = new Set<string>();
  const visit = (id: string) => {
    if (dependencies.has(id)) return;
    const op = state.getOperator(id);
    if (!op) return;
    dependencies.add(id);
    if (op.taskSource) return;
    for (const link of state.getAllLinks()) if (link.target.operatorID === id) visit(link.source.operatorID);
  };
  for (const id of selected) visit(id);
  const details = [...dependencies].map(id => {
    const op = state.getOperator(id)!;
    return op.taskSource ? JSON.stringify({ input: op.taskSource, fixed: true }) : JSON.stringify(definition(op));
  });
  messages.push({
    role: "user",
    content: `# Current operator catalog\n${catalog.join("\n") || "Empty."}\n\n# Selected dependency definitions\n${details.join("\n") || "Select existing inputs through normal dataflow edits or observe to retrieve details."}`,
  });
  return [...messages, ...active];
}
