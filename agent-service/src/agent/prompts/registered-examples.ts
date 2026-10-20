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
import type { RetrievalView } from "../../types/agent";
import type { OperatorPredicate, WorkflowContent } from "../../types/workflow";
import type { DataflowActionsResult } from "../tools/dataflow-actions";
import { selectNativeObservation } from "../native/evidence";
import { describeOperator, type ObservationFormatOptions } from "../native/observation-format";
import type { ProfileColumn, ProfileScalar } from "../native/profiles";
import { availableRetrievalViews } from "../native/retrieval";
import { renderTurnReceipt } from "../native/turn-receipt";
import { parseTurn } from "../native/turn-syntax";

type Row = Record<string, string | number>;
/** No flow switch: the examples, like the rest of the prompt, are the same with
 * flow evidence on or off (flow lines explain themselves in tool results). */
type Options = ObservationFormatOptions & {
  retrievalViews?: RetrievalView[];
  answerStatement?: boolean;
};

/** Small complete synthetic materializations. Receipts use the production
 * evidence and observation renderers; prose never invents a second format. */
export function exampleTable(id: string, kind: string, rows: Row[], inputs: string[] = [], operations = {}) {
  const version = (name: string) => name.padEnd(64, "0");
  const schema = Object.keys(rows[0]).map(name => ({
    name,
    type: typeof rows[0][name] === "number" ? ("int64" as const) : ("str" as const),
  }));
  const op: OperatorPredicate = {
    operatorID: id,
    operatorType: inputs.length ? "DataProcessing" : "DataLoading",
    operatorVersion: "1",
    operatorProperties: {},
    inputPorts: [],
    outputPorts: [],
    showAdvanced: false,
    nativeOp: { type: kind, revision: "example", inputs, properties: {}, profileCollection: true },
  };
  const info: OperatorInfo = {
    state: "Completed",
    inputTuples: 0,
    outputTuples: rows.length,
    resultMode: "table",
    result: rows,
    totalRowCount: rows.length,
    truncated: false,
    resultSchema: schema.map(field => ({
      ...field,
      encoding: field.type === "int64" ? "number-or-decimal-string" : "string",
    })),
    resultVersion: {
      version: 1,
      id: version(id),
      workflowId: 1,
      operatorId: id,
      operatorRevision: "example",
      definitionHash: "example",
      subgraphHash: "example",
      outputPort: 0,
      executionId: "1",
      inputs: inputs.map((name, inputIndex) => ({
        inputIndex,
        operatorId: name,
        outputPort: 0,
        resultVersion: version(name),
      })),
      sourceFingerprints: null,
      complete: true,
      omissions: [],
    },
    tableProfile: {
      version: 1,
      resultVersion: version(id),
      status: "available",
      rowCount: rows.length,
      columnCount: schema.length,
      schema: schema.map(field => ({ ...field, dtype: field.type })),
      schemaComplete: true,
      coverage: { scope: "full", complete: true, expectedWorkers: 1, receivedWorkers: 1, rowsProcessed: rows.length },
      columns: Object.fromEntries(
        schema.map(({ name, type }) => {
          const values = rows.map(row => row[name]);
          const distinct = [...new Set(values)];
          const scalar = (value: string | number): ProfileScalar => ({ type, value: String(value) });
          const column: ProfileColumn = {
            type,
            rowsProcessed: rows.length,
            nullCount: 0,
            nonnullCount: rows.length,
            nullRatio: 0,
            distinctCount: distinct.length,
            uniquenessRatio: distinct.length / rows.length,
            min: type === "int64" ? scalar(Math.min(...(values as number[]))) : null,
            max: type === "int64" ? scalar(Math.max(...(values as number[]))) : null,
            frequencies: {
              values: distinct.map(value => ({ value: scalar(value), count: values.filter(x => x === value).length })),
              otherCount: 0,
              truncated: false,
            },
            omissions: [],
          };
          return [name, column];
        })
      ),
      structure: { duplicateRows: null, allNullRows: 0, allNullColumns: [] },
      native: { operatorType: kind, inputOperators: inputs, outputRows: rows.length, operations },
      producerIds: ["example"],
      omissions: [],
      cost: { collectionMs: 0, cellsProcessed: rows.length * schema.length, payloadBytes: 0 },
    },
  };
  return { op, info };
}

