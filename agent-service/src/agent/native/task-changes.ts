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
import type { SnapshotData } from "../workflow-snapshot-storage";
import { renderTable, tableCell, topologicalOperators } from "./observation-format";
import { operatorRow } from "./session-state";

/**
 * What one task changed in the dataflow, for its catalog card: the source of
 * every definition it registered or changed, and the operators it created,
 * changed or deleted, with results and columns as the task left them. Both
 * ends are saved snapshots, so a finished task's text never changes.
 */
export function renderTaskChanges(
  start: SnapshotData,
  end: SnapshotData,
  format: "markdown" | "tsv" = "markdown"
): string {
  const sections: string[] = [];

  // Bindings keep their latest source, so a definition the task replaced
  // appears once, as the task left it. One statement can bind several names.
  const before = start.workflow.nativeNamespace?.bindings ?? {};
  const namespace = end.workflow.nativeNamespace;
  const cells = namespace?.cells ?? [];
  const seen = new Set<string>();
  const sources = Object.values(namespace?.bindings ?? {})
    .filter(binding => before[binding.name]?.source !== binding.source)
    // Binding cells are numbered from 1, as error locations show them.
    .map(binding => ({ binding, at: Math.max(0, (cells[binding.cell - 1] ?? "").indexOf(binding.source)) }))
    .sort((a, b) => a.binding.cell - b.binding.cell || a.at - b.at || a.binding.name.localeCompare(b.binding.name))
    .filter(({ binding }) => {
      const key = `${binding.cell}\u0000${binding.source}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ binding }) => binding.source.trimEnd());
  if (sources.length) {
    // Multi-line definitions are set apart; one-line imports and constants stay together.
    const code = sources.reduce(
      (text, source, i) =>
        i === 0 ? source : text + (source.includes("\n") || sources[i - 1].includes("\n") ? "\n\n" : "\n") + source,
      ""
    );
    sections.push(["Definitions registered or changed:", "```python", code, "```"].join("\n"));
  }

  const shape = (snapshot: SnapshotData, id: string) => {
    const info = snapshot.results.get(id)?.info;
    return JSON.stringify([
      info?.state,
      !!info?.error,
      info?.totalRowCount ?? info?.outputTuples,
      (info?.resultSchema ?? []).map(field => field.name),
    ]);
  };
  const prior = new Map(start.workflow.operators.filter(op => op.nativeOp).map(op => [op.operatorID, op]));
  const current = topologicalOperators(end.workflow.operators.filter(op => op.nativeOp));
  const changed = current.filter(op => {
    const was = prior.get(op.operatorID);
    return (
      !was ||
      was.nativeOp!.revision !== op.nativeOp!.revision ||
      shape(start, op.operatorID) !== shape(end, op.operatorID)
    );
  });
  if (changed.length) {
    const source = {
      result: (id: string) => end.results.get(id)?.info,
      hadResult: (id: string) => start.results.has(id),
    };
    const rows = changed.map(op => {
      const row = operatorRow(op, source);
      return [row.id, row.definition, row.result, row.columns].map(value => tableCell(value, format));
    });
    sections.push(
      [
        "Operators created or changed:",
        renderTable(["operator", "definition", "result", "columns"], rows, format),
      ].join("\n")
    );
  }
  const kept = new Set(current.map(op => op.operatorID));
  const deleted = [...prior.keys()].filter(id => !kept.has(id));
  if (deleted.length) sections.push(`Operators deleted: ${deleted.join(", ")}`);
  return sections.join("\n\n");
}
