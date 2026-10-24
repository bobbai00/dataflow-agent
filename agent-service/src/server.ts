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

import { observationFormat, observationFormatPatch } from "./agent/native/observation-format";

import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { createOpenAI } from "@ai-sdk/openai";
import { withModelWireTrace } from "./agent/llm-drivers/wire-trace";
import { readInputBudget, withInputBudget, withModelCallLimit } from "./agent/llm-drivers/input-budget";
import { TexeraAgent, type AgentMessageResult } from "./agent/texera-agent";
import { NativeCatalogSettingsError, validateNativeSettings, validateEvidenceSettings } from "./agent/native/settings";
import { NATIVE_OPERATORS } from "./agent/native/catalog";
import { describeNativeStatement } from "./agent/native/statement-form";
import { UserActionError, type UserActionRequest } from "./agent/user-actions";
import {
  operatorResultSummaries,
  type OperatorResultSummary as OperatorResultSummaryWs,
} from "./api/operator-result-summary";
import { isDeepStrictEqual } from "node:util";
import { changesDataflow, type SnapshotData, type VersionInfo } from "./agent/workflow-snapshot-storage";
import type { DataflowProgress } from "./agent/tools/dataflow-action-runtime";
import { getBackendConfig } from "./api/backend-api";
import { extractBearerToken, extractUserFromToken, validateToken } from "./api/auth-api";
import { createWorkflow } from "./api/workflow-api";
import {
  EMPTY_WORKFLOW_CONTENT,
  ensureComputingUnit,
  loadSeedDefinition,
  readSeedArchive,
  type SeedDefinition,
} from "./study/seed";
import type { UserInfo } from "./types/agent";
import type { WorkflowContent } from "./types/workflow";
import { authorizeDiagnosticRead } from "./api/diagnostic-auth";
import { inspectErrorSchema } from "./agent/native/inspect-error-query";
import { WorkflowSystemMetadata } from "./agent/util/workflow-system-metadata";
import { env } from "./config/env";
import { createLogger } from "./logger";
import { openTraceStore, storedTreeComplete, type TraceStore } from "./trace/trace-store";
import { VercelToolUseDriver } from "./agent/llm-drivers/vercel-tool-use-driver";
import { withRequestTimeout } from "./agent/llm-drivers/request-timeout";
import { LocalReactTextDriver } from "./agent/llm-drivers/local-react-text-driver";
import type { ContextAssembler, LLMDriver } from "./agent/llm-drivers/types";
import { readFileSync } from "fs";
import { assembleContext, type AssembleContextOptions } from "./agent/util/context-utils";
import {
  applySummarizeParamsPatch,
  mapLegacyToParams,
  SummarizeParamsPatchSchema,
  type SummarizeParamsPatch,
} from "./agent/context/summarize/params";
import { buildDossier } from "./agent/context/summarize/dossier";
import { summarize as summarizeContext } from "./agent/context/summarize/summarize";
import { selectParams, SelectorConfigSchema, type SelectorConfig } from "./agent/context/selector/selector";
import {
  applyFrontierDecay,
  FrontierDecayConfigSchema,
  type FrontierDecayConfig,
} from "./agent/context/selector/frontier-decay";
import {
  applyProbeRetirement,
  ProbeRetirementConfigSchema,
  type ProbeRetirementConfig,
} from "./agent/context/selector/probe-retirement";
import { applyRolePolicy, RolePolicyConfigSchema, type RolePolicyConfig } from "./agent/context/selector/role-policy";
import {
  FoldResolvedRevisionsConfigSchema,
  type FoldResolvedRevisionsConfig,
} from "./agent/context/select/revision-folds";
import { applyRenderPrefs } from "./agent/context/selector/render-prefs";
import {
  learnedSelectParams,
  buildUtilityModel,
  LearnedConfigSchema,
  type LearnedConfig,
  type UtilityModel,
} from "./agent/context/learned";
import { LLMContextTuner, type TunerConfig } from "./agent/context/tuner/tuner";
import type { OpenAIProvider } from "@ai-sdk/openai";
import { assembleLocalReactContext } from "./agent/util/context-utils-local-react";
import { buildLocalReactSystemPrompt } from "./agent/prompts";
import { dashboardPlugin } from "./dashboard/static";

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
import { AgentMode, AgentState, ContextMode, OperatorResultSerializationMode } from "./types/agent";

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

/** Latest user-role message content along the visible path — the task text the
 *  tuner reasons about. */
function latestTaskText(visibleSteps: { role: string; content?: string; messageSource?: string }[]): string {
  for (let i = visibleSteps.length - 1; i >= 0; i--) {
    // A canvas action reports what the user did; the task is the request before it.
    if (visibleSteps[i].messageSource === "action") continue;
    if (visibleSteps[i].role === "user" && visibleSteps[i].content) return visibleSteps[i].content as string;
  }
  return "";
}

/** The bundled learned utility model (context/learned/model.json), loaded once.
 *  `null` when absent/invalid — callers then fall through to the rule selector. */
let _learnedModel: UtilityModel | null | undefined;
function getLearnedModel(): UtilityModel | null {
  if (_learnedModel !== undefined) return _learnedModel;
  try {
    const p = new URL("./agent/context/learned/model.json", import.meta.url);
    const raw = readFileSync(p, "utf8");
    _learnedModel = buildUtilityModel(JSON.parse(raw));
    console.log(
      `  learned model loaded: ${(_learnedModel.meta as any)?.rows ?? "?"} rows, cvAUC ${(_learnedModel.meta as any)?.cvAucAll ?? "?"}`
    );
  } catch (e) {
    console.warn(
      `  learned model NOT loaded (${e instanceof Error ? e.message : String(e)}) — learnedConfig will fall back`
    );
    _learnedModel = null;
  }
  return _learnedModel;
}

export function buildContextAssembler(kind: AgentDriverKind, openai: OpenAIProvider): ContextAssembler {
  // One tuner per agent, built lazily and reused (it accumulates teacher-token
  // usage). Rebuilt if the teacher model id changes.
  let tuner: LLMContextTuner | undefined;
  let tunerModelId: string | undefined;
  const getTuner = (cfg: TunerConfig): LLMContextTuner => {
    if (!tuner || tunerModelId !== cfg.model) {
      tuner = new LLMContextTuner(openai.chat(cfg.model), cfg);
      tunerModelId = cfg.model;
    }
    return tuner;
  };

  // Layout and sampling are independent of the two explicit evidence channels.
  // Ordinary renderers stay synchronous so debug/UI previews show the current
  // snapshot. Only the opt-in LLM tuner needs an asynchronous result.
  const sdkContext: ContextAssembler = ({
    visibleSteps,
    workflowState,
    snapshotStorage,
    settings,
    compilationResult,
    turnNumberByMessageId,
  }) => {
    const legacyOptions: AssembleContextOptions = {
      compilationResult,
      agentMode: settings.agentMode,
      ...observationFormat(settings),
      nativeEvidence: {
        ...observationFormat(settings),
        data: settings.dataEvidence,
        flow: settings.flowEvidence,
        maxChars: settings.maxOperatorResultCharLimit,
        dataMaxChars: settings.dataEvidenceCharLimit,
        flowMaxChars: settings.flowEvidenceCharLimit,
        checks: settings.nativeChecks,
      },
      dataEvidence: settings.dataEvidence,
      flowEvidence: settings.flowEvidence,
      nativeChecks: settings.nativeChecks,
      resultSelection: settings.resultSelection,
      includeOperatorProperties: settings.includeOperatorProperties,
      thoughtReplay: settings.thoughtReplay,
      agentTurns: settings.agentTurns,
      contextWindowTokens: settings.contextWindowTokens,
      compactionStrategy: settings.compactionStrategy,
      deckSampleRatio: settings.deckSampleRatio,
      errorReflection: settings.errorReflection,
      errorReflectionThreshold: settings.errorReflectionThreshold,
      thoughtReplayK: settings.thoughtReplayK,
      fewShotPrompt: settings.fewShotPrompt,
      maxResultRows: settings.maxResultRows,
      maxOperatorResultCellCharLimit: settings.maxOperatorResultCellCharLimit,
      maxOperatorResultCharLimit: settings.maxOperatorResultCharLimit,
      staticCompaction: settings.staticCompaction,
      // Request placement in multi-request sessions (cache).
      userTaskPlacement: settings.userTaskPlacement,
      attemptReflection: settings.attemptReflection,
      // Caching is not optional: unless an arm pins a layout, LATEST ships one
      // message per operator block (opSplit) and DELTA ships the append-only
      // tool-call transcript (native), the two framings gpt-5.6-* can credit.
      messageLayout: settings.messageLayout ?? (settings.contextMode === ContextMode.LATEST ? "opSplit" : "native"),
      // Rank-3 static rule (DELTA-only): fold resolved operator revisions.
      foldResolvedRevisions: settings.foldResolvedRevisionsConfig ? true : undefined,
      foldGraceEvents: settings.foldResolvedRevisionsConfig?.graceEvents,
      // Write-time render prefs (DELTA event scoping; LATEST goes via overlay).
      renderPrefsEnabled: settings.enableRenderPrefs ? true : undefined,
      summarizePatch: settings.summarizeParams,
      // Global request numbers for the renderer.
      turnNumberByMessageId,
      // Earlier requests as catalog entries ("catalog") or as the transcript.
      multiRequest: settings.multiRequest,
      catalogSource: settings.catalogSource,
      catalogRecent: settings.catalogRecent,
    };
    const evidenceSettings = {
      data: settings.dataEvidence,
      flow: settings.flowEvidence,
      maxChars: settings.maxOperatorResultCharLimit,
    };

    // Context policy precedence: learned model > LLM tuner > rule selector >
    // base-preserving frontier decay > legacy contextMode.
    // Learned path (opt-in): the trained utility model scores each operator and
    // a budget knapsack assigns representation levels (omit≺shape≺sample+stats).
    if (settings.learnedConfig) {
      const model = getLearnedModel();
      if (model) {
        const dossier = buildDossier(visibleSteps, snapshotStorage);
        const params = learnedSelectParams(dossier, model, latestTaskText(visibleSteps), settings.learnedConfig);
        params.nativeEvidence = evidenceSettings;
        return summarizeContext({ visibleSteps, workflowState, snapshotStorage, compilationResult, dossier }, params)
          .messages;
      }
      // No bundled model → fall through to the rule selector / legacy path.
    }
    // Tuner path (opt-in): a teacher LLM chooses per-operator detail from a
    // cheap manifest each step. Async; falls back to the rule selector inside
    // tune() on any failure.
    if (settings.tunerConfig) {
      const dossier = buildDossier(visibleSteps, snapshotStorage);
      return getTuner(settings.tunerConfig)
        .tune(dossier, latestTaskText(visibleSteps))
        .then(({ params }) => {
          params.nativeEvidence = evidenceSettings;
          return summarizeContext({ visibleSteps, workflowState, snapshotStorage, compilationResult, dossier }, params)
            .messages;
        });
    }
    // Selector path (opt-in): the per-step RULE policy chooses summarize()
    // params from the live dossier. The dossier is built once and reused.
    if (settings.selectorConfig) {
      const dossier = buildDossier(visibleSteps, snapshotStorage);
      const params = selectParams(dossier, settings.selectorConfig);
      params.nativeEvidence = evidenceSettings;
      return summarizeContext({ visibleSteps, workflowState, snapshotStorage, compilationResult, dossier }, params)
        .messages;
    }
    // BASE-PRESERVING OVERLAYS — the orthogonality contract: each overlay
    // (1) is independently flag-gated, (2) only LOWERS detail relative to the
    // base params (never raises), and (3) returns the base unchanged when its
    // preconditions don't hold (e.g. wrong context mode) or nothing qualifies.
    // They therefore compose in any order; the fixed order below is kept for
    // reproducibility: frontierDecay -> probeRetirement -> renderPrefs.
    // Flag-off arms bypass this branch entirely (byte-parity with legacy),
    // enforced by orthogonality.test.ts.
    if (
      settings.frontierDecayConfig ||
      settings.probeRetirementConfig ||
      settings.rolePolicyConfig ||
      settings.enableRenderPrefs ||
      (settings.enableCodeInSnapshot && settings.contextMode === ContextMode.LATEST)
    ) {
      const dossier = buildDossier(visibleSteps, snapshotStorage);
      const legacyParams = mapLegacyToParams(settings.contextMode, legacyOptions);
      const baseParams = settings.summarizeParams
        ? applySummarizeParamsPatch(legacyParams, settings.summarizeParams)
        : legacyParams;
      let params = baseParams;
      // Code-in-snapshot (LATEST-only): render every operator's current code as a
      // `Code:` block. DELTA already carries code inline per event, so it is
      // gated off above and never reaches this patch.
      if (settings.enableCodeInSnapshot && settings.contextMode === ContextMode.LATEST) {
        params = applySummarizeParamsPatch(params, {
          operators: { defaults: { property: { includeCode: true } } },
        });
      }
      if (settings.frontierDecayConfig) params = applyFrontierDecay(params, dossier, settings.frontierDecayConfig);
      if (settings.probeRetirementConfig) {
        params = applyProbeRetirement(params, dossier, settings.probeRetirementConfig);
      }
      // RULE A: role-keyed render policy (rich source / lean interior).
      if (settings.rolePolicyConfig) params = applyRolePolicy(params, dossier, settings.rolePolicyConfig);
      // Write-time render prefs: latest landed version's outputSummary /
      // outputSummary becomes a per-operator sample override (LATEST).
      if (settings.enableRenderPrefs) params = applyRenderPrefs(params, dossier);
      return summarizeContext({ visibleSteps, workflowState, snapshotStorage, compilationResult, dossier }, params)
        .messages;
    }
    return assembleContext(visibleSteps, workflowState, snapshotStorage, settings.contextMode, legacyOptions);
  };

  if (kind === "local-react") {
    // The local text-mode driver picks the assembler by tool-call dialect so
    // each dialect's context matches the format its system prompt describes:
    //   - qwen-xml  → the SDK context (its prompt is the CODE-mode body, which
    //     describes `# User Task` / `# Current Dataflow`).
    //   - react-text → the legacy `# Event N` / Thought:/Actions: renderer that
    //     `prompts/local-react.txt` describes.
    // Read per-call from settings (toolDialect is mutable), mirroring how the
    // driver selects its parser and the prompt is rebuilt.
    return input =>
      input.settings.toolDialect === "react-text"
        ? assembleLocalReactContext(input.visibleSteps, input.workflowState, input.snapshotStorage, {})
        : sdkContext(input);
  }
  return sdkContext;
}

