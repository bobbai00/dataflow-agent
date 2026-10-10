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

import { strict as assert } from "node:assert";
import type { RetrievalView } from "../../src/types/agent";
import type { DataflowActionsResult } from "../../src/agent/tools/dataflow-actions";
import { prepareDataflowCall } from "../../src/agent/tools/turn-tool";

/** The debug endpoint takes a Python repr, not JSON. Encode the tree, never
 * replace token words inside submitted callbacks or user string literals. */
export function nativeDebugInput(tool: string, args: Record<string, unknown>): string {
  function python(value: unknown): string {
    if (value === null) return "None";
    if (typeof value === "boolean") return value ? "True" : "False";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (Array.isArray(value)) return `[${value.map(python).join(",")}]`;
    if (typeof value === "object" && value !== null)
      return `{${Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([key, v]) => `${JSON.stringify(key)}:${python(v)}`)
        .join(",")}}`;
    throw new TypeError("Debug arguments must be JSON-compatible values");
  }
  return `Function(name=${JSON.stringify(tool)}, arguments=${JSON.stringify(python(args))})`;
}

/** A `dataflow(python, statements)` call as debug input. The call is parsed
 * here first, so a malformed probe fails before it reaches the service. */
export function dataflowDebugInput(python: string, statements: string, views?: readonly RetrievalView[]): string {
  const prepared = prepareDataflowCall({ python, statements }, views);
  assert.equal(prepared.status, "pending", `The probe's dataflow call does not parse: ${prepared.error}`);
  return nativeDebugInput("dataflow", { python, statements });
}

/** The action list a call becomes (an edit first, `show result` as execute
 * then retrieve), for the statuses a probe expects. */
export function dataflowActionTypes(python: string, statements: string, views?: readonly RetrievalView[]): string[] {
  return prepareDataflowCall({ python, statements }, views).actions.map(item => item.action.type);
}

/** What `show result` returned for one operator, from the call's last retrieve that read it. */
export function shownResult(result: DataflowActionsResult, operatorId: string): any {
  const entry = result.actions
    .filter(item => item.action.type === "retrieve")
    .flatMap(item => ((item.output as any)?.results ?? []) as any[])
    .filter(item => item.operator_id === operatorId)
    .at(-1);
  assert.ok(entry, `No shown result for ${operatorId}`);
  return entry;
}
