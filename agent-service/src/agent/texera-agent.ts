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

import type { ModelMessage } from "ai";
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
} from "../types/agent";
import type { SummarizeParamsPatch } from "./context/summarize/params";
import type { SelectorConfig } from "./context/selector/selector";
import type { FrontierDecayConfig } from "./context/selector/frontier-decay";
import type { ProbeRetirementConfig } from "./context/selector/probe-retirement";
import type { RolePolicyConfig } from "./context/selector/role-policy";
import type { FoldResolvedRevisionsConfig } from "./context/select/revision-folds";
import type { LearnedConfig } from "./context/learned/score";
import type { TunerConfig } from "./context/tuner/tuner";
import type { OperatorInfo } from "../types/execution";
import {
  AgentMode,
  AgentState as AgentStateEnum,
  ContextMode,
  DEFAULT_AGENT_SETTINGS,
  OperatorResultSerializationMode,
} from "../types/agent";
import { buildCodeModeSystemPrompt, buildGeneralModeSystemPrompt } from "./prompts";
import { formatOperatorResult } from "./tools/result-formatting";

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
  createAddOperatorTool,
  createModifyOperatorTool,
  TOOL_NAME_ADD_OPERATOR,
  TOOL_NAME_MODIFY_OPERATOR,
} from "./tools/general-op-tools";
import { createCreateOrModifyOperatorTool, TOOL_NAME_CREATE_OR_MODIFY_OPERATOR } from "./tools/code-op-tools";
import { createInspectResultTool, TOOL_NAME_INSPECT_RESULT } from "./tools/inspect-result-tool";
import { createQueryResultTool, TOOL_NAME_QUERY_RESULT } from "./tools/query-result-tool";
import { createCompactContextTool, TOOL_NAME_COMPACT_CONTEXT } from "./tools/compact-context-tool";
import {
  createRecallStateTool,
  TOOL_NAME_RECALL_STATE,
  type RecalledTurn,
  type RecallVerb,
} from "./tools/recall-state-tool";
import {
  createResumeFromTool,
  TOOL_NAME_RESUME_FROM,
  WRITE_TOOL_NAMES,
} from "./tools/resume-from-tool";
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
  executeWorkflowAndPersist,
  TOOL_NAME_EXECUTE_OPERATOR,
  type ExecutionConfig,
} from "./tools/workflow-execution-tools";
import { compileWorkflowAsync, type WorkflowCompilationResponse } from "../api/compile-api";
import { createLogger } from "../logger";
import type { Logger } from "pino";
import { looksLikeFunctionCall, parseFunctionCall } from "./debug-parser";
import type { LLMDriver, ContextAssembler } from "./llm-drivers/types";
import { parseTraceContext, parsedResultToOperatorInfo } from "./util/parse-trace-results";

const PERSIST_DEBOUNCE_MS = 500;

/** Tool names whose successful invocation triggers post-step operator execution. */
const EXECUTE_AFTER_TOOLS: ReadonlySet<string> = new Set([
  TOOL_NAME_ADD_OPERATOR,
  TOOL_NAME_MODIFY_OPERATOR,
  TOOL_NAME_CREATE_OR_MODIFY_OPERATOR,
]);

/**
 * The layouts' own `# Your Task` directive, lifted verbatim out of a rendered
 * context so cache-aligned step messages can restate it.
 *
 * Verbatim on purpose: a second, hand-written wording would drift from the
 * renderer's and would silently confound any layout comparison. Returns
 * undefined for renders that have no such section (single-turn arms), in which
 * case step messages simply carry no reminder.
 */
export function extractYourTaskDirective(rendered: string): string | undefined {
  const start = rendered.lastIndexOf("\n# Your Task");
  if (start === -1) return undefined;
  const body = rendered.slice(start + 1);
  // The directive is the last H1 section; stop at a following H1 if one exists.
  const next = body.indexOf("\n# ", 1);
  return (next === -1 ? body : body.slice(0, next)).trimEnd();
}

