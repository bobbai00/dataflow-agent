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

import { describe, expect, test } from "bun:test";
import { asSchema } from "ai";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ContextMode, type RetrievalView } from "../../types/agent";
import { buildNativeModeSystemPrompt, type NativePromptLayoutOptions } from "../prompts";
import { TexeraAgent } from "../texera-agent";
import { createDataflowTool, prepareDataflowActions, type DataflowActionsInput } from "../tools/dataflow-actions";
import { missingGraphInputs, parseGraphEdit, planGraphEdit } from "../tools/graph-edits";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { availableRetrievalViews } from "./retrieval";
import { parseAnswerFromParts } from "./answer";
import { nativeTestTools } from "./test-support";

const evidenceCases = [
  { name: "neither", data: false, flow: false },
  { name: "data only", data: true, flow: false },
  { name: "flow only", data: false, flow: true },
  { name: "both", data: true, flow: true },
];

function options(data: boolean, flow: boolean): NativePromptLayoutOptions {
  return {
    multiTask: false,
    dataEvidence: data,
    flowEvidence: flow,
    retrievalViews: data ? ["sample_stats", "full"] : ["sample", "full"],
    fullResultCharLimit: 7500,
    maxOperatorResultCharLimit: 1500,
    maxResultRows: 3,
    dataEvidenceCharLimit: 900,
    flowEvidenceCharLimit: 800,
  };
}

