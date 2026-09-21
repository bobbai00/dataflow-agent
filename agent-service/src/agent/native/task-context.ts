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
import type { TaskHistory, TaskInput } from "./task-history";
import { nativeToolName } from "../tools/native-typed-tools";

/** A compact description, not executable code or a claim of semantic validity. */
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
    case "UDF": {
      // The body stays opaque; the entry line is the contract a later edit has
      // to match (its name and arity), in the author's own parameter names.
      const entry = /^def (process|load)\(([^)]*)\)/m.exec(String(p.code ?? ""));
      head = entry ? `udf(def ${entry[1]}(${entry[2].replace(/\s+/g, " ").trim()}))` : "udf(opaque)";
      break;
    }
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
  const catalog = input.workflowState
    .getAllOperators()
    .filter(op => !op.taskSource)
    .map(op => {
      const info = input.snapshotStorage.getOperatorResult(head, op.operatorID);
      const schema = info?.resultSchema?.map(f => `${f.name}:${f.type}`).join(",") ?? "unknown";
      const status = info?.error ? "current result unavailable" : (info?.state ?? "not executed");
      return `${op.operatorID} = ${operatorSignature(op)}; schema=${schema}; ${status}${info?.totalRowCount !== undefined ? `; rows=${info.totalRowCount}` : ""}`;
    });
  const saved = new Map<string, number[]>();
  for (const task of history?.catalog() ?? [])
    for (const id of task.operators) saved.set(id, [...(saved.get(id) ?? []), task.task]);
  const availability = [...saved].map(([id, tasks]) => `${id}: ${ranges(tasks)}`).join("\n");
  messages.push({
    role: "user",
    content: `# Current operator catalog\n${catalog.join("\n") || "Empty."}${availability ? `\n\n# Saved task outputs, usable as {operator, atTask}\n${availability}` : ""}`,
  });
  return messages;
}

/** Compose catalog memory with the configured synchronous or async assembler.
 * There is one driver, one prompt, one execution path and one observation
 * renderer. Switching context changes only what completed work is replayed. */
export function withTaskCatalog(assemble: ContextAssembler, history?: TaskHistory): ContextAssembler {
  return input => {
    if (!input.settings.nativeTaskContext) return assemble(input);
    const current = input.visibleSteps.findLast(step => step.role === "user" && step.isBegin);
    if (!current) return assemble(input);
    const memory = taskCatalogMemory(input, input.settings.nativeTaskHistory ? history : undefined);
    const active = assemble({
      ...input,
      visibleSteps: input.visibleSteps.filter(step => step.messageId === current.messageId),
      offBranchTurns: [],
    });
    return active instanceof Promise ? active.then(messages => [...memory, ...messages]) : [...memory, ...active];
  };
}