const agentStore = new Map<string, TexeraAgent>();
/** Tracks which driver each agent was constructed with so `getAgentInfo`
 *  can echo it back to the UI. Populated by `createAgentInstance`. */
const agentDrivers = new Map<string, AgentDriverKind>();
/** Every agent's turns, steps, versions, executions and results, as they happen (see trace-store.ts). */
let traceStore: TraceStore | undefined = openTraceStore(env.AGENT_TRACE_DB);
let agentCounter = 0;
/**
 * Per-process salt for agent ids.
 *
 * Ids used to be a bare `agent-<n>` from a module-level counter. That counter
 * restarts at 0 whenever the service restarts (including a `bun --watch` hot
 * reload), so a fresh process re-issues ids that concurrent benchmark tasks
 * are still holding. The result: one task's cleanup `DELETE /api/agents/agent-8`
 * removes the agent a DIFFERENT task is running on, and that task dies with
 * "Agent not found" — 0 steps, 0 tokens, scored as a wrong answer. It looked
 * like random flakiness (~30% of tasks) and was misread as a concurrency limit.
 *
 * The salt makes an id unique to the process that minted it, so a stale id from
 * an earlier process can never address a live agent.
 */
const AGENT_ID_SALT = Math.random().toString(36).slice(2, 8);

/** Apply an agent's initial settings: the create request's, or the stored ones of an agent being restored. */
function applyInitialSettings(
  agentId: string,
  agent: TexeraAgent,
  settings: NonNullable<CreateAgentRequest["settings"]>
): void {
  log.info(
    {
      agentId,
      maxOperatorResultCharLimit: settings.maxOperatorResultCharLimit,
      maxOperatorResultCellCharLimit: settings.maxOperatorResultCellCharLimit,
    },
    "applying initial agent settings"
  );
  agent.updateSettings({
    ...observationFormatPatch(settings),
    maxOperatorResultCharLimit: settings.maxOperatorResultCharLimit,
    maxOperatorResultCellCharLimit: settings.maxOperatorResultCellCharLimit,
    operatorResultSerializationMode: settings.operatorResultSerializationMode
      ? (settings.operatorResultSerializationMode as OperatorResultSerializationMode)
      : undefined,
    toolTimeoutMs: settings.toolTimeoutSeconds ? settings.toolTimeoutSeconds * 1000 : undefined,
    executionTimeoutMs: settings.executionTimeoutMinutes ? settings.executionTimeoutMinutes * 60000 : undefined,
    disabledTools: settings.disabledTools ? new Set(settings.disabledTools) : undefined,
    maxSteps: settings.maxSteps,
    maxOperatorEdits: settings.maxOperatorEdits,
    agentMode: settings.agentMode ? (settings.agentMode as AgentMode) : undefined,
    nativeProfileCollection: settings.nativeProfileCollection,
    nativeProfileScope: settings.nativeProfileScope,
    dataEvidence: settings.dataEvidence,
    retrievalViews: settings.retrievalViews,
    fullResultCharLimit: settings.fullResultCharLimit,
    dataEvidenceCharLimit: settings.dataEvidenceCharLimit,
    flowEvidenceCharLimit: settings.flowEvidenceCharLimit,
    flowEvidence: settings.flowEvidence,
    operatorDoc: settings.operatorDoc,
    respondToCanvasRuns: settings.respondToCanvasRuns,
    instructions: settings.instructions,
    answerStatement: settings.answerStatement,
    nativeChecks: settings.nativeChecks,
    resultSelection: (settings as any).resultSelection,
    contextMode: settings.contextMode ? (settings.contextMode as ContextMode) : undefined,
    parallelToolCalls: settings.parallelToolCalls,
    includeOperatorProperties: settings.includeOperatorProperties,
    thoughtReplay: settings.thoughtReplay,
    agentTurns: settings.agentTurns,
    contextWindowTokens: settings.contextWindowTokens,
    compactionStrategy: settings.compactionStrategy,
    deckSampleRatio: settings.deckSampleRatio,
    errorReflection: settings.errorReflection,
    errorReflectionThreshold: settings.errorReflectionThreshold,
    thoughtReplayK: settings.thoughtReplayK,
    fewShotPrompt: settings.fewShotPrompt,
    maxResultRows: settings.maxResultRows,
    attemptReflection: settings.attemptReflection,
    toolDialect: settings.toolDialect,
    summarizeParams: parseSummarizePatch(settings.summarizeParams),
    selectorConfig: parseSelectorConfigInput((settings as any).selectorConfig),
    frontierDecayConfig: parseFrontierDecayConfigInput((settings as any).frontierDecayConfig),
    foldResolvedRevisionsConfig: parseFoldResolvedRevisionsConfigInput((settings as any).foldResolvedRevisionsConfig),
    probeRetirementConfig: parseProbeRetirementConfigInput((settings as any).probeRetirementConfig),
    rolePolicyConfig: parseRolePolicyConfigInput((settings as any).rolePolicyConfig),
    learnedConfig: parseLearnedConfigInput((settings as any).learnedConfig),
    enableInspectTool: (settings as any).enableInspectTool,
    enableRenderPrefs: (settings as any).enableRenderPrefs,
    enableCodeInSnapshot: (settings as any).enableCodeInSnapshot,
    sourceProvenanceHint: (settings as any).sourceProvenanceHint,
    staticCompaction: (settings as any).staticCompaction,
    userTaskPlacement: (settings as any).userTaskPlacement,
    messageLayout: (settings as any).messageLayout,
    multiRequest: (settings as any).multiRequest,
    catalogSource: (settings as any).catalogSource,
    catalogRecent: (settings as any).catalogRecent,
    tunerConfig: parseTunerConfigInput((settings as any).tunerConfig),
  });
}

