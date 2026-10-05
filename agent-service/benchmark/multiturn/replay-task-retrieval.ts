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
/** Matched, read-only replay of captured task retrievals; no model/engine calls.
 * Saved metadata supplies result identity and availability. Original samples
 * are copied unchanged, never reconstructed or treated as complete tables. */
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WorkflowContent } from "../../src/types/workflow";
import type { OperatorInfo } from "../../src/types/execution";
import type { WorkflowSnapshotStorage } from "../../src/agent/workflow-snapshot-storage";
import { inspectTaskSubgraph, type HistoricalTask, type StateVersion } from "../../src/agent/state-history";
import { executionFingerprints, workflowExecutionPlan } from "../../src/agent/native/result-versions";
import { resultScope } from "../../src/agent/native/result-scope";
import { renderDataflowActionsResult, type DataflowActionsResult } from "../../src/agent/tools/dataflow-actions";

const [studyArg, outputArg] = Bun.argv.slice(2);
assert(studyArg && outputArg, "Use captured-study-dir output-dir");
const study = resolve(studyArg),
  output = resolve(outputArg);
mkdirSync(output, { recursive: true });
const old = await import(join(study, "source/agent-service/src/agent/native/action-observations.ts"));
const load = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const zip = (path: string) => JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(path))));
const rows: any[] = [];

