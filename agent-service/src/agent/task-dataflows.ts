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
import type { ModelMessage } from "ai";
import type { OperatorInfo } from "../types/execution";
import type { OperatorPredicate, TaskResultReference, WorkflowContent } from "../types/workflow";
import { WorkflowState } from "./workflow-state";
import { WorkflowUtilService } from "./util/workflow-utils";
import type { WorkflowSystemMetadata } from "./util/workflow-system-metadata";
import { inspectGraph } from "./tools/graph-edits";

export interface RetainedResult {
  path: string;
  sha256: string;
  rowCount: number;
}
export interface TaskAnswer {
  content: string;
  exports: Array<{ name: string; operator_id: string }>;
  answer_sources: string[];
  defaults: Array<{ name: string; export_name: string }>;
}
export interface SavedTaskOutput {
  operator: OperatorPredicate;
  info: OperatorInfo;
  artifact: RetainedResult;
}
export interface TaskDataflowRecord {
  task_id: number;
  request: string;
  answer: string;
  status: "running" | "completed" | "incomplete";
  graph: WorkflowContent;
  exports: Record<string, SavedTaskOutput>;
  answer_sources: Record<string, SavedTaskOutput>;
  inputs: Record<string, OperatorInfo["resultVersion"]>;
  dependencies: TaskResultReference[];
  default_changes: Array<{ name: string; task_id: number; export_name: string }>;
}
export type TaskDetail = "summary" | "outputs" | "graph" | "implementations" | "dependencies";

/** One record per user request. Archives and default bindings commit together,
 * only after complete outputs have been retained outside the execution cache.
 * This is session memory; durable experiment artifacts are exported by the runner. */
export class TaskDataflows {
  private records: TaskDataflowRecord[] = [];
  private retained = new Map<string, RetainedResult>();
  private bindings = new Map<string, { task_id: number; export_name: string }>();
  private active: number | undefined;
  constructor(private retain: (operator: string, info: OperatorInfo) => Promise<RetainedResult>) {}

  begin(request: string): number {
    if (this.active !== undefined) throw new Error("The previous task is still running");
    const task_id = this.records.length + 1;
    this.records.push({
      task_id,
      request,
      answer: "",
      status: "running",
      graph: new WorkflowState().getWorkflowContent(),
      exports: {},
      answer_sources: {},
      inputs: {},
      dependencies: [],
      default_changes: [],
    });
    this.active = task_id;
    return task_id;
  }
  get currentId(): number | undefined {
    return this.active;
  }
  record(task: number): TaskDataflowRecord {
    const record = this.records[task - 1];
    if (!Number.isSafeInteger(task) || !record) throw new Error(`Task ${task} does not exist.`);
    return structuredClone(record);
  }
  all(): TaskDataflowRecord[] {
    return structuredClone(this.records);
  }
  defaults() {
    return [...this.bindings].map(([name, reference]) => ({ name, ...reference }));
  }
  clear() {
    this.records = [];
    this.retained.clear();
    this.bindings.clear();
    this.active = undefined;
  }
  finishIncomplete(answer = "") {
    if (this.active === undefined) return;
    const record = this.records[this.active - 1];
    record.status = "incomplete";
    record.answer = answer;
    this.active = undefined;
  }

