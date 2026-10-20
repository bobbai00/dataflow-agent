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
import { withRequiredToolChoice } from "./agent/llm-drivers/required-tool-choice";
import { TexeraAgent } from "./agent/texera-agent";
import { NativeCatalogSettingsError, validateNativeSettings, validateEvidenceSettings } from "./agent/native/settings";
import {
  operatorInfoToSummary,
  type OperatorResultSummary as OperatorResultSummaryWs,
} from "./api/operator-result-summary";
import { getBackendConfig } from "./api/backend-api";
import { extractBearerToken, extractUserFromToken, validateToken } from "./api/auth-api";
import { authorizeDiagnosticRead } from "./api/diagnostic-auth";
import { inspectErrorSchema } from "./agent/native/inspect-error-query";
import { WorkflowSystemMetadata } from "./agent/util/workflow-system-metadata";
import { env } from "./config/env";
import { createLogger } from "./logger";
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
/** Turn index (0-based) in which each operator was last touched. */
/**
 * Which operators keep a FULL index entry (summary + schema) this step.
 *
 * The turn's own work and its direct inputs are unconditional — a turn that
 * cannot see what it is editing rebuilds it, which is how operator counts reach
 * the hundreds in the first place. Everything else is admitted
 * most-recently-touched first until `cap` is reached; the remainder collapses to
 * a bare header line, still named and still one `recallState` call away.
 *
 * Exported because this policy is where the 2026-08-06 accuracy regression
 * lived, and a policy that can only be observed through a live benchmark run is
 * a policy that gets its next bug the same expensive way.
 */
export function selectDetailedOperators(
  frontier: string[],
  upstream: string[],
  lastTouch: Map<string, number>,
  cap: number
): Set<string> {
  const keep = new Set<string>([...frontier, ...upstream]);
  const byRecency = [...lastTouch.entries()].sort((a, b) => b[1] - a[1]);
  for (const [opId] of byRecency) {
    if (keep.size >= cap) break;
    keep.add(opId);
  }
  return keep;
}

function lastTouchTurnByOperator(visibleSteps: Array<{ messageId: string; toolCalls?: Array<{ input?: any }> }>): {
  lastTouch: Map<string, number>;
  turnCount: number;
} {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const step of visibleSteps) {
    if (!seen.has(step.messageId)) {
      seen.add(step.messageId);
      order.push(step.messageId);
    }
  }
  const turnOf = new Map(order.map((id, i) => [id, i]));
  const lastTouch = new Map<string, number>();
  for (const step of visibleSteps) {
    const turn = turnOf.get(step.messageId) ?? 0;
    for (const call of step.toolCalls ?? []) {
      const opId = call.input?.operatorId;
      if (typeof opId === "string") lastTouch.set(opId, turn);
    }
  }
  return { lastTouch, turnCount: order.length };
}

/** Operator ids touched by the turn in progress (the newest messageId group) —
 *  the ones that render RICH under the turn-history index while everything
 *  older renders as a one-line entry. */
function currentTurnOperatorIds(
  visibleSteps: Array<{ messageId: string; toolCalls?: Array<{ input?: any }> }>
): string[] {
  if (visibleSteps.length === 0) return [];
  const lastMessageId = visibleSteps[visibleSteps.length - 1].messageId;
  const ids = new Set<string>();
  for (const step of visibleSteps) {
    if (step.messageId !== lastMessageId) continue;
    for (const call of step.toolCalls ?? []) {
      const opId = call.input?.operatorId;
      if (typeof opId === "string") ids.add(opId);
    }
  }
  return [...ids];
}

