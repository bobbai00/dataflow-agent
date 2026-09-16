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
import type { OperatorPredicate } from "../../types/workflow";
import type { TaskHistory, TaskInput } from "./task-history";

/** Facts about declared ancestry, not inferred Python semantics. Historical
 * traversal resolves every ancestor at its recorded task and fails closed.
 * This is context only: it neither rejects a valid subset nor proves scope. */
export function taskReuseFacts(
  id: string,
  operators: readonly OperatorPredicate[],
  history?: Pick<TaskHistory, "resolve">
): string {
  const nodes = new Map(operators.map(op => [op.operatorID, op]));
  const queue: Array<{ id: string; task?: number }> = [{ id }];
  const seen = new Set<string>();
  const facts: string[] = [];
  let omitted = false;
  const compact = (value: unknown) => JSON.stringify(value ?? []).slice(0, 55);
  while (queue.length && seen.size < 64) {
    const current = queue.shift()!;
    const label = current.id + (current.task ? `@task${current.task}` : "");
    if (seen.has(label)) continue;
    seen.add(label);
    let op: OperatorPredicate | undefined;
    if (current.task) {
      try {
        op = history?.resolve({ operator: current.id, atTask: current.task }).operator;
      } catch {
        /* No fallback to a live definition. */
      }
    } else op = nodes.get(current.id);
    if (op?.taskSource) {
      queue.push({ id: op.taskSource.operator, task: op.taskSource.atTask });
      continue;
    }
    const view = op?.nativeOp;
    let fact = "";
    if (!view) fact = "definition unavailable";
    else
      switch (view.type) {
        case "Limit":
          fact = `limit(${view.properties.n}${view.properties.offset ? `,offset=${view.properties.offset}` : ""})`;
          break;
        case "Filter":
          fact = `filter(${((view.properties.columns as string[]) ?? []).join(",")})`;
          break;
        case "Aggregate":
          fact = `group(${compact(view.properties.groupBy)})`;
          break;
        case "Distinct":
          fact = `distinct(${compact(view.properties.columns)})`;
          break;
        case "Join":
          fact = `join(${view.properties.type ?? "inner"},${compact(view.properties.on)})`;
          break;
        case "Scan":
          if (view.properties.preview !== undefined) fact = `preview(${view.properties.preview})`;
          break;
        case "UDF":
          fact = "udf(opaque)";
          break;
      }
    if (fact) {
      const text = `${label}:${fact}`;
      if (facts.length >= 4 || [...facts, text].join(" | ").length > 250) {
        omitted = true;
        break;
      }
      facts.push(text);
    }
    for (const reference of (view?.taskInputs ?? view?.inputs ?? []) as TaskInput[]) {
      queue.push(
        typeof reference === "string"
          ? { id: reference, task: current.task }
          : { id: reference.operator, task: reference.atTask }
      );
    }
  }
  if (queue.length) omitted = true;
  return facts.join(" | ") + (omitted ? " | more; observe for details" : "");
}