  historyMessages(): ModelMessage[] {
    return this.records
      .filter(task => task.status !== "running")
      .flatMap(task => [
        { role: "user" as const, content: `[Task ${task.task_id}]\n${task.request}` },
        {
          role: "assistant" as const,
          content: task.answer || "[Task ended without a final answer; no outputs were saved.]",
        },
      ]);
  }
  list(query: string) {
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return this.records
      .filter(
        task =>
          task.status !== "running" &&
          terms.every(term => `${task.request}\n${task.answer}`.toLowerCase().includes(term))
      )
      .map(task => ({ task_id: task.task_id, request: task.request, answer: task.answer, status: task.status }));
  }
  inspect(task: number, detail: TaskDetail): unknown {
    const record = this.record(task);
    if (detail === "dependencies")
      return {
        task_id: task,
        dependencies: record.dependencies,
        consumers: this.records.filter(r => r.dependencies.some(d => d.task_id === task)).map(r => r.task_id),
        default_changes: record.default_changes,
      };
    if (detail === "graph" || detail === "implementations")
      return {
        task_id: task,
        ...inspectGraph(record.graph),
        ...(detail === "implementations"
          ? {
              definitions: record.graph.operators.map(op => ({
                id: op.operatorID,
                expression: op.nativeOp?.source,
                inputs: op.nativeOp?.inputs,
                functions: op.nativeOp?.functions ?? {},
                ...(op.taskImport ? { saved_result: op.taskImport } : { properties: op.nativeOp?.properties }),
              })),
            }
          : {}),
      };
    const outputs = [
      ...Object.entries(record.exports),
      ...Object.entries(record.answer_sources).map(([id, output]) => [`answer/${id}`, output] as const),
    ].map(([name, output]) => ({
      name,
      operator_id: output.operator.operatorID,
      result_version: output.info.resultVersion?.id,
      rows: output.artifact.rowCount,
      columns: output.info.resultSchema?.length,
      columns_preview: output.info.resultSchema?.slice(0, 12),
      omitted_columns: Math.max(0, (output.info.resultSchema?.length ?? 0) - 12),
    }));
    return { task_id: task, request: record.request, answer: record.answer, status: record.status, outputs };
  }
  resolve(task: number, name: string): SavedTaskOutput {
    const record = this.record(task);
    const output = name.startsWith("answer/")
      ? Object.hasOwn(record.answer_sources, name.slice(7))
        ? record.answer_sources[name.slice(7)]
        : undefined
      : Object.hasOwn(record.exports, name)
        ? record.exports[name]
        : undefined;
    if (record.status !== "completed" || !output)
      throw new Error(
        `Saved output ${JSON.stringify(name)} at task ${task} is unavailable. Inspect that task's exports; current data is not a substitute.`
      );
    return output;
  }

  async seal(
    answer: TaskAnswer,
    workflow: WorkflowContent,
    results: Map<string, OperatorInfo>,
    assertCurrent: () => void = () => {}
  ): Promise<void> {
    const task = this.active;
    if (task === undefined) throw new Error("No active task to finalize");
    assertCurrent();
    const unique = (names: string[], what: string) => {
      if (names.some(name => !name.trim()) || new Set(names).size !== names.length)
        throw new Error(`${what} names must be nonempty and unique`);
    };
    unique(
      answer.exports.map(e => e.name),
      "Export"
    );
    if (answer.exports.some(e => e.name.startsWith("answer/")))
      throw new Error("The answer/ prefix is reserved for saved answer sources");
    unique(
      answer.defaults.map(e => e.name),
      "Default"
    );
    for (const binding of answer.defaults)
      if (!answer.exports.some(e => e.name === binding.export_name))
        throw new Error(`Default ${binding.name} references an unsaved export: ${binding.export_name}`);
    const byId = new Map(workflow.operators.map(op => [op.operatorID, op]));
    const roots = [...new Set([...answer.exports.map(e => e.operator_id), ...answer.answer_sources])];
    const used = new Set<string>();
    const visit = (id: string) => {
      if (used.has(id)) return;
      if (!byId.has(id)) throw new Error(`Output ${id} does not exist in the current dataflow`);
      const info = results.get(id);
      if (
        !info ||
        info.error ||
        !["Completed", "CompletedFromCache"].includes(info.state) ||
        !info.resultVersion?.id ||
        !info.materialization?.executionId
      )
        throw new Error(`Output ${id} has no current completed result. Execute before answering.`);
      used.add(id);
      for (const link of workflow.links.filter(link => link.target.operatorID === id)) visit(link.source.operatorID);
    };
    roots.forEach(visit);
    // Validate everything before the first retention request. Bind the graph to
    // the inputs actually used, including the full result versions, not names.
    for (const id of used) {
      const inputs = byId.get(id)!.nativeOp?.inputs ?? [];
      const consumed = results.get(id)!.resultVersion!.inputs;
      if (
        inputs.some(
          (up, index) =>
            !consumed.some(
              input =>
                input.inputIndex === index &&
                input.operatorId === up &&
                input.resultVersion === results.get(up)?.resultVersion?.id
            )
        )
      )
        throw new Error(`Output ${id} does not have exact current input bindings. Execute the dataflow again.`);
    }
    const saved = new Map<string, SavedTaskOutput>();
    for (const id of roots) {
      const info = results.get(id)!;
      let artifact = this.retained.get(info.resultVersion!.id);
      if (!artifact) {
        artifact = await this.retain(id, info);
        if (
          !artifact.path ||
          !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
          !Number.isSafeInteger(artifact.rowCount) ||
          artifact.rowCount < 0 ||
          artifact.rowCount !== info.totalRowCount
        )
          throw new Error(`Retention did not confirm the complete output of ${id}`);
        this.retained.set(info.resultVersion!.id, structuredClone(artifact));
      }
      assertCurrent();
      saved.set(id, structuredClone({ operator: byId.get(id)!, info, artifact }));
    }
    assertCurrent();
    if (this.active !== task) throw new Error("Active task changed during retention");
    const graph: WorkflowContent = structuredClone({
      ...workflow,
      operators: workflow.operators.filter(op => used.has(op.operatorID)),
      links: workflow.links.filter(link => used.has(link.source.operatorID) && used.has(link.target.operatorID)),
      operatorPositions: Object.fromEntries(Object.entries(workflow.operatorPositions).filter(([id]) => used.has(id))),
    });
    const references = graph.operators.flatMap(op => (op.taskImport ? [op.taskImport] : []));
    const dependencies = [...new Map(references.map(ref => [JSON.stringify(ref), ref])).values()];
    const record: TaskDataflowRecord = {
      ...this.records[task - 1],
      status: "completed",
      answer: answer.content,
      graph,
      exports: Object.fromEntries(answer.exports.map(e => [e.name, saved.get(e.operator_id)!])),
      answer_sources: Object.fromEntries(answer.answer_sources.map(id => [id, saved.get(id)!])),
      inputs: Object.fromEntries([...used].map(id => [id, structuredClone(results.get(id)!.resultVersion)])),
      dependencies,
      default_changes: answer.defaults.map(binding => ({ ...binding, task_id: task })),
    };
    this.records[task - 1] = record;
    for (const { name, task_id, export_name } of record.default_changes)
      this.bindings.set(name, { task_id, export_name });
    this.active = undefined;
  }

