/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { TexeraAgent, type TexeraAgentConfig } from "../texera-agent";
import { AgentMode } from "../../types/agent";
import { buildNativeModeSystemPrompt } from "../prompts";
import { availableRetrievalViews } from "../native/retrieval";
import { createDataflowTool } from "../tools/dataflow-actions";

/** Preserve historical action/history fixtures without restoring a production
 * legacy switch. Only this agent instance uses the old tool and prompt; its
 * state, model loop, execution, snapshots and rendering are the real code. */
export function createLegacyNativeAgent(config: TexeraAgentConfig): TexeraAgent {
  const agent: TexeraAgent = new TexeraAgent({
    ...config,
    systemPromptBuilder:
      config.systemPromptBuilder ??
      ((_dialect, mode): string => {
        const settings = agent.getSettings();
        return buildNativeModeSystemPrompt(mode, {
          ...settings,
          multiTask: settings.multiTask || (agent as any).taskNumberOffset > 0,
          resume: settings.enableResumeTool,
          compact: settings.enableCompactTool,
          versioned: settings.versionedMode,
          session: settings.sessionTurns,
          recall: settings.enableRecallTool,
          reasoning: settings.dataflowReasoning,
          checks: settings.nativeChecks,
          retrievalViews: availableRetrievalViews(settings),
        });
      }),
  });
  const internal = agent as any;
  const createTools = internal.createTools.bind(agent);
  internal.createTools = () => {
    const tools = createTools();
    const settings = agent.getSettings();
    if (settings.agentMode === AgentMode.NATIVE) {
      tools.dataflow = createDataflowTool(
        availableRetrievalViews(settings),
        settings.stateHistory,
        settings.multiTask || settings.stateHistory,
        settings.nativePromptDetail === "on_demand"
      );
      // Service-owned seed calls use the active empty-definition envelope.
      // Historical fixtures still contain legacy graph text; adapt only this
      // no-op field here instead of adding production protocol guessing.
      const execute = tools.dataflow.execute;
      tools.dataflow.execute = (input: any, options: any) =>
        execute(
          {
            ...input,
            actions: input.actions?.map((action: any) => {
              if (action.type !== "edit" || action.python !== "") return action;
              const { python: _python, ...historical } = action;
              return historical;
            }),
          },
          options
        );
    }
    return tools;
  };
  internal.tools = internal.createTools();
  internal.rebuildSystemPrompt();
  return agent;
}
