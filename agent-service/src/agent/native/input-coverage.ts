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
import type { OperatorLink, OperatorPredicate } from "../../types/workflow";
import type { TaskHistory } from "./task-history";

export interface PreviewOrigin {
  operator: string;
  atTask?: number;
}

/** A discovery probe stays a probe through transformations and retention.
 * This tracks known Scan.preview ancestors, not arbitrary Python file reads
 * or whether the model chose the user's intended logical population. */
export function previewDependencies(
  id: string,
  operators: readonly OperatorPredicate[],
  history?: Pick<TaskHistory, "resolve">,
  links: readonly OperatorLink[] = []
): PreviewOrigin[] {
  const nodes = new Map(operators.map(op => [op.operatorID, op]));
  const seen = new Set<string>();
  const origins = new Map<string, PreviewOrigin>();
  const add = (origin: PreviewOrigin) => origins.set(JSON.stringify(origin), origin);
  const visit = (current: string) => {
    if (seen.has(current)) return;
    seen.add(current);
    const op = nodes.get(current);
    if (!op) throw new Error(`Cannot verify input coverage: missing operator ${current}`);
    if (op.taskSource) {
      if (!history) throw new Error("Cannot verify retained input coverage without its task history");
      for (const origin of history.resolve(op.taskSource).previewSources) add(origin);
      return;
    }
    if (op.nativeOp?.type === "Scan" && op.nativeOp.properties.preview !== undefined) add({ operator: current });
    for (const input of op.nativeOp?.inputs ?? []) visit(input);
    for (const link of links) if (link.target.operatorID === current) visit(link.source.operatorID);
  };
  visit(id);
  return [...origins.values()];
}

export function assertFullDataReturn(
  id: string,
  operators: readonly OperatorPredicate[],
  history?: Pick<TaskHistory, "resolve">,
  links: readonly OperatorLink[] = []
): void {
  const sources = previewDependencies(id, operators, history, links);
  if (sources.length)
    throw new Error(
      `Cannot return ${id}: its dependencies include raw discovery previews: ${sources.map(source => source.operator + (source.atTask ? ` at task ${source.atTask}` : "")).join(", ")}. ` +
        "A complete aggregate row does not mean the input file was fully read. Remove Scan.preview to read the complete parsed file, then recompute the relevant calculation. For historical inputs, select a full-data task output or recompute from a complete source. Discovery previews remain available through observe."
    );
}
