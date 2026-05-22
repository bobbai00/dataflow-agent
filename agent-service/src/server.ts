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

import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { createOpenAI } from "@ai-sdk/openai";
import { TexeraAgent } from "./agent/texera-agent";
import { getBackendConfig } from "./api/backend-api";
import { extractUserFromToken, validateToken } from "./api/auth-api";
import { WorkflowSystemMetadata } from "./agent/util/workflow-system-metadata";
import { env } from "./config/env";
import { createLogger } from "./logger";
import { VercelToolUseDriver } from "./agent/llm-drivers/vercel-tool-use-driver";
import { LocalReactTextDriver } from "./agent/llm-drivers/local-react-text-driver";
import type { ContextAssembler, LLMDriver } from "./agent/llm-drivers/types";
import { assembleContext } from "./agent/util/context-utils";
import { assembleLocalReactContext } from "./agent/util/context-utils-local-react";
import { buildLocalReactSystemPrompt } from "./agent/prompts";

const log = createLogger("Server");
const wsLog = createLogger("WS");
import type {
  AgentInfo,
  AgentDelegateConfig,
  AgentDriverKind,
  CreateAgentRequest,
  UpdateAgentSettingsRequest,
  AgentSettingsApi,
  ReActStep,
} from "./types/agent";
import { AgentMode, ContextMode, OperatorResultSerializationMode } from "./types/agent";

/**
 * Pick the driver from an optional explicit choice or fall back to
 * `modelType`. The local LLM served via the dknet gateway uses the
 * text-mode ReAct format with tool definitions baked into its training
 * prompt; every other model speaks the OpenAI-compatible tool-use API.
 */
function resolveDriverKind(modelType: string, explicit?: AgentDriverKind): AgentDriverKind {
  if (explicit) return explicit;
  return modelType === "local-llm" ? "local-react" : "vercel-tool-use";
}

function buildContextAssembler(kind: AgentDriverKind): ContextAssembler {
  if (kind === "local-react") {
    return ({ visibleSteps, workflowState, snapshotStorage, settings }) =>
      assembleLocalReactContext(visibleSteps, workflowState, snapshotStorage, {
        statsEnabled: settings.statsEnabled,
      });
  }
  return ({ visibleSteps, workflowState, snapshotStorage, settings, compilationResult }) =>
    assembleContext(visibleSteps, workflowState, snapshotStorage, settings.contextMode, {
      compilationResult,
      agentMode: settings.agentMode,
      statsEnabled: settings.statsEnabled,
    });
}

const agentStore = new Map<string, TexeraAgent>();
/** Tracks which driver each agent was constructed with so `getAgentInfo`
 *  can echo it back to the UI. Populated by `createAgentInstance`. */
const agentDrivers = new Map<string, AgentDriverKind>();
let agentCounter = 0;

async function createAgentInstance(
  modelType: string,
  customName?: string,
  delegateConfig?: AgentDelegateConfig,
  explicitDriver?: AgentDriverKind
): Promise<{ agentId: string; agent: TexeraAgent }> {
  const agentId = `agent-${++agentCounter}`;
  const config = getBackendConfig();

  const openai = createOpenAI({
    baseURL: `${config.modelsEndpoint}/api`,
    apiKey: env.LLM_API_KEY,
  });

  // Reasoning effort variants are configured as separate model entries in litellm-config.yaml
  // with extra_body to inject reasoning_effort, bypassing LiteLLM's param validation.
  const driverKind = resolveDriverKind(modelType, explicitDriver);
  const model = openai.chat(modelType);
  const driver: LLMDriver =
    driverKind === "local-react" ? new LocalReactTextDriver({ model }) : new VercelToolUseDriver({ model });
  const contextAssembler = buildContextAssembler(driverKind);

  const agent = new TexeraAgent({
    driver,
    contextAssembler,
    modelType,
    agentId,
    agentName: customName || "Bob",
    // local-react needs the training-time system prompt verbatim on every
    // wire call; other drivers fall back to the mode-based builders.
    systemPromptBuilder: driverKind === "local-react" ? buildLocalReactSystemPrompt : undefined,
  });

  // Single bootstrap: metadata + (in delegate mode) workflow load and a
  // synthetic `initialize` step that anchors both the workflow snapshot and
  // every per-operator baseline result.
  await agent.initialize(delegateConfig);

  agentStore.set(agentId, agent);
  agentDrivers.set(agentId, driverKind);
  log.info({ agentId, modelType, driver: driverKind, delegate: !!delegateConfig }, "created agent");

  return { agentId, agent };
}

