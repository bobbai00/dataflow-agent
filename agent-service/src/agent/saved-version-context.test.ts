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

import { expect, test } from "bun:test";
import { buildNativeModeSystemPrompt } from "./prompts";
import { renderTaskBoundary, renderTaskMessages, type TaskRecord } from "./task-history";
import { renderActionObservations } from "./native/action-observations";
test("saved-version prompts teach read, exact results and an editable separate branch", () => {
  const prompt = buildNativeModeSystemPrompt(undefined, {stateHistory:true,multiTask:true});
  expect(prompt).toContain("view=null");
  expect(prompt).toContain("copy = scores@2");
  expect(prompt).toContain("HISTORICAL_RESULT_UNAVAILABLE");
  expect(prompt).not.toMatch(/fork operator|target.*[\"'](?:state|task)[\"']|type.*[\"']retrieve[\"']/);
  expect(prompt).toContain("unique");
});
test("an answer receipt and the next catalog use the same immutable task boundary", () => {
  const task = {task_id:2,request:"Use the full score table",answer:'{"answer":1}',status:"answered",
    operators:[],dependencies:[],consulted_tasks:[],unresolved_references:0,
    operator_changes:[{id:"scores",kind:"process",state:"updated",definition:"process(fn=score, doc=\"All entities scored\")"}],
    output_roots:{basis:"answer",roots:[{operator_id:"scores",task_id:2,step_id:"s2"}]},
    answer_from:"scores top 5 by score desc, entity asc"} as TaskRecord;
  const boundary = renderTaskBoundary(task);
  const messages = renderTaskMessages([task],new Map([[2,[{role:"user",content:task.request}]]]));
  expect(messages.at(-1)?.content).toBe(boundary);
  expect(boundary).toContain("Selection: scores top 5 by score desc, entity asc");
  // A root of the task itself is named plainly; scores@2 reads it later.
  expect(boundary).toContain("Answer sources: `scores`");
  const receipt = {kind:"dataflow-actions",status:"completed",saved_versions:true,answer:task.answer,task_catalog:task,
    operators:[],observe:[],observationErrors:[],actions:[{index:1,action:{type:"answer",content:task.answer,operator_ids:["scores"]},status:"ok",output:{text:"answer"}}]} as any;
  const quoted = renderActionObservations(receipt).split("\n").filter(line=>line.startsWith("> ")).map(line=>line.slice(2)).join("\n");
  expect(quoted).toBe(boundary);
});
