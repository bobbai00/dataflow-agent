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
import { normalizeVersionRef, TexeraAgent } from "./texera-agent";
import { buildCodeModeSystemPrompt } from "./prompts";
import { ContextMode, DEFAULT_AGENT_SETTINGS } from "../types/agent";

describe("normalizeVersionRef", () => {
  test("canonicalizes spacing variants; rejects non-refs", () => {
    expect(normalizeVersionRef("scores (turn 3)")).toBe("scores (turn 3)");
    expect(normalizeVersionRef("  scores ( turn  3 ) ")).toBe("scores (turn 3)");
    expect(normalizeVersionRef("scores")).toBeUndefined();
  });
});

describe("upstreamValueEcho", () => {
  function agent(): any {
    const a: any = new TexeraAgent({
      id: "a1",
      name: "t",
      modelType: "claude-haiku-4.5",
    } as any);
    // The constructor always starts from DEFAULT_AGENT_SETTINGS (the server
    // applies real settings post-create via updateSettings) — set directly.
    a.settings.contextMode = ContextMode.DELTA;
    a.settings.cacheAlignedContext = true;
    a.settings.upstreamValueEcho = true;
    // stub the turn log: turn 2 holds `combined (turn 2)` with a result
    a.buildTurnLog = () => [
      {
        turn: 2,
        operators: ["combined"],
        workflow: { operators: [], links: [] },
        verbs: new Map([["combined", "added"]]),
        results: new Map([
          [
            "combined",
            {
              operatorId: "combined",
              state: "Completed",
              inputTuples: 10,
              outputTuples: 10,
              result: [{ player: "A", score: 1.5 }, { player: "B", score: 2.5 }],
            },
          ],
        ]),
      },
    ];
    return a;
  }

  const write = (upstreams: string[]) => ({
    toolName: "createOrModifyOperator",
    toolCallId: "x",
    input: { operatorId: "pic", upstreams },
  });

  test("a blind cross-turn write gets that version's values attached", () => {
    const a = agent();
    const echo = a.buildUpstreamValueEcho([write(["combined (turn 2)"])]);
    expect(echo).toContain("combined (turn 2) (auto-attached)");
    expect(echo).toContain("player"); // sample rows present
    expect(echo).toContain("WITHOUT recalling");
  });

  test("a ref recalled this turn is NOT echoed", () => {
    const a = agent();
    a.recalledRefsThisTurn.add("combined (turn 2)");
    expect(a.buildUpstreamValueEcho([write(["combined (turn 2)"])])).toBeUndefined();
  });

  test("each version echoes at most once per turn", () => {
    const a = agent();
    expect(a.buildUpstreamValueEcho([write(["combined (turn 2)"])])).toBeTruthy();
    expect(a.buildUpstreamValueEcho([write(["combined (turn 2)"])])).toBeUndefined();
  });

  test("current-turn and unknown refs echo nothing; flag off echoes nothing", () => {
    const a = agent();
    expect(a.buildUpstreamValueEcho([write(["fresh (turn 9)"])])).toBeUndefined();
    const off = agent();
    off.settings.upstreamValueEcho = false;
    expect(off.buildUpstreamValueEcho([write(["combined (turn 2)"])])).toBeUndefined();
  });
});

describe("answerShapeRule prompt knob", () => {
  const V32 = [
    ContextMode.DELTA, false, false, false, false, false, false, false,
    true, false, true, false, false, false,
  ] as const;
  test("off by default, byte-identical off, section lands when on", () => {
    expect(DEFAULT_AGENT_SETTINGS.answerShapeRule).toBe(false);
    const off = buildCodeModeSystemPrompt(...V32, false);
    const on = buildCodeModeSystemPrompt(...V32, true);
    expect(off).toBe(buildCodeModeSystemPrompt(...V32));
    expect(off).not.toContain("## Answer shape");
    expect(on).toContain("## Answer shape");
    expect(on).toContain("verbatim");
  });
});

describe("catalogDetail prompt knob", () => {
  const V32 = [
    ContextMode.DELTA, false, false, false, false, false, false, false,
    true, false, true, false, false, false, false,
  ] as const;
  test('defaults to "schema"; "code" adds the fragment; gated on versioned mode', () => {
    expect(DEFAULT_AGENT_SETTINGS.catalogDetail).toBe("schema");
    const off = buildCodeModeSystemPrompt(...V32, false);
    const on = buildCodeModeSystemPrompt(...V32, true);
    expect(off).toBe(buildCodeModeSystemPrompt(...V32));
    expect(off).not.toContain("## The catalog shows each version's code");
    expect(on).toContain("## The catalog shows each version's code");
    // a session-layout arm (versionedEnabled=false) never gets the fragment
    const session = [
      ContextMode.DELTA, false, false, false, false, false, false, false,
      false, true, false, false, false, false, false,
    ] as const;
    expect(buildCodeModeSystemPrompt(...session, true)).not.toContain(
      "## The catalog shows each version's code"
    );
  });
});

describe("valueProbeRule prompt knob", () => {
  // (contextMode, compaction, inspect, renderPrefs, codeInSnapshot, provenance,
  //  recall, resume, versioned, session, opRecall, specAudit, foundationVerify,
  //  queryTool, answerShape, catalogCode, valueProbe, catalogValues)
  test("off by default; rides only with the query tool; byte-identical off", () => {
    expect(DEFAULT_AGENT_SETTINGS.valueProbeRule).toBe(false);
    const base = [
      ContextMode.DELTA, false, false, false, false, false, false, false,
      true, false, true, false, false,
    ] as const;
    const noQuery = buildCodeModeSystemPrompt(...base, false, false, false, true);
    const withQuery = buildCodeModeSystemPrompt(...base, true, false, false, true);
    const off = buildCodeModeSystemPrompt(...base, true, false, false, false);
    expect(withQuery).toContain("## Literals must come from the data");
    expect(noQuery).not.toContain("## Literals must come from the data");
    expect(off).not.toContain("## Literals must come from the data");
    expect(off).toBe(buildCodeModeSystemPrompt(...base, true, false, false));
  });

  test('catalogDetail "values" swaps in the demoted read-the-entry-first variant', () => {
    const base = [
      ContextMode.DELTA, false, false, false, false, false, false, false,
      true, false, true, false, false,
    ] as const;
    const probeVariant = buildCodeModeSystemPrompt(...base, true, false, false, true, false);
    const catalogVariant = buildCodeModeSystemPrompt(...base, true, false, false, true, true);
    expect(probeVariant).toContain("LOOK at the actual values first");
    expect(probeVariant).not.toContain("Do not re-query what an entry already prints");
    expect(catalogVariant).toContain("Do not re-query what an entry already prints");
    expect(catalogVariant).not.toContain("LOOK at the actual values first");
    // "values" also carries the catalog-code fragment (code is in the entry)
    expect(catalogVariant).toContain("## The catalog shows each version's code");
  });
});
