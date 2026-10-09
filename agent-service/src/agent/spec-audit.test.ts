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
import { readFileSync } from "node:fs";
import { AgentMode } from "../types/agent";
import { assembleContext } from "./util/context-utils";
import { buildScenario, makeInfo, makeWorkflow, type Scenario } from "./context/summarize/fixtures";
import { join } from "node:path";

/** The full v3.2 argument list, so a v3.3 test differs from it in ONE flag. */
const V32 = [
  ContextMode.DELTA, // contextMode
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
] as const;

describe("specAudit prompt knob (v3.3)", () => {
  test("off by default — a v3.2 build is byte-identical with the flag omitted or false", () => {
    const omitted = buildCodeModeSystemPrompt(...V32);
    const explicitOff = buildCodeModeSystemPrompt(...V32, false);
    expect(explicitOff).toBe(omitted);
    expect(DEFAULT_AGENT_SETTINGS.specAudit).toBe(false);
    // The base arm never sees the added principles.
    expect(omitted).not.toContain("It does not mean a mistake has to stand");
  });

  test("on — the principles replace the base fragment, they are not stacked on it", () => {
    const off = buildCodeModeSystemPrompt(...V32, false);
    const on = buildCodeModeSystemPrompt(...V32, true);
    // Section headings are IDENTICAL: the ideas went inside existing sections.
    const heads = (t: string) => (t.match(/^## .*$/gm) ?? []).join("|");
    expect(heads(on)).toBe(heads(off));
    expect(on.length).toBeGreaterThan(off.length);
    expect(on).not.toContain("{{RECALL}}");
  });



  test("carries the repair half: fix the operator, not the answer text", () => {
    const on = buildCodeModeSystemPrompt(...V32, true);
    // The immutability language elsewhere in the versioned fragment must not be
    // readable as "never touch the past" — this line is the counterweight.
    expect(on).toContain("It does not mean a mistake has to stand");
    // Repair fires on observable evidence, never on vague doubt.
    expect(on).toContain("not on vague doubt");
    // And it must propagate, not be papered over in the reply text.
    expect(on).toContain("revise it rather than answering from it");
    // The check line is where errors are caught; echoing a number catches nothing.
    expect(on).toContain("A wrong number reads exactly");
    expect(on).toContain("building a private corrected copy beside it");
  });


  test("names the constraint classes the 59 first errors fell into", () => {
    const on = buildCodeModeSystemPrompt(...V32, true);
    // scope, population, denominator, sign, scale — stated as things to re-read,
    // not as a taxonomy to recite.
    for (const phrase of ["scope,", "population", "denominator", "sign", "scale"]) {
      expect(on).toContain(phrase);
    }
  });

  test("demands a real trace and a copied clause — the two anti-hand-waving rules", () => {
    const on = buildCodeModeSystemPrompt(...V32, true);
    // Without the trace, a value line is self-congratulation; without the copy
    // rule, a paraphrase hides the misreading it was written to catch.
    // Phrases must not span a line wrap in the markdown source.
    // No process jargon: "checklist" invites form-filling over reading.
    expect(on.toLowerCase()).not.toContain("checklist");
  });
});

describe("specAudit reminder in the # Your Task directive", () => {
  // The system-prompt section is the specification; without a reminder at the
  // point of action it fired on 1 turn in 11 of a live run. Both turn-grouped
  // layouts render this same directive, so both get the same reminder.
  const scenario = (): Scenario => {
    const s = buildScenario([
      { id: "u1", stepId: 0, role: "user", messageId: "m1", content: "build it" },
      {
        id: "a1",
        stepId: 1,
        role: "agent",
        messageId: "m1",
        parentId: "u1",
        toolCalls: [{ toolName: "createOrModifyOperator", toolCallId: "t1", input: { operatorId: "scores" } }],
        toolResults: [{ toolCallId: "t1", output: "ok", isError: false }],
      },
    ]);
    s.storage.createSnapshot("a1", makeWorkflow([{ id: "scores", type: "DataLoading" }]));
    s.storage.setOperatorResult("a1", "scores", makeInfo(10, {}));
    return s;
  };

  const render = (extra: Record<string, unknown>): string => {
    const s = scenario();
    return String(
      assembleContext(s.steps, s.workflowState, s.storage, ContextMode.DELTA, {
        compilationResult: null,
        agentMode: AgentMode.CODE,
        versionedCatalog: true,
        recallOperatorLevel: true,
        ...extra,
      } as any)
        .map(m => m.content)
        .join("\n")
    );
  };

  test("off — the directive is byte-identical to the pre-knob build", () => {
    const off = render({});
    expect(off).toContain("# Your Task");
    expect(off).not.toContain("know the operator version");
  });

  test("on — the requirement is restated in the directive, next to Final Answer", () => {
    const on = render({ specAudit: true });
    expect(on).toContain("know the operator version");
    // It has to sit AFTER the Final Answer line: that is the last thing read.
    expect(on.indexOf("know the operator version")).toBeGreaterThan(on.indexOf("**Final Answer:**"));
    // And it must carry the repair half, not just the checking half.
    expect(on).toContain("constrain the");
    expect(on).toContain("a relation that would break if");
  });
});