  importResult(task: number, name: string, id: string, state: WorkflowState, metadata: WorkflowSystemMetadata): void {
    if (!/^[A-Za-z_]\w*$/.test(id)) throw new Error("Local operator ID must be a Python identifier");
    if (state.getOperator(id)) throw new Error(`Operator ${id} already exists. Choose an unused local ID.`);
    const output = this.resolve(task, name);
    const code = [
      "def load():",
      "    import hashlib, pandas as pd, pyarrow as pa, pyarrow.ipc as ipc",
      `    path = ${JSON.stringify(output.artifact.path)}`,
      "    with open(path, 'rb') as stream:",
      "        digest = hashlib.file_digest(stream, 'sha256').hexdigest()",
      `    if digest != ${JSON.stringify(output.artifact.sha256)}:`,
      "        raise ValueError('Retained task output is missing or has changed')",
      "    with pa.memory_map(path, 'r') as stream:",
      "        table = ipc.open_file(stream).read_all()",
      "    types = {pa.int32(): pd.Int64Dtype(), pa.int64(): pd.Int64Dtype(), pa.bool_(): pd.BooleanDtype(), pa.float64(): pd.Float64Dtype(), pa.string(): pd.StringDtype()}",
      "    return table.to_pandas(types_mapper=types.get)",
    ].join("\n");
    const reference = { task_id: task, export_name: name, result_version: output.info.resultVersion!.id };
    const base = new WorkflowUtilService(metadata, state).getNewOperatorPredicate("DataLoading", id);
    state.addOperator({
      ...base,
      operatorID: id,
      taskImport: reference,
      inputPorts: [],
      outputPorts: [{ portID: "output-0", displayName: "out" }],
      operatorProperties: { ...base.operatorProperties, code },
      nativeOp: {
        type: "TaskResult",
        inputs: [],
        properties: reference,
        graph: { inputPorts: [] },
        source: `saved_result(task=${task}, export=${JSON.stringify(name)})`,
        revision: output.artifact.sha256.slice(0, 16),
      },
    });
  }
}
