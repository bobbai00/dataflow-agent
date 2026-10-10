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

import { expect, test } from "bun:test";
import { buildRegisteredNativeSystemPrompt } from "../prompts";
import { ContextMode, type RetrievalView } from "../../types/agent";
import { prepareTurnToolActions } from "../tools/turn-tool";

for (const data of [false, true])
  for (const flow of [false, true])
    test(`turn transport prompt: calls prepare, sections follow the settings, size stays bounded: data=${data}, flow=${flow}`, () => {
      const retrievalViews: RetrievalView[] = data ? ["sample_stats", "full"] : ["sample", "full"];
      const prompt = buildRegisteredNativeSystemPrompt(ContextMode.DELTA, {
        transport: "turn",
        retrievalViews,
        dataEvidence: data,
        flowEvidence: flow,
        fullResultCharLimit: 5000,
        maxOperatorResultCharLimit: 1000,
        maxResultRows: 5,
      });
      expect(prompt).not.toContain("{{");
      expect(prompt).toContain(
        '`summary` (one line), `python` (definitions, or `""`), and `statements` (one per line)'
      );
      expect(prompt).toContain("show result <id>, ... [view]");
      expect(prompt).toContain("reply without calling the tool");
      expect(prompt).toContain("Everything you defined and observed is already in your context");
      // No answer statement, no raw-text framing, no JSON action list.
      expect(prompt).not.toContain("answer: <text to the end of the turn>");
      expect(prompt).not.toContain("````turn");
      expect(prompt).not.toContain('"actions"');
      expect(prompt).not.toContain("Actions run in order.");
      expect(prompt.includes("plus collected column statistics")).toBe(data);
      expect(prompt.includes("Flow statistics report measured effects")).toBe(flow);
      // Every example call is a valid turn for this session.
      const calls = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
      expect(calls.length).toBeGreaterThanOrEqual(2);
      for (const call of calls) {
        expect(Object.keys(call)).toEqual(["summary", "python", "statements"]);
        const result = prepareTurnToolActions(call, retrievalViews);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe("pending");
      }
      // The receipts are real renderer output.
      const receipts = [...prompt.matchAll(/```text\n([\s\S]*?)\n```/g)].map(match => match[1]).join("\n");
      expect(receipts).toContain("## edits applied");
      expect(receipts).toContain("## show result report full");
      expect(receipts.includes("statistics:")).toBe(data);
      expect(receipts.includes("kept=2/4, rejected=2")).toBe(flow);
      expect(prompt).toContain("Reply, without the tool: `Group A: 60; group B: 70.`");
      // The prompt stays within the budget measured for the text transport.
      const examples = prompt.slice(prompt.indexOf("## 4. Worked examples"));
      expect(examples.length).toBeLessThan(flow ? 5000 : 2500);
      expect(prompt.length).toBeLessThan(18000);
    });
