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
import { assembleContext } from "../../util/context-utils";
import { summarize, type SummarizeInput } from "./summarize";
import { deltaPreset, parseSummarizeParams } from "./params";
import {
  buildRichScenario,
  buildScenario,
  contentOf,
  makeInfo,
  makeWorkflow,
  snapshotParams,
  CODE_BY_REGION_V1,
  CODE_BY_REGION_V2,
} from "./fixtures";

function input(): SummarizeInput {
  const { steps, storage, workflowState } = buildRichScenario();
  return { visibleSteps: steps, workflowState, snapshotStorage: storage };
}

/** Params = the current-snapshot layout with a deep patch applied via parse (all
 *  tests drive summarize() the way an API caller would — through the schema). */
function snapshotWith(patch: object) {
  const base = snapshotParams();
  return parseSummarizeParams({
    ...base,
    ...patch,
    operators: {
      defaults: deepMergePlain(base.operators.defaults, (patch as any).operators?.defaults ?? {}),
      overrides: (patch as any).operators?.overrides ?? {},
    },
    trajectory: { ...base.trajectory, ...(patch as any).trajectory },
  });
}

function deepMergePlain(a: any, b: any): any {
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return b ?? a;
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = deepMergePlain(a[k], b[k]);
  return out;
}

describe("summarize — preset ≡ legacy context", () => {
  test("deltaPreset renders identically to assembleContext at the server defaults", () => {
    const { steps, storage, workflowState } = buildRichScenario();
    const legacy = assembleContext(steps, workflowState, storage, {});
    expect(summarize(input(), deltaPreset()).messages).toEqual(legacy);
  });
});

describe("summarize — per-operator detail levels", () => {
  test("override detail:'omit' drops one operator's Result block, others keep theirs", () => {
    const params = snapshotWith({ operators: { overrides: { sales: { result: { latest: { detail: "omit" } } } } } });
    const text = summarize(input(), params).text;
    const salesBlock = text.slice(text.indexOf("### Operator `sales`"), text.indexOf("### Operator `orphan_load`"));
    expect(salesBlock).not.toContain("Result:");
    expect(salesBlock).not.toContain("Output Table:");
    // untouched operator still renders fully
    expect(text).toContain("Output Table: 5 rows, 2 cols"); // legacy_data
  });

  test("override detail:'shape' keeps counts but drops the TSV rows", () => {
    const params = snapshotWith({ operators: { overrides: { sales: { result: { latest: { detail: "shape" } } } } } });
    const text = summarize(input(), params).text;
    const salesBlock = text.slice(text.indexOf("### Operator `sales`"), text.indexOf("### Operator `orphan_load`"));
    expect(salesBlock).toContain("Output Table: 1000 rows, 4 cols");
    expect(salesBlock).not.toContain("$12.50"); // no sample rows
  });

  test("defaults detail:'shape' applies to every operator", () => {
    const params = snapshotWith({ operators: { defaults: { result: { latest: { detail: "shape" } } } } });
    const text = summarize(input(), params).text;
    expect(text).toContain("Output Table: 1000 rows, 4 cols");
    expect(text).not.toContain("$12.50");
    expect(text).not.toContain("alpha"); // legacy_data rows gone too
  });
});