function getAgentInfo(agentId: string, agent: TexeraAgent): AgentInfo {
  const agentSettings = agent.getSettings();
  const settingsApi: AgentSettingsApi = {
    maxOperatorResultCharLimit: agentSettings.maxOperatorResultCharLimit,
    maxOperatorResultCellCharLimit: agentSettings.maxOperatorResultCellCharLimit,
    operatorResultSerializationMode: agentSettings.operatorResultSerializationMode,
    toolTimeoutSeconds: Math.round(agentSettings.toolTimeoutMs / 1000),
    executionTimeoutMinutes: Math.round(agentSettings.executionTimeoutMs / 60000),
    disabledTools: Array.from(agentSettings.disabledTools),
    maxSteps: agentSettings.maxSteps,
    allowedOperatorTypes: agentSettings.allowedOperatorTypes,
    agentMode: agentSettings.agentMode,
    contextMode: agentSettings.contextMode,
    parallelToolCalls: agentSettings.parallelToolCalls,
    statsEnabled: agentSettings.statsEnabled,
  };

  const delegateConfig = agent.getDelegateConfig();

  return {
    id: agentId,
    name: agent.agentName,
    modelType: agent.modelType,
    driver: agentDrivers.get(agentId) ?? "vercel-tool-use",
    state: agent.getState(),
    createdAt: agent.createdAt,
    delegate: delegateConfig
      ? {
          userToken: "***",
          userInfo: delegateConfig.userInfo,
          workflowId: delegateConfig.workflowId,
          workflowName: delegateConfig.workflowName,
          computingUnitId: delegateConfig.computingUnitId,
        }
      : undefined,
    settings: settingsApi,
  };
}

function getAgent(agentId: string): TexeraAgent {
  const agent = agentStore.get(agentId);
  if (!agent) {
    throw new Error("Agent not found");
  }
  return agent;
}

