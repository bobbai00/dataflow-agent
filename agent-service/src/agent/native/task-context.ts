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
import { formatTaskReceipt, type TaskHistory, type TaskInput } from "./task-history";
import { nativeOperators } from "./catalog";
import { nativeToolName } from "../tools/native-typed-tools";
import { collectNativeEvidence } from "./evidence";

/** One line of declared operation over declared inputs: what a card says
 * once the clipped JSON definition, Python bodies and ancestry text are gone.
 * Full definitions stay available at the selected dependency boundary. */
export function operatorSignature(op: OperatorPredicate): string {
  const view = op.nativeOp;
  if (!view) return op.operatorType;
  const p = (view.properties ?? {}) as Record<string, any>;
  const names = (value: unknown): string =>
    Array.isArray(value)
      ? value
          .map(item =>
            typeof item === "string" ? item : (item?.as ?? item?.col ?? item?.column ?? JSON.stringify(item))
          )
          .join(",")
      : "";
  const inputs = ((view.taskInputs ?? view.inputs ?? []) as TaskInput[]).map(ref =>
    typeof ref === "string" ? ref : `${ref.operator}@task${ref.atTask}`
  );
  let head: string;
  switch (view.type) {
    case "Scan":
      head = `scan(${String(p.files ?? "")
        .split("/")
        .pop()}${p.preview !== undefined ? `, preview=${p.preview}` : ""})`;
      break;
    case "Project":
      head = p.keep ? `project(keep ${names(p.keep)})` : p.drop ? `project(drop ${names(p.drop)})` : "project(rename)";
      break;
    case "Aggregate":
      head = `aggregate(group[${names(p.groupBy)}] ${((p.aggregations ?? []) as any[])
        .map(a => `${a.fn}(${a.col ?? "*"})→${a.as ?? a.fn}`)
        .join(" ")})`;
      break;
    case "Join":
      head = `join(${p.type ?? "inner"}, on ${JSON.stringify(p.on ?? [])})`;
      break;
    case "Sort":
      head = `sort(${((p.by ?? []) as any[]).map(b => `${b.col}${b.desc ? "↓" : "↑"}`).join(",")})`;
      break;
    case "Limit":
      head = `limit(${p.n}${p.offset ? `,offset=${p.offset}` : ""})`;
      break;
    case "Window":
      head = `window(${names(p.columns)} by [${names(p.partitionBy)}])`;
      break;
    case "Split":
      head = `split(${p.column}→${names(p.into)})`;
      break;
    case "UDF":
      head = "udf(opaque)";
      break;
    case "TaskResult":
      head = `retained ${p.operator}@task${p.atTask}`;
      break;
    default: {
      const columns = names(p.columns ?? p.column ?? p.keep);
      head = `${nativeToolName(view.type)}(${columns})`;
    }
  }
  return `${head}${inputs.length ? ` <- ${inputs.join(", ")}` : ""}`.slice(0, 200);
}

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
    // The runtime's account of what the task did to the graph, sealed with the
    // task, so a later turn can see that a request changed nothing, or which
    // results were left invalid, without replaying the task's actions.
    const receipt = input.settings.nativeTaskReceipts ? history?.receipt(number(step.messageId)) : undefined;
    if (receipt)
      messages.push({
        role: "user",
        content: formatTaskReceipt(number(step.messageId), receipt),
        providerOptions: { texera: { taskHistory: true } },
      });
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
  // A card's text must change only when that operator changes. The saved-task
  // range of every operator advances on every task, so keeping it inline made
  // the whole catalog a fresh prefix each request; it is emitted once, after
  // the cards, where it costs only its own length.
  const savedRanges: string[] = [];
  const catalog = state
    .getAllOperators()
    .filter(op => !op.taskSource)
    .map(op => {
      const info = storage.getOperatorResult(head, op.operatorID);
      const saved = history?.available(op.operatorID) ?? [];
      const reuse = input.settings.nativeTaskReuse
        ? taskReuseFacts(op.operatorID, state.getAllOperators(), history)
        : "";
      if (saved.length) savedRanges.push(`${op.operatorID}: ${ranges(saved)}`);
      const schema = info?.resultSchema?.map(f => `${f.name}:${f.type}`).join(",") ?? "unknown";
      const status = info?.error ? "current result unavailable" : (info?.state ?? "not executed");
      // Compact index: the declared operation over its inputs, schema, status
      // and row count. Definitions live at the selected dependency boundary.
      if (input.settings.nativeCompactIndex)
        return `${op.operatorID} = ${operatorSignature(op)}; schema=${schema}; ${status}${info?.totalRowCount !== undefined ? `; rows=${info.totalRowCount}` : ""}`;
      return `${clip(JSON.stringify(definition(op)), 280)}; schema=${schema}; ${status}${input.settings.nativeTaskReuse && info?.totalRowCount !== undefined ? `; rows=${info.totalRowCount}` : ""}${reuse ? `; ancestry=${reuse}` : ""}`;
    });
  const deleted = new Map<string, number[]>();
  for (const task of history?.catalog() ?? [])
    for (const id of task.operators)
      if (!state.getOperator(id)) deleted.set(id, [...(deleted.get(id) ?? []), task.task]);
  for (const [id, tasks] of deleted) {
    catalog.push(`${id}: no current operator`);
    savedRanges.push(`${id}: ${ranges(tasks)}`);
  }
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
  // Data/flow facts for the boundary the task actually selected: row counts,
  // kept and rejected rows, join cardinality, null shares. Measured by the
  // engine, bounded to a few lines per operator, only with the compact index.
  const boundaryFacts = (id: string): string[] => {
    if (!input.settings.nativeCompactIndex) return [];
    const op = state.getOperator(id);
    const info = storage.getOperatorResult(head, id);
    if (!op?.nativeOp || !info || info.error) return [];
    try {
      return collectNativeEvidence({
        op,
        info,
        workflow: state.getWorkflowContent(),
        resolveInput: inputId => storage.getOperatorResult(head, inputId),
      })
        .facts.sort((a, b) => b.priority - a.priority)
        .slice(0, 3)
        .map(fact => `  ${fact.text.slice(0, 200)}`);
    } catch {
      return [];
    }
  };
  const details = [...dependencies].flatMap(id => {
    const op = state.getOperator(id)!;
    const definitionText = op.taskSource
      ? JSON.stringify({ input: op.taskSource, fixed: true })
      : JSON.stringify(definition(op));
    return [definitionText, ...boundaryFacts(id)];
  });
  messages.push({
    role: "user",
    content: `# Current operator catalog\n${catalog.join("\n") || "Empty."}${savedRanges.length ? `\n\n# Saved task outputs, usable as {operator, atTask}\n${savedRanges.join("\n")}` : ""}\n\n# Selected dependency definitions\n${details.join("\n") || "Select existing inputs through normal dataflow edits or observe to retrieve details."}`,
  });
  return [...messages, ...active];
}