describe("summarize — code inclusion & history", () => {
  test("includeCode renders a Code: block on healthy code operators only", () => {
    const params = snapshotWith({ operators: { defaults: { property: { includeCode: true } } } });
    const text = summarize(input(), params).text;
    const salesBlock = text.slice(text.indexOf("### Operator `sales`"), text.indexOf("### Operator `orphan_load`"));
    expect(salesBlock).toContain("Code:");
    expect(salesBlock).toContain("skiprows=2");
    // errored op does NOT get a duplicate Code: block (error already embeds it)
    const brBlock = text.slice(text.indexOf("### Operator `by_region`"), text.indexOf("### Operator `report`"));
    expect(brBlock).not.toContain("\nCode:");
    expect(brBlock).toContain("Operator code:"); // the error-embedded copy
  });

  test("codeHistory renders prior versions with event indices + rejection tags", () => {
    const params = snapshotWith({
      operators: { overrides: { by_region: { property: { codeHistory: 2 } } } },
    });
    const text = summarize(input(), params).text;
    const brBlock = text.slice(text.indexOf("### Operator `by_region`"), text.indexOf("### Operator `report`"));
    // current version is V3; history = V2 (rejected @5) then V1 (@4), newest first
    expect(brBlock).toContain("Code @ step 5 (rejected):");
    expect(brBlock).toContain("Code @ step 4:");
    const v2Idx = brBlock.indexOf("Code @ step 5");
    const v1Idx = brBlock.indexOf("Code @ step 4");
    expect(v2Idx).toBeLessThan(v1Idx);
    expect(brBlock).toContain(CODE_BY_REGION_V2.split("\n")[0]);
    expect(brBlock).toContain(CODE_BY_REGION_V1.split("\n")[1]);
  });

  test("result history renders prior versions; errored versions render first-line only", () => {
    const params = snapshotWith({
      operators: { overrides: { by_region: { result: { history: { lastK: 1 } } } } },
    });
    const text = summarize(input(), params).text;
    const brBlock = text.slice(text.indexOf("### Operator `by_region`"), text.indexOf("### Operator `report`"));
    // latest result (error @6) renders as Result:; prior version @4 in history
    expect(brBlock).toContain("Result @ step 4:");
    // history error = first line only, no traceback, no code echo
    const hist = brBlock.slice(brBlock.indexOf("Result @ step 4:"));
    expect(hist).toContain("[ERROR] KeyError: 'region' at line 2 of your code");
    expect(hist).not.toContain("Traceback");
  });

  test("history is suppressed under an interleaved trajectory (precedence rule)", () => {
    const base = deltaPreset();
    const params = parseSummarizeParams({
      ...base,
      operators: {
        defaults: base.operators.defaults,
        overrides: { by_region: { property: { codeHistory: 5 }, result: { history: { lastK: 5 } } } },
      },
    });
    const text = summarize(input(), params).text;
    expect(text).not.toContain("Code @ step");
    expect(text).not.toContain("Result @ step");
  });
});

describe("summarize — column-level metric selection", () => {
  test("schemaTypes:false renders the Schema line without type tags", () => {
    const params = snapshotWith({
      operators: { defaults: { result: { latest: { column: { schema: true, schemaTypes: false } } } } },
    });
    const text = summarize(input(), params).text;
    expect(text).toContain("Schema (4 cols): region, amount, price_display, date");
    expect(text).not.toContain("region (str)");
  });
});

describe("summarize — tuple-level sample profiling", () => {
  test("sampleRows caps the TSV per-operator", () => {
    const params = snapshotWith({
      operators: { overrides: { sales: { result: { latest: { tuple: { sampleRows: 2 } } } } } },
    });
    const text = summarize(input(), params).text;
    const salesBlock = text.slice(text.indexOf("### Operator `sales`"), text.indexOf("### Operator `orphan_load`"));
    expect(salesBlock).toContain("$12.50"); // first row kept
    expect(salesBlock).toContain("$130.40"); // last row kept
    expect(salesBlock).not.toContain("$99.00"); // middle dropped
  });

  test("duplicates + fdHints emit sample-based lines when patterns exist", () => {
    // Dedicated scenario: `city → state` holds on the sample (and one row
    // repeats), so both tuple-level hints fire. The rich fixture deliberately
    // has no non-trivial FD (unique columns are suppressed as key-like).
    const sc = buildScenario([
      { id: "u", stepId: 0, role: "user", messageId: "m", content: "load cities" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        messageId: "m",
        parentId: "u",
        content: "load",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "cities" } }],
        toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
      },
    ]);
    sc.storage.createSnapshot("a1", makeWorkflow([{ id: "cities", type: "DataLoading" }]));
    sc.storage.setOperatorResult(
      "a1",
      "cities",
      makeInfo(4, {
        sampleRows: [
          { city: "SF", state: "CA" },
          { city: "LA", state: "CA" },
          { city: "NYC", state: "NY" },
          { city: "SF", state: "CA" },
        ],
      })
    );
    const params = snapshotWith({
      operators: { defaults: { result: { latest: { tuple: { duplicates: true, fdHints: true } } } } },
    });
    const text = summarize(
      { visibleSteps: sc.steps, workflowState: sc.workflowState, snapshotStorage: sc.storage },
      params
    ).text;
    expect(text).toContain("Sample duplicates (over 4 sampled rows): 1 duplicate row");
    expect(text).toContain("Sample FDs (over 4 sampled rows, approximate):");
    expect(text).toContain("`city` → `state`");
  });
});