const agentsRouter = new Elysia({ prefix: "/agents" })
  // Error handler must live on the same Elysia instance whose routes throw, or
  // its scope will not see the errors. Elysia 1.x defaults to local scoping for
  // .onError, so attach here rather than on the outer app.
  .onError(({ error, set }) => {
    log.error({ err: error }, "request error");
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage === "Agent not found") {
      set.status = 404;
      return { error: "Agent not found" };
    }
    if (errorMessage === "Invalid or expired token") {
      set.status = 401;
      return { error: "Invalid or expired token" };
    }
    if (errorMessage === "modelType is required") {
      set.status = 400;
      return { error: "modelType is required" };
    }
    set.status = 500;
    return { error: errorMessage || "Internal server error" };
  })
  .get("/", () => {
    const agentList = Array.from(agentStore.entries()).map(([id, agent]) => getAgentInfo(id, agent));
    return { agents: agentList };
  })

  .post(
    "/",
    async ({ body }) => {
      const { modelType, name, userToken, workflowId, computingUnitId, settings, driver } = body as CreateAgentRequest;

      if (!modelType) {
        throw new Error("modelType is required");
      }

      let delegateConfig: AgentDelegateConfig | undefined;
      if (userToken) {
        if (!validateToken(userToken)) {
          throw new Error("Invalid or expired token");
        }

        const userInfo = extractUserFromToken(userToken);
        delegateConfig = {
          userToken,
          userInfo,
          workflowId,
          computingUnitId,
        };
      }

      const { agentId, agent } = await createAgentInstance(modelType, name, delegateConfig, driver);

      if (settings) {
        log.info(
          {
            agentId,
            maxOperatorResultCharLimit: settings.maxOperatorResultCharLimit,
            maxOperatorResultCellCharLimit: settings.maxOperatorResultCellCharLimit,
          },
          "applying initial agent settings"
        );
        agent.updateSettings({
          maxOperatorResultCharLimit: settings.maxOperatorResultCharLimit,
          maxOperatorResultCellCharLimit: settings.maxOperatorResultCellCharLimit,
          operatorResultSerializationMode: settings.operatorResultSerializationMode
            ? (settings.operatorResultSerializationMode as OperatorResultSerializationMode)
            : undefined,
          toolTimeoutMs: settings.toolTimeoutSeconds ? settings.toolTimeoutSeconds * 1000 : undefined,
          executionTimeoutMs: settings.executionTimeoutMinutes ? settings.executionTimeoutMinutes * 60000 : undefined,
          disabledTools: settings.disabledTools ? new Set(settings.disabledTools) : undefined,
          maxSteps: settings.maxSteps,
          allowedOperatorTypes: settings.allowedOperatorTypes,
          agentMode: settings.agentMode ? (settings.agentMode as AgentMode) : undefined,
          contextMode: settings.contextMode ? (settings.contextMode as ContextMode) : undefined,
          parallelToolCalls: settings.parallelToolCalls,
          statsEnabled: settings.statsEnabled,
        });
      }

      return getAgentInfo(agentId, agent);
    },
    {
      body: t.Object({
        modelType: t.String(),
        name: t.Optional(t.String()),
        userToken: t.Optional(t.String()),
        workflowId: t.Optional(t.Number()),
        computingUnitId: t.Optional(t.Number()),
        settings: t.Optional(
          t.Object({
            maxOperatorResultCharLimit: t.Optional(t.Number()),
            maxOperatorResultCellCharLimit: t.Optional(t.Number()),
            operatorResultSerializationMode: t.Optional(t.Literal("tsv")),
            toolTimeoutSeconds: t.Optional(t.Number()),
            executionTimeoutMinutes: t.Optional(t.Number()),
            disabledTools: t.Optional(t.Array(t.String())),
            maxSteps: t.Optional(t.Number()),
            allowedOperatorTypes: t.Optional(t.Array(t.String())),
            agentMode: t.Optional(t.Union([t.Literal("code"), t.Literal("general")])),
            contextMode: t.Optional(t.Union([t.Literal("full"), t.Literal("delta"), t.Literal("latest")])),
            parallelToolCalls: t.Optional(t.Boolean()),
            statsEnabled: t.Optional(t.Boolean()),
          })
        ),
      }),
    }
  )

  .get("/:id", ({ params: { id } }) => {
    const agent = getAgent(id);
    return {
      ...getAgentInfo(id, agent),
      workflow: agent.getWorkflowState().getWorkflowContent(),
      stepCount: agent.getReActSteps().length,
    };
  })

  .delete("/:id", ({ params: { id }, set }) => {
    const agent = agentStore.get(id);
    if (!agent) {
      set.status = 404;
      return { error: "Agent not found" };
    }

    agent.destroy();
    agentStore.delete(id);
    agentDrivers.delete(id);
    return { deleted: true };
  })

  .get("/:id/react-steps", ({ params: { id } }) => {
    const agent = getAgent(id);
    return { steps: agent.getReActSteps(), state: agent.getState() };
  })

  .get("/:id/operator-results", ({ params: { id } }) => {
    const agent = getAgent(id);
    return { results: getOperatorResultSummaries(agent) };
  })

  /**
   * Return the workflow content the agent is currently editing — i.e., what a
   * client would see if it asked "show me the workflow as it stands right
   * now." Convenient endpoint for batch drivers that just want the final
   * workflow after a turn without paginating through snapshots.
   */
  .get("/:id/workflow", ({ params: { id } }) => {
    const agent = getAgent(id);
    return {
      headId: agent.getHead(),
      workflow: agent.getWorkflowState().getWorkflowContent(),
    };
  })

  /**
   * Resolve the workflow + operator results visible at a given step via the
   * snapshot storage's ancestor walk. Use the literal "head" alias to read
   * the snapshot at the agent's current HEAD without separately querying it.
   */
  .get("/:id/snapshots/:stepId", ({ params: { id, stepId } }) => {
    const agent = getAgent(id);
    const resolvedStepId = stepId === "head" ? agent.getHead() : stepId;
    const storage = agent.getSnapshotStorage();
    // No HEAD yet (fresh agent before any step) → snapshot is empty.
    if (!resolvedStepId) {
      return { stepId: null, workflow: null, workflowSourceStepId: null, results: {} };
    }
    const workflowEntry = storage.getResolvedWorkflow(resolvedStepId);
    const visibleResults = storage.getAllVisibleResults(resolvedStepId);
    const results: Record<string, unknown> = {};
    for (const [opId, info] of visibleResults) {
      results[opId] = info;
    }
    return {
      stepId: resolvedStepId,
      workflow: workflowEntry?.value ?? null,
      workflowSourceStepId: workflowEntry?.sourceStepId ?? null,
      results,
    };
  })

  .post(
    "/:id/steps-by-operators",
    ({ params: { id }, body }) => {
      const agent = getAgent(id);
      const { operatorIds } = body;
      return { steps: agent.getReActStepsByOperatorIds(operatorIds || []) };
    },
    {
      body: t.Object({
        operatorIds: t.Array(t.String()),
      }),
    }
  )

  .get("/:id/system-info", ({ params: { id } }) => {
    const agent = getAgent(id);
    return agent.getSystemInfo();
  })

  .post("/:id/stop", ({ params: { id } }) => {
    const agent = getAgent(id);
    agent.stop();
    return { status: "stopping" };
  })

  .post("/:id/clear", ({ params: { id } }) => {
    const agent = getAgent(id);
    agent.clearHistory();
    broadcastNextContext(id, agent);
    return { status: "cleared" };
  })

  .post(
    "/:id/import-react-steps",
    async ({ params: { id }, body }) => {
      const agent = getAgent(id);
      const archive = body as { steps?: unknown; snapshots?: unknown };
      if (!archive || !Array.isArray(archive.steps)) {
        throw new Error("body must be { steps: ReActStep[], snapshots?: Record<stepId, WorkflowContent> }");
      }

      const snapshots =
        archive.snapshots && typeof archive.snapshots === "object" && !Array.isArray(archive.snapshots)
          ? (archive.snapshots as Record<string, any>)
          : undefined;

      const { headId, importedCount } = await agent.importReActSteps(archive.steps as any, snapshots);

      const allSteps = agent.getAllSteps();
      const workflowContent = agent.getWorkflowState().getWorkflowContent();
      broadcastToAgent(id, {
        type: "headChange",
        headId,
        steps: allSteps,
        workflowContent,
        operatorResults: getOperatorResultSummaries(agent),
      });
      broadcastNextContext(id, agent);

      return { status: "imported", headId, importedCount };
    },
    {
      body: t.Object(
        {
          steps: t.Array(t.Any()),
          snapshots: t.Optional(t.Record(t.String(), t.Any())),
        },
        { additionalProperties: true }
      ),
    }
  )

  .post("/:id/checkout", ({ params: { id }, body }) => {
    const agent = getAgent(id);
    const { stepId } = body as { stepId: string };
    if (!stepId) throw new Error("stepId is required");

    const success = agent.checkout(stepId);
    if (!success) throw new Error(`Step ${stepId} not found or checkout failed`);

    const allSteps = agent.getAllSteps();
    const workflowContent = agent.getWorkflowState().getWorkflowContent();

    broadcastToAgent(id, {
      type: "headChange",
      headId: stepId,
      steps: allSteps,
      workflowContent,
      operatorResults: getOperatorResultSummaries(agent),
    });
    broadcastNextContext(id, agent);

    return {
      status: "checked out",
      headId: stepId,
    };
  })

  .get("/:id/operator-types", ({ params: { id } }) => {
    const agent = getAgent(id);
    const metadataStore = agent.getMetadataStore();
    const allTypes = metadataStore.getAllOperatorTypes();
    return Object.entries(allTypes).map(([type, description]) => ({ type, description }));
  })

  .get("/:id/settings", ({ params: { id } }) => {
    const agent = getAgent(id);
    const agentSettings = agent.getSettings();
    return {
      maxOperatorResultCharLimit: agentSettings.maxOperatorResultCharLimit,
      maxOperatorResultCellCharLimit: agentSettings.maxOperatorResultCellCharLimit,
      operatorResultSerializationMode: agentSettings.operatorResultSerializationMode,
      toolTimeoutSeconds: Math.round(agentSettings.toolTimeoutMs / 1000),
      executionTimeoutMinutes: Math.round(agentSettings.executionTimeoutMs / 60000),
      disabledTools: Array.from(agentSettings.disabledTools),
      maxSteps: agentSettings.maxSteps,
      allowedOperatorTypes: agentSettings.allowedOperatorTypes,
      agentMode: agentSettings.agentMode,
      contextMode: agentSettings.contextMode,
      parallelToolCalls: agentSettings.parallelToolCalls,
      statsEnabled: agentSettings.statsEnabled,
    };
  })

  .patch(
    "/:id/settings",
    ({ params: { id }, body }) => {
      const agent = getAgent(id);
      const settings = body as UpdateAgentSettingsRequest;

      log.info(
        {
          agentId: id,
          maxOperatorResultCharLimit: settings.maxOperatorResultCharLimit,
          maxOperatorResultCellCharLimit: settings.maxOperatorResultCellCharLimit,
        },
        "updating agent settings"
      );

      agent.updateSettings({
        maxOperatorResultCharLimit: settings.maxOperatorResultCharLimit,
        maxOperatorResultCellCharLimit: settings.maxOperatorResultCellCharLimit,
        operatorResultSerializationMode: settings.operatorResultSerializationMode
          ? (settings.operatorResultSerializationMode as OperatorResultSerializationMode)
          : undefined,
        toolTimeoutMs: settings.toolTimeoutSeconds !== undefined ? settings.toolTimeoutSeconds * 1000 : undefined,
        executionTimeoutMs:
          settings.executionTimeoutMinutes !== undefined ? settings.executionTimeoutMinutes * 60000 : undefined,
        disabledTools: settings.disabledTools ? new Set(settings.disabledTools) : undefined,
        maxSteps: settings.maxSteps,
        allowedOperatorTypes: settings.allowedOperatorTypes,
        agentMode: settings.agentMode ? (settings.agentMode as AgentMode) : undefined,
        contextMode: settings.contextMode ? (settings.contextMode as ContextMode) : undefined,
        parallelToolCalls: settings.parallelToolCalls,
        statsEnabled: settings.statsEnabled,
      });

      // Settings can change context assembly (agentMode flips schema gating,
      // contextMode flips the selection policy) — re-broadcast the preview
      // so clients stay in sync.
      broadcastNextContext(id, agent);

      const agentSettings = agent.getSettings();
      return {
        maxOperatorResultCharLimit: agentSettings.maxOperatorResultCharLimit,
        maxOperatorResultCellCharLimit: agentSettings.maxOperatorResultCellCharLimit,
        operatorResultSerializationMode: agentSettings.operatorResultSerializationMode,
        toolTimeoutSeconds: Math.round(agentSettings.toolTimeoutMs / 1000),
        executionTimeoutMinutes: Math.round(agentSettings.executionTimeoutMs / 60000),
        disabledTools: Array.from(agentSettings.disabledTools),
        maxSteps: agentSettings.maxSteps,
        allowedOperatorTypes: agentSettings.allowedOperatorTypes,
        agentMode: agentSettings.agentMode,
        contextMode: agentSettings.contextMode,
        parallelToolCalls: agentSettings.parallelToolCalls,
        statsEnabled: agentSettings.statsEnabled,
      };
    },
    {
      body: t.Object({
        maxOperatorResultCharLimit: t.Optional(t.Number()),
        maxOperatorResultCellCharLimit: t.Optional(t.Number()),
        operatorResultSerializationMode: t.Optional(t.Literal("tsv")),
        toolTimeoutSeconds: t.Optional(t.Number()),
        executionTimeoutMinutes: t.Optional(t.Number()),
        maxSteps: t.Optional(t.Number()),
        disabledTools: t.Optional(t.Array(t.String())),
        allowedOperatorTypes: t.Optional(t.Array(t.String())),
        agentMode: t.Optional(t.Union([t.Literal("code"), t.Literal("general")])),
        contextMode: t.Optional(t.Union([t.Literal("full"), t.Literal("delta"), t.Literal("latest")])),
        parallelToolCalls: t.Optional(t.Boolean()),
        statsEnabled: t.Optional(t.Boolean()),
      }),
    }
  );

