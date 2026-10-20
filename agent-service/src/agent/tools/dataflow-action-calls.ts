/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { DataflowActionsResult } from "./dataflow-actions";

/** Preserve provider call order while executing one atomic write phase across calls. */
export async function executeDataflowActionCalls(
  calls: DataflowActionsResult[],
  execute: (result: DataflowActionsResult) => Promise<void>
): Promise<void> {
  const all = calls.flatMap((call, callIndex) =>
    call.actions.map(item => ({ call, callIndex, item, localIndex: item.index }))
  );
  const answers = all.filter(entry => entry.item.action.type === "answer");
  if (
    answers.length > 1 ||
    (answers.length && (answers[0] !== all.at(-1) || answers[0].callIndex !== calls.length - 1))
  ) {
    for (const call of calls) {
      call.status = "error";
      call.error = "Answer must occur once, as the final action across the ordered tool calls. No actions ran.";
      for (const item of call.actions) {
        item.status = "skipped";
        item.output = call.error;
      }
    }
    return;
  }
  let previousFailure: string | undefined;
  for (let start = 0; start < calls.length; ) {
    if (calls[start].status === "error") {
      previousFailure ??= calls[start].error ?? "An earlier tool call was invalid.";
      start++;
      continue;
    }
    let end = start;
    while (end < calls.length && calls[end].status === "pending") end++;
    if (end === start) {
      start++;
      continue;
    }
    const segment = calls.slice(start, end);
    const entries = all.filter(entry => entry.callIndex >= start && entry.callIndex < end);
    if (previousFailure) {
      for (const call of segment) {
        call.status = "error";
        call.error = previousFailure;
        for (const item of call.actions) {
          item.status = "skipped";
          item.output = "Not run because an earlier tool call failed.";
        }
      }
      start = end;
      continue;
    }
    entries.forEach((entry, i) => (entry.item.index = i + 1));
    const combined: DataflowActionsResult = {
      kind: "dataflow-actions",
      protocol: "json",
      status: "pending",
      actions: entries.map(e => e.item),
      operators: [],
      observe: [],
      observationErrors: [],
    };
    try {
      await execute(combined);
      for (const call of segment) {
        call.format = combined.format;
        call.operators = call.actions
          .flatMap(item => (item.output as any)?.operators ?? [])
          .filter(op => ["added", "modified", "deleted", "error", "blocked"].includes(op.status));
        const readIds = call.actions.flatMap(item => (item.action.type === "read" ? item.action.ids : []));
        call.observe = combined.observe.filter(id => readIds.includes(id));
        call.observationErrors = [];
        const failure = call.actions.find(item => item.status === "error" || item.status === "skipped");
        call.status = failure ? "error" : "completed";
        if (failure)
          call.error =
            typeof failure.output === "string"
              ? failure.output
              : ((failure.output as any)?.error ?? combined.error ?? "An earlier action failed.");
        const answer = call.actions.find(item => item.status === "ok" && item.action.type === "answer");
        if (answer) call.answer = combined.answer;
        if (combined.references)
          call.references = combined.references
            .filter(ref => entries.some(entry => entry.call === call && entry.item.index === ref.actionIndex))
            .map(ref => {
              const owner = entries.find(entry => entry.item.index === ref.actionIndex)!;
              return { ...ref, actionIndex: owner.localIndex };
            });
      }
      previousFailure = combined.error;
    } finally {
      entries.forEach(entry => (entry.item.index = entry.localIndex));
    }
    start = end;
  }
}