function calls(text: string): DataflowActionsInput[] {
  return [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map(([, json]) => JSON.parse(json));
}

function describedEvidence(prompt: string) {
  return {
    data: /^#+\s+Data statistics\b/im.test(prompt),
    flow: /^#+\s+Flow statistics\b/im.test(prompt),
  };
}

// A small table can be read in full immediately; a sample is a choice of
// evidence, not a compulsory action before using another available view.
const mandatorySampleFirst =
  /(?:look|retrieve|request|inspect)\s+(?:at a result\s+)?(?:with\s+)?[`"]?(?:sample_stats|sample)[`"]?\s+first/i;

describe("single-task prompt evidence configurations", () => {
  for (const evidence of evidenceCases)
    for (const detail of ["full", "on_demand"] as const)
      for (const mode of [ContextMode.DELTA, ContextMode.LATEST])
        test(`${evidence.name}, ${detail}, ${mode}: only available evidence and valid calls`, async () => {
          const settings = { ...options(evidence.data, evidence.flow), nativePromptDetail: detail };
          const views = availableRetrievalViews(settings);
          const prompt = buildNativeModeSystemPrompt(mode, settings);
          expect(describedEvidence(prompt)).toEqual({ data: evidence.data, flow: evidence.flow });
          expect(prompt).not.toContain("{{");
          expect(mandatorySampleFirst.test(prompt)).toBe(false);
          expect(/scan each supplied path/i.test(prompt)).toBe(false);

          for (const view of ["full", "sample", "sample_stats"] as const)
            expect(prompt.includes(`| \`${view}\` |`)).toBe(views.includes(view));
          expect(prompt).toContain("7500 characters");
          expect(prompt).toContain("1500 characters");
          if (evidence.data) expect(prompt).toContain("900-character");

          const examples = calls(prompt);
          expect(examples.length).toBeGreaterThan(0);
          for (const call of examples) {
            expect(prepareDataflowActions(call, views, false).status).toBe("pending");
            for (const action of call.actions) {
              if (action.type === "retrieve") expect(views).toContain(action.view);
              if (action.type === "edit") expect((await parseGraphEdit(action.changes)).length).toBeGreaterThan(0);
              if (action.type === "answer" && "from" in action)
                expect(parseAnswerFromParts(action.from)).not.toHaveProperty("error");
            }
          }

          expect(prompt).not.toMatch(/\b(?:recallState|resumeFrom|compactContext)\b/);
          expect(prompt).not.toMatch(/\bat\([^)]*\btask\s*=/);
          expect(prompt).not.toMatch(/"target"\s*:\s*"(?:task|state)"/);
          expect(prompt).not.toMatch(/"type"\s*:\s*"fork"/);
          if (!evidence.data && !evidence.flow) expect(prompt).not.toMatch(/"example"\s*:\s*"statistics"/);
        });

  test("explicit views determine availability even when dataEvidence is false", () => {
    const off = buildNativeModeSystemPrompt(ContextMode.DELTA, {
      dataEvidence: true,
      retrievalViews: ["sample", "full"],
    });
    const on = buildNativeModeSystemPrompt(ContextMode.DELTA, {
      dataEvidence: false,
      retrievalViews: ["sample_stats", "full"],
    });
    expect(describedEvidence(off).data).toBe(false);
    expect(describedEvidence(on).data).toBe(true);
  });

  test("single-task tool guidance offers the same views without mandatory sampling", () => {
    for (const evidence of evidenceCases) {
      const views = availableRetrievalViews(options(evidence.data, evidence.flow));
      const schema = asSchema(createDataflowTool(views).inputSchema!).jsonSchema as any;
      const retrievals = schema.properties.actions.items.anyOf.filter(
        (item: any) => item.properties.type.const === "retrieve"
      );
      expect(retrievals.length).toBeGreaterThan(0);
      for (const item of retrievals) {
        expect(item.properties.view.enum).toEqual(views);
        expect(item.description).not.toMatch(mandatorySampleFirst);
      }
    }
  });

  test("live setting updates rebuild both prompt evidence and tool views", () => {
    const agent = new TexeraAgent({
      agentId: "single-task-evidence-switch",
      modelType: "test",
      driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
      contextAssembler: () => [],
    });
    for (const evidence of evidenceCases) {
      const settings = options(evidence.data, evidence.flow);
      agent.updateSettings(settings);
      const info = agent.getSystemInfo();
      expect(describedEvidence(info.systemPrompt)).toEqual({ data: evidence.data, flow: evidence.flow });
      const dataflow = info.tools.find(item => item.name === "dataflow")!;
      const retrievals = dataflow.inputSchema.properties.actions.items.anyOf.filter(
        (item: any) => item.properties.type.const === "retrieve"
      );
      for (const item of retrievals) expect(item.properties.view.enum).toEqual(settings.retrievalViews);
    }
  });
});

test("the known-schema single-task example computes the answer without an initial source inspection", async () => {
  const prompt = buildNativeModeSystemPrompt(ContextMode.DELTA, options(false, false));
  const example = calls(prompt).find(call =>
    call.actions.some(action => action.type === "edit" && action.changes.includes('scan("data/orders.csv")'))
  );
  expect(example).toBeDefined();
  expect(example!.actions[0].type).toBe("edit");
  expect(example!.actions[1].type).toBe("execute");
  expect(example!.actions.some(action => action.type === "inspect")).toBe(false);
  expect(example!.actions.some(action => action.type === "retrieve" && action.operator_id === "orders")).toBe(false);

  const directory = mkdtempSync(join(tmpdir(), "single-task-prompt-example-"));
  try {
    const source = join(directory, "orders.csv");
    writeFileSync(source, "region,amount\neast,70.5\nwest,30\neast,50\nwest,50\n");
    const { state } = nativeTestTools();
    const metadataStore = new WorkflowSystemMetadata();
    metadataStore.seedCodeModeDefaults();
    for (const action of example!.actions)
      if (action.type === "edit") {
        const plan = await planGraphEdit(
          state.getWorkflowContent(),
          action.changes.replace('"data/orders.csv"', JSON.stringify(source)),
          { metadataStore }
        );
        state.setWorkflowContent(plan.workflow);
      }
    expect(missingGraphInputs(state.getWorkflowContent())).toEqual([]);

    const python =
      process.env.UDF_PYTHON_PATH ?? fileURLToPath(new URL("../../../../.venv/bin/python", import.meta.url));
    const run = spawnSync(
      python,
      [
        "-c",
        `import json, sys
pending = {op['operatorID']: op for op in json.load(sys.stdin)}
results = {}
while pending:
    ready = [op for op in pending.values() if all(name in results for name in op['nativeOp']['inputs'])]
    assert ready, 'cycle or missing input'
    for op in ready:
        namespace = {}
        exec(op['operatorProperties']['code'], namespace)
        inputs = list(dict.fromkeys(op['nativeOp']['inputs']))
        results[op['operatorID']] = namespace['process'](*[results[name] for name in inputs]) if inputs else namespace['load']()
        del pending[op['operatorID']]
print(results['totals'].to_json(orient='records'))`,
      ],
      { input: JSON.stringify(state.getAllOperators()), encoding: "utf8", timeout: 30_000 }
    );
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([
      { region: "east", total: 120.5 },
      { region: "west", total: 80 },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