async function createAgentInstance(
  modelType: string,
  delegateConfig: AgentDelegateConfig,
  customName?: string,
  explicitDriver?: AgentDriverKind,
  /** The id of an agent being restored from the trace store; it is traced again once rebuilt (see /:id/restore). */
  restoreId?: string
): Promise<{ agentId: string; agent: TexeraAgent }> {
  const agentId = restoreId ?? `agent-${AGENT_ID_SALT}-${++agentCounter}`;
  const config = getBackendConfig();

  const inputBudget = readInputBudget(process.env);
  const modelCallLimit = Number(process.env.MODEL_MAX_CALLS_PER_TURN ?? 0);

  const openai = createOpenAI({
    baseURL: `${config.modelsEndpoint}/api`,
    // The LLM gateway (access-control-service) enforces a REGULAR/ADMIN-role
    // JWT (apache/texera#5421) and injects the LiteLLM master key downstream,
    // so the delegating user's JWT is the only credential this service sends.
    apiKey: delegateConfig.userToken,
    // Every model request has a deadline; a request that never answers is
    // abandoned and the turn retries it (TexeraAgent.sendMessage).
    fetch: withRequestTimeout(
      withModelWireTrace(
        process.env.TEXERA_LLM_TRACE_DIR,
        () => ({
          agentId,
          workflowId: delegateConfig.workflowId,
          headId: agent.getHead(),
          messageId: agent.getCurrentMessageId(),
          inputBudget,
          modelCallLimit,
        }),
        withInputBudget(
          inputBudget,
          withModelCallLimit(modelCallLimit, () => agent.getCurrentMessageId())
        )
      )
    ),
  });

  // Reasoning effort variants are configured as separate model entries in litellm-config.yaml
  // with extra_body to inject reasoning_effort, bypassing LiteLLM's param validation.
  const driverKind = resolveDriverKind(modelType, explicitDriver);
  const model = openai.chat(modelType);
  const requestLimits = {
    maxOutputTokens: process.env.MODEL_MAX_OUTPUT_TOKENS ? Number(process.env.MODEL_MAX_OUTPUT_TOKENS) : undefined,
    maxRetries: process.env.MODEL_SDK_RETRIES ? Number(process.env.MODEL_SDK_RETRIES) : undefined,
  };
  const driver: LLMDriver =
    driverKind === "local-react"
      ? new LocalReactTextDriver({ model })
      : new VercelToolUseDriver({ model, ...requestLimits });
  const contextAssembler = buildContextAssembler(driverKind, openai);

  const agent = new TexeraAgent({
    driver,
    contextAssembler,
    modelType,
    agentId,
    agentName: customName || "Bob",
    // local-react needs the training-time system prompt verbatim on every
    // wire call; other drivers fall back to the mode-based builders.
    systemPromptBuilder: driverKind === "local-react" ? buildLocalReactSystemPrompt : undefined,
    trace: restoreId ? undefined : traceStore,
  });
  if (!restoreId)
    traceStore?.agentCreated({
      id: agentId,
      name: agent.agentName,
      model: modelType,
      driver: driverKind,
      workflowId: delegateConfig.workflowId,
      computingUnitId: delegateConfig.computingUnitId,
      user: delegateConfig.userInfo
        ? { uid: delegateConfig.userInfo.uid, name: delegateConfig.userInfo.name }
        : undefined,
      settings: settingsToApi(agent),
      createdAt: Date.now(),
    });

  // Single bootstrap: metadata + (in delegate mode) workflow load and a
  // synthetic `initialize` step that anchors both the workflow snapshot and
  // every per-operator baseline result. `initialize` itself loads the workflow
  // (retrieveWorkflow) from the delegate config, so no inline load is needed.
  await agent.initialize(delegateConfig);

  agentStore.set(agentId, agent);
  agentDrivers.set(agentId, driverKind);
  log.info({ agentId, modelType, driver: driverKind, delegate: !!delegateConfig }, "created agent");

  return { agentId, agent };
}

/** Render the agent's live settings in the wire shape shared by
 *  `GET /:id`, `GET /:id/settings` and `PATCH /:id/settings` — one source so
 *  a knob the frontend can set is always a knob it can read back. */
const OBSERVATION_SETTINGS_SCHEMA = {
  tableFormat: t.Optional(t.Union([t.Literal("markdown"), t.Literal("tsv")])),
  ...Object.fromEntries(
    [
      "keyValueColumns",
      "columnsShown",
      "definitionChars",
      "cellChars",
      "topValues",
      "catalogRecords",
      "fullPreviewRows",
    ].map(key => [key, t.Optional(t.Integer({ minimum: 0, maximum: 100000 }))])
  ),
  answerEcho: t.Optional(t.Boolean()),
  optionalPython: t.Optional(t.Boolean()),
  dataHygiene: t.Optional(t.Boolean()),
  pandasRound: t.Optional(t.Boolean()),
  compactRecords: t.Optional(t.Boolean()),
  answerOnlyReply: t.Optional(t.Boolean()),
  planLine: t.Optional(t.Boolean()),
};

function settingsToApi(agent: TexeraAgent): AgentSettingsApi {
  const agentSettings = agent.getSettings();
  return {
    ...observationFormat(agentSettings),
    maxOperatorResultCharLimit: agentSettings.maxOperatorResultCharLimit,
    maxOperatorResultCellCharLimit: agentSettings.maxOperatorResultCellCharLimit,
    operatorResultSerializationMode: agentSettings.operatorResultSerializationMode,
    toolTimeoutSeconds: Math.round(agentSettings.toolTimeoutMs / 1000),
    executionTimeoutMinutes: Math.round(agentSettings.executionTimeoutMs / 60000),
    disabledTools: Array.from(agentSettings.disabledTools),
    maxSteps: agentSettings.maxSteps,
    maxOperatorEdits: agentSettings.maxOperatorEdits,
    agentMode: agentSettings.agentMode,
    nativeProfileCollection: agentSettings.nativeProfileCollection,
    nativeProfileScope: agentSettings.nativeProfileScope,
    dataEvidence: agentSettings.dataEvidence,
    retrievalViews: agentSettings.retrievalViews,
    fullResultCharLimit: agentSettings.fullResultCharLimit,
    dataEvidenceCharLimit: agentSettings.dataEvidenceCharLimit,
    flowEvidenceCharLimit: agentSettings.flowEvidenceCharLimit,
    flowEvidence: agentSettings.flowEvidence,
    operatorDoc: agentSettings.operatorDoc,
    respondToCanvasRuns: agentSettings.respondToCanvasRuns,
    instructions: agentSettings.instructions,
    answerStatement: agentSettings.answerStatement,
    nativeChecks: agentSettings.nativeChecks,
    resultSelection: agentSettings.resultSelection,
    contextMode: agentSettings.contextMode,
    messageLayout: agentSettings.messageLayout,
    parallelToolCalls: agentSettings.parallelToolCalls,
    includeOperatorProperties: agentSettings.includeOperatorProperties,
    thoughtReplay: agentSettings.thoughtReplay,
    agentTurns: agentSettings.agentTurns,
    contextWindowTokens: agentSettings.contextWindowTokens,
    compactionStrategy: agentSettings.compactionStrategy,
    deckSampleRatio: agentSettings.deckSampleRatio,
    errorReflection: agentSettings.errorReflection,
    errorReflectionThreshold: agentSettings.errorReflectionThreshold,
    thoughtReplayK: agentSettings.thoughtReplayK,
    fewShotPrompt: agentSettings.fewShotPrompt,
    maxResultRows: agentSettings.maxResultRows,
    attemptReflection: agentSettings.attemptReflection,
    toolDialect: agentSettings.toolDialect,
    summarizeParams: agentSettings.summarizeParams,
    selectorConfig: agentSettings.selectorConfig,
    frontierDecayConfig: agentSettings.frontierDecayConfig,
    foldResolvedRevisionsConfig: agentSettings.foldResolvedRevisionsConfig,
    probeRetirementConfig: agentSettings.probeRetirementConfig,
    rolePolicyConfig: agentSettings.rolePolicyConfig,
    learnedConfig: agentSettings.learnedConfig,
    enableInspectTool: agentSettings.enableInspectTool,
    enableRenderPrefs: agentSettings.enableRenderPrefs,
    enableCodeInSnapshot: agentSettings.enableCodeInSnapshot,
    sourceProvenanceHint: agentSettings.sourceProvenanceHint,
    staticCompaction: agentSettings.staticCompaction,
    tunerConfig: agentSettings.tunerConfig,
    multiRequest: agentSettings.multiRequest,
    catalogSource: agentSettings.catalogSource,
    catalogRecent: agentSettings.catalogRecent,
  };
}

