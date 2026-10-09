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

import { observationFormatPatch, type ObservationFormatOptions } from "./native/observation-format";

import { asSchema, type ModelMessage } from "ai";
import { readInputBudget, budgetContextAssembler } from "./llm-drivers/input-budget";
import { Subscription } from "rxjs";
import { debounceTime } from "rxjs/operators";
import { WorkflowState } from "./workflow-state";
import { OperatorVersionStore } from "./operator-version-store";
import { VersionCheckout } from "./version-checkout";
import { WorkflowUtilService } from "./util/workflow-utils";
import type { WorkflowContent } from "../types/workflow";
import { WorkflowSystemMetadata } from "./util/workflow-system-metadata";
import { WorkflowSnapshotStorage } from "./workflow-snapshot-storage";
import type {
  AgentDelegateConfig,
  AgentSettings,
  CompactionStrategy,
  LocalToolDialect,
  ReActStep,
  TokenUsage,
  UserInfo,
  ToolOperatorAccess,
} from "../types/agent";
import type { SummarizeParamsPatch } from "./context/summarize/params";
import type { SelectorConfig } from "./context/selector/selector";
import type { FrontierDecayConfig } from "./context/selector/frontier-decay";
import type { ProbeRetirementConfig } from "./context/selector/probe-retirement";
import type { RolePolicyConfig } from "./context/selector/role-policy";
import type { FoldResolvedRevisionsConfig } from "./context/select/revision-folds";
import type { LearnedConfig } from "./context/learned/score";
import type { TunerConfig } from "./context/tuner/tuner";
import type { ExecutionRunMetrics, OperatorInfo } from "../types/execution";
import {
  AgentMode,
  AgentState as AgentStateEnum,
  ContextMode,
  DEFAULT_AGENT_SETTINGS,
  OperatorResultSerializationMode,
} from "../types/agent";
import { buildCodeModeSystemPrompt } from "./prompts";

/**
 * W2 — few-shot best-practices appended to the CODE-mode system prompt when the
 * `fewShotPrompt` setting is on. Examples (not just instructions, which got poor
 * .copy() adherence) of the good per-step discipline: inspect-then-decide, lean
 * comment-free code, messy-file handling, commit the answer at a terminal op.
 */
const FEW_SHOT_BEST_PRACTICES = `

# Worked examples — how to work at each step

These show the WORKING STYLE to follow (not task answers).

Example A — inspect before you transform. After a load/edit, READ the result's
Schema + sample rows BEFORE writing the next operator. If columns are generic
(\`Unnamed: 1\`, \`0\`) or a header/footer value sits in a data row, the file
was parsed wrong — re-load with the right \`sep=\`/\`header=\`/\`skiprows=\`,
don't build on the broken frame.

Example B — lean, ephemeral code (each operator runs in isolation; code is
discarded). Write the minimum:
\`\`\`
def process(sales):
    df = sales[sales["status"] == "active"]
    df["amount"] = pd.to_numeric(df["amount"].str.replace(r"[$,]", "", regex=True), errors="coerce")
    return df.groupby("region", as_index=False)["amount"].sum()
\`\`\`
No comments/docstrings, no \`.copy()\`, no \`import pandas as pd\` (it's already \`pd\`).

Example C — clean before you aggregate. Formatted numbers ("1,234", "$5") and
sentinel/footer rows must be stripped/dropped BEFORE a sum/mean/count, or
\`to_numeric(errors="coerce")\` silently NULLs them and the total is wrong.

Example D — commit the answer. The final operator must OUTPUT the answer in the
exact type/shape the question asks (a scalar, or a clean list) — don't leave it
implicit in an intermediate frame.`;
import { createDeleteOperatorTool, TOOL_NAME_DELETE_OPERATOR, type ToolContext } from "./tools/workflow-crud-tools";
import {
  asNativeBatchResult,
  batchObservedIds,
  createNativeTools,
  TOOL_NAME_DATAFLOW,
} from "./tools/native-batch-tools";
import { NativeCatalogSettingsError, validateNativeSettings, validateTaskContextSettings } from "./native/settings";
import { buildTaskGraph, taskHistoryFromSteps } from "./task-history";
import { planSeedSources, registeredSeedStatement } from "./native/seed-sources";
import { formatNativeDiagnostic } from "./native/diagnostics";
import { NativeValidationRepair } from "./native/validation-repair";
import {
  REPEATED_FAILURE_LIMIT,
  REPEATED_FAILURE_WARNING,
  repeatedFailure,
  repeatedFailureError,
  repeatedFailureFeedback,
  type RepeatedFailure,
} from "./native/failure-loop";
import { writtenOperatorId } from "./util/context-utils";
import { buildRegisteredNativeSystemPrompt } from "./prompts";
import { isTransientModelError } from "./llm-drivers/request-timeout";
import type { ResultSelection } from "../types/agent";
import { createCreateOrModifyOperatorTool, TOOL_NAME_CREATE_OR_MODIFY_OPERATOR } from "./tools/code-op-tools";
import { createCompactContextTool, TOOL_NAME_COMPACT_CONTEXT } from "./tools/compact-context-tool";
import {
  createRecallStateTool,
  TOOL_NAME_RECALL_STATE,
  type RecalledTurn,
  type RecallVerb,
} from "./tools/recall-state-tool";
import { createResumeFromTool, TOOL_NAME_RESUME_FROM, WRITE_TOOL_NAMES } from "./tools/resume-from-tool";
import {
  GROUNDING_NUDGES_PER_TURN,
  buildGroundingNudge,
  extractSubstantiveNumbers,
  finalAnswerPayload,
  groundingReport,
  shouldNudge,
} from "./answer-grounding";
import { ToolCallScheduler } from "./tools/tool-call-scheduler";
import {
  createRegisteredDataflowTool,
  asDataflowActionsResult,
  type DataflowActionsResult,
} from "./tools/dataflow-actions";
import type { RetrievalSettings } from "../types/agent";
import { availableRetrievalViews, nativeResultTransportLimit } from "./native/retrieval";
import { executeDataflowActionBatch } from "./tools/dataflow-action-runtime";
import { planGraphEdit, planRegisteredGraphEdit } from "./tools/graph-edits";
import {
  executeWorkflowAndPersist,
  TOOL_NAME_EXECUTE_OPERATOR,
  type ExecutionConfig,
} from "./tools/workflow-execution-tools";
import { compileWorkflowAsync, type WorkflowCompilationResponse } from "../api/compile-api";
import { createLogger } from "../logger";
import type { Logger } from "pino";
import { looksLikeFunctionCall, parseFunctionCall } from "./debug-parser";
import {
  MissingAnswerActionError,
  type LLMDriver,
  type ContextAssembler,
  type DriverRunTurnResult,
} from "./llm-drivers/types";
import { forkState, historicalTask } from "./state-history";
import { restoreAssignment, splitVersionCommands } from "./state-ledger";
import { parseTraceContext, parsedResultToOperatorInfo } from "./util/parse-trace-results";

const PERSIST_DEBOUNCE_MS = 500;

/** Tool names whose successful invocation triggers post-step operator execution. */
const EXECUTE_AFTER_TOOLS: ReadonlySet<string> = new Set([TOOL_NAME_CREATE_OR_MODIFY_OPERATOR, TOOL_NAME_DATAFLOW]);

function createEmptyWorkflowContent(): WorkflowContent {
  return {
    operators: [],
    operatorPositions: {},
    links: [],
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  };
}

export interface TexeraAgentConfig {
  /** LLM strategy. Owns the `LanguageModel` and decides how to translate
   *  the agent's bookkeeping callbacks into one or more model requests.
   *  Pair this with `contextAssembler` — the two travel together. */
  driver: LLMDriver;
  /** Renderer that builds the user-message context array on every
   *  prepareStep. Picked at agent construction to match the driver. */
  contextAssembler: ContextAssembler;
  modelType: string;
  agentId: string;
  agentName?: string;
  systemPrompt?: string;
  /** Optional override for `rebuildSystemPrompt`. When provided, the
   *  agent uses this verbatim instead of the agent-mode-based builders —
   *  used by the local-react driver to inject the LLM's training-time
   *  system prompt unchanged. Receives the current tool-call dialect so the
   *  prompt can match the dialect the parser expects, and the contextMode so
   *  the described context format matches what the assembler renders. */
  systemPromptBuilder?: (dialect: LocalToolDialect, contextMode: ContextMode, compactionEnabled: boolean) => string;
}

export interface AgentMessageResult {
  response: string;
  messages: ModelMessage[];
  usage: TokenUsage;
  stopped: boolean;
  error?: string;
}

type ReActStepCallback = (step: ReActStep) => void;
type SnapshotCallback = (stepId: string, workflow: WorkflowContent) => void;

/**
 * A single Texera agent instance.
 *
 * Owns the conversation (ReAct step tree with HEAD/checkout semantics), the
 * workflow being edited (`WorkflowState`), the per-step snapshot storage
 * (`WorkflowSnapshotStorage`, holding both workflow content and operator
 * results), and the tool surface exposed to the LLM. Each call to
 * `sendMessage` drives one multi-step generation via the Vercel AI SDK,
 * streaming step updates to subscribed websockets.
 */
/**
 * Compact, LLM-friendly summary of agent initialization. Goes into the
 * synthetic `initialize` tool result so the model enters turn 1 already
 * knowing each operator's row count or error.
 */
function formatInitializationSummary(
  runResult: {
    success: boolean;
    state: string;
    opCount: number;
    errorCount: number;
    errorText?: string;
  },
  results: Map<string, OperatorInfo>
): string {
  const header = `Initialization: state=${runResult.state}, operators=${runResult.opCount}, errors=${runResult.errorCount}.`;
  const lines: string[] = [header];
  if (results.size === 0 && runResult.errorText) {
    lines.push(runResult.errorText);
    return lines.join("\n");
  }
  for (const [opId, info] of results) {
    if (info.error) {
      lines.push(`- ${opId}: ERROR ${info.error}`);
    } else {
      const rows = info.totalRowCount ?? info.outputTuples ?? 0;
      lines.push(`- ${opId}: ${rows} rows`);
    }
  }
  return lines.join("\n");
}

/**
 * Derive which operators each tool call viewed / added / modified from the
 * call's input and its result text. Pure; keyed by tool-call index so the
 * frontend can map it onto `toolCalls[i]`. Returns undefined when there are
 * no tool calls so steps without actions stay byte-identical.
 */
export function computeOperatorAccess(
  toolCalls: ReadonlyArray<{ toolName: string; toolCallId: string; input: any }> | undefined,
  toolResults: ReadonlyArray<{ toolCallId: string; output: any; isError?: boolean }> | undefined
): Record<number, ToolOperatorAccess> | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  const access: Record<number, ToolOperatorAccess> = {};
  toolCalls.forEach((tc, i) => {
    const entry: ToolOperatorAccess = {
      viewedOperatorIds: [],
      addedOperatorIds: [],
      modifiedOperatorIds: [],
    };
    const result = toolResults?.find(tr => tr.toolCallId === tc.toolCallId);
    const batch = tc.toolName === TOOL_NAME_DATAFLOW ? asNativeBatchResult(result?.output) : undefined;
    if (batch) {
      entry.addedOperatorIds = batch.operators.filter(op => op.status === "added").map(op => op.id);
      entry.modifiedOperatorIds = batch.operators.filter(op => op.status === "modified").map(op => op.id);
      entry.viewedOperatorIds = [...batch.observe];
      access[i] = entry;
      return;
    }
    // `operatorId` on the code-mode tools; `id` on native mode's deleteOperator.
    const inputOpId = writtenOperatorId(tc.toolName, tc.input);
    if (result && !result.isError && result.output !== undefined && result.output !== null) {
      const out = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
      // Code / general receipts ("Added operator x", "Operator x modified",
      // "Deleted operator: x") and native receipts ("added filter operator
      // `x`; inputs: …", "modified …", "deleted operator `x`").
      const added =
        out.match(/Added operator ([A-Za-z0-9_-]+)/) ?? out.match(/\badded [a-z_]+ operator `([A-Za-z0-9_-]+)`/);
      const modified =
        out.match(/Operator ([A-Za-z0-9_-]+) modified/) ?? out.match(/\bmodified [a-z_]+ operator `([A-Za-z0-9_-]+)`/);
      const deleted =
        out.match(/Deleted operator:? ([A-Za-z0-9_-]+)/) ?? out.match(/\bdeleted operator `([A-Za-z0-9_-]+)`/);
      const executed = out.match(/Executed operator ([A-Za-z0-9_-]+)/);
      if (added) entry.addedOperatorIds.push(added[1]);
      else if (modified) entry.modifiedOperatorIds.push(modified[1]);
      else if (deleted) entry.modifiedOperatorIds.push(deleted[1]);
      else if (executed) entry.viewedOperatorIds.push(executed[1]);
      else if (inputOpId) {
        // Fall back on the tool's declared intent when the result text is
        // not one of the known summaries (e.g. inspect/execute variants).
        if (tc.toolName === TOOL_NAME_CREATE_OR_MODIFY_OPERATOR || tc.toolName === TOOL_NAME_DELETE_OPERATOR)
          entry.modifiedOperatorIds.push(inputOpId);
        else entry.viewedOperatorIds.push(inputOpId);
      }
    } else if (
      inputOpId &&
      (tc.toolName === TOOL_NAME_EXECUTE_OPERATOR ||
        tc.toolName === "inspectResult" || // Historical traces only; no executable tool remains.
        tc.toolName === "inspectError") // Historical traces only; the tool was folded into dataflow receipts.
    ) {
      // A failed read still tells the UI which operator the model looked at.
      entry.viewedOperatorIds.push(inputOpId);
    }
    access[i] = entry;
  });
  return access;
}

/** Retries of a turn whose driver run failed transiently (a timed-out or dropped model request). */
const MODEL_RETRIES_PER_TURN = Number(process.env.MODEL_RETRIES_PER_TURN ?? 2);
/** Backoff before retry n is n times this many milliseconds. */
const MODEL_RETRY_BACKOFF_MS = () => Number(process.env.MODEL_RETRY_BACKOFF_MS ?? 3000);

export class TexeraAgent {
  readonly agentId: string;
  readonly agentName: string;
  readonly modelType: string;
  readonly createdAt: Date;

  private state: AgentStateEnum = AgentStateEnum.AVAILABLE;
  private workflowState: WorkflowState;
  private metadataStore: WorkflowSystemMetadata;
  /**
   * Active step in the version tree. `undefined` means the agent has no steps
   * yet (fresh agent, or `clearHistory` just ran). The first appended step
   * becomes the tree root with `parentId === undefined`.
   */
  private head: string | undefined = undefined;
  private stepsById: Map<string, ReActStep> = new Map();
  private stepCounter = 0;
  private snapshotStorage: WorkflowSnapshotStorage;

  private websockets: Set<any> = new Set();

  private readonly driver: LLMDriver;
  private readonly contextAssembler: ContextAssembler;
  private readonly modelInputBudget = readInputBudget(process.env);
  private readonly systemPromptBuilder:
    | ((dialect: LocalToolDialect, contextMode: ContextMode, compactionEnabled: boolean) => string)
    | undefined;
  private systemPrompt: string;
  private settings: AgentSettings;

  private reActStepsByMessageId: Map<string, ReActStep[]> = new Map();

  private currentMessageId: string | undefined = undefined;
  private readonly nativeValidationRepair = new NativeValidationRepair();
  /** (operatorId, turnId) -> version. Written in EVERY mode so the backbone is
   *  always turn-tracked; only the versioned write path reads it for wiring. */
  readonly versionStore = new OperatorVersionStore();
  /** Materializes referenced versions into wire-able nodes. Built lazily so it
   *  sees the WorkflowUtilService the agent constructs during setup. */
  private versionCheckout: VersionCheckout | undefined;

  /** Content string last produced by the (possibly-async) context assembler on
   *  the prepareStep path. Lets the synchronous `getNextStepContext` preview
   *  return a value even when the assembler is async (the LLM tuner). */
  private lastRenderedContext: string | undefined = undefined;

  private delegateConfig?: {
    userToken: string;
    userInfo?: UserInfo;
    workflowId: number;
    workflowName?: string;
    computingUnitId?: number;
  };

  private stepCallback: ReActStepCallback | null = null;
  private snapshotCallback: SnapshotCallback | null = null;

  private messageCounter = 0;

  private tools: Record<string, any>;

  private abortController: AbortController | null = null;
  private nativeActionAnswer: string | undefined;

  private workflowChangeSubscription: Subscription | null = null;

  private log: Logger;

  constructor(config: TexeraAgentConfig) {
    this.agentId = config.agentId;
    this.agentName = config.agentName || `Agent-${config.agentId}`;
    this.modelType = config.modelType;
    this.createdAt = new Date();
    this.driver = config.driver;
    this.contextAssembler = config.contextAssembler;
    this.systemPromptBuilder = config.systemPromptBuilder;
    this.systemPrompt = config.systemPrompt || "";
    this.log = createLogger("TexeraAgent", { agentId: this.agentId });

    this.workflowState = new WorkflowState();
    this.metadataStore = WorkflowSystemMetadata.getInstance();
    this.snapshotStorage = new WorkflowSnapshotStorage(
      stepId => this.getAncestorPath(stepId),
      () => this.delegateConfig?.workflowId,
      () => (this.delegateConfig?.userToken ? [this.delegateConfig.userToken] : [])
    );

    this.settings = {
      ...DEFAULT_AGENT_SETTINGS,
      systemPrompt: this.systemPrompt,
      parallelToolCalls: DEFAULT_AGENT_SETTINGS.agentMode !== AgentMode.NATIVE,
    };

    this.tools = this.createTools();
  }