interface WsMessage {
  type: "message" | "stop" | "debug";
  content?: string;
  messageSource?: "chat" | "feedback";
}

interface OperatorResultSummaryWs {
  state: string;
  inputTuples: number;
  outputTuples: number;
  inputPortShapes?: { portIndex: number; rows: number; columns: number }[];
  outputColumns?: number;
  error?: string;
  warnings?: string[];
  consoleLogCount?: number;
  totalRowCount?: number;
  sampleRecords?: Record<string, any>[];
  columnStats?: Record<string, string>;
}

interface WsOutgoingMessage {
  type: "step" | "state" | "error" | "complete" | "init" | "headChange" | "nextContext" | "snapshot";
  step?: ReActStep;
  state?: string;
  error?: string;
  steps?: ReActStep[];
  headId?: string;
  operatorResults?: Record<string, OperatorResultSummaryWs>;
  workflowContent?: any;
  /** Assembled next-step user-message content (markdown). Updated whenever
   * steps, HEAD, workflow, or settings change. Same code path the LLM would
   * receive on the next prepareStep. */
  content?: string;
  /** For "snapshot" events: the step the workflow was written under. */
  stepId?: string;
  /** For "snapshot" events: the freshly recorded workflow content. */
  workflow?: any;
}

function getOperatorResultSummaries(agent: TexeraAgent): Record<string, OperatorResultSummaryWs> {
  const head = agent.getHead();
  if (!head) return {};
  const visible = agent.getSnapshotStorage().getAllVisibleResults(head);
  const results: Record<string, OperatorResultSummaryWs> = {};
  for (const [opId, info] of visible) {
    results[opId] = {
      state: info.state,
      inputTuples: info.inputTuples,
      outputTuples: info.outputTuples,
      inputPortShapes: info.inputPortShapes,
      outputColumns:
        info.result && info.result.length > 0
          ? Object.keys(info.result[0]).filter(k => k !== "__row_index__").length
          : undefined,
      error: info.error,
      warnings: info.warnings,
      consoleLogCount: info.consoleLogs?.length,
      totalRowCount: info.totalRowCount,
      sampleRecords: info.result,
      columnStats: info.columnStats,
    };
  }
  return results;
}