for (const dataset of readdirSync(join(study, "recovery1/runs/dependencies-r1"))) {
  const directory = join(study, "recovery1/runs/dependencies-r1", dataset);
  const turns = readdirSync(directory)
    .filter(name => /^t\d\d$/.test(name))
    .sort();
  const workflows = new Map<string, WorkflowContent>();
  const metadata = new Map<string, Map<string, StateVersion>>();
  const tasks: HistoricalTask[] = [];
  const calls: Array<{ turn: string; receipt: DataflowActionsResult; index: number }> = [];
  for (const turn of turns) {
    const saved = zip(join(directory, turn, "workflow.json.gz"));
    workflows.set(saved.headId, saved.workflow);
    const record = load(join(directory, turn, "task-history.json")).tasks.at(-1);
    tasks.push({ taskId: record.task_id, stepId: saved.headId, request: record.request, answer: record.answer });
    for (const step of zip(join(directory, turn, "react_steps.json.gz")).steps)
      for (const tool of step.toolResults ?? []) {
        const receipt = tool.output;
        if (receipt?.kind !== "dataflow-actions") continue;
        for (const [index, action] of receipt.actions.entries()) {
          if (action.status !== "ok" || action.action.type !== "inspect" || action.action.target !== "task") continue;
          calls.push({ turn, receipt, index });
          for (const graph of action.output.dataflows ?? []) {
            const entries = metadata.get(graph.step_id) ?? new Map();
            for (const node of graph.operators) entries.set(node.operator_id, node);
            metadata.set(graph.step_id, entries);
          }
        }
      }
  }
  const info = (step: string, id: string): OperatorInfo | undefined => {
    const node = metadata.get(step)?.get(id);
    if (!node?.result?.available) return undefined;
    return {
      state: "Completed",
      inputTuples: 0,
      outputTuples: node.result.rows ?? 0,
      totalRowCount: node.result.rows,
      resultMode: "table",
      result: [],
      resultVersion: { id: node.result.result_version! } as OperatorInfo["resultVersion"],
    };
  };
  const storage = {
    getWorkflow(step: string) {
      const wf = workflows.get(step);
      assert(wf, `Missing endpoint ${step}`);
      return wf;
    },
    getOperatorResult: info,
    getResolvedOperatorResult(step: string, id: string) {
      const value = info(step, id);
      return value ? { value, sourceStepId: metadata.get(step)?.get(id)?.result?.producing_step ?? step } : undefined;
    },
  } as unknown as WorkflowSnapshotStorage;
  for (const [step, nodes] of metadata) {
    const workflow = workflows.get(step);
    if (!workflow) continue; // Old preview-only snapshots are not expanded by the new automatic path.
    const hashes = executionFingerprints(workflowExecutionPlan(workflow));
    for (const node of nodes.values()) assert.equal(hashes.get(node.operator_id)?.subgraphHash, node.subgraph_hash);
  }
  for (const call of calls) {
    const original = call.receipt.actions[call.index].output as any;
    const selectedTask = tasks.find(t => t.taskId === original.task_id)!;
    const rewrite = (selected: string[] | null) => {
      const value = structuredClone(original);
      const roots =
        selected ??
        (value.output_roots.basis === "answer" ? value.output_roots.roots.map((r: any) => r.operator_id) : []);
      value.selection_basis = selected ? "selected" : value.output_roots.basis;
      value.dataflows = roots.length
        ? [
            inspectTaskSubgraph(
              storage,
              selectedTask,
              tasks,
              roots,
              !!(call.receipt.actions[call.index].action as any).include_implementation
            ),
          ]
        : [];
      if (!roots.length)
        value.note =
          "No confirmed answer roots were recorded. Select operator_id from the result-read candidates or operator index; exploratory reads have not been expanded or retrieved.";
      for (const graph of value.dataflows) {
        const localIds = new Set(graph.operators.map((node: StateVersion) => node.operator_id));
        graph.operator_blocks = graph.operators.map((node: StateVersion) => {
          const captured = original.dataflows
            .flatMap((g: any) => g.operator_blocks)
            .find((block: any) => block.id === node.operator_id);
          assert(captured, `Missing captured block ${node.operator_id}`);
          const block = structuredClone(captured);
          if (block.usedBy) block.usedBy = block.usedBy.filter((id: string) => localIds.has(id));
          return block;
        });
        graph.boundary_inputs = graph.boundary_inputs.map((input: any) => ({
          ...input,
          scope: resultScope(
            storage.getWorkflow(input.step_id).operators.find(op => op.operatorID === input.operator_id)!,
            storage.getWorkflow(input.step_id),
            id => info(input.step_id, id)
          ),
        }));
        graph.observations = original.dataflows
          .flatMap((g: any) => g.observations ?? [])
          .filter((o: any) => roots.includes(o.operator_id));
      }
      const receipt = structuredClone(call.receipt);
      receipt.actions = [{ ...receipt.actions[call.index], index: 1, output: value }];
      if (selected) (receipt.actions[0].action as any).operator_id = selected;
      return { receipt, text: renderDataflowActionsResult(receipt), value };
    };
    const before = structuredClone(call.receipt);
    before.actions = [{ ...before.actions[call.index], index: 1 }];
    const oldText = old.renderActionObservations(before);
    const after = rewrite(null);
    const measure = (value: any, text: string) => ({
      definition_nodes: value.dataflows.reduce((sum: number, graph: any) => sum + graph.operators.length, 0),
      input_references: value.dataflows.reduce(
        (sum: number, graph: any) => sum + (graph.boundary_inputs?.length ?? 0),
        0
      ),
      result_samples: value.dataflows.reduce((sum: number, graph: any) => sum + (graph.observations?.length ?? 0), 0),
      characters: text.length,
    });
    const entry: any = {
      dataset,
      during: call.turn,
      inspected_task: original.task_id,
      source_basis: original.selection_basis,
      before: measure(original, oldText),
      after: measure(after.value, after.text),
    };
    const name = `${dataset}-${call.turn}-task${original.task_id}`;
    writeFileSync(join(output, `${name}-before.txt`), oldText);
    writeFileSync(join(output, `${name}-after.txt`), after.text);
    if (dataset.includes("nyc_restaurants") && original.task_id === 6) {
      const focused = rewrite(["subsidy_top8_t6"]);
      entry.explicit_final_table = measure(focused.value, focused.text);
      entry.explicit_final_table.boundaries = focused.value.dataflows[0].boundary_inputs.map((input: any) => [
        input.operator_id,
        input.task_id,
      ]);
      assert.equal(entry.explicit_final_table.definition_nodes, 11);
      assert.equal(entry.explicit_final_table.input_references, 5);
      assert.equal(entry.explicit_final_table.result_samples, 1);
      writeFileSync(join(output, `${name}-selected.txt`), focused.text);
    }
    rows.push(entry);
  }
}
const total = (kind: string) =>
  rows.reduce(
    (sum, row) => {
      for (const [key, value] of Object.entries(row[kind])) sum[key] = (sum[key] ?? 0) + Number(value);
      return sum;
    },
    {} as Record<string, number>
  );
const report = {
  method:
    "Identical captured graphs, root metadata, immutable result identities and original samples; compare archived and current renderers. No model or engine calls; does not measure solver accuracy or billed tokens.",
  inspections: rows.length,
  before: total("before"),
  after: total("after"),
  rows,
};
writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
