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

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { AgentMode, ContextMode, type AgentSettings } from "../types/agent";
import { buildCodeModeSystemPrompt, buildNativeModeSystemPrompt } from "./prompts";
import { TexeraAgent } from "./texera-agent";

const layouts: AgentSettings["messageLayout"][] = [undefined, "block", "blockSplit", "native", "opSplit", "turnSplit"];

function makeAgent() {
  return new TexeraAgent({
    agentId: "no-inspect-result-test",
    modelType: "test",
    driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
    contextAssembler: () => [],
  });
}

function assertRemoved(agent: TexeraAgent) {
  expect((agent as any).tools.inspectResult).toBeUndefined();
  expect(agent.getSettings().enableInspectTool).toBe(false);
  expect(agent.getSettings().systemPrompt).not.toContain("inspectResult");
  expect(agent.getSettings().systemPrompt).not.toContain("# Inspections");
  expect(JSON.stringify(agent.getSystemInfo())).not.toContain("inspectResult");
}

describe("inspectResult removal", () => {
  test("has no executable factory or model-facing prompt fragment", () => {
    expect(existsSync(new URL("./tools/inspect-result-tool.ts", import.meta.url))).toBe(false);
    expect(existsSync(new URL("./prompts/inspect.md", import.meta.url))).toBe(false);
  });

  test("cannot be enabled initially or through mode, layout, statistics and live setting changes", () => {
    const agent = makeAgent();
    assertRemoved(agent);
    for (const agentMode of Object.values(AgentMode)) {
      for (const nativeToolMode of ["typed", "batch"] as const) {
        for (const contextMode of Object.values(ContextMode)) {
          for (const messageLayout of layouts) {
            for (const grouping of [
              { sessionTurns: false, versionedMode: false },
              { sessionTurns: true, versionedMode: false },
              { sessionTurns: false, versionedMode: true },
            ]) {
              for (const enableInspectTool of [true, false]) {
                agent.updateSettings({
                  agentMode,
                  nativeToolMode,
                  contextMode,
                  messageLayout,
                  ...grouping,
                  enableInspectTool,
                  columnStats: enableInspectTool,
                  dataLevel: enableInspectTool ? 2 : 0,
                });
                assertRemoved(agent);
                if (agentMode === AgentMode.NATIVE && nativeToolMode === "batch") {
                  expect(Object.keys((agent as any).tools).sort()).toEqual(["dataflow", "deleteOperator"]);
                }
              }
            }
          }
        }
      }
    }
    agent.updateSettings({ disabledTools: new Set(["inspectResult"]), enableInspectTool: true });
    assertRemoved(agent);
    agent.updateSettings({ disabledTools: new Set(), enableInspectTool: true });
    assertRemoved(agent);
  });

  test("legacy positional prompt arguments cannot advertise result inspection", () => {
    for (const contextMode of Object.values(ContextMode)) {
      expect(buildCodeModeSystemPrompt(contextMode, false, true)).toBe(
        buildCodeModeSystemPrompt(contextMode, false, false)
      );
      for (const resultSelection of ["all", "rule", "scoped"] as const) {
        for (const layout of [
          {},
          { batch: true },
          { session: true },
          { versioned: true },
          { batch: true, recall: true },
          { batch: true, messageLayout: "block" as const },
        ]) {
          const prompt = buildNativeModeSystemPrompt(contextMode, true, resultSelection, layout);
          expect(prompt).toBe(buildNativeModeSystemPrompt(contextMode, false, resultSelection, layout));
          expect(prompt).not.toContain("inspectResult");
          expect(prompt).not.toContain("stats: true");
          expect(prompt).not.toContain("# Inspections");
        }
      }
    }
  });
});
