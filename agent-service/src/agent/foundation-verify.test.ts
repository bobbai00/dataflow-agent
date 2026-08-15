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

import { describe, expect, test } from "bun:test";
import { buildCodeModeSystemPrompt } from "./prompts";
import { ContextMode, DEFAULT_AGENT_SETTINGS } from "../types/agent";

const MARKER = "## Foundations get verified when they are built";

/** v3.2 catalog argument list (versioned + opRecall), one flag from the test's. */
const V32 = [
  ContextMode.DELTA,
  false, // compaction
  false, // inspect
  false, // renderPrefs
  false, // codeInSnapshot
  false, // sourceProvenanceHint
  false, // recall
  false, // resume
  true, // versioned
  false, // session
  true, // opRecall
  false, // specAudit
] as const;

/** Session-layout argument list — the fragment must be layout-agnostic. */
const SESSION = [
  ContextMode.DELTA,
  false,
  false,
  false,
  false,
  false,
  false, // recall
  false, // resume
  false, // versioned
  true, // session
  false, // opRecall
  false, // specAudit
] as const;

describe("foundationVerify prompt knob", () => {
  test("off by default and byte-identical when off", () => {
    expect(DEFAULT_AGENT_SETTINGS.foundationVerify).toBe(false);
    expect(buildCodeModeSystemPrompt(...V32, false)).toBe(buildCodeModeSystemPrompt(...V32));
    expect(buildCodeModeSystemPrompt(...V32)).not.toContain(MARKER);
  });

  test("on — the section lands under BOTH layouts (it is layout-agnostic)", () => {
    for (const args of [V32, SESSION] as (typeof V32)[]) {
      const off = buildCodeModeSystemPrompt(...args, false);
      const on = buildCodeModeSystemPrompt(...args, true);
      expect(off).not.toContain(MARKER);
      expect(on).toContain(MARKER);
      // The discipline references only vocabulary the system already renders.
      expect(on).toContain("denominator");
      expect(on).toContain("rows");
      // And it is an addition, not a replacement of the layout fragment.
      expect(on.length).toBeGreaterThan(off.length);
    }
  });

  test("composes with specAudit without either fragment displacing the other", () => {
    const both = buildCodeModeSystemPrompt(
      ContextMode.DELTA, false, false, false, false, false, false, false,
      true, false, true,
      true, // specAudit
      true // foundationVerify
    );
    expect(both).toContain(MARKER);
    expect(both).toContain("It does not mean a mistake has to stand");
  });
});