/** Canonical "opId (turn N)" form of a version ref, tolerant of spacing. */
export function normalizeVersionRef(raw: string): string | undefined {
  const m = /^\s*(.+?)\s*\(\s*turn\s+(\d+)\s*\)\s*$/.exec(raw);
  return m ? `${m[1]} (turn ${m[2]})` : undefined;
}

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
  runResult: { success: boolean; state: string; opCount: number; errorCount: number; errorText?: string },
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
  private readonly systemPromptBuilder:
    | ((dialect: LocalToolDialect, contextMode: ContextMode, compactionEnabled: boolean) => string)
    | undefined;
  private systemPrompt: string;
  private settings: AgentSettings;

  private reActStepsByMessageId: Map<string, ReActStep[]> = new Map();

  private currentMessageId: string | undefined = undefined;
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
  /** Cache-aligned mode: this step's execution-result render, consumed by the
   *  next prepareStep as an appended message (append keeps the prefix cached). */
  private pendingStepResultsRender: string | undefined = undefined;
  /** Cache-aligned mode (v2): the message array we ship, built by US.
   *  `[0]` is the turn's full context render, frozen at step 1; every later
   *  entry is one appended user message describing the step that just ran.
   *  Each request is therefore the previous request plus one message, which
   *  is exactly the provider's cache-hit contract (probed: growth INSIDE a
   *  message caches nothing; appended messages cache everything before them,
   *  and the role does not matter). Reset per driver run. */
  private cacheAlignedMessages: ModelMessage[] = [];
  /** Versioned refs recalled/echoed THIS driver run — the upstream-value-echo
   *  bookkeeping. A write whose upstreams name a version in neither set gets
   *  that version's sample rows auto-attached to its observation. */
  private recalledRefsThisTurn: Set<string> = new Set();
  private echoedRefsThisTurn: Set<string> = new Set();
  /** The `# Your Task` reminder appended to every step message: under a frozen
   *  first message the live request would otherwise sit above the entire step
   *  log, which is the burial effect this benchmark already measured across
   *  turns — v1 reproduced it WITHIN a turn and lost ~5 accuracy points. */
  private cacheAlignedTaskReminder: string | undefined = undefined;

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
    this.snapshotStorage = new WorkflowSnapshotStorage(stepId => this.getAncestorPath(stepId));

    this.settings = {
      ...DEFAULT_AGENT_SETTINGS,
      systemPrompt: this.systemPrompt,
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
    } else if (this.settings.agentMode === AgentMode.GENERAL) {
      this.systemPrompt = buildGeneralModeSystemPrompt(this.metadataStore, this.settings.allowedOperatorTypes);
    } else {
      this.systemPrompt = buildCodeModeSystemPrompt(
        this.settings.contextMode,
        compactionEnabled,
        this.settings.enableInspectTool === true,
        this.settings.enableRenderPrefs === true,
        this.settings.enableCodeInSnapshot === true,
        this.settings.sourceProvenanceHint === true,
        this.settings.enableRecallTool === true,
        this.settings.enableResumeTool === true,
        this.settings.versionedMode === true,
        this.settings.sessionTurns === true,
        this.settings.recallOperatorLevel === true,
        this.settings.specAudit === true,
        this.settings.foundationVerify === true,
        this.settings.enableQueryTool === true,
        this.settings.answerShapeRule === true,
        this.settings.catalogDetail === "code",
        this.settings.valueProbeRule === true
      );
    }
    // W2: append worked per-step best-practice examples (few-shot). Examples,
    // not just the instruction (which got poor .copy() adherence). Off by default.
    if (this.settings.fewShotPrompt && this.settings.agentMode !== AgentMode.GENERAL && !this.systemPromptBuilder) {
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
      maxOperatorResultCharLimit: this.settings.maxOperatorResultCharLimit,
      maxOperatorResultCellCharLimit: this.settings.maxOperatorResultCellCharLimit,
      executionTimeoutMs: this.settings.executionTimeoutMs,
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
      settings: {
        maxOperatorResultCharLimit: this.settings.maxOperatorResultCharLimit,
        toolTimeoutMs: this.settings.toolTimeoutMs,
        executionTimeoutMs: this.settings.executionTimeoutMs,
      },
    };

    const tools: Record<string, any> = {
      [TOOL_NAME_DELETE_OPERATOR]: createDeleteOperatorTool(this.workflowState, context),
    };

    if (this.settings.agentMode === AgentMode.CODE) {
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
      tools[TOOL_NAME_ADD_OPERATOR] = createAddOperatorTool(this.workflowState, operatorSchemas, context);
      tools[TOOL_NAME_MODIFY_OPERATOR] = createModifyOperatorTool(this.workflowState, context);
    }

    // Opt-in read-only PULL tool (Direction B): lets the model re-inspect an
    // existing operator's cached result at more detail on demand. Reads the
    // result at the current HEAD; never mutates the DAG or re-executes.
    if (this.settings.enableInspectTool) {
      tools[TOOL_NAME_INSPECT_RESULT] = createInspectResultTool({
        getResult: (opId: string) => (this.head ? this.snapshotStorage.getOperatorResult(this.head, opId) : undefined),
        workflowState: this.workflowState,
      });
    }

    // Opt-in direct-query PULL tool: one read-only pandas expression over an
    // operator's materialized rows, evaluated in a sandboxed python subprocess.
    // Replaces probe-operator writes (engine executions) and the clipped-render
    // trap. Never mutates, never re-executes.
    if (this.settings.enableQueryTool) {
      tools[TOOL_NAME_QUERY_RESULT] = createQueryResultTool({
        getResult: (opId: string) => (this.head ? this.snapshotStorage.getOperatorResult(this.head, opId) : undefined),
        listOperators: () =>
          this.head
            ? [...this.snapshotStorage.getAllVisibleResults(this.head).keys()]
            : this.workflowState.getAllOperators().map(o => o.operatorID),
        getCurrentTurnKey: () => this.currentMessageId ?? "",
      });
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
   * for BOTH code and general modes so any exported session is replayable
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
      },
    };

    return {
      [TOOL_NAME_DELETE_OPERATOR]: createDeleteOperatorTool(this.workflowState, context),
      [TOOL_NAME_ADD_OPERATOR]: createAddOperatorTool(this.workflowState, operatorSchemas, context),
      [TOOL_NAME_MODIFY_OPERATOR]: createModifyOperatorTool(this.workflowState, context),
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

  /** messageId -> global turn number, for the renderer. */
  turnNumberMap(): Map<string, number> {
    const m = new Map<string, number>();
    this.turnOrder().forEach((id, i) => m.set(id, i + 1));
    return m;
  }

  /**
   * Turns that happened but are NOT ancestors of HEAD — the branches left
   * behind by a `resumeFrom`. They stay in the catalogue so the version tree
   * is navigable in both directions; without them, resuming to turn 8 would
   * hide turns 9..20 permanently.
   */
  offBranchTurns(
    visibleSteps: ReActStep[]
  ): Array<{ turn: number; request: string; answer?: string; operators: string[] }> {
    const onBranch = new Set(visibleSteps.map(s => s.messageId));
    const out: Array<{ turn: number; request: string; answer?: string; operators: string[] }> = [];
    this.turnOrder().forEach((msgId, i) => {
      if (onBranch.has(msgId)) return;
      const steps = this.reActStepsByMessageId.get(msgId) ?? [];
      const operators: string[] = [];
      for (const step of steps) {
        for (const call of step.toolCalls ?? []) {
          const opId = (call.input as any)?.operatorId;
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
        if (!WRITE_TOOL_NAMES.has(call.toolName)) continue;
        const opId = (call.input as any)?.operatorId;
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
    if (!baseStepId) return { ok: false, message: `Turn ${turn} recorded no steps to resume from.` };

    const userStep = mine.find(s => s.role === "user");
    if (!userStep) return { ok: false, message: "This turn has no request step to re-parent." };
    userStep.parentId = baseStepId;
    this.workflowState.setWorkflowContent(this.snapshotStorage.getWorkflow(baseStepId));

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
          out.push({ turn: t.turn, code: String(op?.operatorProperties?.code ?? "") });
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
            const opId = (call.input as any)?.operatorId;
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
          const opId = (call.input as any)?.operatorId;
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
      return { turn: turnNo, request, answer: endStep?.content, operators, verbs, workflow, results };
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
    tools: Array<{ name: string; description: string; inputSchema: any; enabled: boolean }>;
  } {
    const toolsInfo = Object.entries(this.tools).map(([name, toolDef]) => {
      const description = toolDef.description || "";
      const inputSchema = toolDef.parameters || {};
      const enabled = !this.settings.disabledTools.has(name);

      return {
        name,
        description,
        inputSchema,
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

  updateSettings(updates: {
    maxOperatorResultCharLimit?: number;
    maxOperatorResultCellCharLimit?: number;
    operatorResultSerializationMode?: OperatorResultSerializationMode;
    toolTimeoutMs?: number;
    executionTimeoutMs?: number;
    disabledTools?: Set<string>;
    maxSteps?: number;
    maxOperatorEdits?: number;
    allowedOperatorTypes?: string[];
    agentMode?: AgentMode;
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
    flowLevel?: number;
    dataLevel?: number;
    columnStats?: boolean;
    valueFormat?: boolean;
    dataHints?: boolean;
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
    coercionTelemetry?: boolean;
    rowLineage?: boolean;
    versionedMode?: boolean;
    versionedHeads?: boolean;
    sessionTurns?: boolean;
    recallMaxResultChars?: number;
    recallOperatorLevel?: boolean;
    specAudit?: boolean;
    foundationVerify?: boolean;
    enableQueryTool?: boolean;
    upstreamValueEcho?: boolean;
    answerShapeRule?: boolean;
    catalogDetail?: "ids" | "brief" | "schema" | "code";
    valueProbeRule?: boolean;
    indexThinObservations?: boolean;
    cacheAlignedContext?: boolean;
    tunerConfig?: TunerConfig | null;
  }): void {
    let promptNeedsRebuild = false;

    if (updates.maxOperatorResultCharLimit !== undefined) {
      this.settings.maxOperatorResultCharLimit = updates.maxOperatorResultCharLimit;
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
    if (updates.allowedOperatorTypes !== undefined) {
      this.settings.allowedOperatorTypes = updates.allowedOperatorTypes;
      promptNeedsRebuild = true;
    }
    if (updates.agentMode !== undefined && updates.agentMode !== this.settings.agentMode) {
      this.settings.agentMode = updates.agentMode;
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
    if (updates.includeOperatorProperties !== undefined) {
      this.settings.includeOperatorProperties = updates.includeOperatorProperties;
      // Pure render-time toggle — controls whether each operator's
      // `Properties:` line is emitted in the assembled snapshot (code
      // operators are always stripped regardless). Read at next assembly.
    }
    if (updates.flowLevel !== undefined) {
      this.settings.flowLevel = updates.flowLevel;
      // DECORATE flow facet ordinal level (CONTEXT-DESIGN §5). Expanded to the
      // flow rung flags by assembleContext via the rung catalog.
    }
    if (updates.dataLevel !== undefined) {
      this.settings.dataLevel = updates.dataLevel;
      // DECORATE data facet ordinal level (CONTEXT-DESIGN §5).
    }
    if (updates.columnStats !== undefined) {
      this.settings.columnStats = updates.columnStats;
      // Standalone Column Stats overlay (independent of dataLevel).
    }
    if (updates.valueFormat !== undefined) {
      this.settings.valueFormat = updates.valueFormat;
      // Standalone value-format-hints flag (data-derived family).
    }
    if (updates.dataHints !== undefined) {
      this.settings.dataHints = updates.dataHints;
      // Standalone structural Data-hints flag (data-derived family).
    }
    if (updates.maxResultRows !== undefined) {
      this.settings.maxResultRows = updates.maxResultRows;
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
      // Adds/removes the read-only inspectResult tool from the model's tool set
      // (createTools() below reads this and rebuilds). The code-mode prompt
      // carries a matching `## On-demand result inspection` section.
      this.settings.enableInspectTool = updates.enableInspectTool;
      promptNeedsRebuild = true;
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
    if (updates.enableResumeTool !== undefined) this.settings.enableResumeTool = updates.enableResumeTool;
    if (updates.enableAnswerGrounding !== undefined)
      this.settings.enableAnswerGrounding = updates.enableAnswerGrounding;
    if (updates.coercionTelemetry !== undefined) this.settings.coercionTelemetry = updates.coercionTelemetry;
    if (updates.rowLineage !== undefined) this.settings.rowLineage = updates.rowLineage;
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
    if (updates.recallOperatorLevel !== undefined && updates.recallOperatorLevel !== this.settings.recallOperatorLevel) {
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
    if (updates.foundationVerify !== undefined && updates.foundationVerify !== this.settings.foundationVerify) {
      // Prompt-only, like specAudit.
      this.settings.foundationVerify = updates.foundationVerify;
      promptNeedsRebuild = true;
    }
    if (updates.upstreamValueEcho !== undefined) this.settings.upstreamValueEcho = updates.upstreamValueEcho;
    if (updates.catalogDetail !== undefined && updates.catalogDetail !== this.settings.catalogDetail) {
      // Render knob, but "code" also carries a prompt fragment (the catalog
      // now shows code, and the recall guidance changes accordingly).
      this.settings.catalogDetail = updates.catalogDetail;
      promptNeedsRebuild = true;
    }
    if (updates.valueProbeRule !== undefined && updates.valueProbeRule !== this.settings.valueProbeRule) {
      // Prompt-only, like specAudit.
      this.settings.valueProbeRule = updates.valueProbeRule;
      promptNeedsRebuild = true;
    }
    if (updates.answerShapeRule !== undefined && updates.answerShapeRule !== this.settings.answerShapeRule) {
      // Prompt-only, like specAudit.
      this.settings.answerShapeRule = updates.answerShapeRule;
      promptNeedsRebuild = true;
    }
    if (updates.enableQueryTool !== undefined && updates.enableQueryTool !== this.settings.enableQueryTool) {
      // Tool set AND prompt fragment change together.
      this.settings.enableQueryTool = updates.enableQueryTool;
      this.tools = this.createTools();
      promptNeedsRebuild = true;
    }
    if (updates.indexThinObservations !== undefined) this.settings.indexThinObservations = updates.indexThinObservations;
    if (updates.cacheAlignedContext !== undefined) this.settings.cacheAlignedContext = updates.cacheAlignedContext;
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

    if (promptNeedsRebuild) {
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
    | { userToken: string; userInfo?: UserInfo; workflowId: number; workflowName?: string; computingUnitId?: number }
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

  async sendMessage(userMessage: string, messageSource?: "chat" | "feedback"): Promise<AgentMessageResult> {
    const messageId = `msg-${this.agentId}-${++this.messageCounter}-${Date.now()}`;
    let stepIndex = 0;

    await this.refreshWorkflowFromBackend();

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
      // User steps carry no tool calls and therefore own no snapshot — the
      // workflow visible here resolves to the nearest action-bearing
      // ancestor via `WorkflowSnapshotStorage.getAssociatedSnapshot`.

      let isFirstStep = true;
      let lastPreparedMessages: ModelMessage[] | undefined;

      // Pass only the current user turn; prepareStep rebuilds full context each step
      // (historical interactions + DAG + this message).
      const currentUserMessage: ModelMessage[] = [{ role: "user", content: userMessage }];
      const runDriverOnce = (seed: ModelMessage[]) => {
        // Cache-aligned bookkeeping is per driver run: a grounding rerun is a
        // fresh SDK loop, so its frozen entry 0 is re-rendered from scratch.
        this.cacheAlignedMessages = [];
        this.cacheAlignedTaskReminder = undefined;
        this.pendingStepResultsRender = undefined;
        this.recalledRefsThisTurn.clear();
        this.echoedRefsThisTurn.clear();
        return this.driver.runTurn({
        initialMessages: seed,
        systemPrompt: this.systemPrompt,
        tools: this.tools,
        maxSteps: this.settings.maxSteps,
        parallelToolCalls: this.settings.parallelToolCalls,
        toolDialect: this.settings.toolDialect,
        abortSignal: this.abortController?.signal,
        prepareStep: async ({ stepNumber, messages: currentMessages }) => {
          // CACHE-ALIGNED CONTEXT (v2). The provider serves a request from
          // cache only when it EXTENDS the previous request with APPENDED
          // messages, earlier ones byte-untouched — growth inside a message
          // caches nothing, and the message ROLE is irrelevant (all probed;
          // see AgentSettings.cacheAlignedContext). The legacy loop re-renders
          // everything into one fresh user message per step, which is exactly
          // the shape that can never hit.
          //
          // So WE own the array: entry 0 is this turn's full context render,
          // frozen at step 1; every later entry is one user message carrying
          // the step that just ran — our renderer's observations, not the
          // SDK's raw tool frames, so every knob (clamps, stats, lineage,
          // telemetry) applies exactly as in legacy — closed by the task
          // reminder, because under a frozen entry 0 the live request would
          // otherwise sit above the whole step log.
          //
          // LATEST is excluded: its context IS a per-step snapshot rebuild.
          const cacheAligned =
            this.settings.cacheAlignedContext && this.settings.contextMode !== ContextMode.LATEST;
          if (cacheAligned && stepNumber > 0 && this.cacheAlignedMessages.length > 0) {
            const stepBlock = this.buildCacheAlignedStepMessage(currentMessages);
            if (stepBlock) this.cacheAlignedMessages.push({ role: "user", content: stepBlock });
            // Trace fidelity: record what the model actually read this step.
            lastPreparedMessages = [...this.cacheAlignedMessages];
            return { messages: this.cacheAlignedMessages };
          }
          let compilationResult: WorkflowCompilationResponse | null = null;
          if (this.workflowState.getAllOperators().length > 0) {
            try {
              const logicalPlan = this.workflowState.toLogicalPlan();
              compilationResult = await compileWorkflowAsync(logicalPlan, this.delegateConfig?.userToken);
            } catch (e: any) {
              this.log.warn({ err: e?.message || e }, "compilation failed; proceeding without schemas");
            }
          }

          const visibleSteps = this.getVisibleReActSteps();
          // The assembler may be async (LLM context tuner). Await it here on the
          // prepareStep path; cache the rendered content for the sync preview.
          const processed = await this.contextAssembler({
            visibleSteps,
            workflowState: this.workflowState,
            snapshotStorage: this.snapshotStorage,
            settings: this.settings,
            compilationResult,
            turnNumberByMessageId: this.turnNumberMap(),
            offBranchTurns: this.offBranchTurns(visibleSteps),
          });
          lastPreparedMessages = processed;
          const firstContent = processed[0]?.content;
          this.lastRenderedContext = typeof firstContent === "string" ? firstContent : undefined;
          if (cacheAligned) {
            // Freeze this render as entry 0 for the rest of the turn, and lift
            // the layouts' own `# Your Task` directive out of it so each step
            // message can restate it verbatim (no second wording to maintain).
            this.cacheAlignedMessages = [...processed];
            this.cacheAlignedTaskReminder =
              typeof firstContent === "string" ? extractYourTaskDirective(firstContent) : undefined;
          }
          return { messages: processed };
        },
        onStepFinish: async ({ text, toolCalls, toolResults, usage }) => {
          stepIndex++;

          const formattedToolCalls = toolCalls?.map(tc => ({
            toolName: tc.toolName,
            toolCallId: tc.toolCallId,
            input: tc.input,
          }));

          // Driver pre-computes isError using the `[ERROR] …` prefix + the
          // structured `{ error: … }` shape — passthrough is enough here.
          const formattedToolResults = toolResults?.map(tr => ({
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
            isBegin: isFirstStep,
            isEnd: false,
            toolCalls: formattedToolCalls,
            toolResults: formattedToolResults,
            usage: usage
              ? {
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  totalTokens: usage.totalTokens,
                  reasoningTokens: (usage as any).reasoningTokens,
                  cachedInputTokens: (usage as any).cachedInputTokens,
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

          await this.runPostStepExecution(toolCalls, toolResults);

          // UPSTREAM VALUE ECHO bookkeeping + attach (versioned arms only).
          for (const tc of toolCalls ?? []) {
            if (tc.toolName === TOOL_NAME_RECALL_STATE) {
              const inp: any = tc.input ?? {};
              for (const r of [...(inp.refs ?? []), ...(inp.ref ? [inp.ref] : [])]) {
                const k = normalizeVersionRef(String(r));
                if (k) this.recalledRefsThisTurn.add(k);
              }
            }
          }
          const echo = this.buildUpstreamValueEcho(toolCalls);
          if (echo) {
            this.pendingStepResultsRender =
              (this.pendingStepResultsRender ? this.pendingStepResultsRender + "\n\n" : "") + echo;
          }

          isFirstStep = false;
        },
        });
      };

      let result = await runDriverOnce(currentUserMessage);

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
          result = await runDriverOnce([{ role: "user", content: nudge }]);
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
        response: result.text,
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
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
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
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
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
    const visibleSteps = this.getVisibleReActSteps();
    const processed = this.contextAssembler({
      visibleSteps,
      workflowState: this.workflowState,
      snapshotStorage: this.snapshotStorage,
      settings: this.settings,
      compilationResult: null,
      turnNumberByMessageId: this.turnNumberMap(),
      offBranchTurns: this.offBranchTurns(visibleSteps),
    });
    // An async assembler (LLM tuner) can't be awaited in this sync preview —
    // return the content last rendered on the prepareStep path.
    if (processed instanceof Promise) return this.lastRenderedContext ?? "";
    const first = processed[0];
    if (!first) return "";
    return typeof first.content === "string" ? first.content : JSON.stringify(first.content);
  }

  stop(): void {
    this.state = AgentStateEnum.STOPPING;
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  clearHistory(): void {
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
      stepById.set(s.id, { ...s, parentId: knownParent(s.parentId), timestamp: toEpochMs(s.timestamp) });
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
   * Cache-aligned mode: the ONE user message describing the step that just ran.
   *
   * Built from the SDK's newest assistant/tool frames plus this step's
   * execution-result render, then closed by the turn's own `# Your Task`
   * directive. Content parity with legacy is the requirement: legacy showed
   * each step's actions and observations through the next re-render, so this
   * message carries the same things — actions with their arguments, tool
   * outputs (recall pulls included, which is how they persist for the turn),
   * and the freshly executed results — and nothing legacy would not have
   * shown. Returns undefined when the step produced nothing to report.
   */
  private buildCacheAlignedStepMessage(currentMessages: readonly ModelMessage[]): string | undefined {
    const stepNo = this.cacheAlignedMessages.length; // entry 0 is the render
    const parts: string[] = [];

    // The SDK appends [assistant(with toolCalls), tool(results)] per step; take
    // the trailing pair(s) added since our last append.
    const tail: ModelMessage[] = [];
    for (let i = currentMessages.length - 1; i >= 0; i--) {
      const m = currentMessages[i];
      if (m.role !== "assistant" && m.role !== "tool") break;
      tail.unshift(m);
      if (tail.length >= 4) break;
    }
    const actions: string[] = [];
    const observations: string[] = [];
    for (const m of tail) {
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const part of m.content as any[]) {
          if (part?.type === "text" && part.text?.trim()) actions.push(part.text.trim());
          if (part?.type === "tool-call") {
            actions.push(`Action: ${part.toolName} ${JSON.stringify(part.input ?? {})}`);
          }
        }
      } else if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) {
        actions.push(m.content.trim());
      } else if (m.role === "tool" && Array.isArray(m.content)) {
        for (const part of m.content as any[]) {
          const out = part?.output;
          const text = typeof out === "string" ? out : (out?.value ?? out?.text ?? JSON.stringify(out ?? ""));
          if (text) observations.push(String(text));
        }
      }
    }
    if (actions.length) parts.push(actions.join("\n"));
    if (observations.length) parts.push(`Observation:\n${observations.join("\n\n")}`);
    if (this.pendingStepResultsRender) {
      parts.push(this.pendingStepResultsRender);
      this.pendingStepResultsRender = undefined;
    }
    if (parts.length === 0) return undefined;

    const head = `## Step ${stepNo}`;
    const reminder = this.cacheAlignedTaskReminder
      ? `\n\n${this.cacheAlignedTaskReminder}`
      : "";
    return `${head}\n${parts.join("\n\n")}${reminder}`;
  }

  /**
   * UPSTREAM VALUE ECHO: sample rows of every version this step WIRED without
   * having recalled it this turn — attached to the step's observation, never a
   * rejection. Exists because the read-before-you-wire discipline is ignored
   * under momentum: nfl t3 (top-10 r2) revised one operator nine times over an
   * unrecalled turn-2 table with a wrong denominator convention and lost ~30
   * dependent turns; the business campaign measured 17.5% of writes blind.
   * Requires cacheAlignedContext (rides the per-step append channel).
   */
  private buildUpstreamValueEcho(
    toolCalls: ReadonlyArray<{ toolName: string; toolCallId: string; input: any }> | undefined
  ): string | undefined {
    if (!this.settings.upstreamValueEcho || !toolCalls?.length) return undefined;
    // Collect unrecalled cross-turn refs first; only then pay for the turn log.
    const wanted: string[] = [];
    for (const tc of toolCalls) {
      if (tc.toolName !== TOOL_NAME_CREATE_OR_MODIFY_OPERATOR) continue;
      for (const raw of (tc.input?.upstreams ?? []) as unknown[]) {
        const key = normalizeVersionRef(String(raw));
        if (!key) continue;
        if (this.recalledRefsThisTurn.has(key) || this.echoedRefsThisTurn.has(key)) continue;
        if (!wanted.includes(key)) wanted.push(key);
      }
    }
    if (!wanted.length) return undefined;
    const turns = this.buildTurnLog();
    const byTurn = new Map(turns.map(t => [t.turn, t]));
    const blocks: string[] = [];
    for (const key of wanted.slice(0, 3)) {
      const m = /^(.+) \(turn (\d+)\)$/.exec(key)!;
      const info = byTurn.get(parseInt(m[2], 10))?.results?.get(m[1]);
      if (!info) continue; // current-turn or unmaterialized refs have no echo
      this.echoedRefsThisTurn.add(key);
      const rendered = formatOperatorResult(m[1], info, this.workflowState, {
        detail: "sample",
        schemaInResult: true,
        columnStats: false,
        coercionTelemetry: true,
        rowLineage: true,
        inputsInResult: false,
        maxResultChars: 800,
      });
      blocks.push(`### ${key} (auto-attached)\n${rendered}`);
    }
    if (!blocks.length) return undefined;
    return (
      "Upstream values — versions this step wired WITHOUT recalling first. Check the code you just " +
      "wrote against these actual values (columns, scales, populations); if it assumed differently, " +
      "revise it now rather than downstream:\n\n" + blocks.join("\n\n")
    );
  }

  private async runPostStepExecution(
    toolCalls: ReadonlyArray<{ toolName: string; toolCallId: string; input: any }> | undefined,
    toolResults: ReadonlyArray<{ toolCallId: string; output: any; isError?: boolean }> | undefined
  ): Promise<void> {
    const execConfig = this.buildExecutionConfig();
    if (!execConfig || !toolCalls || !toolResults) return;

    // Collect every operator successfully edited in this step.
    const editedOpIds: string[] = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      const tr = toolResults[i];
      if (!EXECUTE_AFTER_TOOLS.has(tc.toolName)) continue;
      if (tr?.isError) continue;
      const resultText = typeof tr?.output === "string" ? tr.output : String(tr?.output ?? "");
      if (resultText.startsWith("[ERROR]")) continue;
      const operatorId = (tc.input as any)?.operatorId;
      if (operatorId) editedOpIds.push(operatorId);
    }
    if (editedOpIds.length === 0) return;

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
    for (const opId of editedOpIds) {
      targets.add(opId);
      for (const sink of this.workflowState.getDownstreamSinks(opId)) {
        targets.add(sink);
      }
    }
    if (targets.size === 0) return;

    // One execution covers every edit in this step. `executeWorkflowAndPersist`
    // fires `onResult` for every operator that ran on the backend — including
    // ones reporting errors — so the snapshot at HEAD ends up consistent with
    // what the backend actually produced.
    // Which targets came back with a result — anything missing after a failed
    // execution gets an explicit error entry below.
    const produced = new Set<string>();
    let failure: string | undefined;
    try {
      const outcome = await executeWorkflowAndPersist(this.workflowState, execConfig, {
        abortSignal: this.abortController?.signal,
        opsToViewResult: [...targets],
        onResult: (opId, operatorInfo) => {
          produced.add(opId);
          if (this.head !== undefined) {
            this.snapshotStorage.setOperatorResult(this.head, opId, operatorInfo);
          }
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
    if (failure && this.head !== undefined) {
      for (const opId of targets) {
        if (produced.has(opId)) continue;
        const existing = this.snapshotStorage.getOperatorResult(this.head, opId);
        if (existing && !existing.error) continue; // keep a real earlier result
        this.snapshotStorage.setOperatorResult(this.head, opId, {
          operatorId: opId,
          state: "ExecutionFailed",
          inputTuples: 0,
          outputTuples: 0,
          resultMode: "error",
          error: `execution failed — ${failure}`,
        } as any);
      }
    }

    // CACHE-ALIGNED CONTEXT: under a frozen turn render nothing re-renders, so
    // this step's execution results must travel to the model as an appended
    // message — the next prepareStep picks this up. Same renderer and knobs as
    // every other result surface, so the observation channel stays identical
    // to the legacy per-step re-render.
    if (this.settings.cacheAlignedContext && this.head !== undefined) {
      const blocks: string[] = [];
      for (const opId of targets) {
        const info = this.snapshotStorage.getOperatorResult(this.head, opId);
        if (!info) continue;
        const rendered = formatOperatorResult(opId, info, this.workflowState, {
          detail: "sample",
          schemaInResult: true,
          columnStats: this.settings.columnStats,
          tableStructureHint: this.settings.dataLevel >= 2,
          coercionTelemetry: this.settings.coercionTelemetry,
          rowLineage: this.settings.rowLineage,
          inputsInResult: this.settings.rowLineage,
          maxResultChars: this.settings.maxOperatorResultCharLimit,
        });
        blocks.push(`## ${opId}\n${rendered}`);
      }
      if (blocks.length > 0) {
        this.pendingStepResultsRender =
          "Execution results for the operators this step touched:\n\n" + blocks.join("\n\n");
      }
    }
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
  ): Promise<{ kind: "user_message" | "function_call"; stopped: boolean; error?: string }> {
    this.abortController = new AbortController();
    this.state = AgentStateEnum.GENERATING;

    try {
      // Plain user text → start a new task (fresh messageId, stepId 0).
      if (!looksLikeFunctionCall(content)) {
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
      };
      this.addStep(agentStep);
      this.head = agentStepId;
      // Function(...) always carries a single tool call → snapshot every time.
      this.maybeCreateSnapshotForHead(afterContent);

      await this.runPostStepExecution(formattedToolCalls, formattedToolResults);

      return { kind: "function_call", stopped: false, error: isError ? String(output) : undefined };
    } finally {
      this.abortController = null;
      this.currentMessageId = undefined;
      this.state = AgentStateEnum.AVAILABLE;
    }
  }

  private getOperatorIdsFromStep(step: ReActStep): { added: string[]; modified: string[] } {
    const added: string[] = [];
    const modified: string[] = [];

    if (!step.toolResults) {
      return { added, modified };
    }

    for (const result of step.toolResults) {
      if (result.isError || !result.output) continue;

      const toolCall = step.toolCalls?.find(tc => tc.toolCallId === result.toolCallId);
      const toolName = toolCall?.toolName || "";

      const outputStr = typeof result.output === "string" ? result.output : JSON.stringify(result.output);

      const addedMatch = outputStr.match(/Added operator ([a-zA-Z0-9_-]+)/);
      if (addedMatch && (toolName === "addOperator" || toolName.toLowerCase().includes("add"))) {
        added.push(addedMatch[1]);
        continue;
      }

      const modifiedMatch = outputStr.match(/Operator ([a-zA-Z0-9_-]+) modified/);
      if (modifiedMatch && (toolName === "modifyOperator" || toolName.toLowerCase().includes("modify"))) {
        modified.push(modifiedMatch[1]);
        continue;
      }

      try {
        const output = JSON.parse(outputStr);
        if (output.operatorId) {
          if (toolName === "addOperator" || toolName === "addCodeOperator") {
            added.push(output.operatorId);
          } else if (toolName === "modifyOperator" || toolName === "modifyCodeOperator") {
            modified.push(output.operatorId);
          }
        }
      } catch {}
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