function latestTaskText(visibleSteps: { role: string; content?: string }[]): string {
  for (let i = visibleSteps.length - 1; i >= 0; i--) {
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
    offBranchTurns,
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
      compactKeepLastSteps: settings.compactKeepLastSteps,
      showCompactMeter: settings.enableCompactTool,
      staticCompaction: settings.staticCompaction,
      // Multi-turn: request placement (cache) + prior-turn catalogue (pull).
      userTaskPlacement: settings.userTaskPlacement,
      turnHistoryIndex: settings.turnHistory === "index" ? true : undefined,
      thinObservations: settings.indexThinObservations !== false ? undefined : false,
      attemptReflection: settings.attemptReflection,
      // Caching is not optional: unless an arm pins a layout, LATEST ships one
      // message per operator block (opSplit) and DELTA ships the append-only
      // tool-call transcript (native), the two framings gpt-5.6-* can credit.
      messageLayout:
        settings.messageLayout ??
        (settings.versionedMode || settings.sessionTurns
          ? "turnSplit"
          : settings.contextMode === ContextMode.LATEST
            ? "opSplit"
            : "native"),
      versionedCatalog: settings.versionedMode,
      versionedHeads: settings.versionedHeads,
      sessionTurns: settings.sessionTurns,
      recallOperatorLevel: settings.recallOperatorLevel,
      specAudit: settings.specAudit,
      // Rank-3 static rule (DELTA-only): fold resolved operator revisions.
      foldResolvedRevisions: settings.foldResolvedRevisionsConfig ? true : undefined,
      foldGraceEvents: settings.foldResolvedRevisionsConfig?.graceEvents,
      // Write-time render prefs (DELTA event scoping; LATEST goes via overlay).
      renderPrefsEnabled: settings.enableRenderPrefs ? true : undefined,
      summarizePatch: settings.summarizeParams,
      // Version-tree navigation: global turn numbers, and the turns a resume
      // has branched away from (both empty on a single-branch session).
      turnNumberByMessageId,
      offBranchTurns,
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
      settings.turnHistory === "index" ||
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
      // Turn-history index: the snapshot is an INDEX, not the state dump. First
      // attempt at cataloguing rendered every operator's code + result table in
      // `# Current Dataflow` every step — at turn 30 of the 42-turn NFL task
      // that was 323 operators = 438 KB of a 463 KB prompt, MORE expensive than
      // the append-only baseline it replaced ($12.39 vs $9.99) and the live
      // request buried under it (Initial-turn accuracy fell to 0%). So: every
      // operator renders as summary + Schema line only; code and sample rows
      // render ONLY for operators touched by the turn in progress; anything
      // else is one recallState call away.
      if (settings.turnHistory === "index") {
        params = applySummarizeParamsPatch(params, {
          operators: {
            defaults: {
              property: { includeCode: false },
              result: { latest: { detail: "shape", column: { schema: true } } },
            },
          },
        });
        const frontier = currentTurnOperatorIds(visibleSteps);
        if (frontier.length > 0) {
          // Cap on the UPSTREAM value channel only. There is deliberately no cap
          // on code: an operator this turn is working on renders its code in
          // full, however many of them there are. A partial view of the turn's
          // own code is worse than useless — the model cannot tell whether the
          // definition it needs is absent or merely not shown, so it rebuilds
          // what it already has, which grows the turn and the operator count
          // together. If a turn genuinely touches enough operators for this to
          // hurt, the bug is the operator sprawl, and it is to be diagnosed
          // where it happens rather than hidden here.
          const TABLE_CAP = settings.indexRichTables ?? 12;
          // Value channel, lineage-graded. The binary touched-this-turn rule
          // starved the values that this turn's formulas CONSUME: on the NFL
          // task the model created per-row probe operators (weak_case_1..5)
          // just to read its own report, and every score drifted. So the
          // operators the frontier directly reads from render their samples
          // too — values but not code, which stays a recallState pull.
          const upstream: string[] = [];
          const seenUp = new Set<string>();
          for (const link of workflowState.getWorkflowContent().links ?? []) {
            const src = link?.source?.operatorID;
            const dst = link?.target?.operatorID;
            if (typeof src !== "string" || typeof dst !== "string") continue;
            if (!frontier.includes(dst) || frontier.includes(src) || seenUp.has(src)) continue;
            seenUp.add(src);
            upstream.push(src);
          }
          // The turn's OWN work is never capped, on either axis. Capping it by
          // recency created a feedback loop: on a long turn the operators created
          // earliest fell out of the rich set, so the model could not see what it
          // had just built, rebuilt it, and grew the turn further — 33 operator
          // writes on a turn that needs 3, with recalls for invented operator
          // names. The table budget applies to their UPSTREAMS only.
          const overrides: Record<string, object> = {};
          frontier.forEach(id => {
            // A generous per-operator char budget on the turn's own work. The
            // global 1k cap truncated exactly the results the answer is read
            // from, and the model's workaround was a chain of reformatting
            // operators (223 such calls in 20 netflix turns, against 44 for the
            // baseline). Bytes here are cheap next to a step: every extra step
            // re-sends the whole prompt.
            overrides[id] = {
              property: { includeCode: true },
              result: { latest: { detail: "sample", tuple: { maxChars: 4000 } } },
            };
          });
          // Upstream inputs get VALUES as the budget allows — knowing an input
          // table's numbers matters more often than knowing how it was produced,
          // and code is the half the model can cheapest recall on demand.
          upstream
            .reverse()
            .slice(0, Math.max(0, TABLE_CAP))
            .forEach(id => {
              overrides[id] = { result: { latest: { detail: "sample" } } };
            });
          // OPERATOR SPRAWL is the other unbounded axis, and the sharper one. The
          // index lists every operator ever built: on my_uber_drivers the model
          // had created 737 by turn 30, and their index entries alone were 360 KB
          // of a 559 KB prompt. So operators outside this turn's work collapse to
          // a bare header line — still named and recallable, but no longer paying
          // for a summary and a schema on every step.
          //
          // WHAT SURVIVES IS A COUNT, NOT AN AGE. This was "touched within
          // `indexRecentTurns` turns", and a turn count is the wrong control
          // variable because it says nothing about how much state that admits —
          // which is what the prompt actually pays for. Measured 2026-08-06,
          // same-era, deepseek-v4-pro judge:
          //
          //   recentTurns=3   passnyc (31 ops) STARVED — from turn 5 the model saw
          //                   4 result tables out of ~23 live operators, and
          //                   accuracy fell 63.3% -> 40.0% against baseline.
          //   recentTurns=12  passnyc 76.7%, water-potability 47.2%, energy 25.0%
          //                   (baselines 63.3 / 41.7 / 16.7) — but nfl (277 ops)
          //                   and uber (381 ops) FLOODED: context 360-600 kB and
          //                   turn after turn burning the whole 40-step budget to
          //                   produce an empty answer.
          //
          // Same constant, opposite failures, because 12 turns of a 31-operator
          // task and 12 turns of a 381-operator task are not the same amount of
          // context. So: keep the turn's own work unconditionally, then admit the
          // most-recently-touched operators until a COUNT budget is spent. Small
          // DAGs keep everything (no starvation); large ones keep a bounded, most
          // relevant slice (no flood). Index entries are near-uniform in size, so
          // a count is a good proxy for bytes and is far cheaper to compute.
          // `indexDetailedOperators: 0` = no cap, which is the current default
          // while `resumeFrom` is being evaluated on its own: resuming to an
          // earlier base already bounds the DAG (measured 20-40% smaller mean,
          // 30-50% smaller peak), and stacking the two would make it impossible
          // to attribute a result to either.
          const { lastTouch } = lastTouchTurnByOperator(visibleSteps);
          const cap = settings.indexDetailedOperators ?? 0;
          const keepDetailed =
            cap > 0
              ? selectDetailedOperators(frontier, upstream, lastTouch, cap)
              : new Set<string>([...frontier, ...upstream, ...lastTouch.keys()]);
          for (const op of workflowState.getWorkflowContent().operators ?? []) {
            const id = (op as any)?.operatorID;
            if (typeof id !== "string" || keepDetailed.has(id) || overrides[id]) continue;
            overrides[id] = {
              property: { includeProperties: false },
              result: { latest: { detail: "omit" } },
            };
          }
          params = applySummarizeParamsPatch(params, { operators: { overrides } });
        }
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

async function createAgentInstance(
  modelType: string,
  delegateConfig: AgentDelegateConfig,
  customName?: string,
  explicitDriver?: AgentDriverKind
): Promise<{ agentId: string; agent: TexeraAgent }> {
  const agentId = `agent-${AGENT_ID_SALT}-${++agentCounter}`;
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
      withRequiredToolChoice(
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
        withInputBudget(inputBudget, withModelCallLimit(modelCallLimit, () => agent.getCurrentMessageId()))
        )
      )
    ),
  });

  // Reasoning effort variants are configured as separate model entries in litellm-config.yaml
  // with extra_body to inject reasoning_effort, bypassing LiteLLM's param validation.
  const driverKind = resolveDriverKind(modelType, explicitDriver);
  const model = openai.chat(modelType);
  const driver: LLMDriver =
    driverKind === "local-react"
      ? new LocalReactTextDriver({ model })
      : new VercelToolUseDriver({
          model,
          maxOutputTokens: process.env.MODEL_MAX_OUTPUT_TOKENS
            ? Number(process.env.MODEL_MAX_OUTPUT_TOKENS)
            : undefined,
          maxRetries: process.env.MODEL_SDK_RETRIES ? Number(process.env.MODEL_SDK_RETRIES) : undefined,
        });
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
    ["keyValueColumns", "columnsShown", "definitionChars", "cellChars", "topValues", "catalogRecords"].map(key => [
      key,
      t.Optional(t.Integer({ minimum: 0, maximum: 100000 })),
    ])
  ),
  answerEcho: t.Optional(t.Boolean()),
  multiTask: t.Optional(t.Boolean()),
};

