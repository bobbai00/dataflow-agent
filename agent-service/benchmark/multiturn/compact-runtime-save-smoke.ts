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

/** Recompile an exported graph's generated runtime, save it as a separate,
 * unexecuted temporary workflow, verify an exact round trip, and remove it.
 * Never changes the source file or original workflow. No model calls.
 * Usage: bun run benchmark/multiturn/compact-runtime-save-smoke.ts workflow.json
 * Use the ordinary backend environment settings for the intended test stack. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { compileNativeOp } from "../../src/agent/native/codegen";
import { NATIVE_BY_TYPE } from "../../src/agent/native/catalog";
import { WorkflowState } from "../../src/agent/workflow-state";
import { login, createWorkflow, persistWorkflow, retrieveWorkflow, deleteWorkflow } from "../../src/api";

const path = process.argv[2];
if (!path) throw new Error("Pass an exported workflow.json to test.");
const original = await Bun.file(path).text();
const graph = JSON.parse(original);
assert.ok(Array.isArray(graph.operators));
const before = JSON.stringify(graph).length;
let recompiled = 0;
for (const op of graph.operators) {
  if (!op.nativeOp || !NATIVE_BY_TYPE.has(op.nativeOp.type)) continue;
  op.operatorProperties.code = compileNativeOp(op.nativeOp, op.operatorID).code;
  recompiled++;
}
assert.ok(recompiled > 0, "The graph must contain native operators.");
const content = JSON.stringify(graph);
const token = await login(process.env.TEXERA_USERNAME ?? "texera", process.env.TEXERA_PASSWORD ?? "texera");
const name = `compact-runtime-save-smoke-${Date.now()}`;
const id = await createWorkflow(token, name, new WorkflowState().getWorkflowContent());
try {
  await persistWorkflow(token, id, name, graph);
  const saved = await retrieveWorkflow(token, id);
  assert.equal(JSON.stringify(saved.content), content);
  console.log(
    JSON.stringify({
      source_sha256: createHash("sha256").update(original).digest("hex"),
      original_content_chars: before,
      compact_content_chars: content.length,
      operators: graph.operators.length,
      recompiled,
      round_trip: true,
      executed: false,
    })
  );
} finally {
  await deleteWorkflow(token, id);
}