  /**
   * One-shot bootstrap for a freshly created agent. Init always runs;
   * there is no longer a separate "delegate mode" branch.
   *
   * Phase 1 — metadata: load operator schemas + system prompt + tools.
   * Phase 2 — workflow load: if `config` carries `userToken`+`workflowId`,
   *   fetch the workflow from the backend. Failure leaves the agent with
   *   an empty workflow; init still proceeds.
   * Phase 3 — backend wiring: if creds are present, `setDelegateConfig`
   *   wires auto-persist and rebuilds the tool set with the execution
   *   tool included.
   * Phase 4 — init step (always): record a synthetic `initialize` agent
   *   step. The step is action-bearing (it carries an `initialize` tool
   *   call) and produces one snapshot — the first child of the snapshot
   *   tree's empty root. If the workflow has operators and we have an
   *   execution config, a baseline run populates per-operator results on
   *   that snapshot. Otherwise the step still lands with an empty
   *   results map. Agent creation never throws.
   */
  async initialize(config?: AgentDelegateConfig): Promise<void> {
    try {
      if (!this.metadataStore.isInitialized()) {
        await this.metadataStore.initializeFromBackend();
      }
      this.rebuildSystemPrompt();
      this.tools = this.createTools();
      this.log.info({ operatorCount: this.metadataStore.getOperatorCount() }, "agent initialized");
    } catch (error) {
      this.log.error({ err: error }, "failed to initialize metadata");
    }

    const haveCreds = !!(config?.workflowId && config.userToken);

    // Phase 2 — try to load the workflow if we have creds.
    let workflowContent: WorkflowContent | undefined;
    let workflowName = config?.workflowName;
    if (haveCreds && config) {
      try {
        const { retrieveWorkflow } = await import("../api/workflow-api");
        const workflow = await retrieveWorkflow(config.userToken!, config.workflowId!);
        workflowContent = workflow.content;
        workflowName = workflow.name;
        this.log.info({ workflowId: config.workflowId, workflowName }, "loaded workflow for agent");
      } catch (error) {
        this.log.warn({ err: error, workflowId: config.workflowId }, "initialize: failed to load workflow");
      }
    }

    const effectiveWorkflow = workflowContent ?? createEmptyWorkflowContent();
    // Push to the live buffer first so any auto-persist subscription wired
    // below sees the loaded content rather than the empty default.
    this.workflowState.setWorkflowContent(effectiveWorkflow);

    // Phase 3 — backend wiring (only if creds present).
    if (haveCreds && config) {
      this.setDelegateConfig({
        userToken: config.userToken!,
        userInfo: config.userInfo,
        workflowId: config.workflowId!,
        workflowName,
        computingUnitId: config.computingUnitId,
      });
    }

    // Phase 4 — always record the init step. This anchors the snapshot
    // tree's first non-root node.
    await this.recordInitializationStep(effectiveWorkflow);
  }

