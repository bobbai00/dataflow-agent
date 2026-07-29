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
import { ContextMode } from "../types/agent";

describe("sourceProvenanceHint prompt principle", () => {
  test("flag off (default) — prompt is byte-identical to the pre-flag build", () => {
    const explicitOff = buildCodeModeSystemPrompt(ContextMode.LATEST, false, false, false, true, false);
    const defaulted = buildCodeModeSystemPrompt(ContextMode.LATEST, false, false, false, true);
    expect(explicitOff).toBe(defaulted);
    expect(explicitOff).not.toContain("__source_file");
    expect(explicitOff).not.toContain("{{PROVENANCE}}"); // placeholder never leaks
  });

  test("flag on — the bullet appears exactly once, after the subsetting principle", () => {
    const on = buildCodeModeSystemPrompt(ContextMode.LATEST, false, false, false, true, true);
    const hits = on.split("Multi-file loads must carry provenance").length - 1;
    expect(hits).toBe(1);
    expect(on).toContain("__source_file");
    const anchor = on.indexOf("load all relevant files first");
    const bullet = on.indexOf("Multi-file loads must carry provenance");
    expect(anchor).toBeGreaterThan(-1);
    expect(bullet).toBeGreaterThan(anchor);
    expect(on).not.toContain("{{PROVENANCE}}");
  });

  test("flag on in DELTA mode — bullet present there too (principles are mode-shared)", () => {
    const on = buildCodeModeSystemPrompt(ContextMode.DELTA, false, false, false, true, true);
    expect(on).toContain("__source_file");
  });
});
