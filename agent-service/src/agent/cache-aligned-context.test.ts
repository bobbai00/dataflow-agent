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
import { extractYourTaskDirective, TexeraAgent } from "./texera-agent";
import { ContextMode, DEFAULT_AGENT_SETTINGS } from "../types/agent";

const RENDERED = `# Catalog (the whole session, one entry per turn)

## Turn 1
### Task
Build the ride ledger.
### Answer
{"rows": 3}

## Turn 2 (in progress)
### Task
Which five rows fall out after the adjustment?

# Your Task

Work on the current turn (turn 2). Earlier turns are the state and conventions
they established. When the current turn's task is solved, end your reply with:

**Final Answer:** <your answer, in the format the task asks for>`;

describe("cacheAlignedContext — the directive lift", () => {
  test("the reminder is the layout's own directive, verbatim", () => {
    const d = extractYourTaskDirective(RENDERED)!;
    expect(d.startsWith("# Your Task")).toBe(true);
    expect(d).toContain("turn 2");
    expect(d).toContain("**Final Answer:**");
    // Verbatim: it is a substring of what the renderer produced, so a layout
    // change can never leave a stale second wording behind.
    expect(RENDERED).toContain(d);
  });

  test("renders without the section yield no reminder (single-turn arms)", () => {
    expect(extractYourTaskDirective("# Agent Events\n\nsome step log")).toBeUndefined();
  });

  test("a later H1 does not get swallowed into the directive", () => {
    const withTail = `${RENDERED}\n\n# Appendix\n\nnot part of the directive`;
    const d = extractYourTaskDirective(withTail)!;
    expect(d).not.toContain("Appendix");
  });
});

describe("cacheAlignedContext — step messages extend, never rewrite", () => {
  function agent(): any {
    return new TexeraAgent({
      id: "a1",
      name: "t",
      modelType: "claude-haiku-4.5",
      settings: { ...DEFAULT_AGENT_SETTINGS, contextMode: ContextMode.DELTA, cacheAlignedContext: true },
    } as any);
  }

  const asstStep = (tool: string, input: any) => ({
    role: "assistant" as const,
    content: [{ type: "tool-call", toolName: tool, input }],
  });
  const toolStep = (out: string) => ({
    role: "tool" as const,
    content: [{ type: "tool-result", output: out }],
  });

  test("each step appends exactly one message and keeps the prefix byte-identical", () => {
    const a = agent();
    a.cacheAlignedMessages = [{ role: "user", content: RENDERED }];
    a.cacheAlignedTaskReminder = extractYourTaskDirective(RENDERED);

    const snapshots: string[] = [];
    for (let step = 1; step <= 3; step++) {
      const msgs = [
        { role: "user" as const, content: RENDERED },
        asstStep("createOrModifyOperator", { operatorId: `op${step}` }),
        toolStep(`operator op${step} added`),
      ];
      a.pendingStepResultsRender = `## op${step}\nOutput Table: ${step * 10} rows, 3 cols`;
      const block = a.buildCacheAlignedStepMessage(msgs);
      expect(block).toBeTruthy();
      a.cacheAlignedMessages.push({ role: "user", content: block });
      snapshots.push(JSON.stringify(a.cacheAlignedMessages));
    }

    // THE cache property: every request is a strict byte-extension of the last.
    expect(a.cacheAlignedMessages.length).toBe(4);
    for (let i = 1; i < snapshots.length; i++) {
      const prevBody = snapshots[i - 1].slice(0, -1); // drop the closing ]
      expect(snapshots[i].startsWith(prevBody)).toBe(true);
    }
  });

  test("a step message carries actions, observations, results AND the reminder", () => {
    const a = agent();
    a.cacheAlignedMessages = [{ role: "user", content: RENDERED }];
    a.cacheAlignedTaskReminder = extractYourTaskDirective(RENDERED);
    a.pendingStepResultsRender = "## pressure_rows\nOutput Table: 23 rows, 9 cols";
    const block = a.buildCacheAlignedStepMessage([
      { role: "user", content: RENDERED },
      asstStep("recallState", { refs: ["pressure_rows (turn 1)"] }),
      toolStep("# pressure_rows (turn 1)\nResult: 23 rows x 9 cols"),
    ])!;
    expect(block).toContain("## Step 1");
    expect(block).toContain("Action: recallState");
    expect(block).toContain("pressure_rows (turn 1)"); // the pull persists here
    expect(block).toContain("Output Table: 23 rows, 9 cols"); // execution result
    expect(block.trimEnd().endsWith("**Final Answer:** <your answer, in the format the task asks for>")).toBe(true);
  });

  test("a step with nothing to report appends nothing", () => {
    const a = agent();
    a.cacheAlignedMessages = [{ role: "user", content: RENDERED }];
    expect(a.buildCacheAlignedStepMessage([{ role: "user", content: RENDERED }])).toBeUndefined();
  });
});