  /**
   * Append the agent's `initialize` step at the tree root and create the
   * first snapshot under the empty root. The tool call is synthetic
   * (`toolName: "initialize"`) — there is no registered tool of that
   * name; it exists only so the step participates in the
   * "tool-calls ⇒ snapshot edge" rule used by every later step.
   *
   * Baseline execution runs only when the workflow has operators AND a
   * backend execution config is wired (i.e. the agent has token +
   * workflowId). Otherwise we record the step with no per-op results.
   */
  private async recordInitializationStep(workflowContent: WorkflowContent): Promise<void> {
    const execConfig = this.buildExecutionConfig();
    const opIds = workflowContent.operators.map(op => op.operatorID);
    const collected = new Map<string, OperatorInfo>();
    let runResult: Awaited<ReturnType<typeof executeWorkflowAndPersist>>;

    if (opIds.length === 0 || !execConfig) {
      // No baseline run: either nothing to run, or no backend wiring.
      runResult = { success: true, state: "Empty", opCount: 0, errorCount: 0 };
    } else {
      try {
        runResult = await executeWorkflowAndPersist(this.workflowState, execConfig, {
          onResult: (opId, info) => {
            collected.set(opId, info);
          },
          opsToViewResult: opIds,
        });
      } catch (error) {
        this.log.warn({ err: error, workflowId: execConfig.workflowId }, "initialize: baseline execution threw");
        runResult = {
          success: false,
          state: "Error",
          opCount: 0,
          errorCount: 0,
          errorText: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const messageId = `msg-${this.agentId}-${++this.messageCounter}-init-${Date.now()}`;
    const stepId = this.generateStepId();
    const toolCallId = `call-${stepId}-initialize`;
    const summary = formatInitializationSummary(runResult, collected);

    const initStep: ReActStep = {
      id: stepId,
      parentId: undefined,
      messageId,
      stepId: 0,
      timestamp: Date.now(),
      role: "agent",
      content: "Initialization: loaded workflow and recorded a baseline of each operator's current result.",
      isBegin: true,
      isEnd: true,
      toolCalls: [
        {
          toolName: "initialize",
          toolCallId,
          input: { workflowId: execConfig?.workflowId },
        },
      ],
      toolResults: [
        {
          toolCallId,
          output: summary,
          isError: !runResult.success,
        },
      ],
    };
    this.addStep(initStep);
    this.head = stepId;

    // The init step is action-bearing — create its snapshot as the first
    // child of the storage's empty root.
    this.snapshotStorage.createSnapshot(stepId, workflowContent);
    this.snapshotCallback?.(stepId, workflowContent);
    for (const [opId, info] of collected) {
      this.snapshotStorage.setOperatorResult(stepId, opId, info);
    }

    this.log.info(
      {
        workflowId: execConfig?.workflowId,
        stepId,
        opCount: runResult.opCount,
        errorCount: runResult.errorCount,
        state: runResult.state,
      },
      "initialization step recorded"
    );
  }

  private rebuildSystemPrompt(): void {
    // The `## History Compaction` section describes the COMPRESS deck specifically,
    // so inject it only when the window is on AND the strategy is compress. Sliding
    // produces a self-describing `(… omitted …)` marker, not a deck, so it gets no
    // section (describing a deck it never renders would be its own drift).
    const compactionEnabled =
      (this.settings.contextWindowTokens > 0 && this.settings.compactionStrategy === "compress") ||
      this.settings.staticCompaction === true;
    if (this.systemPromptBuilder) {
      // Driver-level override (local-react). Bypass the mode-based builders
      // entirely so the wire prompt always matches the model's training
      // distribution — and the tool-call dialect the parser expects.
      this.systemPrompt = this.systemPromptBuilder(
        this.settings.toolDialect,
        this.settings.contextMode,
        compactionEnabled
      );
    } else if (this.settings.agentMode === AgentMode.NATIVE) {
      this.systemPrompt = buildRegisteredNativeSystemPrompt(this.settings.contextMode, {
        ...observationFormatPatch(this.settings),
        // Decided when the session starts (the setting, or state loaded before
        // the first request), never by the arrival of a later request: a
        // system prompt that changes mid-session invalidates the whole cached
        // prefix and gives the first task different instructions.
        multiTask: this.settings.multiTask || this.taskNumberOffset > 0,
        resume: this.settings.enableResumeTool === true,
        compact: this.settings.enableCompactTool === true,
        versioned: this.settings.versionedMode === true,
        session: this.settings.sessionTurns === true,
        recall: this.settings.enableRecallTool === true,
        messageLayout: this.settings.messageLayout,
        reasoning: this.settings.dataflowReasoning === true,
        dataEvidence: this.settings.dataEvidence === true,
        flowEvidence: this.settings.flowEvidence === true,
        checks: this.settings.nativeChecks === true,
        nativePromptDetail: this.settings.nativePromptDetail,
        retrievalViews: availableRetrievalViews(this.settings),
        fullResultCharLimit: this.settings.fullResultCharLimit,
        maxOperatorResultCharLimit: this.settings.maxOperatorResultCharLimit,
        maxResultRows: this.settings.maxResultRows,
        dataEvidenceCharLimit: this.settings.dataEvidenceCharLimit,
        flowEvidenceCharLimit: this.settings.flowEvidenceCharLimit,
        stateHistory: this.settings.stateHistory === true,
        stateLedger: this.settings.stateLedger === true,
      });
    } else {
      this.systemPrompt = buildCodeModeSystemPrompt(
        this.settings.contextMode,
        compactionEnabled,
        false,
        this.settings.enableRenderPrefs === true,
        this.settings.enableCodeInSnapshot === true,
        this.settings.sourceProvenanceHint === true,
        this.settings.enableRecallTool === true,
        this.settings.enableResumeTool === true,
        this.settings.versionedMode === true,
        this.settings.sessionTurns === true,
        this.settings.recallOperatorLevel === true,
        this.settings.specAudit === true
      );
    }
    // W2: append worked per-step best-practice examples (few-shot). Examples,
    // not just the instruction (which got poor .copy() adherence). Off by default.
    if (this.settings.fewShotPrompt && this.settings.agentMode === AgentMode.CODE && !this.systemPromptBuilder) {
      this.systemPrompt += FEW_SHOT_BEST_PRACTICES;
    }
    this.settings.systemPrompt = this.systemPrompt;
  }

  private buildExecutionConfig(): ExecutionConfig | undefined {
    if (!this.delegateConfig) return undefined;
    return {
      userToken: this.delegateConfig.userToken,
      workflowId: this.delegateConfig.workflowId,
      computingUnitId: this.delegateConfig.computingUnitId,
      maxOperatorResultCharLimit:
        this.settings.agentMode === AgentMode.NATIVE
          ? nativeResultTransportLimit(this.settings)
          : this.settings.maxOperatorResultCharLimit,
      maxOperatorResultCellCharLimit:
        this.settings.agentMode === AgentMode.NATIVE
          ? Math.min(nativeResultTransportLimit(this.settings), 20000)
          : this.settings.maxOperatorResultCellCharLimit,
      executionTimeoutMs: this.settings.executionTimeoutMs,
      // Structured (versioned, profiled) results are what native operators
      // produce; a delegated GUI workflow of plain Texera operators keeps the
      // legacy transport even under native mode.
      structuredResults:
        this.settings.agentMode === AgentMode.NATIVE && this.workflowState.getAllOperators().some(op => op.nativeOp),
    };
  }

  /**
   * Whether the agent can read its own operator code in the context it is fed.
   * True by default: DELTA replays `code:` on every agent event, and LATEST
   * carries per-operator `Code:` blocks whenever the snapshot flag is on. The
   * single code-blind configuration is LATEST with `enableCodeInSnapshot` off —
   * there the summaries are the only record of what an operator does, so the
   * tool asks for detailed ones instead.
   */
  private isCodeShownToAgent(): boolean {
    return this.settings.contextMode === ContextMode.DELTA || this.settings.enableCodeInSnapshot === true;
  }

  private createTools(): Record<string, any> {
    const operatorSchemas = new Map<string, any>();
    for (const type of Object.keys(this.metadataStore.getAllOperatorTypes())) {
      const jsonSchema = this.metadataStore.getSchema(type);
      const additionalMetadata = this.metadataStore.getAdditionalMetadata(type);
      if (jsonSchema) {
        operatorSchemas.set(type, { jsonSchema, additionalMetadata });
      }
    }

    const context: ToolContext = {
      metadataStore: this.metadataStore,
      nativeValidationRepair: this.nativeValidationRepair,
      settings: {
        maxOperatorResultCharLimit: this.settings.maxOperatorResultCharLimit,
        toolTimeoutMs: this.settings.toolTimeoutMs,
        executionTimeoutMs: this.settings.executionTimeoutMs,
        nativeProfileCollection: this.settings.nativeProfileCollection,
        nativeProfileScope: this.settings.nativeProfileScope,
        dataflowReasoning: this.settings.dataflowReasoning === true,
        nativeChecks: this.settings.nativeChecks === true,
      },
    };

    const tools: Record<string, any> = {};

    if (this.settings.agentMode === AgentMode.CODE) {
      tools[TOOL_NAME_DELETE_OPERATOR] = createDeleteOperatorTool(this.workflowState, context);
      tools[TOOL_NAME_CREATE_OR_MODIFY_OPERATOR] = createCreateOrModifyOperatorTool(
        this.workflowState,
        operatorSchemas,
        context,
        this.settings.maxOperatorEdits,
        this.settings.enableRenderPrefs === true,
        this.isCodeShownToAgent(),
        this.settings.versionedMode ? this.operatorVersionStore() : undefined
      );
    } else {
      tools[TOOL_NAME_DATAFLOW] = createRegisteredDataflowTool(
        availableRetrievalViews(this.settings),
        this.settings.stateHistory,
        this.settings.multiTask || this.settings.stateHistory
      );
    }

    // Opt-in agent-triggered compaction (POC): a marker tool. The DELTA assembler
    // folds the trajectory up to the newest call into a compact deck. Read-only.
    if (this.settings.enableCompactTool) {
      tools[TOOL_NAME_COMPACT_CONTEXT] = createCompactContextTool();
    }

    // Opt-in multi-turn state recall: the model fetches the specific earlier
    // state this turn depends on, instead of the renderer pushing every turn
    // forever. Pairs with `turnHistory: "index"`. Read-only.
    if (this.settings.enableRecallTool) {
      tools[TOOL_NAME_RECALL_STATE] = createRecallStateTool({
        getTurns: () => this.buildTurnLog(),
        // The messageId of the turn in progress: one user request per messageId,
        // so this is what resets the per-turn recall budget.
        getCurrentTurnKey: () => this.currentMessageId ?? "",
        workflowState: this.workflowState,
        maxResultChars: this.settings.recallMaxResultChars,
        operatorLevel: this.settings.recallOperatorLevel === true,
      });
    }

    // Opt-in version-tree navigation: the model names the turn it builds on,
    // instead of a recency heuristic choosing for it. Pairs with recallState —
    // resumeFrom MOVES, recallState READS.
    if (this.settings.enableResumeTool) {
      tools[TOOL_NAME_RESUME_FROM] = createResumeFromTool({
        resumeToTurn: (turn: number) => this.resumeToTurn(turn),
        turnCount: () => this.turnOrder().length,
        getCurrentTurnKey: () => this.currentMessageId ?? "",
      });
    }

    // When parallel tool calls are enabled the model can emit N tool calls in
    // one assistant turn; wrap each tool's `execute` so all calls in that
    // turn land in one batch and run sequentially in dependency order. With
    // parallel disabled, wrapping is a no-op equivalent (batch size 1), so we
    // skip the wrap to keep the call path identical to the pre-batching code.
    if (this.settings.parallelToolCalls) {
      const scheduler = new ToolCallScheduler();
      for (const name of Object.keys(tools)) {
        tools[name] = scheduler.wrap(name, tools[name]);
      }
    }

    return tools;
  }

  /**
   * Build a tool registry for `importReActSteps` replay. Includes CRUD tools
   * for BOTH code and native modes so any exported session is replayable
   * regardless of the agent's current `agentMode`. No scheduler wrapping —
   * the replay loop awaits each call sequentially.
   */
  private buildReplayTools(): Record<string, any> {
    const operatorSchemas = new Map<string, any>();
    for (const type of Object.keys(this.metadataStore.getAllOperatorTypes())) {
      const jsonSchema = this.metadataStore.getSchema(type);
      const additionalMetadata = this.metadataStore.getAdditionalMetadata(type);
      if (jsonSchema) {
        operatorSchemas.set(type, { jsonSchema, additionalMetadata });
      }
    }

    const context: ToolContext = {
      metadataStore: this.metadataStore,
      settings: {
        maxOperatorResultCharLimit: this.settings.maxOperatorResultCharLimit,
        toolTimeoutMs: this.settings.toolTimeoutMs,
        executionTimeoutMs: this.settings.executionTimeoutMs,
        dataflowReasoning: this.settings.dataflowReasoning === true,
        nativeProfileCollection: this.settings.nativeProfileCollection,
        nativeProfileScope: this.settings.nativeProfileScope,
        nativeChecks: this.settings.nativeChecks === true,
      },
    };

    return {
      [TOOL_NAME_DATAFLOW]: createNativeTools(this.workflowState, context)[TOOL_NAME_DATAFLOW],
      [TOOL_NAME_DELETE_OPERATOR]: createDeleteOperatorTool(this.workflowState, context),
      [TOOL_NAME_CREATE_OR_MODIFY_OPERATOR]: createCreateOrModifyOperatorTool(
        this.workflowState,
        operatorSchemas,
        context,
        0,
        this.settings.enableRenderPrefs === true,
        this.isCodeShownToAgent()
      ),
    };
  }

  getState(): AgentStateEnum {
    return this.state;
  }

  getWorkflowState(): WorkflowState {
    return this.workflowState;
  }

  getMetadataStore(): WorkflowSystemMetadata {
    return this.metadataStore;
  }

  getHead(): string | undefined {
    return this.head;
  }

  getAncestorPath(stepId?: string): string[] {
    const target = stepId ?? this.head;
    if (!target) return [];
    const chain: string[] = [];
    let current: string | undefined = target;
    while (current) {
      chain.unshift(current);
      current = this.stepsById.get(current)?.parentId;
    }
    return chain;
  }

  getStepsById(): Map<string, ReActStep> {
    return this.stepsById;
  }

  getSnapshotStorage(): WorkflowSnapshotStorage {
    return this.snapshotStorage;
  }

  getWebsockets(): Set<any> {
    return this.websockets;
  }

  addWebsocket(ws: any): void {
    this.websockets.add(ws);
  }

  removeWebsocket(ws: any): void {
    this.websockets.delete(ws);
  }

  getReActSteps(): ReActStep[] {
    const all: ReActStep[] = [];
    for (const steps of this.reActStepsByMessageId.values()) {
      all.push(...steps);
    }
    return all;
  }

  getVisibleReActSteps(): ReActStep[] {
    return this.getAncestorPath()
      .map(id => this.stepsById.get(id)!)
      .filter(Boolean);
  }

  /**
   * The COMPLETED turns before the current one, for `recallState`.
   *
   * Turns are the `messageId` groups along the visible path (one user request per
   * group), which is the same grouping the renderer's `# Prior Turns` catalogue
   * numbers from — so a turn number the model reads in the prompt resolves here.
   * The last group is the turn in progress and is excluded: its events are
   * already rendered raw, and recalling the request you were just handed is
   * pure waste.
   *
   * Each turn carries the workflow snapshot recorded at its final step, which is
   * what makes "the code of operator X as of turn 12" answerable, plus that
   * snapshot's materialized results, which makes "and what did it compute then"
   * answerable without reaching forward to HEAD (where the operator may since
   * have been revised — reading today's numbers for an earlier turn's question
   * is precisely the cascade error this tool exists to prevent).
   *
   * The per-operator VERB comes from diffing consecutive turn snapshots, so the
   * "delta set" the tool reports is the real one: an id the turn wrote but left
   * byte-identical still lists (the turn did work on it), while added / revised /
   * deleted is decided by what actually changed in the DAG.
   */
  /**
   * GLOBAL turn order: the messageIds of every turn ever asked, in the order
   * they were asked, with the synthetic `initialize` bootstrap excluded.
   *
   * Numbering must not depend on the current branch. Once a turn resumes from
   * an earlier one, the ancestor path is SHORTER than the session — turns on
   * abandoned branches are no longer ancestors of HEAD — so numbering by path
   * position would renumber everything, and "Turn 5" in the catalogue would
   * stop meaning turn 5 to `resumeFrom` / `recallState`. `stepsById` is a Map,
   * so its insertion order is creation order, which is exactly the ask order.
   */
  turnOrder(): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const step of this.stepsById.values()) {
      if (TexeraAgent.isInitializationStep(step)) continue;
      // Loaded state is not a request: task numbers start at the first user message.
      if (step.synthetic === "state") continue;
      if (seen.has(step.messageId)) continue;
      seen.add(step.messageId);
      order.push(step.messageId);
    }
    return order;
  }

  /** 1-based global turn number for a messageId, or undefined if unknown. */
  turnNumberOf(messageId: string): number | undefined {
    const i = this.turnOrder().indexOf(messageId);
    return i < 0 ? undefined : i + 1;
  }

  getCurrentMessageId(): string | undefined {
    return this.currentMessageId;
  }

  /** messageId -> global turn number, for the renderer. */
  turnNumberMap(): Map<string, number> {
    const m = new Map<string, number>();
    this.turnOrder().forEach((id, i) => m.set(id, i + 1));
    return m;
  }

  /** HEAD when the request that owns `stepId` arrived: the user step's parent.
   * The ledger and provenance cards measure a task's changes against it. */
  private taskBaseStepId(stepId: string): string | undefined {
    const messageId = this.stepsById.get(stepId)?.messageId;
    if (!messageId) return undefined;
    return (this.reActStepsByMessageId.get(messageId) ?? []).find(step => step.role === "user")?.parentId;
  }

  /** HEAD when the first request arrived: the state loaded before this conversation. */
  private loadedStepId(): string | undefined {
    const first = this.turnOrder()[0];
    return first
      ? (this.reActStepsByMessageId.get(first) ?? []).find(step => step.role === "user")?.parentId
      : undefined;
  }

  /** The number of the task a step belongs to, counted like `completedStateTasks`. */
  private currentTaskNumber(stepId: string): number | undefined {
    const messageId = this.stepsById.get(stepId)?.messageId;
    const index = messageId ? this.turnOrder().indexOf(messageId) : -1;
    return index >= 0 ? index + 1 + this.taskNumberOffset : undefined;
  }

  private archivedTaskHistory() {
    return taskHistoryFromSteps(
      this.getReActSteps(),
      this.snapshotStorage,
      this.turnNumberMap(),
      this.taskNumberOffset
    );
  }

  getTaskHistory() {
    return buildTaskGraph(this.snapshotStorage, this.archivedTaskHistory());
  }

  /** Resolve completed user tasks directly from the append-only ReAct tree. */
  private completedStateTasks() {
    const currentMessage = this.head ? this.stepsById.get(this.head)?.messageId : undefined;
    return this.turnOrder().flatMap((messageId, i) => {
      if (messageId === currentMessage) return [];
      const steps = this.reActStepsByMessageId.get(messageId) ?? [];
      const end = [...steps].reverse().find(
        step =>
          step.role === "agent" &&
          step.isEnd &&
          step.toolResults?.some(result => {
            const actions = asDataflowActionsResult(result.output);
            return actions?.status === "completed" && actions.answer !== undefined;
          })
      );
      if (!end) return [];
      return [
        {
          // Tasks are numbered as the user counts requests: loaded tasks
          // first, then every request of this conversation, answered or not.
          taskId: i + 1 + this.taskNumberOffset,
          stepId: end.id,
          request: steps.find(step => step.role === "user")?.content ?? "",
          answer: end.content,
          steps: steps.slice(0, steps.indexOf(end) + 1),
        },
      ];
    });
  }

  /**
   * Turns that happened but are NOT ancestors of HEAD — the branches left
   * behind by a `resumeFrom`. They stay in the catalogue so the version tree
   * is navigable in both directions; without them, resuming to turn 8 would
   * hide turns 9..20 permanently.
   */
  offBranchTurns(visibleSteps: ReActStep[]): Array<{
    turn: number;
    request: string;
    answer?: string;
    operators: string[];
  }> {
    const onBranch = new Set(visibleSteps.map(s => s.messageId));
    const out: Array<{
      turn: number;
      request: string;
      answer?: string;
      operators: string[];
    }> = [];
    this.turnOrder().forEach((msgId, i) => {
      if (onBranch.has(msgId)) return;
      const steps = this.reActStepsByMessageId.get(msgId) ?? [];
      const operators: string[] = [];
      for (const step of steps) {
        for (const call of step.toolCalls ?? []) {
          const opId = writtenOperatorId(call.toolName, call.input);
          if (typeof opId === "string" && !operators.includes(opId)) operators.push(opId);
        }
      }
      out.push({
        turn: i + 1,
        request: steps.find(s => s.role === "user")?.content ?? "",
        answer: [...steps].reverse().find(s => s.role === "agent" && s.isEnd)?.content,
        operators,
      });
    });
    return out;
  }

  /**
   * Move this turn's base to the end of an earlier turn (see resume-from-tool).
   *
   * The move is a RE-PARENT of the current turn's user step, not a mutation of
   * history: the turn being left keeps all of its steps, and the snapshot
   * storage resolves state through a live ancestor-path callback, so changing
   * one parent link is enough to change which workflow and which results the
   * renderer sees. Nothing is copied and nothing is deleted.
   */
  resumeToTurn(turn: number): { ok: boolean; message: string } {
    const order = this.turnOrder();
    const currentMsg = this.currentMessageId;
    if (!currentMsg) return { ok: false, message: "No turn is in progress." };
    const completed = order.filter(m => m !== currentMsg);

    // THE FIRST TURN HAS NOTHING TO RESUME FROM, and this must not be an error.
    // The prompt tells the model to resume before building, so on turn 1 it
    // dutifully calls `resumeFrom(1)` — and an error there is a rejection with
    // no alternative action, which the model answers by retrying verbatim.
    // Measured: 35 identical failing calls on nfl turn 1, the whole 40-step
    // budget spent, no answer. Same shape as the recall loops before it. So
    // this succeeds and says what to do instead.
    if (completed.length === 0) {
      return {
        ok: true,
        message:
          "This is the first turn of the session, so there is no earlier state to resume from — " +
          "you are starting from an empty dataflow, which is correct. Build what the request needs. " +
          "Do not call resumeFrom again this turn.",
      };
    }

    const noRetry = " Do not call resumeFrom again this turn — pick a valid turn or proceed with the base you have.";
    if (turn < 1 || turn > order.length) {
      return {
        ok: false,
        message: `Turn ${turn} does not exist. Earlier turns are 1..${completed.length}.` + noRetry,
      };
    }
    const targetMsg = order[turn - 1];
    if (targetMsg === currentMsg) {
      return {
        ok: false,
        message:
          `Turn ${turn} is the turn you are on. Earlier turns are 1..${completed.length}; ` +
          `to continue from where the last turn left off, resume from ${completed.length}.` +
          noRetry,
      };
    }

    // The uncommitted-changes guard. Moving now would strand this turn's own
    // operators on a branch that is no longer an ancestor of HEAD.
    const mine = this.reActStepsByMessageId.get(currentMsg) ?? [];
    const built: string[] = [];
    for (const step of mine) {
      for (const call of step.toolCalls ?? []) {
        if (call.toolName === TOOL_NAME_DATAFLOW) {
          const batch = asNativeBatchResult(step.toolResults?.find(r => r.toolCallId === call.toolCallId)?.output);
          for (const outcome of batch?.operators ?? [])
            if ((outcome.status === "added" || outcome.status === "modified") && !built.includes(outcome.id))
              built.push(outcome.id);
          continue;
        }
        if (!WRITE_TOOL_NAMES.has(call.toolName)) continue;
        const opId = writtenOperatorId(call.toolName, call.input);
        if (typeof opId === "string" && !built.includes(opId)) built.push(opId);
      }
    }
    if (built.length > 0) {
      return {
        ok: false,
        message:
          `Cannot change base now: this turn already built ${built.join(", ")}. ` +
          "Resuming would strand that work on an abandoned branch. Continue from the base you have, " +
          "or use `recallState` to READ an earlier turn without moving to it.",
      };
    }

    const group = this.reActStepsByMessageId.get(targetMsg) ?? [];
    const baseStepId = group[group.length - 1]?.id;
    if (!baseStepId)
      return {
        ok: false,
        message: `Turn ${turn} recorded no steps to resume from.`,
      };

    const userStep = mine.find(s => s.role === "user");
    if (!userStep)
      return {
        ok: false,
        message: "This turn has no request step to re-parent.",
      };
    userStep.parentId = baseStepId;
    this.workflowState.setWorkflowContent(this.snapshotStorage.getWorkflow(baseStepId));
    this.nativeValidationRepair.clear();

    const ops = (this.snapshotStorage.getWorkflow(baseStepId).operators ?? []).length;
    return {
      ok: true,
      message:
        `Resumed from turn ${turn}. The dataflow is now that turn's state: ${ops} operator(s). ` +
        "Everything you build now branches from there. Every turn is still listed in the `# Catalog` " +
        "and still resumable.",
    };
  }

  /**
   * The version store for STRICT (operatorId, turnId) addressing: which
   * finished turns wrote each operator (with that turn's code), which turn is
   * in progress, and what it has touched so far. Derived from the same turn
   * grouping as the catalogue and `recallState`, so a version turn the model
   * reads anywhere is valid everywhere.
   */
  /**
   * Record the current definition of each edited operator as its version at
   * the turn in progress.
   *
   * `inputRefs` are captured from the live graph — for each upstream, the
   * version that upstream currently holds — so a version remembers what it
   * actually consumed. That is what makes checking out an old version a
   * lookup chain instead of guesswork about which inputs were in play.
   */
  private recordVersionsFor(operatorIds: readonly string[]): void {
    const turn = this.turnOrder().length;
    if (turn <= 0) return;
    for (const opId of new Set(operatorIds)) {
      const op = this.workflowState.getOperator(opId);
      if (!op) continue;
      const inputRefs = this.workflowState
        .getLinksConnectedToOperator(opId)
        .filter(l => l.target.operatorID === opId)
        .map(l => l.source.operatorID)
        .map(srcId => ({
          operatorId: srcId,
          // An upstream written earlier this turn is at THIS turn; otherwise
          // it is whatever version it last landed at.
          turn: this.versionStore.latestTurnOf(srcId) ?? turn,
        }));
      try {
        this.versionStore.recordWrite({
          operatorId: opId,
          turn,
          code: String((op.operatorProperties as Record<string, unknown> | undefined)?.code ?? ""),
          operatorType: op.operatorType,
          inputPorts: op.inputPorts,
          outputPorts: op.outputPorts,
          inputRefs,
          resultStepId: this.head,
        });
      } catch (e: any) {
        // Only thrown when writing into a closed turn — a real invariant
        // breach worth seeing, never worth killing the turn over.
        this.log.warn({ err: e?.message || e, opId, turn }, "version store write rejected");
      }
    }
  }

  /**
   * Resolve `(operatorId, turn)` to the node the write path should wire from.
   * Built on first use so it picks up the initialized metadata store.
   */
  private checkoutVersion(
    operatorId: string,
    turn: number,
    writingOperatorId?: string
  ): { operatorId: string; pinned: boolean } | { error: string } {
    if (!this.versionCheckout) {
      const util = new WorkflowUtilService(this.metadataStore, this.workflowState);
      this.versionCheckout = new VersionCheckout({
        workflowState: this.workflowState,
        store: this.versionStore,
        newOperator: (operatorType, displayName) => {
          try {
            return util.getNewOperatorPredicate(operatorType, displayName);
          } catch {
            return undefined;
          }
        },
      });
    }
    const outcome = this.versionCheckout.resolve({ operatorId, turn }, writingOperatorId);
    // A freshly materialized pin is itself a version of this turn: recording
    // it keeps the store's picture of the graph complete, and gives the pin a
    // lineage entry of its own.
    if (!("error" in outcome) && outcome.pinned) {
      this.recordVersionsFor([outcome.operatorId]);
    }
    return outcome;
  }

  /** Seal the finished turn's versions: from here they are permanent facts. */
  private closeVersionTurn(): void {
    const turn = this.turnOrder().length;
    if (turn > 0) this.versionStore.closeTurn(turn);
  }

  operatorVersionStore() {
    const agent = this;
    return {
      versionsOf(operatorId: string): Array<{ turn: number; code: string }> {
        const out: Array<{ turn: number; code: string }> = [];
        for (const t of agent.buildTurnLog()) {
          if (!t.operators.includes(operatorId)) continue;
          const op = (t.workflow?.operators as any[])?.find(o => o?.operatorID === operatorId);
          out.push({
            turn: t.turn,
            code: String(op?.operatorProperties?.code ?? ""),
          });
        }
        return out;
      },
      currentTurn(): number {
        return agent.turnOrder().length;
      },
      touchedThisTurn(): Set<string> {
        const touched = new Set<string>();
        const msg = agent.currentMessageId;
        if (!msg) return touched;
        for (const step of agent.reActStepsByMessageId.get(msg) ?? []) {
          for (const call of step.toolCalls ?? []) {
            const opId = writtenOperatorId(call.toolName, call.input);
            if (typeof opId === "string") touched.add(opId);
          }
        }
        return touched;
      },
      checkout: (operatorId: string, turn: number, writingOperatorId?: string) =>
        agent.checkoutVersion(operatorId, turn, writingOperatorId),
      pinnedLabelOf: (operatorId: string) => agent.versionCheckout?.pinnedLabel(operatorId),
      resultOf(operatorId: string, turn: number) {
        // The same as-of-turn results recallState serves — one source of truth
        // for "what did this version hold" (buildTurnLog resolves each turn's
        // ending snapshot).
        return agent
          .buildTurnLog()
          .find(t => t.turn === turn)
          ?.results?.get(operatorId);
      },
    };
  }

  private buildTurnLog(): RecalledTurn[] {
    // Drop the synthetic `initialize` bootstrap step exactly as the renderer's
    // buildPath does. Without this the tool numbers turns one higher than the
    // `# Prior Turns` catalogue the model is reading, so "turn 1" returns the
    // bootstrap group with an empty request — which sent the model into a
    // retrieval loop (44 recall calls in one turn, observed 2026-08-04).
    const path = this.getVisibleReActSteps().filter(s => !TexeraAgent.isInitializationStep(s));
    const groups: ReActStep[][] = [];
    const indexByMessageId = new Map<string, number>();
    for (const step of path) {
      let idx = indexByMessageId.get(step.messageId);
      if (idx === undefined) {
        idx = groups.length;
        indexByMessageId.set(step.messageId, idx);
        groups.push([]);
      }
      groups[idx].push(step);
    }
    // Drop the in-progress turn.
    const prior = groups.slice(0, -1);

    // The snapshot that ends each turn, resolved once so turn i can be diffed
    // against turn i-1. `undefined` when the turn wrote nothing at all.
    const endStepIdOf = (steps: ReActStep[]): string | undefined => {
      for (const step of [...steps].reverse()) {
        if (this.snapshotStorage.hasSnapshotFor(step.id)) return step.id;
      }
      return undefined;
    };
    const endStepIds = prior.map(endStepIdOf);

    return prior.map((steps, i) => {
      const request = steps.find(s => s.role === "user")?.content ?? "";
      const endStep = [...steps].reverse().find(s => s.role === "agent" && s.isEnd);
      const operators: string[] = [];
      const seen = new Set<string>();
      for (const step of steps) {
        for (const call of step.toolCalls ?? []) {
          const opId = writtenOperatorId(call.toolName, call.input);
          if (typeof opId !== "string" || seen.has(opId)) continue;
          seen.add(opId);
          operators.push(opId);
        }
      }

      // Prefer the snapshot at the step that ended the turn; fall back to the
      // newest snapshot-bearing step in the group. A turn that wrote nothing
      // inherits the previous turn's state, so walk back for its baseline too.
      const endId = endStepIds[i];
      const workflow = endId ? this.snapshotStorage.getWorkflow(endId) : undefined;
      const results = endId ? this.snapshotStorage.getAllVisibleResults(endId) : undefined;

      let beforeId: string | undefined;
      for (let j = i - 1; j >= 0; j--) {
        if (endStepIds[j]) {
          beforeId = endStepIds[j];
          break;
        }
      }
      const before = new Set(
        (beforeId ? this.snapshotStorage.getWorkflow(beforeId).operators : []).map(o => o.operatorID)
      );
      const after = new Set((workflow?.operators ?? []).map(o => o.operatorID));
      const verbs = new Map<string, RecallVerb>();
      for (const opId of operators) {
        if (!after.has(opId)) verbs.set(opId, "deleted");
        else verbs.set(opId, before.has(opId) ? "revised" : "added");
      }

      // GLOBAL turn number, not the position on this branch. After a resume the
      // branch is shorter than the session, so `i + 1` would renumber turns and
      // `recallState(turn: 5)` would stop meaning the catalogue's "Turn 5".
      const msgId = steps[0]?.messageId;
      const turnNo = (msgId ? this.turnNumberOf(msgId) : undefined) ?? i + 1;
      return {
        turn: turnNo,
        request,
        answer: endStep?.content,
        operators,
        verbs,
        workflow,
        results,
      };
    });
  }

  getAllSteps(): ReActStep[] {
    return Array.from(this.stepsById.values());
  }

  /**
   * True for the synthetic bootstrap step that carries the `initialize` tool
   * call. It seeds turn 1 and anchors the version tree / first snapshot
   * internally, but is not meaningful to display, so it is excluded from the
   * client-facing step lists.
   */
  static isInitializationStep(step: ReActStep): boolean {
    return Array.isArray(step.toolCalls) && step.toolCalls.some((tc: any) => tc?.toolName === "initialize");
  }

  /**
   * Steps a client should render — every step except the synthetic
   * `initialize` bootstrap step. The init step is retained internally (it owns
   * the first snapshot and roots the tree) but never sent for display.
   */
  getRenderableReActSteps(): ReActStep[] {
    return this.getAllSteps().filter(step => !TexeraAgent.isInitializationStep(step));
  }

  checkout(stepId: string): boolean {
    const step = this.stepsById.get(stepId);
    if (!step) return false;
    this.head = stepId;
    // Restore the workflow visible at this branch. The storage's reads are
    // total — if no action-bearing ancestor owns a snapshot on this branch
    // we fall through to the empty root's empty workflow.
    this.workflowState.setWorkflowContent(this.snapshotStorage.getWorkflow(stepId));
    this.nativeValidationRepair.clear();
    return true;
  }

  setStepCallback(callback: ReActStepCallback | null): void {
    this.stepCallback = callback;
  }

  /**
   * Subscribe to workflow-snapshot writes. Fires after a `createSnapshot`
   * actually committed a new snapshot — i.e., HEAD is action-bearing. Used by
   * the websocket layer to push a `snapshot` event so clients can refresh
   * their view without embedding workflow content in every step event.
   */
  setSnapshotCallback(callback: SnapshotCallback | null): void {
    this.snapshotCallback = callback;
  }

  private generateStepId(): string {
    return `step-${this.agentId}-${++this.stepCounter}-${Date.now()}`;
  }

  /**
   * Create a snapshot owned by HEAD iff the step is action-bearing (i.e.
   * it has at least one tool call). Steps without tool calls (user
   * messages, plain "thinking" replies, error frames) own no snapshot —
   * lookups for them resolve to the nearest action-bearing ancestor via
   * the snapshot storage's associated-snapshot rule.
   *
   * Must be called AFTER `addStep` advances HEAD to the step we're writing
   * for.
   */
  private maybeCreateSnapshotForHead(content: WorkflowContent): void {
    const head = this.head;
    if (head === undefined) return;
    const step = this.stepsById.get(head);
    if (!step?.toolCalls || step.toolCalls.length === 0) return;
    if (step.toolCalls.every(call => call.toolName === "inspectError")) return;
    if (this.snapshotStorage.hasSnapshotFor(head)) return;
    this.snapshotStorage.createSnapshot(head, content);
    this.snapshotCallback?.(head, content);
  }

  private addStep(step: ReActStep): void {
    let steps = this.reActStepsByMessageId.get(step.messageId);
    if (!steps) {
      steps = [];
      this.reActStepsByMessageId.set(step.messageId, steps);
    }
    steps.push(step);
    this.stepsById.set(step.id, step);
    if (this.stepCallback) {
      this.stepCallback(step);
    }
  }

  getSystemInfo(): {
    systemPrompt: string;
    tools: Array<{
      name: string;
      description: string;
      inputSchema: any;
      strict?: boolean;
      enabled: boolean;
    }>;
  } {
    const toolsInfo = Object.entries(this.tools).map(([name, toolDef]) => {
      const description = toolDef.description || "";
      const schema = toolDef.inputSchema ?? toolDef.parameters;
      const inputSchema = schema ? asSchema(schema).jsonSchema : {};
      const enabled = !this.settings.disabledTools.has(name);

      return {
        name,
        description,
        inputSchema,
        ...(toolDef.strict !== undefined ? { strict: toolDef.strict } : {}),
        enabled,
      };
    });

    return {
      systemPrompt: this.systemPrompt,
      tools: toolsInfo,
    };
  }

  getSettings(): AgentSettings {
    return { ...this.settings };
  }

  updateSettings(
    updates: {
      maxOperatorResultCharLimit?: number;
      maxOperatorResultCellCharLimit?: number;
      operatorResultSerializationMode?: OperatorResultSerializationMode;
      toolTimeoutMs?: number;
      executionTimeoutMs?: number;
      disabledTools?: Set<string>;
      maxSteps?: number;
      maxOperatorEdits?: number;
      agentMode?: AgentMode;
      nativeProfileCollection?: boolean;
      nativeProfileScope?: "prefix" | "full";
      dataEvidence?: boolean;
      flowEvidence?: boolean;
      dataflowReasoning?: boolean;
      nativeChecks?: boolean;
      nativePromptDetail?: "full" | "on_demand";
      taskContext?: "trajectory" | "dependencies";
      stateHistory?: boolean;
      stateLedger?: boolean;
      resultSelection?: ResultSelection;
      contextMode?: ContextMode;
      parallelToolCalls?: boolean;
      includeOperatorProperties?: boolean;
      thoughtReplay?: boolean;
      thoughtReplayK?: number;
      agentTurns?: boolean;
      contextWindowTokens?: number;
      compactionStrategy?: CompactionStrategy;
      deckSampleRatio?: number;
      errorReflection?: boolean;
      errorReflectionThreshold?: number;
      fewShotPrompt?: boolean;
      maxResultRows?: number;
      attemptReflection?: boolean;
      toolDialect?: LocalToolDialect;
      summarizeParams?: SummarizeParamsPatch | null;
      selectorConfig?: SelectorConfig | null;
      frontierDecayConfig?: FrontierDecayConfig | null;
      foldResolvedRevisionsConfig?: FoldResolvedRevisionsConfig | null;
      probeRetirementConfig?: ProbeRetirementConfig | null;
      rolePolicyConfig?: RolePolicyConfig | null;
      learnedConfig?: LearnedConfig | null;
      enableInspectTool?: boolean;
      enableRenderPrefs?: boolean;
      enableCodeInSnapshot?: boolean;
      sourceProvenanceHint?: boolean;
      enableCompactTool?: boolean;
      compactKeepLastSteps?: number;
      staticCompaction?: boolean;
      userTaskPlacement?: "top" | "bottom";
      turnHistory?: "full" | "index";
      enableRecallTool?: boolean;
      indexRichTables?: number;
      indexDetailedOperators?: number;
      enableResumeTool?: boolean;
      enableAnswerGrounding?: boolean;
      seedSources?: boolean;
      messageLayout?: AgentSettings["messageLayout"];
      versionedMode?: boolean;
      versionedHeads?: boolean;
      sessionTurns?: boolean;
      recallMaxResultChars?: number;
      recallOperatorLevel?: boolean;
      specAudit?: boolean;
      indexThinObservations?: boolean;
      tunerConfig?: TunerConfig | null;
    } & RetrievalSettings &
      ObservationFormatOptions & { multiTask?: boolean }
  ): void {
    // Validate the effective combination before mutating ANY setting. In
    // particular a rejected mode change must not leave the prompt/tools split.
    validateNativeSettings(updates);
    validateTaskContextSettings({ ...this.settings, ...updates });
    const collection = updates.nativeProfileCollection ?? this.settings.nativeProfileCollection ?? false;
    const scope = updates.nativeProfileScope ?? this.settings.nativeProfileScope ?? "prefix";
    if (
      (collection !== (this.settings.nativeProfileCollection ?? false) ||
        scope !== (this.settings.nativeProfileScope ?? "prefix")) &&
      (this.state !== AgentStateEnum.AVAILABLE || this.workflowState.getAllOperators().length > 0)
    ) {
      throw new NativeCatalogSettingsError(
        "Changing profile collection or scope requires a fresh agent and workflow; existing operators retain their compiled setting"
      );
    }
    let promptNeedsRebuild = false;
    if (updates.nativePromptDetail !== undefined && updates.nativePromptDetail !== this.settings.nativePromptDetail) {
      this.settings.nativePromptDetail = updates.nativePromptDetail;
      promptNeedsRebuild = true;
    }
    if (updates.taskContext !== undefined) this.settings.taskContext = updates.taskContext;
    const formatUpdates = observationFormatPatch(updates);
    if (Object.keys(formatUpdates).length) {
      Object.assign(this.settings, formatUpdates);
      promptNeedsRebuild = true;
    }
    if (updates.multiTask !== undefined) {
      this.settings.multiTask = updates.multiTask;
      promptNeedsRebuild = true;
    }
    for (const key of [
      "retrievalViews",
      "fullResultCharLimit",
      "dataEvidenceCharLimit",
      "flowEvidenceCharLimit",
    ] as const) {
      if (updates[key] !== undefined) {
        Object.assign(this.settings, { [key]: structuredClone(updates[key]) });
        promptNeedsRebuild = true;
      }
    }
    this.settings.nativeProfileCollection = collection;
    this.settings.nativeProfileScope = scope;
    // The native prompt documents exactly the evidence kinds that are on.
    if (updates.dataEvidence !== undefined && updates.dataEvidence !== this.settings.dataEvidence) {
      this.settings.dataEvidence = updates.dataEvidence;
      promptNeedsRebuild = true;
    }
    if (updates.flowEvidence !== undefined && updates.flowEvidence !== this.settings.flowEvidence) {
      this.settings.flowEvidence = updates.flowEvidence;
      promptNeedsRebuild = true;
    }
    if (updates.dataflowReasoning !== undefined && updates.dataflowReasoning !== this.settings.dataflowReasoning) {
      // Changes the tool schema (rebuilt below) and the prompt's tool section.
      this.settings.dataflowReasoning = updates.dataflowReasoning;
      promptNeedsRebuild = true;
    }
    if (updates.stateHistory !== undefined && updates.stateHistory !== this.settings.stateHistory) {
      this.settings.stateHistory = updates.stateHistory;
      promptNeedsRebuild = true;
    }
    if (updates.stateLedger !== undefined && updates.stateLedger !== this.settings.stateLedger) {
      this.settings.stateLedger = updates.stateLedger;
      promptNeedsRebuild = true;
    }
    if (updates.nativeChecks !== undefined && updates.nativeChecks !== this.settings.nativeChecks) {
      this.settings.nativeChecks = updates.nativeChecks;
      promptNeedsRebuild = true;
    }

    if (updates.maxOperatorResultCharLimit !== undefined) {
      this.settings.maxOperatorResultCharLimit = updates.maxOperatorResultCharLimit;
      promptNeedsRebuild = true;
    }
    if (updates.maxOperatorResultCellCharLimit !== undefined) {
      this.settings.maxOperatorResultCellCharLimit = updates.maxOperatorResultCellCharLimit;
    }
    if (updates.operatorResultSerializationMode !== undefined) {
      this.settings.operatorResultSerializationMode = updates.operatorResultSerializationMode;
    }
    if (updates.toolTimeoutMs !== undefined) {
      this.settings.toolTimeoutMs = updates.toolTimeoutMs;
    }
    if (updates.executionTimeoutMs !== undefined) {
      this.settings.executionTimeoutMs = updates.executionTimeoutMs;
    }
    if (updates.disabledTools !== undefined) {
      this.settings.disabledTools = updates.disabledTools;
    }
    if (updates.maxSteps !== undefined) {
      this.settings.maxSteps = updates.maxSteps;
    }
    if (updates.maxOperatorEdits !== undefined) {
      this.settings.maxOperatorEdits = updates.maxOperatorEdits;
      // Read by createTools() below when (re)building the code-op tool; the
      // guard's consecutive-edit counter resets with the rebuilt closure.
    }
    if (updates.agentMode !== undefined && updates.agentMode !== this.settings.agentMode) {
      this.settings.agentMode = updates.agentMode;
      promptNeedsRebuild = true;
    }
    if (updates.resultSelection !== undefined && updates.resultSelection !== this.settings.resultSelection) {
      // Render-time selection of result blocks; the native prompt describes the
      // shapes the agent will see, so it rebuilds too.
      this.settings.resultSelection = updates.resultSelection;
      promptNeedsRebuild = true;
    }
    if (updates.contextMode !== undefined && updates.contextMode !== this.settings.contextMode) {
      this.settings.contextMode = updates.contextMode;
      // Context mode now selects the prompt's Context-Format + Example sections
      // (LATEST snapshot vs DELTA/FULL agent-events), so the prompt must rebuild.
      promptNeedsRebuild = true;
    } else if (updates.contextMode !== undefined) {
      this.settings.contextMode = updates.contextMode;
    }
    if (updates.parallelToolCalls !== undefined) {
      this.settings.parallelToolCalls = updates.parallelToolCalls;
      // The wrap/unwrap decision lives in createTools(); the call below
      // rebuilds the tool set so the change takes effect on the next turn.
    }
    if (this.settings.agentMode === AgentMode.NATIVE) {
      this.settings.parallelToolCalls = false;
      this.settings.dataflowReasoning = true;
    }
    if (updates.includeOperatorProperties !== undefined) {
      this.settings.includeOperatorProperties = updates.includeOperatorProperties;
      // Pure render-time toggle — controls whether each operator's
      // `Properties:` line is emitted in the assembled snapshot (code
      // operators are always stripped regardless). Read at next assembly.
    }
    if (updates.maxResultRows !== undefined) {
      this.settings.maxResultRows = updates.maxResultRows;
      promptNeedsRebuild = true;
      // Pure render-time setting — caps the per-operator TSV sample rows (W1).
    }
    if (updates.thoughtReplay !== undefined) {
      this.settings.thoughtReplay = updates.thoughtReplay;
      // Pure render-time toggle — LATEST-mode thought-replay reinjection rung.
    }
    if (updates.agentTurns !== undefined) {
      this.settings.agentTurns = updates.agentTurns;
      // Pure render-time toggle — LATEST-mode `# Agent Turns` trajectory section.
    }
    if (updates.contextWindowTokens !== undefined) {
      // Crossing the 0/>0 boundary flips the DELTA prompt's `## History
      // Compaction` section on/off, so rebuild the prompt when the enabled-state
      // changes.
      if (updates.contextWindowTokens > 0 !== this.settings.contextWindowTokens > 0) {
        promptNeedsRebuild = true;
      }
      this.settings.contextWindowTokens = updates.contextWindowTokens;
      // DELTA context-window budget (tokens). 0 ⇒ unbounded lossless delta;
      // >0 ⇒ raw delta until it would overflow, then compaction via compactionStrategy.
    }
    if (updates.compactionStrategy !== undefined) {
      // Switching to/from compress flips whether the `## History Compaction`
      // (deck) section is in the prompt, so rebuild when it changes under a window.
      if (updates.compactionStrategy !== this.settings.compactionStrategy && this.settings.contextWindowTokens > 0) {
        promptNeedsRebuild = true;
      }
      this.settings.compactionStrategy = updates.compactionStrategy;
      // How DELTA compacts over budget (sliding | compress).
    }
    if (updates.deckSampleRatio !== undefined) {
      this.settings.deckSampleRatio = updates.deckSampleRatio;
      // Pure render-time setting — compress-deck row-sample fraction.
    }
    if (updates.thoughtReplayK !== undefined) {
      this.settings.thoughtReplayK = updates.thoughtReplayK;
      // Pure render-time setting — how many recent events the # Reasoning block shows.
    }
    if (updates.errorReflection !== undefined) {
      this.settings.errorReflection = updates.errorReflection;
      // Pure render-time toggle — LATEST-mode error-reflection rung.
    }
    if (updates.errorReflectionThreshold !== undefined) {
      this.settings.errorReflectionThreshold = updates.errorReflectionThreshold;
      // Pure render-time setting — N consecutive refixes before folded history shows.
    }
    if (updates.fewShotPrompt !== undefined) {
      this.settings.fewShotPrompt = updates.fewShotPrompt;
      promptNeedsRebuild = true; // W2: changes the SYSTEM prompt
    }
    if (updates.attemptReflection !== undefined) {
      this.settings.attemptReflection = updates.attemptReflection;
      // Pure render-time toggle — injects an `Attempt reflection:` block on
      // heavily-edited operators. Read at the next assembleContext.
    }
    if (updates.summarizeParams !== undefined) {
      // Pure render-time patch over the summarize() parameter space; applied
      // on the next context assembly. `null` clears a previously-set patch.
      this.settings.summarizeParams = updates.summarizeParams ?? undefined;
    }
    if (updates.selectorConfig !== undefined) {
      // Pure render-time: switches the assembler onto the per-step selector
      // policy. `null` turns the selector off (back to the contextMode path).
      this.settings.selectorConfig = updates.selectorConfig ?? undefined;
    }
    if (updates.frontierDecayConfig !== undefined) {
      // Pure render-time overlay on the legacy context preset. `null` clears it.
      this.settings.frontierDecayConfig = updates.frontierDecayConfig ?? undefined;
    }
    if (updates.foldResolvedRevisionsConfig !== undefined) {
      // Pure render-time (DELTA): fold resolved revisions. `null` clears it.
      this.settings.foldResolvedRevisionsConfig = updates.foldResolvedRevisionsConfig ?? undefined;
    }
    if (updates.probeRetirementConfig !== undefined) {
      // Pure render-time (LATEST): probe-retirement overlay. `null` clears it.
      this.settings.probeRetirementConfig = updates.probeRetirementConfig ?? undefined;
    }
    if (updates.rolePolicyConfig !== undefined) {
      // Pure render-time (LATEST): role-keyed render policy. `null` clears it.
      this.settings.rolePolicyConfig = updates.rolePolicyConfig ?? undefined;
    }
    if (updates.learnedConfig !== undefined) {
      // Pure render-time: switches the assembler onto the learned utility model.
      // `null` turns it off (back to selector/contextMode). Read per-call.
      this.settings.learnedConfig = updates.learnedConfig ?? undefined;
    }
    if (updates.enableInspectTool !== undefined) {
      // Compatibility input only. Result retrieval is through batch observe;
      // legacy clients cannot re-enable a removed tool by changing settings.
      this.settings.enableInspectTool = false;
    }
    if (updates.enableRenderPrefs !== undefined) {
      // Write-time render prefs: gates the createOrModifyOperator params (tools
      // rebuilt below), the prompt section + example variant (rebuilt here),
      // and the render application (read by the assembler per call).
      this.settings.enableRenderPrefs = updates.enableRenderPrefs;
      promptNeedsRebuild = true;
    }
    if (updates.enableCodeInSnapshot !== undefined) {
      // Code-in-snapshot: gates the tool summary description (tools rebuilt
      // below), the prompt context-format + example variant (rebuilt here), and
      // the includeCode render patch (read by the assembler per call, LATEST-only).
      this.settings.enableCodeInSnapshot = updates.enableCodeInSnapshot;
      promptNeedsRebuild = true;
    }
    if (updates.sourceProvenanceHint !== undefined) {
      // Provenance principle: one conditional bullet in the code-mode prompt.
      this.settings.sourceProvenanceHint = updates.sourceProvenanceHint;
      promptNeedsRebuild = true;
    }
    if (updates.enableCompactTool !== undefined) {
      // Adds/removes the compactContext marker tool (createTools() rebuilds).
      this.settings.enableCompactTool = updates.enableCompactTool;
      promptNeedsRebuild = true;
    }
    if (updates.compactKeepLastSteps !== undefined) {
      this.settings.compactKeepLastSteps = updates.compactKeepLastSteps;
    }
    if (updates.staticCompaction !== undefined) {
      this.settings.staticCompaction = updates.staticCompaction;
    }
    if (updates.userTaskPlacement !== undefined) {
      // Pure render-time: where the `# User Task` block goes.
      this.settings.userTaskPlacement = updates.userTaskPlacement;
    }
    if (updates.turnHistory !== undefined) {
      // Pure render-time: prior turns raw vs catalogued.
      this.settings.turnHistory = updates.turnHistory;
    }
    if (updates.indexRichTables !== undefined) this.settings.indexRichTables = updates.indexRichTables;
    if (updates.indexDetailedOperators !== undefined)
      this.settings.indexDetailedOperators = updates.indexDetailedOperators;
    if (updates.enableResumeTool !== undefined && updates.enableResumeTool !== this.settings.enableResumeTool) {
      this.settings.enableResumeTool = updates.enableResumeTool;
      promptNeedsRebuild = true;
    }
    if (updates.enableAnswerGrounding !== undefined)
      this.settings.enableAnswerGrounding = updates.enableAnswerGrounding;
    if (updates.seedSources !== undefined) this.settings.seedSources = updates.seedSources;
    if (updates.messageLayout !== undefined && updates.messageLayout !== this.settings.messageLayout) {
      this.settings.messageLayout = updates.messageLayout;
      if (this.settings.agentMode === AgentMode.NATIVE) {
        promptNeedsRebuild = true;
      }
    }
    if (updates.versionedMode !== undefined && updates.versionedMode !== this.settings.versionedMode) {
      // Changes the write tool's schema (strict version params), the context
      // layout, AND the prompt fragment describing both. Tools are rebuilt at
      // the end of this method regardless; the prompt needs an explicit rebuild.
      this.settings.versionedMode = updates.versionedMode;
      promptNeedsRebuild = true;
    }
    if (updates.versionedHeads !== undefined) this.settings.versionedHeads = updates.versionedHeads;
    if (updates.sessionTurns !== undefined && updates.sessionTurns !== this.settings.sessionTurns) {
      // Changes the context layout and the prompt fragment describing it.
      this.settings.sessionTurns = updates.sessionTurns;
      promptNeedsRebuild = true;
    }
    if (updates.recallMaxResultChars !== undefined) {
      // Tools are rebuilt at the end of this method, which re-reads the cap.
      this.settings.recallMaxResultChars = updates.recallMaxResultChars;
    }
    if (
      updates.recallOperatorLevel !== undefined &&
      updates.recallOperatorLevel !== this.settings.recallOperatorLevel
    ) {
      // Changes the recall tool's schema AND the prompt fragment + catalog
      // header describing its addressing.
      this.settings.recallOperatorLevel = updates.recallOperatorLevel;
      promptNeedsRebuild = true;
    }
    if (updates.specAudit !== undefined && updates.specAudit !== this.settings.specAudit) {
      // Adds/removes a system-prompt section only — no tool or schema changes.
      this.settings.specAudit = updates.specAudit;
      promptNeedsRebuild = true;
    }
    if (updates.indexThinObservations !== undefined)
      this.settings.indexThinObservations = updates.indexThinObservations;
    if (updates.enableRecallTool !== undefined && updates.enableRecallTool !== this.settings.enableRecallTool) {
      // Adds/removes the read-only recallState tool AND its prompt section, so
      // the system prompt has to be rebuilt (same contract as inspect/compact).
      this.settings.enableRecallTool = updates.enableRecallTool;
      promptNeedsRebuild = true;
    }
    if (updates.tunerConfig !== undefined) {
      // Pure render-time: switches the assembler onto the LLM context-tuner
      // path. `null` turns it off. The assembler reads this per-call.
      this.settings.tunerConfig = updates.tunerConfig ?? undefined;
    }
    if (updates.toolDialect !== undefined && updates.toolDialect !== this.settings.toolDialect) {
      this.settings.toolDialect = updates.toolDialect;
      // Local-react only: selects the system prompt AND the output parser for
      // the next turn. The parser is read from settings at runTurn; the prompt
      // is rebuilt below (the builder is dialect-aware).
      promptNeedsRebuild = true;
    }

    // An agent that has not been initialized yet has no prompt at all; the
    // first settings update gives it one for the (possibly default) mode.
    if (promptNeedsRebuild || !this.systemPrompt) {
      this.rebuildSystemPrompt();
    }

    this.tools = this.createTools();
    this.log.info(
      {
        maxOperatorResultCharLimit: this.settings.maxOperatorResultCharLimit,
        maxOperatorResultCellCharLimit: this.settings.maxOperatorResultCellCharLimit,
      },
      "settings updated"
    );
  }

  async refreshWorkflowFromBackend(): Promise<void> {
    // Once any step exists, that step's snapshot defines the workflow at HEAD;
    // only reload from backend for an empty agent (e.g. clearHistory just ran).
    if (this.head !== undefined) {
      return;
    }

    if (!this.delegateConfig?.workflowId || !this.delegateConfig?.userToken) {
      return;
    }

    try {
      const { retrieveWorkflow } = await import("../api/workflow-api");
      const workflow = await retrieveWorkflow(this.delegateConfig.userToken, this.delegateConfig.workflowId);
      this.workflowState.setWorkflowContent(workflow.content);
      this.log.debug({ workflowId: this.delegateConfig.workflowId }, "refreshed workflow from backend");
    } catch (error) {
      this.log.warn({ err: error }, "failed to refresh workflow from backend");
    }
  }

  setDelegateConfig(config: {
    userToken: string;
    userInfo?: UserInfo;
    workflowId: number;
    workflowName?: string;
    computingUnitId?: number;
  }): void {
    this.delegateConfig = config;

    this.tools = this.createTools();

    this.setupWorkflowChangeHandlers();
  }

  getDelegateConfig():
    | {
        userToken: string;
        userInfo?: UserInfo;
        workflowId: number;
        workflowName?: string;
        computingUnitId?: number;
      }
    | undefined {
    return this.delegateConfig;
  }

  private setupWorkflowChangeHandlers(): void {
    if (this.workflowChangeSubscription) {
      this.workflowChangeSubscription.unsubscribe();
    }

    const subscription = new Subscription();
    const workflowChanged$ = this.workflowState.getWorkflowChangedStream();

    if (this.delegateConfig?.workflowId && this.delegateConfig.userToken) {
      const persistSubscription = workflowChanged$.pipe(debounceTime(PERSIST_DEBOUNCE_MS)).subscribe(async () => {
        if (!this.delegateConfig?.workflowId || !this.delegateConfig.userToken) {
          return;
        }

        try {
          const { persistWorkflow } = await import("../api/workflow-api");
          const workflowContent = this.workflowState.getWorkflowContent();
          await persistWorkflow(
            this.delegateConfig.userToken,
            this.delegateConfig.workflowId,
            this.delegateConfig.workflowName || "Agent Workflow",
            workflowContent
          );
          this.log.debug({ workflowId: this.delegateConfig.workflowId }, "auto-persisted workflow");
        } catch (error) {
          this.log.error({ err: error }, "failed to auto-persist workflow");
        }
      });

      subscription.add(persistSubscription);
    }

    this.workflowChangeSubscription = subscription;
    this.workflowState.addSubscription(subscription);
  }

  async sendMessage(
    userMessage: string,
    messageSource?: "chat" | "feedback",
    options?: { sources?: readonly string[] }
  ): Promise<AgentMessageResult> {
    const messageId = `msg-${this.agentId}-${++this.messageCounter}-${Date.now()}`;
    let stepIndex = 0;
    // Failed/stopped turns still consumed model responses. Preserve their
    // reported usage; absent provider fields remain unknown rather than zero.
    const recordedUsage: TokenUsage = {};
    this.nativeActionAnswer = undefined;

    await this.refreshWorkflowFromBackend();

    this.nativeValidationRepair.clear();

    this.abortController = new AbortController();

    this.state = AgentStateEnum.GENERATING;

    this.currentMessageId = messageId;

    try {
      const estimatedInputTokens = Math.ceil(userMessage.length / 4);
      const userStepId = this.generateStepId();
      const userStep: ReActStep = {
        id: userStepId,
        parentId: this.head,
        messageId,
        stepId: 0,
        timestamp: Date.now(),
        role: "user",
        content: userMessage,
        isBegin: true,
        isEnd: true,
        messageSource,
        usage: {
          inputTokens: estimatedInputTokens,
          outputTokens: 0,
          totalTokens: estimatedInputTokens,
        },
      };
      this.addStep(userStep);
      this.head = userStepId;
      if (this.settings.agentMode === AgentMode.NATIVE) this.rebuildSystemPrompt();
      // User steps carry no tool calls and therefore own no snapshot — the
      // workflow visible here resolves to the nearest action-bearing
      // ancestor via `WorkflowSnapshotStorage.getAssociatedSnapshot`.

      // Seeded source roots: a system-performed opening step (stepId 1) the
      // model's first step then builds on. Only when the arm opts in AND the
      // message names its sources; otherwise the turn is byte-identical.
      if (this.settings.seedSources && options?.sources && options.sources.length > 0) {
        if (await this.seedSourceRoots(messageId, options.sources)) stepIndex = 1;
      }

      let isFirstStep = stepIndex === 0;
      let lastPreparedMessages: ModelMessage[] | undefined;

      // Pass only the current user turn; prepareStep rebuilds full context each step
      // (historical interactions + DAG + this message).
      const currentUserMessage: ModelMessage[] = [{ role: "user", content: userMessage }];
      // Step lifecycle logs (ported from feat/state-registry cc16aedf4) place a
      // stall: preparing / requesting model / model step finished / post-step done,
      // each with its duration.
      let requestedAt = 0;
      const turnStartStepIndex = stepIndex;
      let protocolFeedbackSteps = 0;
      let budgetFeedbackSteps = 0;
      let repeatedFailureFeedbackSteps = 0;
      let failureStreak = 0;
      let lastFailure: RepeatedFailure | undefined;
      const budgetReminders = new Set<number>();
      const runDriverOnce = (seed: ModelMessage[], maxSteps: number = this.settings.maxSteps) =>
        this.driver.runTurn({
          initialMessages: seed,
          systemPrompt: this.systemPrompt,
          tools: this.tools,
          maxSteps,
          parallelToolCalls: this.settings.parallelToolCalls,
          requireToolCall: this.settings.agentMode === AgentMode.NATIVE,
          getFinalAnswer: () => this.nativeActionAnswer,
          toolDialect: this.settings.toolDialect,
          abortSignal: this.abortController?.signal,
          prepareStep: async ({ stepNumber, messages: _currentMessages }) => {
            // Stop before another request, after the failed step is fully saved.
            if (lastFailure && failureStreak >= REPEATED_FAILURE_LIMIT) throw new Error(repeatedFailureError(lastFailure));
            const preparing = Date.now();
            this.log.info({ messageId, stepNumber }, "preparing step");
            const remaining =
              this.settings.maxSteps -
              (stepIndex -
                turnStartStepIndex -
                protocolFeedbackSteps -
                budgetFeedbackSteps -
                repeatedFailureFeedbackSteps);
            if (
              this.settings.agentMode === AgentMode.NATIVE &&
              [3, 1].includes(remaining) &&
              !budgetReminders.has(remaining)
            ) {
              budgetReminders.add(remaining);
              const content =
                remaining === 1
                  ? "1 model call remains in this turn. Use Answer as the sole action now, based on the results already received. State any unresolved limitation in the answer."
                  : "3 model calls remain in this turn. Reserve one for Answer. Batch any necessary edit, execute and retrieve; verify only unresolved questions. Answer now if the requested result is supported.";
              const feedbackId = this.generateStepId();
              // Append an immutable event rather than rewriting a prompt or
              // earlier frame: the preceding context remains a cacheable prefix.
              this.addStep({
                id: feedbackId,
                parentId: this.head,
                messageId,
                stepId: ++stepIndex,
                timestamp: Date.now(),
                role: "user",
                content,
                isBegin: false,
                isEnd: true,
                messageSource: "feedback",
              });
              this.head = feedbackId;
              budgetFeedbackSteps++;
            }
            let compilationResult: WorkflowCompilationResponse | null = null;
            if (this.workflowState.getAllOperators().length > 0) {
              try {
                const logicalPlan = this.workflowState.toLogicalPlan();
                compilationResult = await compileWorkflowAsync(logicalPlan, this.delegateConfig?.userToken, {
                  abortSignal: this.abortController?.signal,
                });
              } catch (e: any) {
                this.abortController?.signal.throwIfAborted();
                this.log.warn({ err: e?.message || e }, "compilation failed; proceeding without schemas");
              }
            }
            const compiled = Date.now();

            const visibleSteps = this.getVisibleReActSteps();
            // The assembler may be async (LLM context tuner). Await it here on the
            // prepareStep path; cache the rendered content for the sync preview.
            const processed = await budgetContextAssembler(
              this.contextAssembler,
              () => this.getSystemInfo(),
              this.modelInputBudget,
              value =>
                this.log.info({ messageId, inputBudget: this.modelInputBudget, ...value }, "full model input budget")
            )({
              visibleSteps,
              workflowState: this.workflowState,
              snapshotStorage: this.snapshotStorage,
              settings: this.settings,
              compilationResult,
              turnNumberByMessageId: this.turnNumberMap(),
              offBranchTurns: this.offBranchTurns(visibleSteps),
              taskHistory: this.settings.taskContext === "dependencies" ? this.archivedTaskHistory() : undefined,
            });
            lastPreparedMessages = processed;
            this.lastRenderedContext = processed
              .map(message => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
              .join("\n\n");
            requestedAt = Date.now();
            this.log.info(
              {
                messageId,
                stepNumber,
                compileMs: compiled - preparing,
                contextMs: requestedAt - compiled,
                contextChars: this.lastRenderedContext.length,
              },
              "requesting model"
            );
            return { messages: processed };
          },
          onStepFinish: async ({ text, reasoningText, toolCalls, toolResults, usage }) => {
            stepIndex++;
            for (const key of Object.keys(usage ?? {}) as (keyof TokenUsage)[]) {
              const value = usage?.[key];
              if (typeof value === "number" && Number.isFinite(value) && value >= 0)
                recordedUsage[key] = (recordedUsage[key] ?? 0) + value;
            }
            const finishing = Date.now();
            this.log.info(
              {
                messageId,
                stepIndex,
                modelMs: requestedAt ? finishing - requestedAt : undefined,
                toolCalls: toolCalls?.length ?? 0,
                outputTokens: usage?.outputTokens,
                text: !!text,
              },
              "model step finished"
            );

            // Some routes repeat one tool call within a response (Qwen on
            // DeepInfra returned 62 copies of one dataflow call, sometimes with
            // the reasoning reworded). Copies with the same actions are one
            // decision: keep the first call and its result, so the copies
            // neither run nor enter the replayed context.
            const seenInputs = new Set<string>();
            const keptCallIds = new Set<string>();
            const formattedToolCalls = toolCalls
              ?.filter(tc => {
                const input = tc.input as { actions?: unknown } | null | undefined;
                const decision = tc.toolName === TOOL_NAME_DATAFLOW && input?.actions !== undefined ? input.actions : input;
                const key = `${tc.toolName}\u0000${JSON.stringify(decision ?? null)}`;
                if (seenInputs.has(key)) return false;
                seenInputs.add(key);
                keptCallIds.add(tc.toolCallId);
                return true;
              })
              .map(tc => ({
                toolName: tc.toolName,
                toolCallId: tc.toolCallId,
                input: tc.input,
              }));
            const duplicateCalls = (toolCalls?.length ?? 0) - (formattedToolCalls?.length ?? 0);
            if (duplicateCalls > 0) this.log.info({ messageId, stepIndex, duplicateCalls }, "dropped duplicate tool calls");

            // Driver pre-computes isError using the `[ERROR] …` prefix + the
            // structured `{ error: … }` shape — passthrough is enough here.
            const formattedToolResults = toolResults
              ?.filter(tr => keptCallIds.has(tr.toolCallId))
              .map(tr => ({
                toolCallId: tr.toolCallId,
                output: tr.output,
                isError: tr.isError,
              }));

            const afterStepContent = this.workflowState.getWorkflowContent();

            const agentStepId = this.generateStepId();
            const agentStep: ReActStep = {
              id: agentStepId,
              parentId: this.head,
              messageId,
              stepId: stepIndex,
              timestamp: Date.now(),
              role: "agent",
              content: text || "",
              reasoningText: reasoningText || undefined,
              isBegin: isFirstStep,
              isEnd: false,
              toolCalls: formattedToolCalls,
              toolResults: formattedToolResults,
              operatorAccess: computeOperatorAccess(formattedToolCalls, formattedToolResults),
              usage: usage
                ? {
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    totalTokens: usage.totalTokens,
                    reasoningTokens: (usage as any).reasoningTokens,
                    cachedInputTokens: (usage as any).cachedInputTokens,
                    cacheCreationInputTokens: (usage as any).cacheCreationInputTokens,
                  }
                : undefined,
              inputMessages: lastPreparedMessages,
            };
            lastPreparedMessages = undefined;
            this.addStep(agentStep);
            this.head = agentStepId;
            // Snapshot iff the model emitted tool calls this step; thinking
            // turns and final summaries don't own a snapshot.
            this.maybeCreateSnapshotForHead(afterStepContent);

            await this.runPostStepExecution(formattedToolCalls, formattedToolResults);
            this.log.info({ messageId, stepIndex, postStepMs: Date.now() - finishing }, "post-step done");

            // Identical failures in a row spend the turn's budget on nothing:
            // one correction after two, and the turn ends after four. Counted
            // per model decision; a success, a different failure, or a changed
            // graph resets the streak.
            const failure =
              this.settings.agentMode === AgentMode.NATIVE
                ? repeatedFailure(agentStep, this.workflowState.getWorkflowContent())
                : undefined;
            failureStreak = failure && failure.signature === lastFailure?.signature ? failureStreak + 1 : failure ? 1 : 0;
            lastFailure = failure;
            if (failure && failureStreak === REPEATED_FAILURE_WARNING) {
              const feedbackId = this.generateStepId();
              this.addStep({
                id: feedbackId,
                parentId: this.head,
                messageId,
                stepId: ++stepIndex,
                timestamp: Date.now(),
                role: "user",
                content: repeatedFailureFeedback(failure, this.workflowState.getWorkflowContent()),
                isBegin: false,
                isEnd: true,
                messageSource: "feedback",
              });
              this.head = feedbackId;
              repeatedFailureFeedbackSteps++;
              this.log.info({ messageId, stepIndex, head: failure.head }, "recorded one repeated-failure correction");
            }

            isFirstStep = false;
          },
        });

      // A driver run that failed because a model request timed out or its
      // connection dropped is retried (ported from feat/state-registry
      // 4fbff96b5). The recorded steps stay: prepareStep rebuilds the context
      // from them, so the model continues where it stopped, and a retry only
      // gets the steps left in this turn's budget.
      const runDriverWithRetry = async (seed: ModelMessage[]) => {
        const partials: DriverRunTurnResult[] = [];
        for (let attempt = 0; ; ) {
          const stepsDone =
            stepIndex - turnStartStepIndex - protocolFeedbackSteps - budgetFeedbackSteps - repeatedFailureFeedbackSteps;
          try {
            const result = await runDriverOnce(seed, Math.max(1, this.settings.maxSteps - stepsDone));
            if (!partials.length) return result;
            const segments = [...partials, result];
            const keys = new Set(segments.flatMap(segment => Object.keys(segment.usage))) as Set<keyof TokenUsage>;
            return {
              ...result,
              messages: segments.flatMap(segment => segment.messages),
              usage: Object.fromEntries(
                [...keys].map(key => [key, segments.reduce((n, segment) => n + (segment.usage[key] ?? 0), 0)])
              ),
            };
          } catch (error) {
            if (
              error instanceof MissingAnswerActionError &&
              error.canContinue &&
              this.settings.agentMode === AgentMode.NATIVE &&
              !protocolFeedbackSteps &&
              !this.abortController?.signal.aborted
            ) {
              partials.push(error.partial);
              const feedback =
                "No Dataflow action was called. Continue through the dataflow tool. To finish, submit " +
                JSON.stringify({
                  reasoning: "Submit the supported result.",
                  actions: [{ type: "answer", content: "<answer in the user's required format>" }],
                }) +
                ". Put the final response in answer.content; Answer must be the sole action. Use other actions if more work is needed.";
              const feedbackId = this.generateStepId();
              this.addStep({
                id: feedbackId,
                parentId: this.head,
                messageId,
                stepId: ++stepIndex,
                timestamp: Date.now(),
                role: "user",
                content: feedback,
                isBegin: false,
                isEnd: true,
                messageSource: "feedback",
              });
              this.head = feedbackId;
              protocolFeedbackSteps++;
              seed = [{ role: "user", content: feedback }];
              this.log.info({ messageId }, "recorded one missing-action correction");
              continue;
            }
            if (
              this.abortController?.signal.aborted ||
              attempt >= MODEL_RETRIES_PER_TURN ||
              !isTransientModelError(error)
            )
              throw error;
            attempt++;
            this.log.warn(
              {
                messageId,
                attempt,
                stepsDone,
                err: error instanceof Error ? error.message : String(error),
              },
              "model request failed transiently; retrying the turn"
            );
            await new Promise(resolve => setTimeout(resolve, MODEL_RETRY_BACKOFF_MS() * attempt));
          }
        }
      };
      let result = await runDriverWithRetry(currentUserMessage);

      // ANSWER GROUNDING (opt-in): a final answer's numbers must trace to
      // materialized results or state recalled this turn — the property a
      // dataflow makes checkable that a notebook transcript does not. On total
      // failure, one feedback round: the nudge is recorded as a visible
      // feedback step (so the re-rendered context carries it) and the driver
      // runs once more. One round only — it either works or it will not.
      if (this.settings.enableAnswerGrounding && result.text) {
        for (let round = 0; round < GROUNDING_NUDGES_PER_TURN; round++) {
          const payload = finalAnswerPayload(result.text);
          if (!payload) break;
          const numbers = extractSubstantiveNumbers(payload);
          const pulls: string[] = [];
          for (const step of this.reActStepsByMessageId.get(messageId) ?? []) {
            for (const tr of step.toolResults ?? []) {
              if (typeof tr.output === "string") pulls.push(tr.output);
            }
          }
          const report = groundingReport(
            numbers,
            this.head ? this.snapshotStorage.getAllVisibleResults(this.head) : new Map(),
            pulls
          );
          if (!shouldNudge(report)) break;
          this.log.info(
            { unmatched: report.unmatched.slice(0, 5), messageId },
            "answer grounding failed; sending feedback round"
          );
          const nudge = buildGroundingNudge(report);
          const nudgeStepId = this.generateStepId();
          this.addStep({
            id: nudgeStepId,
            parentId: this.head,
            messageId,
            stepId: ++stepIndex,
            timestamp: Date.now(),
            role: "user",
            content: nudge,
            isBegin: false,
            isEnd: true,
            messageSource: "feedback",
          });
          this.head = nudgeStepId;
          this.nativeActionAnswer = undefined;
          result = await runDriverWithRetry([{ role: "user", content: nudge }]);
        }
      }

      const msgSteps = this.reActStepsByMessageId.get(messageId);
      if (msgSteps && msgSteps.length > 0) {
        const lastStep = msgSteps[msgSteps.length - 1];
        if (lastStep.role === "agent") {
          lastStep.isEnd = true;
        }
      }

      return {
        response: this.nativeActionAnswer ?? result.text,
        messages: result.messages,
        usage: result.usage,
        stopped: false,
      };
    } catch (error: any) {
      const isAborted = error.name === "AbortError" || this.abortController?.signal.aborted;

      if (isAborted) {
        stepIndex++;
        const stoppedStepId = this.generateStepId();
        const stoppedStep: ReActStep = {
          id: stoppedStepId,
          parentId: this.head,
          messageId,
          stepId: stepIndex,
          timestamp: Date.now(),
          role: "agent",
          content: "Generation stopped by user.",
          isBegin: false,
          isEnd: true,
        };
        this.addStep(stoppedStep);
        this.head = stoppedStepId;

        return {
          response: "",
          messages: [],
          usage: recordedUsage,
          stopped: true,
        };
      }

      stepIndex++;
      const errorStepId = this.generateStepId();
      const errorStep: ReActStep = {
        id: errorStepId,
        parentId: this.head,
        messageId,
        stepId: stepIndex,
        timestamp: Date.now(),
        role: "agent",
        content: `Error: ${error.message || String(error)}`,
        isBegin: false,
        isEnd: true,
      };
      this.addStep(errorStep);
      this.head = errorStepId;

      return {
        response: "",
        messages: [],
        usage: recordedUsage,
        stopped: false,
        error: error.message || String(error),
      };
    } finally {
      // The turn is over however it ended (answered, aborted, error): seal its
      // versions. A later turn referencing `X (turn N)` must get one fixed
      // definition, so the boundary — not the outcome — is what freezes it.
      this.closeVersionTurn();
      this.abortController = null;
      this.currentMessageId = undefined;
      this.state = AgentStateEnum.AVAILABLE;
    }
  }

  /**
   * Public preview of the next-step user-message content as a single string.
   *
   * Same `assembleContext` code path that `prepareStep` uses, but synchronous
   * — the workflow compiler is intentionally skipped because (a) the preview
   * is broadcast on every step / settings change and we don't want to fire a
   * compile on each frame, and (b) the schema lines are mode-gated to GENERAL
   * so missing them in the CODE-mode preview is a no-op. If a compile result
   * is needed for accuracy in GENERAL mode later, it can be plumbed through
   * with a small refactor.
   */
  getNextStepContext(): string {
    if (this.modelInputBudget.tokens > 0 && this.lastRenderedContext !== undefined) return this.lastRenderedContext;
    const visibleSteps = this.getVisibleReActSteps();
    const processed = this.contextAssembler({
      visibleSteps,
      workflowState: this.workflowState,
      snapshotStorage: this.snapshotStorage,
      settings: this.settings,
      compilationResult: null,
      turnNumberByMessageId: this.turnNumberMap(),
      offBranchTurns: this.offBranchTurns(visibleSteps),
      taskHistory: this.settings.taskContext === "dependencies" ? this.archivedTaskHistory() : undefined,
    });
    // An async assembler (LLM tuner) can't be awaited in this sync preview —
    // return the content last rendered on the prepareStep path.
    if (processed instanceof Promise) return this.lastRenderedContext ?? "";
    return processed
      .map(message => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
      .join("\n\n");
  }

  stop(): void {
    this.state = AgentStateEnum.STOPPING;
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  clearHistory(): void {
    this.nativeValidationRepair.clear();
    this.reActStepsByMessageId.clear();
    this.stepsById.clear();
    this.currentMessageId = undefined;
    this.head = undefined;
    this.snapshotStorage.clear();
  }

  /**
   * Rehydrate the agent from an exported archive `{ steps, snapshots? }`
   * (the JSON produced by the frontend Export button).
   *
   * Requirements / contract:
   * - `steps[]` may be in any order; parent links (`parentId`) define the tree.
   *   A `parentId` that doesn't match any step in the archive is dropped and
   *   the step becomes a root. This is the normal export shape: the synthetic
   *   `initialize` bootstrap step is excluded from every client-facing list,
   *   so the earliest exported step always references a parent that was never
   *   exported.
   * - `snapshots`: optional `Record<stepId, WorkflowContent>` — explicit
   *   per-step overrides. When provided for a step, that snapshot is loaded
   *   verbatim and replay is skipped for that step.
   * - Steps without explicit snapshots are reconstructed by *replaying* their
   *   workflow-CRUD tool calls against a clean `WorkflowState` rooted at the
   *   parent step's content. Replay is DFS-ordered so each step's snapshot is
   *   created after its parent's. Skipped tool names:
   *     - the synthetic `initialize` (no registered tool),
   *     - `executeOperator` (no workflow execution on import).
   *   Individual tool failures are logged and ignored; the original session
   *   may itself have produced error toolResults.
   * - Replay starts from an empty workflow when no parent snapshot exists,
   *   so a session that loaded a non-empty baseline at init will lose
   *   operators that were never touched by tool calls.
   * - HEAD is set to the deepest leaf on the longest chain (last by timestamp
   *   among nodes with no children). For a linear export this is the final
   *   step; for a branched export it picks the most-recently-extended branch.
   * - The workflow visible at HEAD via `snapshotStorage.getWorkflow(headId)`
   *   restores `workflowState` so the live DAG matches the loaded HEAD.
   * - Operator execution results are NOT in the export — the snapshot
   *   storage's results map stays empty until the user re-runs.
   *
   * Throws on structural problems (cycle, duplicate id) so a partial state
   * is never installed.
   */
  async importReActSteps(
    steps: ReActStep[],
    snapshots?: Record<string, WorkflowContent>
  ): Promise<{ headId: string; importedCount: number }> {
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error("import requires a non-empty steps array");
    }

    // Validate ids first; bail before mutating anything.
    const seenIds = new Set<string>();
    for (const s of steps) {
      if (!s || typeof s.id !== "string" || s.id.length === 0) {
        throw new Error("every step must have a non-empty 'id'");
      }
      if (seenIds.has(s.id)) throw new Error(`duplicate step id: ${s.id}`);
      seenIds.add(s.id);
    }
    // A parentId not present in the archive is dropped and the step becomes
    // a root. Exports never contain the synthetic `initialize` bootstrap step
    // (it is filtered from every client-facing list), so the earliest
    // exported step always carries a dangling parentId — replaying it from
    // the empty workflow is the documented root semantics.
    const knownParent = (pid: string | undefined): string | undefined =>
      pid !== undefined && seenIds.has(pid) ? pid : undefined;
    const orphans = steps.filter(s => s.parentId !== undefined && !seenIds.has(s.parentId));
    if (orphans.length > 0) {
      this.log.warn(
        { steps: orphans.map(s => ({ id: s.id, parentId: s.parentId })) },
        "import: parentId not in archive (the initialize root is never exported) — treating step as a root"
      );
    }

    // Build child adjacency. Roots (no surviving parent link) are listed
    // under the synthetic VIRTUAL_ROOT key only for traversal/cycle
    // bookkeeping — they never become real entries in `stepsById`.
    const VIRTUAL_ROOT = "__import_root__";
    const childrenOf = new Map<string, string[]>();
    for (const s of steps) {
      const key = knownParent(s.parentId) ?? VIRTUAL_ROOT;
      const arr = childrenOf.get(key) ?? [];
      arr.push(s.id);
      childrenOf.set(key, arr);
    }
    // Cycle / unreachable check: BFS from every root.
    const reachable = new Set<string>();
    const stack: string[] = [...(childrenOf.get(VIRTUAL_ROOT) ?? [])];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const c of childrenOf.get(id) ?? []) stack.push(c);
    }
    for (const s of steps) {
      if (!reachable.has(s.id)) {
        throw new Error(`step ${s.id} is not reachable from a root (cycle or detached subtree)`);
      }
    }

    // Normalize fields that the export may serialize as strings: `timestamp`
    // is exported as an ISO string but the in-memory type is `number` (epoch
    // ms). Coerce so downstream sorts and any consumer reading
    // step.timestamp behave correctly.
    const toEpochMs = (v: unknown): number => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string") {
        const parsed = Date.parse(v);
        if (Number.isFinite(parsed)) return parsed;
        const asNum = Number(v);
        if (Number.isFinite(asNum)) return asNum;
      }
      return 0;
    };

