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
import { resolveOperatorParams } from "../summarize/params";
import { summarize } from "../summarize/summarize";
import { buildRichScenario } from "../summarize/fixtures";
import { buildTunerManifest } from "./manifest";
import { translateTunerOutput, TunerOutputSchema, type TunerOutput } from "./tuner";

function dossierOf() {
  const { steps, storage } = buildRichScenario();
  return buildDossier(steps, storage);
}

describe("buildTunerManifest", () => {
  const m = buildTunerManifest(dossierOf(), "Compute revenue per region; which region is max?");

  test("lists every leaf operator with role/state/shape and upstreams", () => {
    expect(m.operatorIds.sort()).toEqual(["by_region", "legacy_data", "orphan_load", "report", "sales"]);
    expect(m.text).toContain("# Task the agent is solving");
    expect(m.text).toContain("Compute revenue per region");
    expect(m.text).toContain("`by_region` (DataProcessing)");
    expect(m.text).toContain("ERRORING"); // by_region errored
    expect(m.text).toContain("<- `sales`"); // by_region's upstream
    expect(m.text).toContain("summary:");
  });

  test("does not embed raw result tables (stays cheap)", () => {
    // The 1000-row sales sample must NOT appear — only its shape.
    expect(m.text).not.toContain("$12.50");
    expect(m.text).toContain("result=1000×4");
  });
});

describe("TunerOutputSchema", () => {
  test("parses a valid plan and defaults reasoningReplayK", () => {
    const o = TunerOutputSchema.parse({ operators: [{ operatorId: "a", detail: "shape" }] });
    expect(o.reasoningReplayK).toBe(8);
  });
  test("rejects an unknown detail level", () => {
    expect(() => TunerOutputSchema.parse({ operators: [{ operatorId: "a", detail: "huge" }] })).toThrow();
  });
});

describe("translateTunerOutput → SummarizeParams", () => {
  const output: TunerOutput = {
    operators: [
      { operatorId: "legacy_data", detail: "omit" },
      { operatorId: "orphan_load", detail: "omit" },
      { operatorId: "sales", detail: "sample" },
      { operatorId: "by_region", detail: "rich" },
      { operatorId: "report", detail: "shape" },
    ],
    reasoningReplayK: 5,
  };
  const params = translateTunerOutput(output, { model: "gpt-5.4", sampleRows: 8, richRows: 12 });

  test("maps each detail level to the right per-operator params", () => {
    expect(resolveOperatorParams(params, "legacy_data").result.latest.detail).toBe("omit");
    expect(resolveOperatorParams(params, "orphan_load").result.latest.detail).toBe("omit");
    const sales = resolveOperatorParams(params, "sales");
    expect(sales.result.latest.detail).toBe("sample");
    expect(sales.result.latest.tuple.sampleRows).toBe(8);
    const br = resolveOperatorParams(params, "by_region");
    expect(br.result.latest.detail).toBe("sample");
    expect(br.result.latest.tuple.sampleRows).toBe(12);
    expect(br.property.includeCode).toBe(true);
    expect(Object.hasOwn(br.result.latest.column ?? {}, "stats")).toBe(false);
    expect(Object.hasOwn(br.result.latest.column ?? {}, "structuralHints")).toBe(false);
    expect(resolveOperatorParams(params, "report").result.latest.detail).toBe("shape");
  });

  test("reasoningReplayK flows through", () => {
    expect(params.trajectory.reasoningReplayK).toBe(5);
  });

  test("unmentioned operators fall back to the cheap default (shape+schema)", () => {
    const other = resolveOperatorParams(params, "some_other_op");
    expect(other.result.latest.detail).toBe("shape");
    expect(other.result.latest.column.schema).toBe(true);
  });

  test("wide-table guardrail clamps sample/rich → shape, but respects omit", () => {
    const wide = new Set(["sales", "by_region", "legacy_data"]);
    const clamped = translateTunerOutput(
      {
        operators: [
          { operatorId: "sales", detail: "sample" }, // wide → shape
          { operatorId: "by_region", detail: "rich" }, // wide → shape
          { operatorId: "legacy_data", detail: "omit" }, // wide but omit wins
          { operatorId: "report", detail: "sample" }, // narrow → unchanged
        ],
        reasoningReplayK: 8,
      },
      { model: "gpt-5.4" },
      wide
    );
    expect(resolveOperatorParams(clamped, "sales").result.latest.detail).toBe("shape");
    expect(resolveOperatorParams(clamped, "by_region").result.latest.detail).toBe("shape");
    expect(resolveOperatorParams(clamped, "legacy_data").result.latest.detail).toBe("omit");
    expect(resolveOperatorParams(clamped, "report").result.latest.detail).toBe("sample");
  });

  test("renders end-to-end: omitted ops drop their table, rich op shows code+stats", () => {
    const { steps, storage, workflowState } = buildRichScenario();
    const dossier = buildDossier(steps, storage);
    const text = summarize(
      { visibleSteps: steps, workflowState, snapshotStorage: storage, compilationResult: null, dossier },
      params
    ).text;
    // legacy_data omitted → no Result table for it
    const legacyBlock = text.slice(text.indexOf("### Operator `legacy_data`"), text.indexOf("### Operator `sales`"));
    expect(legacyBlock).not.toContain("Output Table:");
    // by_region (rich) → code block present
    const brBlock = text.slice(text.indexOf("### Operator `by_region`"), text.indexOf("### Operator `report`"));
    expect(brBlock).toContain("Operator code:"); // error render carries code
  });
});