function broadcastToAgent(agentId: string, message: WsOutgoingMessage): void {
  const agent = agentStore.get(agentId);
  if (!agent) return;

  const jsonMessage = JSON.stringify(message);
  for (const ws of agent.getWebsockets()) {
    try {
      ws.send(jsonMessage);
    } catch (error) {
      wsLog.error({ agentId, err: error }, "failed to send message to client");
      agent.removeWebsocket(ws);
    }
  }
}

/**
 * Broadcast the assembled next-step context to all WebSocket clients of an
 * agent. Re-uses TexeraAgent.getNextStepContext() so the preview matches what
 * the model would actually receive on the next prepareStep. Safe to call from
 * any handler — failures are logged but don't propagate.
 */
function broadcastNextContext(agentId: string, agent: TexeraAgent): void {
  try {
    const content = agent.getNextStepContext();
    broadcastToAgent(agentId, { type: "nextContext", content });
  } catch (e: any) {
    wsLog.warn({ agentId, err: e?.message || e }, "failed to compute nextContext");
  }
}

export function buildApp() {
  return new Elysia()
    .use(cors())
    .group(env.API_PREFIX, app =>
      app
        .get("/healthcheck", () => ({
          status: "ok",
          timestamp: new Date().toISOString(),
        }))
        .use(agentsRouter)
    )
    .ws(`${env.API_PREFIX}/agents/:id/react`, {
      open(ws) {
        const agentId = (ws.data as any).params?.id;
        wsLog.info({ agentId }, "client connected");

        const agent = agentStore.get(agentId);
        if (!agent) {
          ws.send(JSON.stringify({ type: "error", error: "Agent not found" }));
          ws.close();
          return;
        }

        agent.addWebsocket(ws);

        const initMessage: WsOutgoingMessage = {
          type: "init",
          state: agent.getState(),
          steps: agent.getAllSteps(),
          headId: agent.getHead(),
          operatorResults: getOperatorResultSummaries(agent),
        };
        ws.send(JSON.stringify(initMessage));

        // Send the initial next-step context preview right after init so the
        // panel has something to show before any message is sent.
        try {
          ws.send(JSON.stringify({ type: "nextContext", content: agent.getNextStepContext() }));
        } catch (e: any) {
          wsLog.warn({ agentId, err: e?.message || e }, "failed to send initial nextContext");
        }
      },

      async message(ws, messageData) {
        const agentId = (ws.data as any).params?.id;
        const agent = agentStore.get(agentId);

        if (!agent) {
          ws.send(JSON.stringify({ type: "error", error: "Agent not found" }));
          return;
        }

        let msg: WsMessage;
        try {
          msg = typeof messageData === "string" ? JSON.parse(messageData) : (messageData as WsMessage);
        } catch {
          ws.send(JSON.stringify({ type: "error", error: "Invalid message format" }));
          return;
        }

        if (msg.type === "stop") {
          agent.stop();
          broadcastToAgent(agentId, { type: "state", state: "STOPPING" });
          return;
        }

        if (msg.type === "message") {
          if (!msg.content || typeof msg.content !== "string") {
            ws.send(JSON.stringify({ type: "error", error: "Message content is required" }));
            return;
          }

          wsLog.info({ agentId, preview: msg.content.substring(0, 50) }, "received message");

          agent.setStepCallback((step: ReActStep) => {
            const hasToolCalls = step.toolCalls && step.toolCalls.length > 0;
            broadcastToAgent(agentId, {
              type: "step",
              step,
              ...(hasToolCalls ? { operatorResults: getOperatorResultSummaries(agent) } : {}),
            });
            broadcastNextContext(agentId, agent);
          });
          // Snapshot writes ride alongside step events. The frontend listens
          // to this stream to refresh its view of the workflow without
          // embedding workflow content in every step payload.
          agent.setSnapshotCallback((stepId, workflow) => {
            broadcastToAgent(agentId, { type: "snapshot", stepId, workflow });
          });

          broadcastToAgent(agentId, { type: "state", state: "GENERATING" });

          try {
            const result = await agent.sendMessage(msg.content, msg.messageSource);

            agent.setStepCallback(null);
            agent.setSnapshotCallback(null);

            const allSteps = agent.getReActSteps();
            const lastStep = allSteps[allSteps.length - 1];
            if (lastStep && lastStep.isEnd) {
              broadcastToAgent(agentId, { type: "step", step: lastStep });
            }

            broadcastToAgent(agentId, {
              type: "complete",
              state: agent.getState(),
              operatorResults: getOperatorResultSummaries(agent),
            });
            broadcastNextContext(agentId, agent);

            wsLog.info({ agentId, steps: result.messages.length }, "agent run complete");
          } catch (error: any) {
            agent.setStepCallback(null);
            agent.setSnapshotCallback(null);
            broadcastToAgent(agentId, { type: "error", error: error.message });
          }
        }

        // Debug input — bypasses the LLM. Mirrors the "message" branch: same
        // step callback, same state frames; the agent records steps directly.
        if (msg.type === "debug") {
          if (!msg.content || typeof msg.content !== "string") {
            ws.send(JSON.stringify({ type: "error", error: "Debug content is required" }));
            return;
          }

          wsLog.info({ agentId, preview: msg.content.substring(0, 50) }, "received debug input");

          agent.setStepCallback((step: ReActStep) => {
            const hasToolCalls = step.toolCalls && step.toolCalls.length > 0;
            broadcastToAgent(agentId, {
              type: "step",
              step,
              ...(hasToolCalls ? { operatorResults: getOperatorResultSummaries(agent) } : {}),
            });
            broadcastNextContext(agentId, agent);
          });
          agent.setSnapshotCallback((stepId, workflow) => {
            broadcastToAgent(agentId, { type: "snapshot", stepId, workflow });
          });

          broadcastToAgent(agentId, { type: "state", state: "GENERATING" });

          try {
            await agent.handleDebugInput(msg.content, msg.messageSource);
            agent.setStepCallback(null);
            agent.setSnapshotCallback(null);
            broadcastToAgent(agentId, {
              type: "complete",
              state: agent.getState(),
              operatorResults: getOperatorResultSummaries(agent),
            });
            broadcastNextContext(agentId, agent);
            wsLog.info({ agentId }, "debug input complete");
          } catch (error: any) {
            agent.setStepCallback(null);
            agent.setSnapshotCallback(null);
            broadcastToAgent(agentId, { type: "error", error: error.message || String(error) });
            broadcastToAgent(agentId, { type: "state", state: agent.getState() });
          }
        }
      },

      close(ws) {
        const agentId = (ws.data as any).params?.id;
        wsLog.info({ agentId }, "client disconnected");

        const agent = agentStore.get(agentId);
        if (agent) {
          agent.removeWebsocket(ws);
        }
      },
    })
    .onError(({ error, set }) => {
      // Catch-all for non-router routes such as /api/healthcheck and the websocket route.
      log.error({ err: error }, "request error");
      set.status = 500;
      return { error: error instanceof Error ? error.message : String(error) };
    });
}

