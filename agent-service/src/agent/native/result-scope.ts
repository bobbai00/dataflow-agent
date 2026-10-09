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

import type { OperatorInfo } from "../../types/execution";
import type { OperatorPredicate, WorkflowContent } from "../../types/workflow";

/** Facts from one observation's graph and results. These describe input
 * ancestry, not whether a selection satisfies the user's analytical request.
 * No data records, model summaries, ledger, or profiling switch are needed. */
export function resultScope(
  op: OperatorPredicate,
  workflow: WorkflowContent,
  resolve: (id: string) => OperatorInfo | undefined,
  displayName: (id: string) => string = id => id,
  includeUpstream = true
): string[] {
  const byId = new Map(workflow.operators.map(item => [item.operatorID, item]));
  const name = (id: string) => {
    const label = displayName(id);
    return JSON.stringify(label.length > 80 ? label.slice(0, 80) + "…" : label);
  };
  const completed = (id: string) => {
    const info = resolve(id);
    if (!info || info.error || !["Completed", "CompletedFromCache"].includes(info.state)) return undefined;
    const revision = byId.get(id)?.nativeOp?.revision;
    if (info.resultVersion?.operatorRevision && revision && info.resultVersion.operatorRevision !== revision)
      return undefined;
    return info;
  };
  const rows = (info: OperatorInfo | undefined) => {
    const count = info?.totalRowCount ?? info?.outputTuples;
    return count !== undefined && Number.isSafeInteger(count) && count >= 0
      ? `${count.toLocaleString("en-US")} ${count === 1 ? "row" : "rows"}`
      : "unknown rows";
  };
  const inputShape = (item: OperatorPredicate, input: string) => {
    let info = completed(input);
    const child = completed(item.operatorID)?.resultVersion;
    if (child) {
      const binding = child.inputs?.find(part => part.operatorId === input);
      if (!binding?.resultVersion || binding.resultVersion !== info?.resultVersion?.id) info = undefined;
    }
    return `${name(input)} (${rows(info)})`;
  };
  const pending = [op.operatorID];
  const seen = new Set<string>();
  const lines: string[] = [];
  const omission = "Further input ancestry omitted; inspect upstream definitions.";
  let chars = 0;
  while (pending.length && seen.size < 32 && lines.length < 3) {
    const id = pending.shift()!;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const item = byId.get(id);
    const view = item?.nativeOp;
    if (!item || !view) continue;
    const inputs = view.inputs.filter(Boolean);
    let line: string | undefined;
    if (view.type === "Process") {
      line = `${view.registeredName ?? "process"} ${name(id)}: row selection inside Python is unknown; inspect its definition.`;
      // The result need not be a subset of its inputs. Do not infer its
      // population from upstream filters or limits, even if counts match.
    } else {
      if (["Filter", "Limit", "Distinct"].includes(view.type)) {
        const parameters =
          view.type === "Limit" ? `n=${view.properties.n}, offset=${view.properties.offset ?? 0}; ` : "";
        line = `${view.type.toLowerCase()} ${name(id)}: ${parameters}input ${inputs[0] ? inputShape(item, inputs[0]) : "unconnected"}; output ${rows(completed(id))}.`;
      } else if (view.type === "Scan" && view.properties.preview !== undefined) {
        line = `preview ${name(id)}: ${view.properties.preview}-row budget per file/sheet/table; headers or metadata may add rows; not a full scan.`;
      }
      if (includeUpstream) pending.push(...inputs);
    }
    if (line) {
      const allowance = 600 - omission.length - chars - lines.length;
      if (line.length > allowance) {
        lines.push(line.slice(0, Math.max(0, allowance - 22)) + "… (clipped; inspect)");
        if (pending.some(input => !seen.has(input))) lines.push(omission);
        return lines;
      }
      lines.push(line);
      chars += line.length;
    }
  }
  if (pending.some(id => !seen.has(id))) lines.push(omission);
  return lines;
}
