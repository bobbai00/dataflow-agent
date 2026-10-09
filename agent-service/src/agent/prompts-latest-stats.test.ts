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
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * SYSTEM PROMPT × CONTEXT MODE — does the prompt describe the layout the agent
 * is actually fed?
 *
 * Motivated by the `Files read:` bug, where the prompt and the renderer had
 * drifted apart silently for months. Verify LATEST with code in snapshot,
 * and prevent retired statistics overlays from returning through the prompt.
 *
 * `buildCodeModeSystemPrompt` positional args on this branch:
 *   (contextMode, compactionEnabled, inspectEnabled, renderPrefsEnabled,
 *    codeInSnapshotEnabled, sourceProvenanceHint)
 * Later branches append recall/resume/versioned/session after these six; the
 * first six are stable, so slot 5 is `codeInSnapshotEnabled` either way.
 */

import { describe, expect, test } from "bun:test";
import { buildCodeModeSystemPrompt } from "./prompts";
import { ContextMode } from "../types/agent";

/** The C4Sample2k shape: LATEST, code in snapshot on. */
const latestWithCode = () => buildCodeModeSystemPrompt(ContextMode.LATEST, false, false, false, /*code*/ true, false);
/** LATEST, code-blind (the only configuration where summaries carry the logic). */
const latestNoCode = () => buildCodeModeSystemPrompt(ContextMode.LATEST, false, false, false, /*code*/ false, false);
/** DELTA — never code-blind: every Action carries the code inline. */
const delta = () => buildCodeModeSystemPrompt(ContextMode.DELTA, false, false, false, true, false);

describe("LATEST: the prompt describes the current layout", () => {
  test("selects the code-visible LATEST fragment, not the code-blind one", () => {
    const p = latestWithCode();
    expect(p).toContain("Each operator's current code **is** shown");
    expect(p).not.toContain("Operator code is **not** shown for successful operators");
  });

  test("describes `# Current Dataflow` and states there is no action history", () => {
    const p = latestWithCode();
    expect(p).toContain("**`# Current Dataflow`**");
    expect(p).toContain("No action history is shown");
  });

  test("does NOT describe the DELTA event log — the arm never renders one", () => {
    const p = latestWithCode();
    expect(p).not.toContain("**`# Agent Events`**");
    expect(p).not.toContain("## Agent Event N");
  });

  test("code-blind LATEST gets the other fragment (the switch really switches)", () => {
    const p = latestNoCode();
    expect(p).toContain("Operator code is **not** shown for successful operators");
    expect(p).not.toContain("Each operator's current code **is** shown");
  });

  test("DELTA gets the event-log fragment, not either LATEST one", () => {
    const p = delta();
    expect(p).toContain("**`# Agent Events`**");
    expect(p).not.toContain("**`# Current Dataflow`**");
  });

  test("the three modes produce three distinct prompts", () => {
    const [a, b, c] = [latestWithCode(), latestNoCode(), delta()];
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });

  test("no unreplaced template placeholders survive", () => {
    for (const p of [latestWithCode(), latestNoCode(), delta()]) {
      expect(p).not.toMatch(/\{\{[A-Z_]+\}\}/);
    }
  });

  test("the worked example shows a LATEST-shaped observation", () => {
    const p = latestWithCode();
    expect(p).toContain("Observation — `# Current Dataflow`");
    // ZERO mentions of the DELTA event log. The old "Context optimization"
    // principle hedged with "the `# Current Dataflow` snapshot, or the
    // `# Agent Events` history" — one generic sentence covering both modes,
    // which named a section a LATEST agent never sees. Each variant now speaks
    // only about the layout its arm actually gets.
    expect((p.match(/# Agent Events/g) ?? []).length).toBe(0);
  });

  test("retired statistics overlays are not advertised", () => {
    const p = latestWithCode();
    expect(p).not.toContain("Column Schema and stats:");
    expect(p).not.toContain("Output Table profile:");
    expect(p).not.toContain("You MUST examine stats");
    expect(p).toContain("Schema (N cols)");
  });
});

/**
 * CODE-VISIBILITY PRINCIPLES — the prompt must not contradict itself.
 *
 * Three Key Principles used to be unconditional prose written for the
 * code-blind case, so every code-visible arm was told both that its code is
 * shown (context-format fragment) and that its code is gone (principles):
 *   "code is not preserved in history" / "but not its code" /
 *   "Your code is discarded after each step".
 * They are now selected by `noCode`, the same predicate `isCodeShownToAgent()`
 * uses, so DELTA — which carries code inline in every Action — is covered too.
 */
const CODE_BLIND_CLAIMS = [
  "code is not preserved in history",
  "but not its code",
  "Your code is discarded after each step",
];

describe("code-visibility principles match what the agent can actually see", () => {
  test("LATEST + code: no code-blind claim survives", () => {
    const p = latestWithCode();
    expect(p).toContain("Each operator's current code **is** shown");
    for (const claim of CODE_BLIND_CLAIMS) expect(p).not.toContain(claim);
  });

  test("DELTA: no code-blind claim either — Actions carry the code inline", () => {
    const p = delta();
    for (const claim of CODE_BLIND_CLAIMS) expect(p).not.toContain(claim);
  });

  test("LATEST code-blind: the original prose is preserved exactly", () => {
    const p = latestNoCode();
    expect(p).toContain("Operator code is **not** shown for successful operators");
    for (const claim of CODE_BLIND_CLAIMS) expect(p).toContain(claim);
  });

  test("code-visible arms are told to READ the code before rewriting", () => {
    for (const p of [latestWithCode(), delta()]) {
      expect(p).toContain("READ the code shown for it");
      expect(p).toContain("send the complete function every time");
    }
  });

  test("code-visible summaries are brief; code-blind summaries carry the logic", () => {
    expect(latestWithCode()).toContain("Do NOT restate the detailed logic");
    expect(latestNoCode()).toContain("Always include the significant processing logic");
    // and they must not both appear in either
    expect(latestWithCode()).not.toContain("Always include the significant processing logic");
    expect(latestNoCode()).not.toContain("Do NOT restate the detailed logic");
  });

  test("the shared advice survives in BOTH variants (no accidental drop)", () => {
    for (const p of [latestWithCode(), latestNoCode()]) {
      expect(p).toContain("NO inline comments or docstrings");
      expect(p).toContain("do NOT re-`import pandas as pd`");
      expect(p).toContain("OWN isolated execution space");
      expect(p).toContain("name the input operator(s) as the grammatical subject");
    }
  });

  test("the prompt agrees with the tool schema's summary guidance", () => {
    // code-op-tools picks its `summary` description with the same predicate:
    // code shown -> "Do NOT restate the detailed logic"; code-blind -> detailed.
    expect(latestWithCode()).toContain("one short line");
    expect(latestNoCode()).toContain("your only record");
  });
});