describe("summarize — trajectory combinations", () => {
  test("observations:'none' keeps Thought/Action but drops Observations (interleaved)", () => {
    const base = deltaPreset();
    const params = parseSummarizeParams({ ...base, trajectory: { ...base.trajectory, observations: "none" } });
    const text = summarize(input(), params).text;
    expect(text).toContain("## Agent Event");
    expect(text).toContain("Action:");
    expect(text).not.toContain("Observation:");
  });

  test("interleaved + currentSnapshot appends # Current Dataflow after the events", () => {
    const base = deltaPreset();
    const params = parseSummarizeParams({ ...base, currentSnapshot: true });
    const text = summarize(input(), params).text;
    expect(text).toContain("# Agent Events");
    expect(text).toContain("# Current Dataflow");
    expect(text.indexOf("# Agent Events")).toBeLessThan(text.indexOf("# Current Dataflow"));
  });

  test("events:'none' + currentSnapshot:false renders the task only", () => {
    const params = parseSummarizeParams({ ...snapshotParams(), currentSnapshot: false });
    const text = summarize(input(), params).text;
    expect(text).toContain("# User Task");
    expect(text).not.toContain("# Current Dataflow");
    expect(text).not.toContain("## Agent Event");
  });
});

describe("summarizePatch — the settings-level door into the param space", () => {
  test("assembleContext applies a deep-partial patch on top of the legacy-derived params", () => {
    const { steps, storage, workflowState } = buildRichScenario();
    const text = contentOf(
      assembleContext(steps, workflowState, storage, {
        summarizePatch: {
          trajectory: { events: "none" },
          currentSnapshot: true,
          operators: {
            defaults: { property: { includeCode: true } },
            overrides: { sales: { result: { latest: { detail: "shape" } } } },
          },
        },
      })
    );
    // patch landed: the current-snapshot layout, default includeCode + per-op shape override
    expect(text).toContain("# Current Dataflow");
    expect(text).not.toContain("## Agent Event");
    expect(text).toContain("Code:");
    expect(text).not.toContain("$12.50");
    expect(text).toContain("Output Table: 1000 rows, 4 cols");
  });

  test("an invalid patch throws a zod error", () => {
    const { steps, storage, workflowState } = buildRichScenario();
    expect(() =>
      assembleContext(steps, workflowState, storage, {
        summarizePatch: { trajectory: { events: "bogus" } } as any,
      })
    ).toThrow();
  });
});

describe("summarize — breakdown", () => {
  test("sections attribute tokens per top-level heading", () => {
    const res = summarize(input(), snapshotParams());
    const titles = res.breakdown.sections.map(s => s.title);
    expect(titles).toContain("User Task");
    expect(titles).toContain("Current Dataflow");
    expect(res.breakdown.totalTokens).toBeGreaterThan(0);
    const sum = res.breakdown.sections.reduce((a, s) => a + s.tokens, 0);
    // Sections cover the whole text (± newline rounding per section)
    expect(Math.abs(sum - res.breakdown.totalTokens)).toBeLessThan(res.breakdown.sections.length + 2);
  });
});