export function registeredExamples(options: Options): string {
  const views = availableRetrievalViews(options);
  const sample = views.includes("sample_stats") ? "sample_stats" : views.includes("sample") ? "sample" : "full";
  const finalView = views.includes("full") ? "full" : sample;
  const tables = new Map<string, ReturnType<typeof exampleTable>>();
  const completed = new Set<string>();
  const add = (table: ReturnType<typeof exampleTable>) => tables.set(table.op.operatorID, table);
  const show = (ids: string, final = false) =>
    `show result ${ids} ${(final ? finalView : sample) === "full" ? "full" : ""}`.trim();
  const block = (text: string) => `\`\`\`text\n${text}\n\`\`\``;
  // The answer is a reply without the tool, never a statement.
  const reply = (text: string) => `Reply, without the tool: \`${text}\``;
  const call = (python: string, statements: string, receipt = false): string => {
    const fields = { python, statements };
    const parsed = parseTurn(fields, { views, answer: options.answerStatement === true });
    if (!parsed.ok) throw new Error(`Invalid teaching example: ${parsed.error}`);
    const { actions } = parsed.turn;
    const authored = `\`\`\`json\n${JSON.stringify(fields, null, 2)}\n\`\`\``;
    if (!receipt) return authored;
    const workflow: WorkflowContent = {
      operators: [...tables.values()].map(t => t.op),
      operatorPositions: {},
      links: [],
      commentBoxes: [],
      settings: { dataTransferBatchSize: 400 },
    };
    const observe = (id: string, view: RetrievalView, upstream = true) => {
      const table = tables.get(id)!;
      return selectNativeObservation({
        ...options,
        ...table,
        workflow,
        resolveInput: name => tables.get(name)?.info,
        view,
        data: upstream && view === "sample_stats",
        flow: false,
        upstream,
        maxChars: 2000,
        maxRows: 2,
        dataMaxChars: 2000,
        flowMaxChars: 2000,
      });
    };
    const rendered = (id: string, execution = false) => {
      const table = tables.get(id)!;
      const flow = observe(id, "full", false);
      const chunks = flow.chunks.filter(chunk => chunk.id.startsWith("flow."));
      return {
        ...describeOperator(table.op, table.info),
        ...(execution
          ? {
              state: completed.has(id) ? "cached" : "executed",
              flow_observation: { resultVersion: flow.resultVersion, chunks },
            }
          : {}),
        issues: execution ? chunks.map(chunk => chunk.text) : [],
      };
    };
    const result: DataflowActionsResult = {
      kind: "dataflow-actions",
      protocol: "registered-python-v1",
      status: "completed",
      operators: [],
      observe: [],
      observationErrors: [],
      actions: actions.map((action, i) => {
        let output: unknown;
        if (action.type === "edit")
          output = {
            registrations: [...(action.python ?? "").matchAll(/^def (\w+)\(/gm)].map(m => ({
              name: m[1],
              kind: "registered",
            })),
            changes: [...action.changes.matchAll(/^set (\w+): (\w+)\(/gm)].map(m => ({
              change: "operator",
              operator_id: m[1],
              operator: m[2],
              action: "created",
            })),
          };
        else if (action.type === "execute") {
          const ids = new Set<string>();
          const visit = (id: string) => {
            if (ids.has(id)) return;
            tables.get(id)?.op.nativeOp?.inputs.forEach(visit);
            ids.add(id);
          };
          action.operator_ids?.forEach(visit);
          output = {
            operator_blocks: [...ids].map(id => rendered(id, true)),
            operators: [...ids].map(id => ({ id, state: completed.has(id) ? "cached" : "executed", status: "ok" })),
          };
          ids.forEach(id => completed.add(id));
        } else if (action.type === "retrieve")
          output = {
            results: action.operator_ids.map(id => {
              const observation = observe(id, action.view);
              return {
                operator_id: id,
                status: "ok",
                operator_blocks: [rendered(id)],
                observation,
                text: observation.text,
              };
            }),
          };
        else output = {};
        return { index: i + 1, action, status: "ok" as const, output };
      }),
    };
    return `${authored}\n\nTool result:\n\n${block(renderTurnReceipt(result, parsed.turn))}`;
  };

  add(
    exampleTable("records", "Scan", [
      { group: "A", value: 10 },
      { group: "A", value: 20 },
      { group: "B", value: 30 },
      { group: "B", value: 40 },
      { group: "A", value: 10 },
      { group: "A", value: 20 },
    ])
  );
  add(
    exampleTable(
      "totals",
      "Aggregate",
      [
        { group: "A", total: 60 },
        { group: "B", total: 70 },
      ],
      ["records"]
    )
  );
  tables.get("totals")!.op.nativeOp!.properties.groupBy = ["group"];
  add(
    exampleTable(
      "report",
      "Sort",
      [
        { group: "A", total: 60 },
        { group: "B", total: 70 },
      ],
      ["totals"]
    )
  );
  const parts = [
    "### Read unfamiliar data, then batch a known computation",
    sample === "full"
      ? "Request: report the total value for every group in alphabetical order. These synthetic tool results use 2,000-character budgets; your session budgets are listed above."
      : "Request: report the total value for every group in alphabetical order. These synthetic tool results use two sample rows and 2,000-character budgets to make the difference between records and evidence visible; your session budgets are listed above.",
    "Check the source's columns and values before choosing the grouping:",
    call("", `set records: scan(files='data/example.csv')\n${show("records")}`, true),
    sample === "sample_stats"
      ? "Both displayed rows belong to A, but the full-table statistics also contain B. A sample does not define the population; aggregate the whole source."
      : sample === "sample"
        ? "Both displayed rows belong to A. They do not establish which groups exist; aggregate the whole source."
        : "The complete source contains groups A and B. Aggregate the whole source.",
    call(
      "",
      `set totals: aggregate(records, by=['group'], outputs={'total': sum('value')})\nset report: sort(totals, by=['group'])\n${show("report", true)}`,
      true
    ),
    ...(options.answerStatement
      ? [
          "Give the answer from the result:",
          call("", "answer report"),
          'The reply is `[{"group":"A","total":60},{"group":"B","total":70}]`, and the request ends.',
        ]
      : [reply("Group A: 60; group B: 70.")]),
  ];

  // One reading example and the answer rule. Every example is paid for on
  // every call of every task. The flow-repair example that used to follow when
  // flow evidence was on is gone: it composed a whole computation before
  // looking, and decisions shifted before any flow line appeared (2026-10-13).
  parts.push(
    options.answerStatement
      ? "An answer statement returns values exactly as computed: round, rename, and order them in the graph as the request asks."
      : "If the user asks for a `Final Answer:` label, put it in the reply, for example `**Final Answer: 60**`. A reply before any `show result` has succeeded is not an answer and computes nothing."
  );
  return parts.join("\n\n");
}