// Reset module-level state. Used by tests to start each case from a clean store.
export function _resetAgentStoreForTests(): void {
  agentStore.clear();
  agentDrivers.clear();
  agentCounter = 0;
}

function printStartupMessage(app: ReturnType<typeof buildApp>) {
  const LINE = "=".repeat(60);
  console.log(LINE);
  console.log("Texera Agent Service (Elysia.js + RxJS)");
  console.log(LINE);
  console.log(`Server running at http://localhost:${env.PORT}`);
  console.log("");

  console.log("Registered Routes:");
  const routes = app.routes;

  const httpRoutes = routes.filter(r => r.method !== "WS");
  const wsRoutes = routes.filter(r => r.method === "WS");

  for (const route of httpRoutes) {
    const method = route.method.padEnd(6);
    console.log(`  ${method} ${route.path}`);
  }

  if (wsRoutes.length > 0) {
    console.log("");
    console.log("WebSocket Endpoints:");
    for (const route of wsRoutes) {
      console.log(`  WS     ${route.path}`);
    }
    console.log("         Send: { type: 'message', content: '...' }");
    console.log("         Send: { type: 'stop' }");
    console.log("         Recv: { type: 'step' | 'state' | 'complete' | 'error' | 'init', ... }");
  }

  console.log("");
  console.log("Environment:");
  console.log(`  LLM_API_KEY: ${env.LLM_API_KEY === "dummy" ? "dummy (default)" : "set"}`);
  console.log(`  LLM_ENDPOINT: ${getBackendConfig().modelsEndpoint}`);
  console.log(`  WORKFLOW_COMPILING_SERVICE_ENDPOINT: ${getBackendConfig().compileEndpoint}`);
  console.log(`  TEXERA_DASHBOARD_SERVICE_ENDPOINT: ${getBackendConfig().apiEndpoint}`);
  console.log("");
  console.log("Features:");
  console.log("  - Auto-persistence with debounce (500ms)");
  console.log(LINE);
}

async function initializeServices() {
  try {
    log.info("initializing global workflow system metadata");
    const metadata = await WorkflowSystemMetadata.initializeGlobal();
    log.info({ operatorCount: metadata.getOperatorCount() }, "loaded operators into global metadata");
  } catch (error) {
    log.warn({ err: error }, "failed to initialize global metadata; agents will initialize individually");
  }
}

export async function start() {
  await initializeServices();
  const app = buildApp().listen(env.PORT);
  printStartupMessage(app);
  return app;
}

// Run the server only when this file is the entry point, not when it is
// imported by tests or other modules.
if (import.meta.main) {
  start();
}