    // Reset state, then ingest in parent-before-child order so addStep's
    // bookkeeping always sees a known parent. BFS from the virtual root.
    this.clearHistory();
    const stepById = new Map<string, ReActStep>();
    for (const s of steps) {
      stepById.set(s.id, {
        ...s,
        parentId: knownParent(s.parentId),
        timestamp: toEpochMs(s.timestamp),
      });
    }
    const order: ReActStep[] = [];
    const queue: string[] = [...(childrenOf.get(VIRTUAL_ROOT) ?? [])];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const s = stepById.get(id);
      if (!s) continue;
      order.push(s);
      for (const c of childrenOf.get(id) ?? []) queue.push(c);
    }
    for (const s of order) this.addStep(s);

    // Reconstruct snapshots in DFS order: for each action-bearing step,
    // restore `workflowState` to its parent's content, replay the step's
    // workflow-CRUD tool calls (skipping `initialize` and `executeOperator`),
    // then snapshot the result. Explicit `snapshots[id]` overrides replay.
    // Per-operator results aren't in the export, so each restored snapshot
    // starts with whatever results its parent snapshot has (typically empty).
    //
    // Seed minimal schemas for the two code-mode operator types before
    // building the replay tools. Without this, `createOrModifyOperator`
    // replay errors out on every step when the agent service can't reach
    // its backend operator-metadata endpoint — and the imported workflow
    // ends up empty even though the snapshot *tree* structure is fine.
    // Backend-loaded metadata, if any, has already populated the store
    // and is left alone; the seed only fills in gaps.
    this.metadataStore.seedCodeModeDefaults();
    const replayTools = this.buildReplayTools();
    const explicitSnapshots = snapshots ?? {};
    type ReplayFrame = { id: string; parentContent: WorkflowContent };
    const frames: ReplayFrame[] = [];
    const emptyRoot = createEmptyWorkflowContent();
    for (const rootId of childrenOf.get(VIRTUAL_ROOT) ?? []) {
      frames.push({ id: rootId, parentContent: emptyRoot });
    }
    while (frames.length > 0) {
      const { id, parentContent } = frames.pop()!;
      const step = stepById.get(id)!;
      let myContent = parentContent;
      let ownsSnapshot = false;

      if (explicitSnapshots[id] !== undefined) {
        this.snapshotStorage.createSnapshot(id, explicitSnapshots[id]);
        myContent = explicitSnapshots[id];
        ownsSnapshot = true;
      } else if (step.toolCalls && step.toolCalls.length > 0) {
        this.workflowState.setWorkflowContent(parentContent);
        for (const tc of step.toolCalls) {
          if (tc.toolName === "initialize" || tc.toolName === TOOL_NAME_EXECUTE_OPERATOR) continue;
          const tool = replayTools[tc.toolName];
          if (!tool?.execute) {
            this.log.warn({ stepId: id, toolName: tc.toolName }, "import replay: unknown tool, skipped");
            continue;
          }
          try {
            if (tc.toolName === TOOL_NAME_DATAFLOW && Array.isArray(tc.input?.actions)) {
              const saved = asDataflowActionsResult(
                step.toolResults?.find(r => r.toolCallId === tc.toolCallId)?.output
              );
              // Replay recorded edits only. Never execute a saved workflow or
              // apply an action that the original run skipped after a failure.
              for (const item of saved?.actions ?? []) {
                if (item.status === "pending" || item.status === "skipped") break;
                if (item.action.type === "fork" && item.status === "ok") {
                  const plan = forkState(
                    this.workflowState.getWorkflowContent(),
                    this.snapshotStorage,
                    this.completedStateTasks(),
                    item.action.task_id,
                    item.action.operator_id,
                    item.action.new_operator_id
                  );
                  this.workflowState.setWorkflowContent(plan.workflow);
                } else if (item.action.type === "edit" && "changes" in item.action) {
                  if (item.status === "ok") {
                    if (saved?.protocol === "registered-python-v1") {
                      const plan = await planRegisteredGraphEdit(
                        this.workflowState.getWorkflowContent(),
                        item.action.python ?? "",
                        item.action.changes,
                        { metadataStore: this.metadataStore, settings: this.settings }
                      );
                      this.workflowState.setWorkflowContent(plan.workflow);
                      continue;
                    }
                    const { rest, versions } = splitVersionCommands(item.action.changes);
                    const tasks = this.completedStateTasks().filter(task =>
                      this.snapshotStorage.hasSnapshotFor(task.stepId)
                    );
                    const expanded: string[] = [];
                    for (const command of versions) {
                      const task = historicalTask(tasks, command.task);
                      if (command.as) {
                        this.workflowState.setWorkflowContent(
                          forkState(
                            this.workflowState.getWorkflowContent(),
                            this.snapshotStorage,
                            tasks,
                            task.taskId,
                            command.id,
                            command.as
                          ).workflow
                        );
                      } else {
                        expanded.push(
                          restoreAssignment(
                            this.snapshotStorage,
                            task,
                            this.workflowState.getWorkflowContent(),
                            command.id
                          ).assignment
                        );
                      }
                    }
                    const changes = [...expanded, rest].filter(text => text.trim()).join("\n");
                    const plan = changes
                      ? await planGraphEdit(this.workflowState.getWorkflowContent(), changes, {
                          metadataStore: this.metadataStore,
                          settings: this.settings,
                        })
                      : { workflow: this.workflowState.getWorkflowContent() };
                    this.workflowState.setWorkflowContent(plan.workflow);
                  }
                } else if ((item.action as { type: string }).type === "edit") {
                  const legacy = item.action as unknown as {
                    expressions?: string;
                    program?: string;
                    delete?: string[];
                  };
                  const landed = (item.output as { operators?: Array<{ status: string }> } | undefined)?.operators;
                  if (landed?.some(op => ["added", "modified", "deleted"].includes(op.status))) {
                    // Imported action traces may predate the expressions field.
                    const expressions = legacy.expressions ?? legacy.program;
                    await tool.execute({ edits: expressions, delete: legacy.delete });
                  }
                }
                if (item.status === "error") break;
              }
              continue;
            }
            await tool.execute(tc.input);
          } catch (err) {
            this.log.warn({ err, stepId: id, toolName: tc.toolName }, "import replay: tool threw, continuing");
          }
        }
        myContent = this.workflowState.getWorkflowContent();
        this.snapshotStorage.createSnapshot(id, myContent);
        ownsSnapshot = true;
      }

      const childContent = ownsSnapshot ? myContent : parentContent;
      for (const childId of childrenOf.get(id) ?? []) {
        frames.push({ id: childId, parentContent: childContent });
      }
    }

    // Populate per-operator results from each step's `inputMessages`.
    //
    // The live execution path fills `snapshot.results` via
    // `runPostStepExecution` immediately after a step's actions run. That
    // doesn't fire during import — without this pass the snapshot tree's
    // workflow is faithful but every snapshot's `results` map stays empty,
    // so callers (the dashboard, the agent's own context assembler if the
    // import is followed by `sendMessage`) see no operator state.
    //
    // The agent service's context assemblers already serialized that state
    // into each agent step's `inputMessages` content — the model literally
    // saw it. We parse those `Operator <id> (Type) / Result: …` blocks
    // and write the recovered `OperatorInfo` to the snapshot that the
    // context was rendered FROM, which is `getAssociatedSnapshot(step.parentId)`:
    //
    //   step S+1's inputMessages   describes state AT
    //                              ─────────────────────────────────────
    //                              the associated snapshot of S+1.parentId
    //                              (S+1's most recent action-bearing ancestor)
    //
    // Multiple later steps that share the same action-bearing ancestor
    // will each write into that ancestor's snapshot; later writes
    // overwrite earlier ones, which is exactly the freshness we want
    // (deeper traces saw more recent context). Operators not in the
    // target snapshot's workflow are skipped — the trace may mention an
    // id from a previous branch that the current path doesn't contain.
    for (const step of order) {
      if (!step.inputMessages || step.inputMessages.length === 0) continue;
      if (!step.parentId) continue;
      const target = this.snapshotStorage.getAssociatedSnapshot(step.parentId);
      const targetStepId = target.reactStepId;
      if (!targetStepId) continue; // empty root — no snapshot owner to write to
      const opsInTarget = new Set(target.workflow.operators.map(o => o.operatorID));
      for (const msg of step.inputMessages) {
        const content =
          typeof (msg as { content?: unknown })?.content === "string" ? (msg as { content: string }).content : "";
        if (!content) continue;
        let parsed: Map<string, ReturnType<typeof parseTraceContext> extends Map<infer _, infer V> ? V : never>;
        try {
          parsed = parseTraceContext(content);
        } catch (err) {
          this.log.warn({ err, stepId: step.id }, "import: failed to parse inputMessages, skipping");
          continue;
        }
        for (const [opId, parsedResult] of parsed) {
          if (!opsInTarget.has(opId)) continue;
          const info = parsedResultToOperatorInfo(parsedResult);
          if (!info) continue; // nothing usable — don't shadow an inherited entry
          try {
            this.snapshotStorage.setOperatorResult(targetStepId, opId, info);
          } catch (err) {
            this.log.warn({ err, stepId: targetStepId, opId }, "import: failed to set operator result, skipping");
          }
        }
      }
    }

    // Results above were attributed to each owning snapshot only. Cascade them
    // down the tree so descendant snapshots — including HEAD, whose owning
    // step is described by no later context — inherit ancestor results and
    // every checkout shows the operator state the model actually saw.
    this.snapshotStorage.propagateInheritedResults();

    // Pick HEAD: leaf with the latest timestamp on its branch.
    const leaves = order.filter(s => (childrenOf.get(s.id) ?? []).length === 0);
    if (leaves.length === 0) {
      throw new Error("import has no leaf steps (impossible after structure check)");
    }
    leaves.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    const headStep = leaves[0];
    this.head = headStep.id;

    // Restore workflow visible at HEAD. The storage's read is total — if
    // no action-bearing ancestor recorded one, we land on the empty
    // root's empty workflow.
    this.workflowState.setWorkflowContent(this.snapshotStorage.getWorkflow(headStep.id));
    this.nativeValidationRepair.clear();

    // Recompute stepCounter from the largest numeric segment in any imported
    // id of the form `step-<agentId>-<n>-<ts>`, so subsequent generateStepId()
    // calls don't collide with imported ids.
    const idPattern = new RegExp(`^step-${this.agentId}-(\\d+)-`);
    let maxN = 0;
    for (const s of order) {
      const m = s.id.match(idPattern);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > maxN) maxN = n;
      }
    }
    this.stepCounter = maxN;

    return { headId: this.head, importedCount: order.length };
  }

  // ============================================================================
  // Debug mode (bypass the LLM)
  // ============================================================================

  /**
   * Execute a single registered tool by name.
   * @throws if the tool isn't found or has no execute hook (the SDK's `tool()`
   * helper always sets one, so a missing execute means a misconfigured tool).
   */
  async executeTool(toolName: string, input: any): Promise<any> {
    const toolDef = this.tools[toolName];
    if (!toolDef) {
      throw new Error(`Tool '${toolName}' not found`);
    }
    if (!toolDef.execute) {
      throw new Error(`Tool '${toolName}' does not have an execute function`);
    }
    return await toolDef.execute(input);
  }

  /**
   * Run the post-step operator-execution batch for tool calls that just
   * modified the workflow. Skips when there's no execution config (no
   * delegate mode), when no tool call was an edit, or when every edit
   * returned an error.
   *
   * Batched semantics: every successful edit in this step contributes its
   * downstream sinks to a single `opsToViewResult` set, and we run **one**
   * `executeWorkflowAndPersist` call. The backend run materializes each sink
   * once, regardless of how many sibling edits in this turn share upstream
   * — replacing the previous per-sink loop that re-ran shared upstream once
   * per sink. Per-operator results (including any backend errors) land via
   * `onResult` and are persisted at the current HEAD.
   *
   * Used by both `sendMessage` (LLM path) and `handleDebugInput` (debug
   * path) so a Function(...) tool call has identical post-step behaviour to
   * an LLM-emitted one.
   */
  /**
   * LOADED STATE — materialize tables as the state in force before the
   * session's first request, without a model call. The edit program creates
   * the operators (typically one `scan` per saved table) and the batch
   * executes them; the step is recorded under its own message, marked
   * `synthetic: "state"`, so its snapshot and results are inherited by every
   * later step while nothing about it is rendered into the model's context or
   * counted as a task. Returns the action receipt.
   */
  /** Tasks completed before this conversation, declared with the loaded state. */
  private taskNumberOffset = 0;

  async seedState(changes: string, completedTasks = 0): Promise<DataflowActionsResult> {
    if (this.settings.agentMode !== AgentMode.NATIVE) throw new Error("seedState requires native mode");
    if (!Number.isInteger(completedTasks) || completedTasks < 0)
      throw new Error("completedTasks must be a non-negative integer");
    if (this.state !== AgentStateEnum.AVAILABLE) throw new Error(`agent is ${this.state}; seed state while it is idle`);
    // Loaded state defines task numbering and the system prompt for the whole
    // session, so it can only be loaded before the first request.
    if (this.turnOrder().length > 0)
      throw new Error("seed state before the first request; this session already has requests");
    const tool = this.tools[TOOL_NAME_DATAFLOW];
    if (!tool || typeof tool.execute !== "function") throw new Error("dataflow tool is not registered");
    this.abortController = new AbortController();
    this.nativeActionAnswer = undefined;
    this.state = AgentStateEnum.GENERATING;
    try {
      const messageId = `seed-state-${this.agentId}-${++this.messageCounter}-${Date.now()}`;
      this.currentMessageId = messageId;
      const stepId = this.generateStepId();
      const toolCallId = `call-${stepId}-state`;
      const input = {
        reasoning: "Load the tables in force from the completed tasks.",
        actions: [{ type: "edit", python: "", changes }, { type: "execute" }],
      };
      const output = (await tool.execute(input, { toolCallId, messages: [] })) as DataflowActionsResult;
      const toolCalls = [{ toolName: TOOL_NAME_DATAFLOW, toolCallId, input }];
      const toolResults = [{ toolCallId, output, isError: false }];
      const step: ReActStep = {
        id: stepId,
        parentId: this.head,
        messageId,
        stepId: 1,
        timestamp: Date.now(),
        role: "agent",
        content: "",
        isBegin: true,
        isEnd: false,
        toolCalls,
        toolResults,
        operatorAccess: computeOperatorAccess(toolCalls, toolResults),
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 },
        synthetic: "state",
      };
      this.addStep(step);
      this.head = stepId;
      this.maybeCreateSnapshotForHead(this.workflowState.getWorkflowContent());
      await this.runPostStepExecution(toolCalls, toolResults);
      this.taskNumberOffset = completedTasks;
      this.log.info(
        { messageId, status: output.status, operators: output.operators?.length ?? 0, completedTasks },
        "seedState: loaded state recorded"
      );
      return output;
    } finally {
      this.abortController = null;
      this.currentMessageId = undefined;
      this.state = AgentStateEnum.AVAILABLE;
    }
  }

  /**
   * SEEDED SOURCE ROOTS — materialize the DAG's roots before the first model
   * call of this turn. The scans of the task's listed files are the one part
   * of the dataflow the model cannot decide differently, so the service runs
   * them and records the result as an ordinary `dataflow` batch step: tool
   * call, tool result and captured observations, exactly what the model's own
   * opening scan step would have produced. Zero usage, `synthetic: "seed"`.
   * Returns true when a seed step was recorded.
   */
  private async seedSourceRoots(messageId: string, sources: readonly string[]): Promise<boolean> {
    if (this.settings.agentMode !== AgentMode.NATIVE) {
      this.log.warn({ messageId }, "seedSources ignored: requires native mode");
      return false;
    }
    const plan = planSeedSources(sources, this.settings.maxOperatorResultCharLimit);
    if (plan.operators.length === 0) {
      this.log.info({ messageId, skipped: plan.skipped }, "seedSources: nothing to seed");
      return false;
    }
    const tool = this.tools[TOOL_NAME_DATAFLOW];
    if (!tool || typeof tool.execute !== "function") return false;
    const stepId = this.generateStepId();
    const toolCallId = `call-${stepId}-seed`;
    const views = availableRetrievalViews(this.settings);
    const view = views.includes("sample_stats") ? "sample_stats" : views.includes("sample") ? "sample" : "full";
    const input = {
      reasoning: "Load the supplied source files.",
      actions: [
        { type: "edit", python: "", changes: plan.operators.map(registeredSeedStatement).join("\n") },
        { type: "execute" },
        { type: "retrieve", operator_ids: plan.observe, view },
      ],
    };
    let output: unknown;
    let isError = false;
    try {
      output = await tool.execute(input, { toolCallId, messages: [] });
    } catch (error: any) {
      output = `[ERROR] seed failed: ${error?.message ?? String(error)}`;
      isError = true;
    }
    const toolCalls = [{ toolName: TOOL_NAME_DATAFLOW, toolCallId, input }];
    const toolResults = [{ toolCallId, output, isError }];
    const afterStepContent = this.workflowState.getWorkflowContent();
    const step: ReActStep = {
      id: stepId,
      parentId: this.head,
      messageId,
      stepId: 1,
      timestamp: Date.now(),
      role: "agent",
      content: "",
      isBegin: true,
      isEnd: false,
      toolCalls,
      toolResults,
      operatorAccess: computeOperatorAccess(toolCalls, toolResults),
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 },
      synthetic: "seed",
    };
    this.addStep(step);
    this.head = stepId;
    this.maybeCreateSnapshotForHead(afterStepContent);
    await this.runPostStepExecution(toolCalls, toolResults, { maxChars: plan.perSourceChars });
    this.log.info(
      { messageId, seeded: plan.observe, skipped: plan.skipped, perSourceChars: plan.perSourceChars },
      "seeded source roots"
    );
    return true;
  }

  private async runPostStepExecution(
    toolCalls: ReadonlyArray<{ toolName: string; toolCallId: string; input: any }> | undefined,
    toolResults: ReadonlyArray<{ toolCallId: string; output: any; isError?: boolean }> | undefined,
    overrides?: { maxChars?: number }
  ): Promise<void> {
    const actions = (toolResults ?? []).map(tr => asDataflowActionsResult(tr.output)).filter(r => r !== undefined);
    if (actions.length && this.head) {
      const stepId = this.head;
      const previousTasks = this.archivedTaskHistory().filter(
        task => task.steps[0]?.messageId !== this.stepsById.get(stepId)?.messageId
      );
      // Several distinct dataflow calls in one response (Qwen splits one turn's
      // work into two or more calls) run in the order given, each with its own
      // receipt, as if their action lists had been sent as one call. Calls
      // after an answer are not run: the task ended there.
      if (actions.length > 1) this.log.info({ stepId, calls: actions.length }, "running several dataflow calls from one response in order");
      let answered = false;
      for (const result of actions) {
        if (answered) {
          result.status = "error";
          result.error = "Not run: an earlier dataflow call in this response answered the task.";
          for (const item of result.actions) {
            item.status = "skipped";
            item.output = result.error;
          }
          continue;
        }
        await executeDataflowActionBatch(result, {
          state: this.workflowState,
          storage: this.snapshotStorage,
          stepId,
          settings: {
            ...this.settings,
            maxOperatorResultCharLimit: overrides?.maxChars ?? this.settings.maxOperatorResultCharLimit,
          },
          context: {
            metadataStore: this.metadataStore,
            nativeValidationRepair: this.nativeValidationRepair,
            settings: this.settings,
          },
          execute: (operatorIds, onExecution) => this.executePostStepChanges([], [], true, operatorIds, onExecution),
          edited: ids => this.recordVersionsFor(ids),
          isCurrent: () => this.head === stepId && this.snapshotStorage.hasSnapshotFor(stepId),
          signal: this.abortController?.signal,
          historicalTasks: previousTasks,
          taskHistory: previousTasks,
          taskBaseStepId: this.taskBaseStepId(stepId),
          taskNumberOffset: this.taskNumberOffset,
          taskNumber: this.currentTaskNumber(stepId),
          loadedStepId: this.loadedStepId(),
          taskChanges: new Map(
            this.getVisibleReActSteps()
              .filter(step => step.messageId === this.stepsById.get(stepId)?.messageId)
              .flatMap(step =>
                (step.toolResults ?? []).flatMap(result =>
                  (asDataflowActionsResult(result.output)?.actions ?? [])
                    .filter(action => action.status === "ok" && action.action.type === "edit")
                    .flatMap(action =>
                      (
                        (action.output as { operator_blocks?: Array<{ id: string; state: string }> })
                          ?.operator_blocks ?? []
                      ).map(block => [block.id, block.state] as const)
                    )
                )
              )
          ),
          // Every request of the session so far, for the decimal rule an
          // answer composed from a table has to follow.
          requestTexts: this.getVisibleReActSteps()
            .filter(step => step.role === "user" && step.isBegin)
            .map(step => String(step.content ?? "")),
        });
        if (result.answer !== undefined) {
          this.nativeActionAnswer = result.answer;
          answered = true;
        }
      }
      const step = this.stepsById.get(stepId);
      if (step) {
        step.operatorAccess = computeOperatorAccess(step.toolCalls, step.toolResults);
        for (const tr of step.toolResults ?? []) {
          const result = asDataflowActionsResult(tr.output);
          if (result) tr.isError = result.status === "error";
        }
        if (this.nativeActionAnswer !== undefined) {
          step.content = this.nativeActionAnswer;
          step.isEnd = true;
        }
        this.stepCallback?.(step);
      }
      this.snapshotCallback?.(stepId, this.workflowState.getWorkflowContent());
      return;
    }
    const owningStepId = this.head;
    const owningSignal = this.abortController?.signal;
    const requested = batchObservedIds({ toolCalls, toolResults } as Pick<ReActStep, "toolCalls" | "toolResults">);
    // Capture exposure settings before awaiting the engine. Changing settings
    // while the request is in flight must not rewrite this event's selection.
    const options = {
      data: this.settings.dataEvidence,
      flow: this.settings.flowEvidence,
      maxChars: overrides?.maxChars ?? this.settings.maxOperatorResultCharLimit,
      maxRows: this.settings.maxResultRows,
    };
    await this.executePostStepChanges(toolCalls, toolResults);
    if (
      requested &&
      owningStepId &&
      this.head === owningStepId &&
      !owningSignal?.aborted &&
      this.settings.agentMode === AgentMode.NATIVE &&
      this.snapshotStorage.hasSnapshotFor(owningStepId)
    ) {
      for (const call of toolCalls ?? []) {
        if (call.toolName !== TOOL_NAME_DATAFLOW) continue;
        const batch = asNativeBatchResult(toolResults?.find(result => result.toolCallId === call.toolCallId)?.output);
        for (const outcome of batch?.operators ?? []) {
          if (outcome.status !== "error" && outcome.status !== "blocked") continue;
          const view = outcome.attempted;
          if (!view || !outcome.id) continue;
          const diagnostic = outcome.diagnostic ?? {
            version: 1 as const,
            operatorId: outcome.id,
            operatorRevision: view.revision!,
            code: outcome.status === "blocked" ? "UPSTREAM_FAILED" : "EDIT_REJECTED",
            stage: outcome.status === "blocked" ? ("dependency" as const) : ("validate" as const),
            message: outcome.message,
            hint: "Repair the rejected arguments/upstream dependency and resubmit; the DAG definition was not changed.",
            retryable: false,
          };
          const summary = this.snapshotStorage.captureNativeAttemptDiagnostic(
            owningStepId,
            {
              operatorID: outcome.id,
              operatorType: "DataProcessing",
              operatorVersion: "1",
              operatorProperties: {},
              inputPorts: [],
              outputPorts: [],
              showAdvanced: false,
              nativeOp: view,
            },
            "NATIVE_ERROR_V2:" + JSON.stringify(diagnostic)
          );
          outcome.diagnostic = summary.diagnostic;
          this.nativeValidationRepair.bind(
            outcome.op,
            { id: outcome.id, inputs: view.inputs, ...view.properties },
            summary
          );
          outcome.message = `${formatNativeDiagnostic(summary.diagnostic)}\nDiagnostic: ${summary.diagnosticId} (rejected edit; DAG definition unchanged)`;
        }
      }
      this.snapshotStorage.restoreNativeRejectedEdits(owningStepId);
      this.snapshotStorage.captureNativeObservations(owningStepId, requested, options);
    }
  }

  private async executePostStepChanges(
    toolCalls: ReadonlyArray<{ toolName: string; toolCallId: string; input: any }> | undefined,
    toolResults: ReadonlyArray<{ toolCallId: string; output: any; isError?: boolean }> | undefined,
    executeAll = false,
    operatorIds?: readonly string[],
    onExecution?: (run: ExecutionRunMetrics) => void
  ): Promise<void> {
    if (!toolCalls || !toolResults) return;

    // Collect every operator successfully edited in this step.
    const editedOpIds: string[] = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      const tr = toolResults.find(result => result.toolCallId === tc.toolCallId);
      if (!EXECUTE_AFTER_TOOLS.has(tc.toolName)) continue;
      if (tc.toolName === TOOL_NAME_DATAFLOW) {
        const batch = asNativeBatchResult(tr?.output);
        for (const outcome of batch?.operators ?? []) {
          if (outcome.status === "added" || outcome.status === "modified") editedOpIds.push(outcome.id);
        }
        continue;
      }
      if (tr?.isError) continue;
      const resultText = typeof tr?.output === "string" ? tr.output : String(tr?.output ?? "");
      if (resultText.startsWith("[ERROR]")) continue;
      const operatorId = (tc.input as any)?.operatorId;
      if (operatorId) editedOpIds.push(operatorId);
    }
    if (editedOpIds.length === 0 && !executeAll) return;
    if (this.head && this.settings.agentMode === AgentMode.NATIVE) {
      this.snapshotStorage.clearNativeRejectedEdits(this.head, editedOpIds);
    }
    const execConfig = this.buildExecutionConfig();
    if (!execConfig) {
      if (executeAll) throw new Error("Execution is unavailable: this agent has no backend workflow connection.");
      return;
    }

    // WRITE THROUGH TO THE VERSION STORE — every mode. The store is the only
    // place a version is a thing rather than an inference; recording here (on
    // the post-step path, after the write succeeded and the graph settled)
    // means `inputRefs` capture the wiring that actually landed.
    this.recordVersionsFor(editedOpIds);

    // Build the materialization set: every edited op AND every downstream sink
    // of every edited op. Including the edited op itself is critical for
    // parallel-mode batches: if the model creates `A` and `B` in the same turn
    // where `B` consumes `A`, by post-step time `A` already has `B` as a
    // descendant, so `getDownstreamSinks(A)` returns `[B]` only. Without
    // including `A` here, the backend would run `A` (because it's upstream of
    // `B`) but never materialize its result table — the renderer would then
    // omit `A`'s `Result:` block, and the model, seeing no result, would loop
    // trying to "fix" an operator that's actually working. In serial mode this
    // didn't surface because `A` was a sink at the moment of its own edit.
    const targets = new Set<string>();
    if (executeAll) {
      const operators = operatorIds
        ? this.workflowState.getSubDAGForTargets(operatorIds).operators
        : this.workflowState.getAllOperators();
      for (const op of operators) targets.add(op.operatorID);
    }
    for (const opId of editedOpIds) {
      targets.add(opId);
      if (this.settings.agentMode === AgentMode.NATIVE) {
        // Typed chains are long and every operator below an edit is a table the
        // render shows (or decides a shape from). Materialize all descendants,
        // not just the sinks — otherwise an upstream modify leaves the
        // intermediate blocks without a fresh Result (seen in the pilot).
        for (const down of this.workflowState.getDownstreamOperators(opId)) {
          targets.add(down);
        }
      } else {
        for (const sink of this.workflowState.getDownstreamSinks(opId)) {
          targets.add(sink);
        }
      }
    }
    // An aborted request can still finish remotely (or return after checkout).
    // Capture ownership now; never route its data/profiles/errors via a later HEAD.
    const owningStepId = this.head;
    const owningSignal = this.abortController?.signal;
    const stillOwned = () =>
      owningStepId !== undefined &&
      this.head === owningStepId &&
      !owningSignal?.aborted &&
      this.snapshotStorage.hasSnapshotFor(owningStepId);

    // A rejected edit never entered the DAG. Executing a later consumer across
    // it would silently use the last accepted definition instead of the model's
    // requested computation. Keep independent branches runnable, but require an
    // explicit accepted repair for each rejected root (including same-ID/same-code).
    const blocked = new Map<string, { root: string; revision: string }>();
    if (owningStepId && this.settings.agentMode === AgentMode.NATIVE) {
      const roots = new Map(
        Object.entries(this.snapshotStorage.getAssociatedSnapshot(owningStepId).nativeRejectedEdits ?? {}).map(
          ([id, summary]) => [id, summary.operatorRevision]
        )
      );
      for (const call of toolCalls) {
        if (call.toolName !== TOOL_NAME_DATAFLOW) continue;
        const batch = asNativeBatchResult(toolResults.find(result => result.toolCallId === call.toolCallId)?.output);
        for (const outcome of batch?.operators ?? []) {
          if (outcome.status !== "error" && outcome.status !== "blocked") continue;
          const revision = outcome.attempted?.revision;
          if (revision) roots.set(outcome.id, revision);
        }
      }
      for (const [root, revision] of roots) {
        for (const id of [root, ...this.workflowState.getDownstreamOperators(root)]) {
          if (targets.delete(id)) blocked.set(id, { root, revision });
        }
      }
    }
    const persistBlocked = () => {
      if (!stillOwned()) return;
      // Upstream-first writes: each error invalidates its descendants; writing
      // a downstream first and its parent last would erase the blocked receipt.
      const pending = new Map(blocked);
      while (pending.size) {
        const id =
          [...pending.keys()].find(
            id =>
              !this.workflowState
                .getAllLinks()
                .some(link => link.target.operatorID === id && pending.has(link.source.operatorID))
          ) ?? pending.keys().next().value!;
        const cause = pending.get(id)!;
        pending.delete(id);
        const op = this.workflowState.getOperator(id);
        if (!op?.nativeOp) continue;
        this.snapshotStorage.setOperatorResult(owningStepId!, id, {
          state: "Blocked",
          inputTuples: 0,
          outputTuples: 0,
          resultMode: "table",
          error:
            "NATIVE_ERROR_V2:" +
            JSON.stringify({
              version: 1,
              operatorId: id,
              operatorRevision: op.nativeOp.revision,
              code: "UPSTREAM_FAILED",
              stage: "dependency",
              message: `Not executed: ${cause.root} revision ${cause.revision} was rejected. Explicitly repair/resubmit that operator before using its downstream results.`,
            }),
        });
      }
    };
    if (targets.size === 0) {
      persistBlocked();
      return;
    }

    // One execution covers every edit in this step. `executeWorkflowAndPersist`
    // fires `onResult` for every operator that ran on the backend — including
    // ones reporting errors — so the snapshot at HEAD ends up consistent with
    // what the backend actually produced.
    // Which targets came back with an outcome — anything else after a failed
    // execution gets an explicit error entry below. An entry the engine never
    // finished (Uninitialized or Running, no error: its worker died) is not an
    // outcome, or the run's failure never reached the model.
    const produced = new Set<string>();
    const finished = (info: OperatorInfo) =>
      !!info.error || info.state === "Completed" || info.state === "CompletedFromCache";
    let failure: string | undefined;
    try {
      const outcome = await executeWorkflowAndPersist(this.workflowState, execConfig, {
        abortSignal: owningSignal,
        opsToViewResult: [...targets],
        onExecution: run => {
          if (stillOwned()) onExecution?.(run);
        },
        onResult: (opId, operatorInfo) => {
          if (!stillOwned()) return;
          if (finished(operatorInfo)) produced.add(opId);
          this.snapshotStorage.setOperatorResult(owningStepId!, opId, operatorInfo);
        },
      });
      if (outcome && outcome.success === false) {
        failure = outcome.errorText?.trim() || `execution ${outcome.state ?? "failed"}`;
      }
    } catch (e: any) {
      failure = e?.message || String(e);
      this.log.warn({ err: failure, targetCount: targets.size }, "post-step batched execution failed");
    }

    // SURFACE THE FAILURE. Without this the operator simply has no result, the
    // renderer prints `(not executed)`, and the model reads that as "my code
    // produced nothing" — then rewrites the operator under a new name, again
    // and again. Measured: one cyclic edge made every execution fail for 15
    // turns, and the agent burned 5 whole step budgets rewriting working code
    // because nothing ever told it the ENGINE was refusing the plan.
    if (failure && stillOwned()) {
      for (const opId of targets) {
        if (produced.has(opId)) continue;
        const existing = this.snapshotStorage.getOperatorResult(owningStepId!, opId);
        if (existing && !existing.error && finished(existing)) continue; // keep a real earlier result
        this.snapshotStorage.setOperatorResult(owningStepId!, opId, {
          operatorId: opId,
          state: "ExecutionFailed",
          inputTuples: 0,
          outputTuples: 0,
          resultMode: "error",
          error: `execution failed — ${failure}`,
        } as any);
      }
    }
    persistBlocked();
    if (executeAll && failure) throw new Error(failure);
  }

  /**
   * Find the messageId of the most recent ongoing user task on the HEAD
   * ancestor path. A task is "ongoing" if it contains a user step but no
   * agent step with isEnd=true. Returns undefined if no such task exists, or
   * if the most recent task is already completed (we don't reach back across
   * completion boundaries).
   *
   * Used by handleDebugInput so consecutive debug Function(...) actions
   * accumulate as Turn 1, 2, 3 of the user's open task instead of each
   * becoming its own one-step "completed" task.
   */
  private findOngoingUserTaskMessageId(): string | undefined {
    const visible = this.getVisibleReActSteps();
    const messageIds: string[] = [];
    const stepsByMessage = new Map<string, ReActStep[]>();
    for (const step of visible) {
      let group = stepsByMessage.get(step.messageId);
      if (!group) {
        group = [];
        stepsByMessage.set(step.messageId, group);
        messageIds.push(step.messageId);
      }
      group.push(step);
    }
    for (let i = messageIds.length - 1; i >= 0; i--) {
      const msgId = messageIds[i];
      const group = stepsByMessage.get(msgId)!;
      const hasAgentEnd = group.some(s => s.role === "agent" && s.isEnd);
      if (hasAgentEnd) return undefined;
      const hasUser = group.some(s => s.role === "user");
      if (hasUser) return msgId;
    }
    return undefined;
  }

  /**
   * Process a debug-mode input. Bypasses the LLM completely.
   *
   * - Plain text → starts a fresh task with one user `ReActStep`. Useful for
   *   recording context or notes without the model spending tokens on them.
   * - `Function(name='X', arguments='{...}')` → parsed by debug-parser and
   *   executed as a single tool call. Attaches to the most recent ongoing
   *   user task as the next turn (Turn 1, 2, 3, …) so consecutive debug
   *   actions don't fragment into separate one-step tasks. Post-step
   *   auto-execution runs identically to the LLM path.
   *
   * Tool execution and post-step execution happen exactly as they would after
   * an LLM-produced tool call — only the model call and the ReAct loop are skipped.
   */
  async handleDebugInput(
    content: string,
    messageSource?: "chat" | "feedback"
  ): Promise<{
    kind: "user_message" | "function_call";
    stopped: boolean;
    error?: string;
  }> {
    this.abortController = new AbortController();
    this.nativeActionAnswer = undefined;
    this.state = AgentStateEnum.GENERATING;

    try {
      // Plain user text → start a new task (fresh messageId, stepId 0).
      if (!looksLikeFunctionCall(content)) {
        this.nativeValidationRepair.clear();
        const messageId = `dbg-${this.agentId}-${++this.messageCounter}-${Date.now()}`;
        this.currentMessageId = messageId;

        const userStepId = this.generateStepId();
        const userStep: ReActStep = {
          id: userStepId,
          parentId: this.head,
          messageId,
          stepId: 0,
          timestamp: Date.now(),
          role: "user",
          content,
          isBegin: true,
          isEnd: true,
          messageSource,
        };
        this.addStep(userStep);
        this.head = userStepId;
        // No tool calls → no snapshot; reads resolve to the nearest
        // action-bearing ancestor.
        return { kind: "user_message", stopped: false };
      }

      // Function(...) → attach to the most recent ongoing user task as the
      // next turn. If no ongoing user task exists, start a fresh one. isEnd
      // stays false in debug mode — there's no model deciding "this turn is
      // final"; the task closes naturally when the user moves on.
      const attachedMessageId = this.findOngoingUserTaskMessageId();
      let messageId: string;
      let stepId: number;
      let isBegin: boolean;
      if (attachedMessageId) {
        messageId = attachedMessageId;
        const groupSteps = this.getVisibleReActSteps().filter(s => s.messageId === messageId);
        const maxStepId = groupSteps.reduce((m, s) => Math.max(m, s.stepId), -1);
        stepId = maxStepId + 1;
        isBegin = false;
      } else {
        messageId = `dbg-${this.agentId}-${++this.messageCounter}-${Date.now()}`;
        this.nativeValidationRepair.clear();
        stepId = 0;
        isBegin = true;
      }
      this.currentMessageId = messageId;

      let parsed;
      try {
        parsed = parseFunctionCall(content);
      } catch (e: any) {
        const message = `Failed to parse Function(...): ${e?.message || String(e)}`;
        const errorStepId = this.generateStepId();
        const errorStep: ReActStep = {
          id: errorStepId,
          parentId: this.head,
          messageId,
          stepId,
          timestamp: Date.now(),
          role: "agent",
          content: `[ERROR] ${message}`,
          isBegin,
          isEnd: false,
        };
        this.addStep(errorStep);
        this.head = errorStepId;
        // Parse-error step carries no tool calls → owns no snapshot.
        return { kind: "function_call", stopped: false, error: message };
      }

      const toolCallId = `dbg-tc-${this.stepCounter}-${Date.now()}`;
      let output: any;
      let isError = false;
      try {
        output = await this.executeTool(parsed.name, parsed.arguments);
      } catch (e: any) {
        output = `[ERROR] ${e?.message || String(e)}`;
        isError = true;
      }
      // Match sendMessage's error-detection convention.
      if (!isError) {
        if (typeof output === "string" && output.startsWith("[ERROR]")) isError = true;
        else if (output && typeof output === "object" && (output as any).error) isError = true;
      }

      const afterContent = this.workflowState.getWorkflowContent();

      const formattedToolCalls = [{ toolName: parsed.name, toolCallId, input: parsed.arguments }];
      const formattedToolResults = [{ toolCallId, output, isError }];

      const agentStepId = this.generateStepId();
      const agentStep: ReActStep = {
        id: agentStepId,
        parentId: this.head,
        messageId,
        stepId,
        timestamp: Date.now(),
        role: "agent",
        content: "",
        isBegin,
        isEnd: false,
        toolCalls: formattedToolCalls,
        toolResults: formattedToolResults,
        operatorAccess: computeOperatorAccess(formattedToolCalls, formattedToolResults),
      };
      this.addStep(agentStep);
      this.head = agentStepId;
      // Function(...) always carries a single tool call → snapshot every time.
      this.maybeCreateSnapshotForHead(afterContent);

      await this.runPostStepExecution(formattedToolCalls, formattedToolResults);

      return {
        kind: "function_call",
        stopped: false,
        error: asDataflowActionsResult(output)?.error ?? (isError ? String(output) : undefined),
      };
    } finally {
      this.abortController = null;
      this.currentMessageId = undefined;
      this.state = AgentStateEnum.AVAILABLE;
    }
  }

  private getOperatorIdsFromStep(step: ReActStep): {
    added: string[];
    modified: string[];
  } {
    // Prefer the access map recorded at step time; derive it for steps that
    // predate the field (imported archives, older persisted traces).
    const access = step.operatorAccess ?? computeOperatorAccess(step.toolCalls, step.toolResults);
    const added: string[] = [];
    const modified: string[] = [];
    if (!access) return { added, modified };
    for (const entry of Object.values(access)) {
      added.push(...entry.addedOperatorIds);
      modified.push(...entry.modifiedOperatorIds);
    }
    return { added, modified };
  }

  public getReActStepsByOperatorIds(operatorIds: string[]): ReActStep[] {
    const allSteps = this.getReActSteps();
    if (!operatorIds || operatorIds.length === 0) {
      return allSteps;
    }

    const operatorIdSet = new Set(operatorIds);
    const relevantSteps: ReActStep[] = [];

    for (const step of allSteps) {
      const { added, modified } = this.getOperatorIdsFromStep(step);

      const affectsOperator = [...added, ...modified].some(id => operatorIdSet.has(id));

      if (affectsOperator) {
        relevantSteps.push(step);
      }
    }

    return relevantSteps;
  }

  destroy(): void {
    if (this.workflowChangeSubscription) {
      this.workflowChangeSubscription.unsubscribe();
      this.workflowChangeSubscription = null;
    }

    this.workflowState.destroy();

    this.websockets.clear();

    this.reActStepsByMessageId.clear();
    this.stepsById.clear();
    this.currentMessageId = undefined;
  }
}