function getAgentInfo(agentId: string, agent: TexeraAgent): AgentInfo {
  const settingsApi = settingsToApi(agent);
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

/** The delegating user behind a request, or the errors the create route raises without one. */
function requireUser(authorization: string | undefined): { userToken: string; userInfo: UserInfo } {
  const userToken = extractBearerToken(authorization);
  if (!userToken) throw new Error("Authorization header with a Bearer token is required");
  if (!validateToken(userToken)) throw new Error("Invalid or expired token");
  return { userToken, userInfo: extractUserFromToken(userToken) };
}

/**
 * Bring a traced agent back to life under its old id, for the user who owns it
 * (or an admin): its settings, steps, dataflow versions and results, traced
 * again from here on. Shared by `POST /:id/restore` and the agent list, which
 * restores a workflow's agents when their user opens it after a restart.
 */
async function restoreAgent(id: string, userToken: string, requester: UserInfo): Promise<TexeraAgent> {
  const stored = traceStore?.agent(id);
  if (!stored) throw new Error(`No trace for agent ${id}`);
  if (stored.user_uid != null && stored.user_uid !== requester.uid && requester.role !== "ADMIN")
    throw new Error(`Agent ${id} belongs to another user`);
  const delegateConfig: AgentDelegateConfig = {
    userToken,
    userInfo: requester,
    workflowId: (stored.workflow_id as number | null) ?? undefined,
    computingUnitId: (stored.computing_unit_id as number | null) ?? undefined,
  };
  const { agent } = await createAgentInstance(
    String(stored.model),
    delegateConfig,
    typeof stored.name === "string" ? stored.name : undefined,
    (stored.driver as AgentDriverKind | null) ?? undefined,
    id
  );
  try {
    if (stored.settings)
      applyInitialSettings(id, agent, stored.settings as NonNullable<CreateAgentRequest["settings"]>);
    // The trace's version tree comes back as it was: every version, each with its own results,
    // and HEAD where the user left it. A tree the trace lost rows of (recorded before it kept each
    // agent's rows apart) is replayed from the steps instead, under ids it has not used.
    const steps = traceStore!.stepsOf(id);
    const snapshots = traceStore!.snapshotsOf(id);
    const results = traceStore!.snapshotResultsOf(id);
    const complete = storedTreeComplete(steps, snapshots);
    agent.getSnapshotStorage().skipIdsThrough(snapshots.map(snapshot => snapshot.id));
    const { headId, importedCount } = await agent.importReActSteps(steps, undefined, {
      ...(complete ? { tree: { snapshots, results } } : {}),
      head: traceStore!.lastCheckout(id),
    });
    if (!complete)
      agent.restoreOperatorResults(
        results.flatMap(({ stepId, operatorId, info }) => (stepId ? [{ stepId, operatorId, info }] : []))
      );
    agent.attachTrace(traceStore);
    traceStore!.event({ agentId: id, kind: "restore", detail: { importedCount, headId } });
  } catch (error) {
    agent.destroy();
    agentStore.delete(id);
    agentDrivers.delete(id);
    throw error;
  }
  return agent;
}

interface ArchiveImport {
  steps: unknown[];
  snapshots?: unknown;
  results?: unknown;
  instructions?: unknown;
  execute?: unknown;
}

/**
 * Load an archive into a live agent: its steps (and dataflow versions), each
 * step's operator results, its instructions; with `execute`, the dataflow runs
 * once so the results are this workflow's own. Shared by the import route and
 * seeding.
 */
async function importArchive(
  id: string,
  agent: TexeraAgent,
  archive: ArchiveImport
): Promise<{ headId: string; importedCount: number; restored: number; executed?: { state: string } }> {
  const snapshots =
    archive.snapshots && typeof archive.snapshots === "object" && !Array.isArray(archive.snapshots)
      ? (archive.snapshots as Record<string, any>)
      : undefined;
  const { headId, importedCount } = await agent.importReActSteps(archive.steps as any, snapshots);
  // An archive's results land on the steps that earned them; its instructions become the agent's.
  const results =
    archive.results && typeof archive.results === "object" && !Array.isArray(archive.results)
      ? (archive.results as Record<string, Record<string, any>>)
      : {};
  const restored = Object.entries(results).flatMap(([stepId, byOperator]) =>
    Object.entries(byOperator ?? {}).map(([operatorId, info]) => ({ stepId, operatorId, info }))
  );
  if (restored.length) agent.restoreOperatorResults(restored);
  if (typeof archive.instructions === "string") agent.updateSettings({ instructions: archive.instructions });
  // With `execute`, the dataflow runs once here, so its results are this workflow's own (an
  // archive's results came from another workflow and would be recomputed on the first question).
  const executed = archive.execute === true ? await agent.executeAllForHead() : undefined;
  traceStore?.event({
    agentId: id,
    kind: "import",
    detail: { importedCount, headId, results: restored.length, executed: executed?.state },
  });
  broadcastToAgent(id, {
    type: "headChange",
    headId,
    steps: agent.getRenderableReActSteps(),
    workflowContent: agent.getWorkflowState().getWorkflowContent(),
    operatorResults: getOperatorResultSummaries(agent),
  });
  broadcastNextContext(id, agent);
  return { headId, importedCount, restored: restored.length, ...(executed ? { executed } : {}) };
}

// ── seeding (study/seed.ts) ────────────────────────────────────────────────
// Every user gets the seed's workflow, agent and trace once: on their first
// visit (the frontend asks on login) or when a facilitator's script asks for
// them. The work runs in the background; GET /seed says where it stands.

let seedDefinition: SeedDefinition | undefined = loadSeedDefinition(env.AGENT_SEED_FILE);
const runningSeeds = new Map<string, Promise<void>>();

type SeedStatus =
  | { status: "disabled" }
  | { status: "none"; seed: string }
  | (NonNullable<ReturnType<TraceStore["seedOf"]>> & { live: boolean });

function seedStatusFor(user: UserInfo): SeedStatus {
  if (!seedDefinition?.bobflow || !traceStore) return { status: "disabled" };
  const row = traceStore.seedOf(user.uid, seedDefinition.name);
  if (!row) return { status: "none", seed: seedDefinition.name };
  return { ...row, live: row.agentId !== undefined && agentStore.has(row.agentId) };
}

/** Start the seed for a user unless it is done or under way; returns its state right away. */
function startSeed(userToken: string, user: UserInfo): SeedStatus {
  const current = seedStatusFor(user);
  if (current.status === "disabled" || current.status === "done" || current.status === "running") return current;
  const seed = seedDefinition!;
  const key = `${user.uid}:${seed.name}`;
  if (!runningSeeds.has(key)) {
    traceStore!.seedStarted({ userUid: user.uid, userName: user.name, seed: seed.name });
    runningSeeds.set(
      key,
      runSeed(userToken, user).finally(() => runningSeeds.delete(key))
    );
  }
  return seedStatusFor(user);
}

async function runSeed(userToken: string, user: UserInfo): Promise<void> {
  const seed = seedDefinition!;
  const bob = seed.bobflow!;
  let agentId: string | undefined;
  try {
    const computingUnitId = await ensureComputingUnit(userToken, bob.computingUnit);
    const workflowId = await createWorkflow(
      userToken,
      bob.workflowName,
      EMPTY_WORKFLOW_CONTENT as unknown as WorkflowContent,
      bob.description ?? `Seeded for ${user.name} from ${seed.name}`
    );
    const settings = { operatorDoc: true, ...(bob.settings ?? {}) } as NonNullable<CreateAgentRequest["settings"]>;
    validateNativeSettings(settings);
    const created = await createAgentInstance(
      bob.model,
      { userToken, userInfo: user, workflowId, computingUnitId },
      bob.agentName ?? "Bob"
    );
    agentId = created.agentId;
    applyInitialSettings(agentId, created.agent, settings);
    const archive = readSeedArchive(bob) as unknown as ArchiveImport;
    if (!Array.isArray(archive.steps)) throw new Error(`${bob.archive} is not an agent archive (no steps)`);
    const imported = await importArchive(agentId, created.agent, { ...archive, execute: true });
    traceStore!.seedFinished(user.uid, seed.name, { status: "done", workflowId, agentId, computingUnitId });
    log.info(
      {
        user: user.name,
        seed: seed.name,
        workflowId,
        agentId,
        steps: imported.importedCount,
        executed: imported.executed,
      },
      "user seeded"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    traceStore!.seedFinished(user.uid, seed.name, { status: "failed", agentId, error: message });
    log.warn({ err: error, user: user.name, seed: seed.name }, "seeding failed");
  }
}

/** Tests swap the definition in and out. */
export function _setSeedDefinitionForTests(definition: SeedDefinition | undefined): void {
  seedDefinition = definition;
}

// Status codes for handler-thrown errors; anything unlisted is a 500.
const ERROR_STATUS: Record<string, number> = {
  "Agent not found": 404,
  "Invalid or expired token": 401,
  "Authorization header with a Bearer token is required": 401,
  "modelType is required": 400,
};

/** Validate an incoming `summarizeParams` patch at the API boundary so bad
 *  knob values 400 at settings time instead of blowing up mid-turn. */
function parseSummarizePatch(raw: unknown): SummarizeParamsPatch | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null; // explicit clear
  const parsed = SummarizeParamsPatchSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid summarizeParams: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`
    );
  }
  return parsed.data;
}

/**
 * Generic validator for the optional experiment-config settings. One contract
 * for all: `undefined` = leave unchanged, `null` = turn the feature off,
 * object = zod-validate, filling defaults (failures throw `Invalid <name>: …`,
 * mapped to HTTP 400 by the handlers).
 */
function makeConfigParser<T>(name: string, schema: { safeParse: (raw: unknown) => any }) {
  return (raw: unknown): T | null | undefined => {
    if (raw === undefined) return undefined;
    if (raw === null) return null;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Invalid ${name}: ${parsed.error.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
      );
    }
    return parsed.data as T;
  };
}

const parseSelectorConfigInput = makeConfigParser<SelectorConfig>("selectorConfig", SelectorConfigSchema);
const parseFrontierDecayConfigInput = makeConfigParser<FrontierDecayConfig>(
  "frontierDecayConfig",
  FrontierDecayConfigSchema
);
const parseFoldResolvedRevisionsConfigInput = makeConfigParser<FoldResolvedRevisionsConfig>(
  "foldResolvedRevisionsConfig",
  FoldResolvedRevisionsConfigSchema
);
const parseRolePolicyConfigInput = makeConfigParser<RolePolicyConfig>("rolePolicyConfig", RolePolicyConfigSchema);
const parseProbeRetirementConfigInput = makeConfigParser<ProbeRetirementConfig>(
  "probeRetirementConfig",
  ProbeRetirementConfigSchema
);

/** Validate an incoming `tunerConfig` (the LLM context-tuner settings). `null`
 *  turns the tuner off. Requires a non-empty `model`. */
function parseTunerConfigInput(raw: unknown): TunerConfig | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "object" || raw === null || typeof (raw as any).model !== "string" || !(raw as any).model) {
    throw new Error("Invalid tunerConfig: `model` (string) is required");
  }
  const r = raw as any;
  return { model: r.model, sampleRows: r.sampleRows, richRows: r.richRows };
}

/** Validate an incoming `learnedConfig` (the learned-selector settings). `null`
 *  turns it off. */
function parseLearnedConfigInput(raw: unknown): LearnedConfig | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const parsed = LearnedConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid learnedConfig: ${parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`
    );
  }
  return parsed.data;
}