function settingsToApi(agent: TexeraAgent): AgentSettingsApi {
  const agentSettings = agent.getSettings();
  return {
    ...observationFormat(agentSettings),
    multiTask: agentSettings.multiTask,
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
    dataEvidence: agentSettings.dataEvidence,
    retrievalViews: agentSettings.retrievalViews,
    fullResultCharLimit: agentSettings.fullResultCharLimit,
    dataEvidenceCharLimit: agentSettings.dataEvidenceCharLimit,
    flowEvidenceCharLimit: agentSettings.flowEvidenceCharLimit,
    flowEvidence: agentSettings.flowEvidence,
    dataflowReasoning: agentSettings.dataflowReasoning,
    nativeChecks: agentSettings.nativeChecks,
    stateHistory: agentSettings.stateHistory,
    stateLedger: agentSettings.stateLedger,
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
    enableCompactTool: agentSettings.enableCompactTool,
    compactKeepLastSteps: agentSettings.compactKeepLastSteps,
    staticCompaction: agentSettings.staticCompaction,
    tunerConfig: agentSettings.tunerConfig,
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
  .get("/", () => {
    const agentList = Array.from(agentStore.entries()).map(([id, agent]) => getAgentInfo(id, agent));
    return { agents: agentList };
  })

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
            ...observationFormatPatch(settings),
            multiTask: settings.multiTask,
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
            dataEvidence: settings.dataEvidence,
            retrievalViews: settings.retrievalViews,
            fullResultCharLimit: settings.fullResultCharLimit,
            dataEvidenceCharLimit: settings.dataEvidenceCharLimit,
            flowEvidenceCharLimit: settings.flowEvidenceCharLimit,
            flowEvidence: settings.flowEvidence,
            dataflowReasoning: settings.dataflowReasoning,
            nativeChecks: settings.nativeChecks,
            stateHistory: settings.stateHistory,
            stateLedger: settings.stateLedger,
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
            foldResolvedRevisionsConfig: parseFoldResolvedRevisionsConfigInput(
              (settings as any).foldResolvedRevisionsConfig
            ),
            probeRetirementConfig: parseProbeRetirementConfigInput((settings as any).probeRetirementConfig),
            rolePolicyConfig: parseRolePolicyConfigInput((settings as any).rolePolicyConfig),
            learnedConfig: parseLearnedConfigInput((settings as any).learnedConfig),
            enableInspectTool: (settings as any).enableInspectTool,
            enableRenderPrefs: (settings as any).enableRenderPrefs,
            enableCodeInSnapshot: (settings as any).enableCodeInSnapshot,
            sourceProvenanceHint: (settings as any).sourceProvenanceHint,
            enableCompactTool: (settings as any).enableCompactTool,
            compactKeepLastSteps: (settings as any).compactKeepLastSteps,
            staticCompaction: (settings as any).staticCompaction,
            userTaskPlacement: (settings as any).userTaskPlacement,
            turnHistory: (settings as any).turnHistory,
            enableRecallTool: (settings as any).enableRecallTool,
            recallMaxResultChars: (settings as any).recallMaxResultChars,
            recallOperatorLevel: (settings as any).recallOperatorLevel,
            specAudit: (settings as any).specAudit,
            indexRichTables: (settings as any).indexRichTables,
            indexDetailedOperators: (settings as any).indexDetailedOperators,
            enableResumeTool: (settings as any).enableResumeTool,
            enableAnswerGrounding: (settings as any).enableAnswerGrounding,
            seedSources: (settings as any).seedSources,
            messageLayout: (settings as any).messageLayout,
            versionedMode: (settings as any).versionedMode,
            versionedHeads: (settings as any).versionedHeads,
            sessionTurns: (settings as any).sessionTurns,
            indexThinObservations: (settings as any).indexThinObservations,
            tunerConfig: parseTunerConfigInput((settings as any).tunerConfig),
          });
        }
      } catch (error) {
        // Graph-dependent validation happens after bootstrap. A rejected
        // initial configuration must not leave a registered, unusable agent.
        agent.destroy();
        agentStore.delete(agentId);
        agentDrivers.delete(agentId);
        throw error;
      }

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
            dataflowReasoning: t.Optional(t.Boolean()),
            nativeChecks: t.Optional(t.Boolean()),
            stateHistory: t.Optional(t.Boolean()),
            stateLedger: t.Optional(t.Boolean()),
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
            enableCompactTool: t.Optional(t.Boolean()),
            compactKeepLastSteps: t.Optional(t.Number()),
            staticCompaction: t.Optional(t.Boolean()),
            userTaskPlacement: t.Optional(t.Union([t.Literal("top"), t.Literal("bottom")])),
            turnHistory: t.Optional(t.Union([t.Literal("full"), t.Literal("index")])),
            enableRecallTool: t.Optional(t.Boolean()),
            recallMaxResultChars: t.Optional(t.Number()),
            recallOperatorLevel: t.Optional(t.Boolean()),
            specAudit: t.Optional(t.Boolean()),
            indexRichTables: t.Optional(t.Number()),
            indexDetailedOperators: t.Optional(t.Number()),
            enableResumeTool: t.Optional(t.Boolean()),
            enableAnswerGrounding: t.Optional(t.Boolean()),
            seedSources: t.Optional(t.Boolean()),
            messageLayout: t.Optional(t.String()),
            versionedMode: t.Optional(t.Boolean()),
            versionedHeads: t.Optional(t.Boolean()),
            sessionTurns: t.Optional(t.Boolean()),
            indexThinObservations: t.Optional(t.Boolean()),
            tunerConfig: t.Optional(t.Any()),
          })
        ),
      }),
    }
  )

  .get("/:id", ({ params: { id } }) => {
    const agent = getAgent(id);
    // Version inventory: `(operatorId, turn)` pairs with their lineage. Small
    // (ids and numbers), and the only way to confirm from outside that the
    // store recorded what the graph actually did.
    const versions = agent.versionStore.operatorIds().flatMap(opId =>
      agent.versionStore.versionsOf(opId).map(turn => {
        const v = agent.versionStore.get(opId, turn)!;
        return {
          operatorId: opId,
          turn,
          provisional: v.provisional,
          inputRefs: v.inputRefs.map(r => `${r.operatorId} (turn ${r.turn})`),
        };
      })
    );
    return {
      ...getAgentInfo(id, agent),
      workflow: agent.getWorkflowState().getWorkflowContent(),
      stepCount: agent.getReActSteps().length,
      versions,
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
    return { steps: agent.getRenderableReActSteps(), state: agent.getState() };
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
   * Snapshot tree shape — every node in the agent's
   * `WorkflowSnapshotStorage`, parent links, owning ReAct step, and a few
   * size hints. Powers the dashboard's "Snapshot tree" view. Full workflow
   * + results bodies are still fetched lazily via `/snapshots/:stepId`.
   */
  .get("/:id/snapshot-tree", ({ params: { id } }) => {
    const agent = getAgent(id);
    const storage = agent.getSnapshotStorage();
    const rootId = storage.getRootSnapshotId();
    // Each snapshot's timestamp is the time of its owning ReAct step. Use
    // getAllSteps (includes the hidden init step) so the first snapshot also
    // gets one.
    const stepTimes = new Map(agent.getAllSteps().map(s => [s.id, s.timestamp]));
    // Exclude the synthetic empty-root snapshot ("S0"). It is a structural
    // placeholder with no workflow of its own; its children (the first real
    // snapshots) become the visible top-level nodes. `rootId` is still returned
    // so clients can resolve the "no active snapshot" fallback.
    return {
      rootId,
      nodes: storage
        .getSnapshotTreeNodes()
        .filter(n => n.id !== rootId)
        .map(n => ({
          ...n,
          timestamp: n.reactStepId !== undefined ? (stepTimes.get(n.reactStepId) ?? null) : null,
        })),
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
    const visibleResults = storage.getAllVisibleResults(resolvedStepId);
    const results: Record<string, OperatorResultSummaryWs> = {};
    for (const [opId, info] of visibleResults) {
      results[opId] = operatorInfoToSummary(info);
    }
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
    return { ...agent.getSystemInfo(), inputBudget: readInputBudget(process.env), modelCallLimit: Number(process.env.MODEL_MAX_CALLS_PER_TURN ?? 0) };
  })

  .post("/:id/stop", ({ params: { id } }) => {
    const agent = getAgent(id);
    agent.stop();
    return { status: "stopping" };
  })

  // Load tables as the state in force before the first request: an edit
  // program (one `scan` per saved table) plus execution, recorded as a hidden
  // synthetic step with no model call. Used by the gold-prefix protocol.
  .post(
    "/:id/seed-state",
    async ({ params: { id }, body, set }) => {
      const agent = getAgent(id);
      if (agent.getState() !== AgentState.AVAILABLE) {
        set.status = 409;
        return { error: `agent is ${agent.getState()} — seed state while it is idle` };
      }
      let receipt: Awaited<ReturnType<typeof agent.seedState>>;
      try {
        receipt = await agent.seedState(body.changes, body.completedTasks ?? 0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Refusals about when or how state may be loaded are the caller's to fix.
        if (/before the first request|requires native mode|seed state while it is idle|completedTasks/.test(message)) {
          set.status = 409;
          return { error: message };
        }
        throw error;
      }
      broadcastNextContext(id, agent);
      return {
        status: receipt.status,
        error: receipt.error ?? null,
        operators: receipt.operators,
        actions: receipt.actions.map((item: (typeof receipt.actions)[number]) => ({
          type: item.action.type,
          status: item.status,
          output: item.output,
        })),
        headId: agent.getHead(),
      };
    },
    { body: t.Object({ changes: t.String(), completedTasks: t.Optional(t.Integer({ minimum: 0 })) }) }
  )

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
      const { content, messageSource, sources } = body as {
        content: string;
        messageSource?: "chat" | "feedback";
        sources?: string[];
      };
      if (agent.getState() !== AgentState.AVAILABLE) {
        set.status = 409;
        return { error: `agent is ${agent.getState()} — one turn at a time` };
      }
      const result = await agent.sendMessage(content, messageSource, { sources });
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
        sources: t.Optional(t.Array(t.String())),
      }),
    }
  )

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

      const allSteps = agent.getRenderableReActSteps();
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
        multiTask: settings.multiTask,
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
        dataEvidence: settings.dataEvidence,
        retrievalViews: settings.retrievalViews,
        fullResultCharLimit: settings.fullResultCharLimit,
        dataEvidenceCharLimit: settings.dataEvidenceCharLimit,
        flowEvidenceCharLimit: settings.flowEvidenceCharLimit,
        flowEvidence: settings.flowEvidence,
        dataflowReasoning: settings.dataflowReasoning,
        nativeChecks: settings.nativeChecks,
        stateHistory: settings.stateHistory,
        stateLedger: settings.stateLedger,
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
        enableCompactTool: (settings as UpdateAgentSettingsRequest).enableCompactTool,
        compactKeepLastSteps: (settings as UpdateAgentSettingsRequest).compactKeepLastSteps,
        tunerConfig: parseTunerConfigInput((settings as any).tunerConfig),
      });

      // Settings can change context assembly (agentMode flips schema gating,
      // contextMode flips the selection policy) — re-broadcast the preview
      // so clients stay in sync.
      broadcastNextContext(id, agent);

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
        dataflowReasoning: t.Optional(t.Boolean()),
        nativeChecks: t.Optional(t.Boolean()),
        stateHistory: t.Optional(t.Boolean()),
        stateLedger: t.Optional(t.Boolean()),
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
        enableCompactTool: t.Optional(t.Boolean()),
        compactKeepLastSteps: t.Optional(t.Number()),
        // LLM context-tuner config; validated in-handler. null turns it off.
        tunerConfig: t.Optional(t.Any()),
      }),
    }
  );

interface WsMessage {
  type: "message" | "stop" | "debug";
  content?: string;
  messageSource?: "chat" | "feedback";
  /** Seeded source roots: the task's input files/globs (see `seedSources`). */
  sources?: string[];
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
  /** Assembled next-step transcript content (markdown/JSON). Updated whenever
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
    results[opId] = operatorInfoToSummary(info);
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
  return new Elysia({ normalize: false })
    .use(cors())
    .use(dashboardPlugin)
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
            // Never stream the synthetic init step to clients.
            if (TexeraAgent.isInitializationStep(step)) return;
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
            const result = await agent.sendMessage(msg.content, msg.messageSource, {
              sources: Array.isArray(msg.sources) ? msg.sources.filter(s => typeof s === "string") : undefined,
            });

            agent.setStepCallback(null);
            agent.setSnapshotCallback(null);

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
            // Never stream the synthetic init step to clients.
            if (TexeraAgent.isInitializationStep(step)) return;
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
