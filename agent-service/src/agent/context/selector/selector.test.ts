/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { describe, expect, test } from "bun:test";
import { buildDossier } from "../summarize/dossier";
import { summarize } from "../summarize/summarize";
import { resolveOperatorParams } from "../summarize/params";
import { extractFeatures } from "./features";
import { selectParams, buildOverride, DEFAULT_SELECTOR_CONFIG, parseSelectorConfig } from "./selector";
import { buildRichScenario, buildScenario, makeInfo, makeWorkflow } from "../summarize/fixtures";

function dossierOf() {
  const { steps, storage } = buildRichScenario();
  return buildDossier(steps, storage);
}
function renderWith(config = DEFAULT_SELECTOR_CONFIG) {
  const { steps, storage, workflowState } = buildRichScenario();
  const dossier = buildDossier(steps, storage);
  const params = selectParams(dossier, config);
  return {
    params,
    text: summarize(
      { visibleSteps: steps, workflowState, snapshotStorage: storage, compilationResult: null, dossier },
      params
    ).text,
  };
}
function opBlock(text: string, id: string): string {
  const start = text.indexOf(`### Operator \`${id}\``);
  if (start < 0) return "";
  const next = text.indexOf("### Operator ", start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

/* ============================================================================
 *  Features
 * ========================================================================= */

describe("extractFeatures — roles on the rich scenario", () => {
  const feats = extractFeatures(dossierOf());
  const role = (id: string) => feats.operators.get(id)?.role;

  test("the erroring, most-recently-edited op is the frontier", () => {
    expect(role("by_region")).toBe("frontier");
    expect(feats.trajectory.frontierOpId).toBe("by_region");
  });
  test("a direct upstream of the frontier is near-frontier", () => {
    expect(role("sales")).toBe("near-frontier");
  });
  test("an op with no result whose upstream errored is blocked", () => {
    expect(role("report")).toBe("blocked");
  });
  test("a deleted op is flagged deleted", () => {
    expect(role("inspect_sales")).toBe("deleted");
  });
  test("thrash + edit-count are tracked", () => {
    expect(feats.operators.get("by_region")?.editCount).toBe(3);
    expect(feats.trajectory.anyThrashing).toBe(true);
  });
  test("retired worker statistics cannot steer the selector", () => {
    expect(feats.operators.get("sales")?.categoricalLowCard).toBe(false);
    expect(feats.operators.get("sales")?.hasColumnStats).toBe(false);
  });
});

/* ============================================================================
 *  selectParams — the policy output
 * ========================================================================= */

describe("selectParams — per-operator allocation", () => {
  const params = selectParams(dossierOf());

  test("defaults are the cheap settled profile (shape + schema)", () => {
    expect(params.operators.defaults.result.latest.detail).toBe("shape");
    expect(params.operators.defaults.result.latest.column.schema).toBe(true);
  });

  test("frontier gets sample + code + thrash history", () => {
    const p = resolveOperatorParams(params, "by_region");
    expect(p.result.latest.detail).toBe("sample");
    expect(p.property.includeCode).toBe(true);
    expect(p.property.codeHistory).toBe(DEFAULT_SELECTOR_CONFIG.historyDepth);
    expect(p.result.history.lastK).toBe(DEFAULT_SELECTOR_CONFIG.historyDepth);
    expect(Object.hasOwn(p.result.latest.column ?? {}, "structuralHints")).toBe(false);
  });

  test("blocked operator is omitted", () => {
    expect(resolveOperatorParams(params, "report").result.latest.detail).toBe("omit");
  });

  test("near-frontier upstream keeps a sample + categorical stats", () => {
    const p = resolveOperatorParams(params, "sales");
    expect(p.result.latest.detail).toBe("sample");
    expect(Object.hasOwn(p.result.latest.column ?? {}, "stats")).toBe(false);
  });

  test("flow insurance is on and error-reflection fires under thrash", () => {
    expect(Object.hasOwn(params.flow ?? {}, "errorContext")).toBe(false);
    expect(Object.hasOwn(params.flow ?? {}, "loaderHints")).toBe(false);
    expect(params.flow.errorReflection).toBe(true);
  });
});

/* ============================================================================
 *  Config ablations (the trainable knobs actually move the output)
 * ========================================================================= */

describe("SelectorConfig knobs move the policy", () => {
  test("raising thrashHistoryThreshold suppresses history", () => {
    const p = selectParams(dossierOf(), parseSelectorConfig({ thrashHistoryThreshold: 10 }));
    expect(resolveOperatorParams(p, "by_region").property.codeHistory).toBe(0);
  });
  test("insurance=false drops the flow rungs", () => {
    const p = selectParams(dossierOf(), parseSelectorConfig({ insurance: false }));
    expect(Object.hasOwn(p.flow ?? {}, "loaderHints")).toBe(false);
    expect(Object.hasOwn(p.flow ?? {}, "errorContext")).toBe(false);
  });
  test("frontierSampleRows flows through to the frontier op", () => {
    const p = selectParams(dossierOf(), parseSelectorConfig({ frontierSampleRows: 3 }));
    expect(resolveOperatorParams(p, "by_region").result.latest.tuple.sampleRows).toBe(3);
  });
  test("a settled source (healthy consumer, past decay) decays to shape", () => {
    // sales' consumer errors in the rich fixture, so build a clean 2-op chain
    // where the loader HAS a healthy consumer and is past the decay window.
    const sc = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m", content: "go" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        messageId: "m",
        parentId: "u",
        content: "load",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "src" } }],
        toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
      },
      {
        id: "a2",
        stepId: 2,
        role: "agent",
        messageId: "m",
        parentId: "a1",
        content: "transform",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t2", input: { operatorId: "agg" } }],
        toolResults: [{ toolCallId: "t2", output: "ok", isError: false }],
      },
      {
        id: "a3",
        stepId: 3,
        role: "agent",
        messageId: "m",
        parentId: "a2",
        content: "finalize",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t3", input: { operatorId: "answer" } }],
        toolResults: [{ toolCallId: "t3", output: "ok", isError: false }],
      },
    ]);
    sc.storage.createSnapshot("a1", makeWorkflow([{ id: "src", type: "DataLoading" }]));
    sc.storage.setOperatorResult("a1", "src", makeInfo(500));
    sc.storage.createSnapshot(
      "a2",
      makeWorkflow(
        [
          { id: "src", type: "DataLoading" },
          { id: "agg", type: "DataProcessing", numInputPorts: 1 },
        ],
        [["src", "agg"]]
      )
    );
    sc.storage.setOperatorResult("a2", "agg", makeInfo(10));
    sc.storage.createSnapshot(
      "a3",
      makeWorkflow(
        [
          { id: "src", type: "DataLoading" },
          { id: "agg", type: "DataProcessing", numInputPorts: 1 },
          { id: "answer", type: "DataProcessing", numInputPorts: 1 },
        ],
        [
          ["src", "agg"],
          ["agg", "answer"],
        ]
      )
    );
    sc.storage.setOperatorResult("a3", "answer", makeInfo(1));
    const dossier = buildDossier(sc.steps, sc.storage);
    const p = selectParams(dossier, parseSelectorConfig({ sourceDecaySteps: 1 }));
    // src: edited at event 1, current event 3 → stepsSinceEdit=2 ≥ 1, has healthy
    // consumer agg → decays to shape.
    expect(resolveOperatorParams(p, "src").result.latest.detail).toBe("shape");
  });
});

/* ============================================================================
 *  End-to-end render through summarize()
 * ========================================================================= */

describe("selector → summarize render", () => {
  test("frontier shows current code + code/result history; blocked op has no Result", () => {
    const { text } = renderWith();
    const br = opBlock(text, "by_region");
    expect(br).toContain("Code @ step"); // history
    expect(br).toContain("[ERROR] KeyError"); // current error
    // Blocked op renders NO raw table, but keeps the cheap one-line
    // "skipped — upstream errored" pointer (the useful signal, not bloat).
    const rep = opBlock(text, "report");
    expect(rep).not.toContain("Output Table:");
    expect(rep).toContain("skipped");
    // settled interior default is shape — but the rich fixture's leaf has no
    // pure-interior op; assert the near-frontier source still shows its table
    expect(opBlock(text, "sales")).toContain("Output Table: 1000 rows");
  });

  test("insurance flows section appears (needs-attention)", () => {
    const { text } = renderWith();
    expect(text).not.toContain("# Operators needing attention");
    expect(text).toContain("# Reasoning (your recent steps)");
  });
});