// Reject unknown/retired settings instead of Elysia silently stripping them.
const agentsRouter = new Elysia({ prefix: "/agents", normalize: false })
  // Error handler must live on the same Elysia instance whose routes throw, or
  // its scope will not see the errors. Elysia 1.x defaults to local scoping for
  // .onError, so attach here rather than on the outer app.
  .onError(({ code, error, set }) => {
    log.error({ err: error }, "request error");
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Body schema violations and malformed JSON are client errors, not 500s.
    if (code === "VALIDATION" || code === "PARSE" || error instanceof NativeCatalogSettingsError) {
      set.status = 400;
      return { error: errorMessage || "Invalid request body" };
    }
    // Zod-level context-policy validation failures are client errors too.
    if (
      errorMessage.startsWith("Invalid summarizeParams") ||
      errorMessage.startsWith("Invalid selectorConfig") ||
      errorMessage.startsWith("Invalid frontierDecayConfig") ||
      errorMessage.startsWith("Invalid foldResolvedRevisionsConfig") ||
      errorMessage.startsWith("Invalid probeRetirementConfig") ||
      errorMessage.startsWith("Invalid rolePolicyConfig") ||
      errorMessage.startsWith("Invalid learnedConfig") ||
      errorMessage.startsWith("Invalid tunerConfig")
    ) {
      set.status = 400;
      return { error: errorMessage };
    }
    set.status = ERROR_STATUS[errorMessage] ?? 500;
    return { error: errorMessage || "Internal server error" };
  })
  // The caller's agents (every agent, without a token or for an admin). With
  // `workflowId`, the caller's traced agents on that workflow that a restart
  // dropped come back first, so a seeded or earlier agent is there when its
  // user opens the workflow.
  .get("/", async ({ query, headers }) => {
    const token = extractBearerToken(headers.authorization);
    const user = token && validateToken(token) ? extractUserFromToken(token) : undefined;
    const workflowId = query.workflowId ? Number(query.workflowId) : undefined;
    if (user && token && workflowId !== undefined && Number.isFinite(workflowId) && traceStore) {
      for (const stored of traceStore.agentsOf(user.uid, workflowId)) {
        const id = String(stored.id);
        if (agentStore.has(id)) continue;
        try {
          await restoreAgent(id, token, user);
        } catch (error) {
          log.warn({ err: error, agentId: id, workflowId }, "a traced agent could not be restored for the list");
        }
      }
    }
    // An agent is its delegating user's; one made without a workflow has no owner and shows to everyone.
    const mine = (agent: TexeraAgent) => {
      const owner = agent.getDelegateConfig()?.userInfo?.uid;
      return !user || user.role === "ADMIN" || owner === undefined || owner === user.uid;
    };
    const agentList = Array.from(agentStore.entries())
      .filter(([, agent]) => mine(agent))
      .map(([id, agent]) => getAgentInfo(id, agent));
    return { agents: agentList };
  })
  // Seeding: the state of this user's seed, and a request to start it (see runSeed).
  .get("/seed", ({ headers }) => seedStatusFor(requireUser(headers.authorization).userInfo))
  .post("/seed", ({ headers }) => {
    const { userToken, userInfo } = requireUser(headers.authorization);
    return startSeed(userToken, userInfo);
  })
  // The built-in native operators, for clients that render native operators
  // (the workspace's property panel): each type's contract and the JSON schema
  // of the `properties` its operators carry. Declared before `/:id`.
  .get("/native-catalog", () => ({
    operators: NATIVE_OPERATORS.map(({ name, type, inputs, rowEffect, signature, doc, schema }) => ({
      name,
      type,
      inputs,
      rowEffect,
      signature,
      doc,
      schema,
    })),
  }))

  .post(
    "/",
    async ({ body, headers }) => {
      const { modelType, name, workflowId, computingUnitId, settings, driver } = body as CreateAgentRequest;

      if (!modelType) {
        throw new Error("modelType is required");
      }

      // The agent always calls the LLM gateway as the delegating user, so an
      // agent without a user token would be unable to generate anything. The
      // token travels in the Authorization header, never in the payload.
      const userToken = extractBearerToken(headers.authorization);
      if (!userToken) {
        throw new Error("Authorization header with a Bearer token is required");
      }
      if (!validateToken(userToken)) {
        throw new Error("Invalid or expired token");
      }

      validateNativeSettings(settings);

      const userInfo = extractUserFromToken(userToken);
      const delegateConfig: AgentDelegateConfig = {
        userToken,
        userInfo,
        workflowId,
        computingUnitId,
      };

      const { agentId, agent } = await createAgentInstance(modelType, delegateConfig, name, driver);

      try {
        if (settings) applyInitialSettings(agentId, agent, settings);
      } catch (error) {
        // Graph-dependent validation happens after bootstrap. A rejected
        // initial configuration must not leave a registered, unusable agent.
        agent.destroy();
        agentStore.delete(agentId);
        agentDrivers.delete(agentId);
        throw error;
      }

      if (settings) traceStore?.agentSettings(agentId, settingsToApi(agent), settings);
      return getAgentInfo(agentId, agent);
    },
    {
      body: t.Object({
        modelType: t.String(),
        name: t.Optional(t.String()),
        workflowId: t.Optional(t.Number()),
        computingUnitId: t.Optional(t.Number()),
        // Explicit driver override. Must be in the schema or Elysia's
        // normalize pass strips it from the body before the handler reads it.
        driver: t.Optional(t.Union([t.Literal("vercel-tool-use"), t.Literal("local-react")])),
        settings: t.Optional(
          t.Object({
            maxOperatorResultCharLimit: t.Optional(t.Number()),
            maxOperatorResultCellCharLimit: t.Optional(t.Number()),
            operatorResultSerializationMode: t.Optional(t.Literal("tsv")),
            toolTimeoutSeconds: t.Optional(t.Number()),
            executionTimeoutMinutes: t.Optional(t.Number()),
            disabledTools: t.Optional(t.Array(t.String())),
            maxSteps: t.Optional(t.Number()),
            maxOperatorEdits: t.Optional(t.Number()),
            agentMode: t.Optional(t.Union([t.Literal("code"), t.Literal("native")])),
            ...OBSERVATION_SETTINGS_SCHEMA,
            nativeProfileCollection: t.Optional(t.Boolean()),
            nativeProfileScope: t.Optional(t.Union([t.Literal("prefix"), t.Literal("full")])),
            dataEvidence: t.Optional(t.Boolean()),
            retrievalViews: t.Optional(
              t.Array(t.Union([t.Literal("full"), t.Literal("sample"), t.Literal("sample_stats")]), {
                minItems: 1,
                maxItems: 3,
              })
            ),
            fullResultCharLimit: t.Optional(t.Integer({ minimum: 128, maximum: 100000 })),
            dataEvidenceCharLimit: t.Optional(t.Integer({ minimum: 128, maximum: 100000 })),
            flowEvidenceCharLimit: t.Optional(t.Integer({ minimum: 128, maximum: 100000 })),
            flowEvidence: t.Optional(t.Boolean()),
            operatorDoc: t.Optional(t.Boolean()),
            respondToCanvasRuns: t.Optional(t.Boolean()),
            instructions: t.Optional(t.String({ maxLength: 20000 })),
            answerStatement: t.Optional(t.Boolean()),
            nativeChecks: t.Optional(t.Boolean()),
            resultSelection: t.Optional(t.Union([t.Literal("all"), t.Literal("rule"), t.Literal("scoped")])),
            contextMode: t.Optional(t.Union([t.Literal("delta"), t.Literal("latest")])),
            parallelToolCalls: t.Optional(t.Boolean()),
            includeOperatorProperties: t.Optional(t.Boolean()),
            thoughtReplay: t.Optional(t.Boolean()),
            agentTurns: t.Optional(t.Boolean()),
            contextWindowTokens: t.Optional(t.Number()),
            compactionStrategy: t.Optional(t.Union([t.Literal("sliding"), t.Literal("compress")])),
            deckSampleRatio: t.Optional(t.Number()),
            errorReflection: t.Optional(t.Boolean()),
            errorReflectionThreshold: t.Optional(t.Number()),
            thoughtReplayK: t.Optional(t.Number()),
            fewShotPrompt: t.Optional(t.Boolean()),
            maxResultRows: t.Optional(t.Number()),
            attemptReflection: t.Optional(t.Boolean()),
            toolDialect: t.Optional(t.Union([t.Literal("qwen-xml"), t.Literal("react-text")])),
            // Deep-partial summarize() params patch; zod-validated in-handler
            // (the shape is too rich for a TypeBox mirror to earn its keep).
            summarizeParams: t.Optional(t.Any()),
            selectorConfig: t.Optional(t.Any()),
            frontierDecayConfig: t.Optional(t.Any()),
            foldResolvedRevisionsConfig: t.Optional(t.Any()),
            probeRetirementConfig: t.Optional(t.Any()),
            rolePolicyConfig: t.Optional(t.Any()),
            learnedConfig: t.Optional(t.Any()),
            enableInspectTool: t.Optional(t.Boolean()),
            enableRenderPrefs: t.Optional(t.Boolean()),
            enableCodeInSnapshot: t.Optional(t.Boolean()),
            sourceProvenanceHint: t.Optional(t.Boolean()),
            staticCompaction: t.Optional(t.Boolean()),
            userTaskPlacement: t.Optional(t.Union([t.Literal("top"), t.Literal("bottom")])),
            messageLayout: t.Optional(t.String()),
            multiRequest: t.Optional(t.Union([t.Literal("off"), t.Literal("transcript"), t.Literal("catalog")])),
            catalogSource: t.Optional(t.Union([t.Literal("full"), t.Literal("docstring")])),
            catalogRecent: t.Optional(t.Integer()),
            tunerConfig: t.Optional(t.Any()),
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
    traceStore?.agentEnded(id, "deleted");
    return { deleted: true };
  })

  .get("/:id/react-steps", ({ params: { id } }) => {
    const agent = getAgent(id);
    return { steps: agent.getRenderableReActSteps(), state: agent.getState() };
  })

  // The agent's analysis as a file the chat's Import button takes into a fresh
  // agent: its steps, each step's operator results, and its instructions. The
  // dataflow is rebuilt from the steps' recorded calls on import, so no
  // snapshots travel.
  .get("/:id/archive", ({ params: { id } }) => {
    const agent = getAgent(id);
    const steps = agent.getRenderableReActSteps();
    return {
      agentId: id,
      agentName: agent.agentName,
      modelType: agent.modelType,
      exportedAt: new Date().toISOString(),
      instructions: settingsToApi(agent).instructions ?? "",
      stepCount: steps.length,
      steps,
      results: agent.exportOperatorResults(),
    };
  })

  .post("/:id/inspect-error", async ({ params: { id }, headers, body, set }) => {
    const agent = getAgent(id);
    const authorization = await authorizeDiagnosticRead(headers.authorization, agent.getDelegateConfig());
    if (!authorization.ok) {
      set.status = authorization.status;
      return { error: authorization.error };
    }
    const query = inspectErrorSchema.safeParse(body);
    if (!query.success) {
      set.status = 400;
      return { error: "Expected operatorId and optional revision/diagnosticId; no other fields are accepted." };
    }
    const inspection = agent.getSnapshotStorage().inspectNativeError(agent.getHead(), query.data);
    if (!inspection.found) set.status = 404;
    return inspection;
  })
  .get("/:id/operator-results", ({ params: { id } }) => {
    const agent = getAgent(id);
    return { results: getOperatorResultSummaries(agent) };
  })

  /**
   * Canvas actions on one native operator. `form` splits its statement into
   * fields for the editor; `edit` and `run` apply the user's change or run it
   * as a user step the agent reads on its next turn (TexeraAgent.applyUserAction).
   */
  .get("/:id/operators/:operatorId/form", async ({ params: { id, operatorId }, set }) => {
    const workflow = getAgent(id).getWorkflowState().getWorkflowContent();
    const view = workflow.operators.find(op => op.operatorID === operatorId)?.nativeOp;
    if (!view) {
      set.status = 404;
      return { error: `There is no native operator \`${operatorId}\`.` };
    }
    try {
      return await describeNativeStatement(operatorId, view, workflow);
    } catch (error) {
      set.status = 422;
      return { error: error instanceof Error ? error.message : String(error) };
    }
  })
  .post(
    "/:id/operators/:operatorId/edit",
    ({ params: { id, operatorId }, body, set }) => runUserAction(id, { kind: "edit", operatorId, ...body }, set),
    {
      body: t.Object({
        statement: t.String({ minLength: 1 }),
        python: t.Optional(t.String()),
        run: t.Optional(t.Boolean()),
      }),
    }
  )
  .post("/:id/operators/:operatorId/run", ({ params: { id, operatorId }, set }) =>
    runUserAction(id, { kind: "run", operatorId }, set)
  )

  /**
   * Check out a dataflow version from the version tree. A step's last version
   * moves HEAD there; one in the middle of a step's edits is restored as a
   * user step the agent reads (TexeraAgent.checkoutVersion).
   */
  .post(
    "/:id/checkout-version",
    ({ params: { id }, body, set }) => {
      const agent = getAgent(id);
      if (agent.getState() !== AgentState.AVAILABLE) {
        set.status = 409;
        return { error: "The agent is working; try again when it finishes." };
      }
      const headId = agent.checkoutVersion(body.snapshotId);
      traceStore?.event({ agentId: id, kind: "checkout-version", detail: { snapshotId: body.snapshotId, headId } });
      if (!headId) {
        set.status = 404;
        return { error: `There is no version ${body.snapshotId}.` };
      }
      broadcastToAgent(id, {
        type: "headChange",
        headId,
        steps: agent.getRenderableReActSteps(),
        workflowContent: agent.getWorkflowState().getWorkflowContent(),
        operatorResults: getOperatorResultSummaries(agent),
      });
      broadcastNextContext(id, agent);
      return { status: "checked out", headId };
    },
    { body: t.Object({ snapshotId: t.String() }) }
  )

  /** One version's dataflow and results, to preview it (version playback) without moving HEAD. */
  .get("/:id/versions/:snapshotId", ({ params: { id, snapshotId }, set }) => {
    const snapshot = getAgent(id).getSnapshotStorage().getSnapshotById(snapshotId);
    if (!snapshot || snapshot.version === undefined) {
      set.status = 404;
      return { error: `There is no version ${snapshotId}.` };
    }
    return {
      id: snapshot.id,
      version: snapshot.version,
      action: snapshot.action,
      timestamp: snapshot.createdAt,
      workflow: snapshot.workflow,
      operatorResults: versionResults(snapshot),
    };
  })

  /**
   * Snapshot tree shape — every node in the agent's
   * `WorkflowSnapshotStorage`, parent links, owning ReAct step, and a few
   * size hints. Powers the dashboard's "Snapshot tree" view. Full workflow
   * + results bodies are still fetched lazily via `/snapshots/:stepId`.
   */
  .get("/:id/snapshot-tree", ({ params: { id } }) => {
    const agent = getAgent(id);
    const storage = agent.getSnapshotStorage();
    const rootId = storage.getRootSnapshotId();
    // Exclude the synthetic empty-root snapshot ("S0"). It is a structural
    // placeholder with no workflow of its own; its children (the first real
    // snapshots) become the visible top-level nodes. `rootId` is still returned
    // so clients can resolve the "no active snapshot" fallback. Each node's
    // timestamp is when its action happened.
    return {
      rootId,
      // The snapshot HEAD shows; the version tree marks its nearest version.
      headSnapshotId: storage.getAssociatedSnapshot(agent.getHead()).id,
      nodes: storage.getSnapshotTreeNodes().filter(n => n.id !== rootId),
    };
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
    const results = operatorResultSummaries(storage.getAllVisibleResults(resolvedStepId), workflowEntry.value);
    return {
      stepId: resolvedStepId,
      workflow: workflowEntry?.value ?? null,
      workflowSourceStepId: workflowEntry?.sourceStepId ?? null,
      results,
      ...(storage.getAssociatedSnapshot(resolvedStepId).nativeObservations !== undefined
        ? { nativeObservations: storage.getAssociatedSnapshot(resolvedStepId).nativeObservations }
        : {}),
    };
  })

  .post(
    "/:id/steps-by-operators",
    ({ params: { id }, body }) => {
      const agent = getAgent(id);
      const { operatorIds } = body;
      // Exclude the synthetic init step (it "touched" every operator on load).
      return {
        steps: agent.getReActStepsByOperatorIds(operatorIds || []).filter(s => !TexeraAgent.isInitializationStep(s)),
      };
    },
    {
      body: t.Object({
        operatorIds: t.Array(t.String()),
      }),
    }
  )

  .get("/:id/system-info", ({ params: { id } }) => {
    const agent = getAgent(id);
    return {
      ...agent.getSystemInfo(),
      inputBudget: readInputBudget(process.env),
      modelCallLimit: Number(process.env.MODEL_MAX_CALLS_PER_TURN ?? 0),
    };
  })

  .post("/:id/stop", ({ params: { id } }) => {
    const agent = getAgent(id);
    agent.stop();
    traceStore?.event({ agentId: id, kind: "stop" });
    return { status: "stopping" };
  })

  // Synchronous one-turn REST entry point — the easy integration surface for
  // external callers (scripts, notebooks, other services) that don't want to
  // speak the WebSocket protocol. Runs one full agent turn and returns the
  // final answer; the trace is then a GET /:id/react-steps away. WS clients
  // attached to the same agent still receive every step/state frame live —
  // the step callbacks fire regardless of which door the message came in.
  .post(
    "/:id/message",
    async ({ params: { id }, body, set }) => {
      const agent = getAgent(id);
      const { content, messageSource, contextRequests, contextTables, contextUpstream, contextTasks } = body as {
        content: string;
        messageSource?: "chat" | "feedback";
        contextRequests?: number[];
        contextTables?: string[];
        contextUpstream?: boolean;
        contextTasks?: number[];
      };
      if (agent.getState() !== AgentState.AVAILABLE) {
        set.status = 409;
        return { error: `agent is ${agent.getState()} — one turn at a time` };
      }
      const result = await agent.sendMessage(content, messageSource, {
        contextRequests,
        contextTables,
        contextUpstream,
        contextTasks,
      });
      const steps = agent.getReActSteps();
      const endStep = [...steps].reverse().find(s => s.role === "agent" && s.isEnd);
      const lastWithContent = [...steps].reverse().find(s => s.role === "agent" && (s.content ?? "").trim().length > 0);
      broadcastNextContext(id, agent);
      return {
        status: "complete",
        state: agent.getState(),
        answer: (endStep?.content ?? lastWithContent?.content ?? "").trim(),
        steps: result.messages.length,
        headId: agent.getHead(),
      };
    },
    {
      body: t.Object({
        content: t.String(),
        messageSource: t.Optional(t.Union([t.Literal("chat"), t.Literal("feedback")])),
        // Earlier requests, by number from 1, that this request's context shows; all when absent.
        contextRequests: t.Optional(t.Array(t.Integer({ minimum: 1 }))),
        // Earlier tables this request builds on; the context then shows them, and lists the rest, instead of earlier requests.
        contextTables: t.Optional(t.Array(t.String())),
        // With contextTables: also show what the named tables are built from, back to the files.
        contextUpstream: t.Optional(t.Boolean()),
        // Instead of contextTables: the earlier tasks this request builds on. The context then lists every
        // earlier task by its request, dataflow changes and answer, with these in detail, instead of earlier requests.
        contextTasks: t.Optional(t.Array(t.Integer({ minimum: 1 }))),
      }),
    }
  )

  // An agent the trace store holds but memory does not (the service restarted):
  // rebuilt as it was created, with its stored settings, steps, dataflow versions
  // and operator results, and traced from here on. The caller's token stands in
  // for the one the agent had, as for a new agent.
  .post("/:id/restore", async ({ params: { id }, headers, set }) => {
    if (agentStore.has(id)) {
      set.status = 409;
      return { error: `Agent ${id} is live` };
    }
    if (!traceStore?.agent(id)) {
      set.status = 404;
      return { error: `No trace for agent ${id}` };
    }
    const { userToken, userInfo } = requireUser(headers.authorization);
    const agent = await restoreAgent(id, userToken, userInfo);
    return getAgentInfo(id, agent);
  })

  .post("/:id/clear", ({ params: { id } }) => {
    const agent = getAgent(id);
    agent.clearHistory();
    traceStore?.event({ agentId: id, kind: "clear" });
    broadcastNextContext(id, agent);
    return { status: "cleared" };
  })

  .post(
    "/:id/import-react-steps",
    async ({ params: { id }, body }) => {
      const agent = getAgent(id);
      const archive = body as {
        steps?: unknown;
        snapshots?: unknown;
        results?: unknown;
        instructions?: unknown;
        execute?: unknown;
      };
      if (!archive || !Array.isArray(archive.steps)) {
        throw new Error(
          "body must be { steps: ReActStep[], snapshots?: Record<stepId, WorkflowContent>, results?: Record<stepId, Record<operatorId, OperatorInfo>>, instructions?: string }"
        );
      }

      const { headId, importedCount, executed } = await importArchive(id, agent, archive as ArchiveImport);
      return { status: "imported", headId, importedCount, ...(executed ? { executed } : {}) };
    },
    {
      body: t.Object(
        {
          steps: t.Array(t.Any()),
          snapshots: t.Optional(t.Record(t.String(), t.Any())),
          results: t.Optional(t.Record(t.String(), t.Record(t.String(), t.Any()))),
          instructions: t.Optional(t.String({ maxLength: 20000 })),
          execute: t.Optional(t.Boolean()),
        },
        { additionalProperties: true }
      ),
    }
  )

  .post("/:id/checkout", ({ params: { id }, body, set }) => {
    const agent = getAgent(id);
    const { stepId } = body as { stepId: string };
    if (!stepId) throw new Error("stepId is required");
    // Moving HEAD under a running turn would graft its next steps elsewhere.
    if (agent.getState() !== AgentState.AVAILABLE) {
      set.status = 409;
      return { error: "The agent is working; try again when it finishes." };
    }

    const success = agent.checkout(stepId);
    traceStore?.event({ agentId: id, kind: "checkout", detail: { stepId, success } });
    if (!success) throw new Error(`Step ${stepId} not found or checkout failed`);

    const allSteps = agent.getRenderableReActSteps();
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

  .get("/:id/settings", ({ params: { id } }) => settingsToApi(getAgent(id)))

  .patch(
    "/:id/settings",
    ({ params: { id }, body }) => {
      const agent = getAgent(id);
      const settings = body as UpdateAgentSettingsRequest;
      validateEvidenceSettings(settings);

      log.info(
        {
          agentId: id,
          maxOperatorResultCharLimit: settings.maxOperatorResultCharLimit,
          maxOperatorResultCellCharLimit: settings.maxOperatorResultCellCharLimit,
        },
        "updating agent settings"
      );

      agent.updateSettings({
        ...observationFormatPatch(settings),
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
        maxOperatorEdits: settings.maxOperatorEdits,
        agentMode: settings.agentMode ? (settings.agentMode as AgentMode) : undefined,
        nativeProfileCollection: settings.nativeProfileCollection,
        nativeProfileScope: settings.nativeProfileScope,
        dataEvidence: settings.dataEvidence,
        retrievalViews: settings.retrievalViews,
        fullResultCharLimit: settings.fullResultCharLimit,
        dataEvidenceCharLimit: settings.dataEvidenceCharLimit,
        flowEvidenceCharLimit: settings.flowEvidenceCharLimit,
        flowEvidence: settings.flowEvidence,
        operatorDoc: settings.operatorDoc,
        respondToCanvasRuns: settings.respondToCanvasRuns,
        instructions: settings.instructions,
        answerStatement: settings.answerStatement,
        nativeChecks: settings.nativeChecks,
        resultSelection: (settings as any).resultSelection,
        contextMode: settings.contextMode ? (settings.contextMode as ContextMode) : undefined,
        parallelToolCalls: settings.parallelToolCalls,
        includeOperatorProperties: settings.includeOperatorProperties,
        thoughtReplay: settings.thoughtReplay,
        // These four were accepted by the body schema but silently dropped
        // before the summarize() refactor — forward them like the create path.
        agentTurns: settings.agentTurns,
        contextWindowTokens: settings.contextWindowTokens,
        compactionStrategy: settings.compactionStrategy,
        deckSampleRatio: settings.deckSampleRatio,
        errorReflection: settings.errorReflection,
        errorReflectionThreshold: settings.errorReflectionThreshold,
        thoughtReplayK: settings.thoughtReplayK,
        fewShotPrompt: settings.fewShotPrompt,
        maxResultRows: settings.maxResultRows,
        attemptReflection: settings.attemptReflection,
        toolDialect: settings.toolDialect,
        summarizeParams: parseSummarizePatch((settings as UpdateAgentSettingsRequest).summarizeParams),
        selectorConfig: parseSelectorConfigInput((settings as any).selectorConfig),
        frontierDecayConfig: parseFrontierDecayConfigInput((settings as any).frontierDecayConfig),
        foldResolvedRevisionsConfig: parseFoldResolvedRevisionsConfigInput(
          (settings as any).foldResolvedRevisionsConfig
        ),
        probeRetirementConfig: parseProbeRetirementConfigInput((settings as any).probeRetirementConfig),
        rolePolicyConfig: parseRolePolicyConfigInput((settings as any).rolePolicyConfig),
        learnedConfig: parseLearnedConfigInput((settings as any).learnedConfig),
        enableInspectTool: (settings as UpdateAgentSettingsRequest).enableInspectTool,
        enableRenderPrefs: (settings as any).enableRenderPrefs,
        sourceProvenanceHint: (settings as any).sourceProvenanceHint,
        tunerConfig: parseTunerConfigInput((settings as any).tunerConfig),
        multiRequest: settings.multiRequest,
        catalogSource: settings.catalogSource,
        catalogRecent: settings.catalogRecent,
      });

      // Settings can change context assembly (agentMode flips schema gating,
      // contextMode flips the selection policy) — re-broadcast the preview
      // so clients stay in sync.
      broadcastNextContext(id, agent);
      traceStore?.agentSettings(id, settingsToApi(agent), settings);

      return settingsToApi(agent);
    },
    {
      body: t.Object({
        maxOperatorResultCharLimit: t.Optional(t.Number()),
        maxOperatorResultCellCharLimit: t.Optional(t.Number()),
        operatorResultSerializationMode: t.Optional(t.Literal("tsv")),
        toolTimeoutSeconds: t.Optional(t.Number()),
        executionTimeoutMinutes: t.Optional(t.Number()),
        maxSteps: t.Optional(t.Number()),
        maxOperatorEdits: t.Optional(t.Number()),
        disabledTools: t.Optional(t.Array(t.String())),
        agentMode: t.Optional(t.Union([t.Literal("code"), t.Literal("native")])),
        ...OBSERVATION_SETTINGS_SCHEMA,
        nativeProfileCollection: t.Optional(t.Boolean()),
        nativeProfileScope: t.Optional(t.Union([t.Literal("prefix"), t.Literal("full")])),
        dataEvidence: t.Optional(t.Boolean()),
        retrievalViews: t.Optional(
          t.Array(t.Union([t.Literal("full"), t.Literal("sample"), t.Literal("sample_stats")]), {
            minItems: 1,
            maxItems: 3,
          })
        ),
        fullResultCharLimit: t.Optional(t.Integer({ minimum: 128, maximum: 100000 })),
        dataEvidenceCharLimit: t.Optional(t.Integer({ minimum: 128, maximum: 100000 })),
        flowEvidenceCharLimit: t.Optional(t.Integer({ minimum: 128, maximum: 100000 })),
        flowEvidence: t.Optional(t.Boolean()),
        operatorDoc: t.Optional(t.Boolean()),
        respondToCanvasRuns: t.Optional(t.Boolean()),
        instructions: t.Optional(t.String({ maxLength: 20000 })),
        answerStatement: t.Optional(t.Boolean()),
        nativeChecks: t.Optional(t.Boolean()),
        resultSelection: t.Optional(t.Union([t.Literal("all"), t.Literal("rule"), t.Literal("scoped")])),
        contextMode: t.Optional(t.Union([t.Literal("delta"), t.Literal("latest")])),
        parallelToolCalls: t.Optional(t.Boolean()),
        includeOperatorProperties: t.Optional(t.Boolean()),
        thoughtReplay: t.Optional(t.Boolean()),
        agentTurns: t.Optional(t.Boolean()),
        contextWindowTokens: t.Optional(t.Number()),
        compactionStrategy: t.Optional(t.Union([t.Literal("sliding"), t.Literal("compress")])),
        deckSampleRatio: t.Optional(t.Number()),
        errorReflection: t.Optional(t.Boolean()),
        errorReflectionThreshold: t.Optional(t.Number()),
        thoughtReplayK: t.Optional(t.Number()),
        fewShotPrompt: t.Optional(t.Boolean()),
        maxResultRows: t.Optional(t.Number()),
        attemptReflection: t.Optional(t.Boolean()),
        toolDialect: t.Optional(t.Union([t.Literal("qwen-xml"), t.Literal("react-text")])),
        // Deep-partial summarize() params patch; zod-validated in-handler.
        // Pass null to clear a previously-set patch.
        summarizeParams: t.Optional(t.Any()),
        // Selector action vector; zod-validated in-handler. null turns it off.
        selectorConfig: t.Optional(t.Any()),
        // Conservative settled-result overlay; zod-validated in-handler.
        frontierDecayConfig: t.Optional(t.Any()),
        // Rank-3 fold-resolved-revisions rule; zod-validated in-handler.
        foldResolvedRevisionsConfig: t.Optional(t.Any()),
        // Rank-4 probe-retirement overlay; zod-validated in-handler.
        probeRetirementConfig: t.Optional(t.Any()),
        rolePolicyConfig: t.Optional(t.Any()),
        // Learned-selector config; validated in-handler. null turns it off.
        learnedConfig: t.Optional(t.Any()),
        enableInspectTool: t.Optional(t.Boolean()),
        enableRenderPrefs: t.Optional(t.Boolean()),
        // LLM context-tuner config; validated in-handler. null turns it off.
        tunerConfig: t.Optional(t.Any()),
        multiRequest: t.Optional(t.Union([t.Literal("off"), t.Literal("transcript"), t.Literal("catalog")])),
        catalogSource: t.Optional(t.Union([t.Literal("full"), t.Literal("docstring")])),
        catalogRecent: t.Optional(t.Integer()),
      }),
    }
  );

interface WsMessage {
  type: "message" | "stop" | "debug";
  content?: string;
  messageSource?: "chat" | "feedback";
}

interface WsOutgoingMessage {
  type: "step" | "state" | "error" | "complete" | "init" | "headChange" | "nextContext" | "snapshot" | "progress";
  step?: ReActStep;
  state?: string;
  error?: string;
  steps?: ReActStep[];
  headId?: string;
  operatorResults?: Record<string, OperatorResultSummaryWs>;
  workflowContent?: any;
  /** Assembled next-step transcript content (markdown/JSON). Updated whenever
   * steps, HEAD, workflow, or settings change. Same code path the LLM would
   * receive on the next prepareStep. */
  content?: string;
  /** For "snapshot" events: the step the workflow was written under. */
  stepId?: string;
  /** For "snapshot" events: the freshly recorded workflow content. */
  workflow?: any;
  /** For "progress" events: the version an action of a running call recorded. */
  version?: VersionInfo;
  /** For "progress" events of an edit: what it changed, on top of the dataflow
   * the client has (DataflowChange). */
  dataflow?: DataflowChange;
  /** For "progress" events of a run: the operators it computes; [] once it finished. */
  running?: string[];
}

/** An edit's change to the dataflow: the operators it added or changed, in
 * full; the ones it removed; and the links and positions after it. Sending
 * only these keeps each event small, as a native operator carries its runtime. */
interface DataflowChange {
  operators: unknown[];
  removed: string[];
  links: unknown[];
  operatorPositions: Record<string, unknown>;
}

function getOperatorResultSummaries(agent: TexeraAgent): Record<string, OperatorResultSummaryWs> {
  const head = agent.getHead();
  if (!head) return {};
  const storage = agent.getSnapshotStorage();
  return operatorResultSummaries(storage.getAllVisibleResults(head), storage.getWorkflow(head));
}

/** Every operator's result at one version. */
function versionResults(snapshot: SnapshotData): Record<string, OperatorResultSummaryWs> {
  return operatorResultSummaries(
    new Map([...snapshot.results].map(([operatorId, entry]) => [operatorId, entry.info])),
    snapshot.workflow
  );
}

/** A "progress" event for a version a running call recorded: an edit carries
 * its change to the dataflow; a run, the operators it computes, then, like a
 * show, every operator's result at that version. */
function progressMessage(agent: TexeraAgent, stepId: string, progress: DataflowProgress): WsOutgoingMessage {
  const storage = agent.getSnapshotStorage();
  const snapshot = storage.getSnapshotById(progress.version.snapshotId);
  const message: WsOutgoingMessage = { type: "progress", stepId, version: progress.version };
  if (!snapshot) return message;
  if (changesDataflow(progress.version)) {
    const previous = snapshot.parentId ? storage.getSnapshotById(snapshot.parentId)?.workflow : undefined;
    const before = new Map((previous?.operators ?? []).map(op => [op.operatorID, op]));
    const after = new Set(snapshot.workflow.operators.map(op => op.operatorID));
    message.dataflow = {
      operators: snapshot.workflow.operators.filter(op => !isDeepStrictEqual(before.get(op.operatorID), op)),
      removed: [...before.keys()].filter(operatorId => !after.has(operatorId)),
      links: snapshot.workflow.links,
      operatorPositions: snapshot.workflow.operatorPositions,
    };
  }
  if (progress.running) message.running = progress.running;
  if (progress.version.kind === "show" || progress.running?.length === 0)
    message.operatorResults = versionResults(snapshot);
  return message;
}

/** Stream what a running turn or canvas action records to the agent's
 * WebSocket clients: each step as it lands or changes, each version a
 * dataflow call records, and each snapshot write. */
function streamAgentEvents(agentId: string, agent: TexeraAgent): void {
  agent.setStepCallback(step => {
    // Never stream the synthetic init step to clients.
    if (TexeraAgent.isInitializationStep(step)) return;
    broadcastToAgent(agentId, { type: "step", step });
    broadcastNextContext(agentId, agent);
  });
  agent.setSnapshotCallback((stepId, workflow) => broadcastToAgent(agentId, { type: "snapshot", stepId, workflow }));
  agent.setProgressCallback((stepId, progress) => broadcastToAgent(agentId, progressMessage(agent, stepId, progress)));
}

function stopAgentEvents(agent: TexeraAgent): void {
  agent.setStepCallback(null);
  agent.setSnapshotCallback(null);
  agent.setProgressCallback(null);
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
 * Run one agent turn and stream it to the agent's WebSocket clients: the
 * state, each step as it lands, snapshot writes (so clients refresh their
 * view of the workflow without it riding on every step), and the completion
 * frame. A failed turn sends an error frame.
 */
async function streamTurn(agentId: string, agent: TexeraAgent, run: () => Promise<AgentMessageResult>): Promise<void> {
  streamAgentEvents(agentId, agent);
  broadcastToAgent(agentId, { type: "state", state: "GENERATING" });
  try {
    const result = await run();
    stopAgentEvents(agent);
    const allSteps = agent.getReActSteps();
    const lastStep = allSteps[allSteps.length - 1];
    if (lastStep && lastStep.isEnd && !TexeraAgent.isInitializationStep(lastStep)) {
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
    stopAgentEvents(agent);
    broadcastToAgent(agentId, { type: "error", error: error.message });
    broadcastToAgent(agentId, { type: "state", state: agent.getState() });
  }
}

/**
 * Apply a canvas action (TexeraAgent.applyUserAction) and stream it to the
 * agent's WebSocket clients as a turn is streamed: state, step, snapshot and
 * completion frames. A rejected action, or one that changes nothing, streams
 * nothing.
 */
async function runUserAction(agentId: string, action: UserActionRequest, set: { status?: number | string }) {
  const agent = getAgent(agentId);
  // Checked before the callbacks are taken over: they belong to a running turn.
  if (agent.getState() !== AgentState.AVAILABLE) {
    set.status = 409;
    return { error: "The agent is working; try again when it finishes." };
  }
  let recorded = false;
  // A run the agent answers: its turn starts once the action is streamed.
  let respondTo: ReActStep | undefined;
  streamAgentEvents(agentId, agent);
  try {
    const outcome = await agent.applyUserAction(action, () => {
      recorded = true;
      broadcastToAgent(agentId, { type: "state", state: "GENERATING" });
    });
    if (outcome.respond && outcome.step) respondTo = outcome.step;
    return {
      status: outcome.status,
      ...(outcome.step
        ? { stepId: outcome.step.id, userAction: outcome.step.userAction, content: outcome.step.content }
        : {}),
      operatorResults: getOperatorResultSummaries(agent),
      responding: respondTo !== undefined,
    };
  } catch (error) {
    if (error instanceof UserActionError) {
      set.status = error.status;
      return { error: error.message };
    }
    throw error;
  } finally {
    stopAgentEvents(agent);
    if (recorded) {
      broadcastToAgent(agentId, {
        type: "complete",
        state: agent.getState(),
        operatorResults: getOperatorResultSummaries(agent),
      });
      broadcastNextContext(agentId, agent);
    }
    const step = respondTo;
    if (step) void streamTurn(agentId, agent, () => agent.respondToUserAction(step));
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
  return new Elysia({ normalize: false })
    .use(cors())
    .use(dashboardPlugin)
    .group(env.API_PREFIX, app =>
      app
        .get("/healthcheck", () => ({
          status: "ok",
          timestamp: new Date().toISOString(),
        }))
        // The trace store: every agent it holds, and one agent's whole trace as JSON.
        .get("/traces", ({ query }) => ({
          database: traceStore?.path ?? null,
          // `?user=<name or uid>` keeps one participant's agents.
          agents: (traceStore?.listAgents(typeof query.user === "string" ? query.user : undefined) ?? []).map(
            agent => ({
              ...agent,
              live: agentStore.has(String(agent.id)),
            })
          ),
        }))
        .get("/traces/:id", ({ params: { id }, set }) => {
          const trace = traceStore?.exportAgent(id);
          if (!trace) {
            set.status = 404;
            return { error: `No trace for agent ${id}` };
          }
          return trace;
        })
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
          steps: agent.getRenderableReActSteps(),
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
          traceStore?.event({ agentId, kind: "stop" });
          broadcastToAgent(agentId, { type: "state", state: "STOPPING" });
          return;
        }

        // One turn or canvas action at a time, as on the REST route.
        if ((msg.type === "message" || msg.type === "debug") && agent.getState() !== AgentState.AVAILABLE) {
          ws.send(JSON.stringify({ type: "error", error: "The agent is busy; wait until it finishes." }));
          return;
        }

        if (msg.type === "message") {
          if (!msg.content || typeof msg.content !== "string") {
            ws.send(JSON.stringify({ type: "error", error: "Message content is required" }));
            return;
          }

          wsLog.info({ agentId, preview: msg.content.substring(0, 50) }, "received message");
          await streamTurn(agentId, agent, () => agent.sendMessage(msg.content!, msg.messageSource));
        }

        // Debug input — bypasses the LLM. Mirrors the "message" branch: same
        // step callback, same state frames; the agent records steps directly.
        if (msg.type === "debug") {
          if (!msg.content || typeof msg.content !== "string") {
            ws.send(JSON.stringify({ type: "error", error: "Debug content is required" }));
            return;
          }

          wsLog.info({ agentId, preview: msg.content.substring(0, 50) }, "received debug input");

          streamAgentEvents(agentId, agent);
          broadcastToAgent(agentId, { type: "state", state: "GENERATING" });

          try {
            await agent.handleDebugInput(msg.content, msg.messageSource);
            stopAgentEvents(agent);
            broadcastToAgent(agentId, {
              type: "complete",
              state: agent.getState(),
              operatorResults: getOperatorResultSummaries(agent),
            });
            broadcastNextContext(agentId, agent);
            wsLog.info({ agentId }, "debug input complete");
          } catch (error: any) {
            stopAgentEvents(agent);
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
    .onError(({ code, error, set }) => {
      // Catch-all for non-router routes such as /api/healthcheck and the websocket route.
      // Elysia tags unmatched paths with code === "NOT_FOUND" — those are
      // routine client mistakes (favicon probes, etc.) and don't deserve an
      // ERROR-level stack trace, just a quiet 404.
      if (code === "NOT_FOUND") {
        set.status = 404;
        return { error: "not found" };
      }
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
  // Agent ids start over, so the trace store starts over too: rows of an earlier test's agent must
  // not come back as a later agent's past.
  traceStore = openTraceStore(env.AGENT_TRACE_DB);
}

/** Forget a live agent, as a restart does, leaving its trace in the store. */
export function _dropLiveAgentForTests(agentId: string): void {
  agentStore.delete(agentId);
  agentDrivers.delete(agentId);
}

function printStartupMessage(app: ReturnType<typeof buildApp>) {
  const LINE = "=".repeat(60);
  console.log(LINE);
  console.log("Texera Agent Service (Elysia.js + RxJS)");
  console.log(LINE);
  console.log(`Server running at http://localhost:${env.PORT}`);
  console.log(`Trace dashboard:  http://localhost:${env.PORT}/dashboard`);
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
