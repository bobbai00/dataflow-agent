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

import { isDeepStrictEqual } from "node:util";
import { observationFormatPatch, type ObservationFormatOptions } from "./native/observation-format";
import { sessionRequests } from "./request-catalog";
import { renderTableContext, renderTaskCatalog } from "./table-context";

import { asSchema, type ModelMessage } from "ai";
import { readInputBudget, budgetContextAssembler } from "./llm-drivers/input-budget";
import { Subscription } from "rxjs";
import { debounceTime } from "rxjs/operators";
import { WorkflowState } from "./workflow-state";
import type { WorkflowContent } from "../types/workflow";
import { WorkflowSystemMetadata } from "./util/workflow-system-metadata";
import {
  WorkflowSnapshotStorage,
  type RestoredResult,
  type RestoredSnapshot,
  type VersionAction,
} from "./workflow-snapshot-storage";
import type {
  AgentDelegateConfig,
  AgentSettings,
  CompactionStrategy,
  LocalToolDialect,
  ReActStep,
  TokenUsage,
  UserActionInfo,
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
import type { TraceStore, TraceTurnEnd } from "../trace/trace-store";
import {
  AgentMode,
  AgentState as AgentStateEnum,
  ContextMode,
  DEFAULT_AGENT_SETTINGS,
  OperatorResultSerializationMode,
} from "../types/agent";
import { buildCodeModeSystemPrompt, withSessionInstructions } from "./prompts";

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
import { asNativeBatchResult, batchObservedIds, TOOL_NAME_DATAFLOW } from "./tools/native-batch-tools";
import { NativeCatalogSettingsError, validateNativeSettings } from "./native/settings";
import { formatNativeDiagnostic } from "./native/diagnostics";
import { requestFilePath } from "./native/turn-syntax";
import {
  REPEATED_FAILURE_LIMIT,
  REPEATED_FAILURE_WARNING,
  repeatedFailure,
  repeatedFailureError,
  repeatedFailureFeedback,
  type RepeatedFailure,
} from "./native/failure-loop";
import { writtenOperatorId } from "./util/context-utils";
import { withCurrentLayout } from "./util/auto-layout";
import { buildRegisteredNativeSystemPrompt } from "./prompts";
import { isTransientModelError } from "./llm-drivers/request-timeout";
import type { ResultSelection } from "../types/agent";
import { createCreateOrModifyOperatorTool, TOOL_NAME_CREATE_OR_MODIFY_OPERATOR } from "./tools/code-op-tools";
import { ToolCallScheduler } from "./tools/tool-call-scheduler";
import { asDataflowActionsResult, type DataflowActionsResult } from "./tools/dataflow-actions";
import { renderAnswer } from "./native/answer";
import { hasCurrentResult, namedOperatorIds, namedResultsFeedback } from "./native/named-results";
import { createDataflowTool, mergeDataflowCalls, prepareDataflowCall } from "./tools/turn-tool";
import { nativeAssignmentText } from "./native/catalog";
import {
  UserActionError,
  userActionCall,
  userActionContent,
  userActionRows,
  userActionVersion,
  restoreContent,
  type UserActionRequest,
} from "./user-actions";
import type { RetrievalSettings } from "../types/agent";
import { availableRetrievalViews, nativeResultTransportLimit } from "./native/retrieval";
import { executeDataflowActionBatch, type DataflowProgress } from "./tools/dataflow-action-runtime";
import { editVersions, planRegisteredGraphEdit } from "./tools/graph-edits";
import {
  executeWorkflowAndPersist,
  TOOL_NAME_EXECUTE_OPERATOR,
  type ExecutionConfig,
} from "./tools/workflow-execution-tools";
import { compileWorkflowAsync, type WorkflowCompilationResponse } from "../api/compile-api";
import { createLogger } from "../logger";
import type { Logger } from "pino";
import { looksLikeAgentInput, parseDebugInput, type DebugAgentInput } from "./debug-parser";
import {
  MissingAnswerActionError,
  type LLMDriver,
  type ContextAssembler,
  type DriverRunTurnResult,
} from "./llm-drivers/types";
import { parseTraceContext, parsedResultToOperatorInfo } from "./util/parse-trace-results";

const PERSIST_DEBOUNCE_MS = 500;

/** Code-mode tool names whose successful invocation triggers post-step operator
 * execution; a native `dataflow` call executes through its own statements. */
const EXECUTE_AFTER_TOOLS: ReadonlySet<string> = new Set([TOOL_NAME_CREATE_OR_MODIFY_OPERATOR]);

function createEmptyWorkflowContent(): WorkflowContent {
  return {
    operators: [],
    operatorPositions: {},
    links: [],
    commentBoxes: [],
    settings: { dataTransferBatchSize: 400 },
  };
}

/** The version a saved run or read made: an execution that ran (its output
 * lists outcomes; a rejected one is only an error message), or a read that
 * showed at least one result. */
function importedRequest(
  item: DataflowActionsResult["actions"][number],
  author: VersionAction["author"]
): VersionAction | undefined {
  const output = item.output as { operators?: unknown; results?: Array<{ status?: string; operator_id?: string }> };
  if (item.action.type === "execute" && Array.isArray(output?.operators))
    return { kind: "run", ...(item.action.operator_ids ? { operatorIds: [...item.action.operator_ids] } : {}), author };
  if (item.action.type !== "retrieve") return undefined;
  const shown = (output?.results ?? []).filter(entry => entry.status === "ok").map(entry => String(entry.operator_id));
  return shown.length ? { kind: "show", operatorIds: shown, author } : undefined;
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
  /** Where the agent's turns, steps, versions, executions and results are recorded as they happen. */
  trace?: TraceStore;
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
type ProgressCallback = (stepId: string, progress: DataflowProgress) => void;

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

/** The correction for a text reply when the answer is an answer statement. */
const ANSWER_STATEMENT_FEEDBACK =
  "That reply was text, so it was not taken as the answer: in this session the final answer is an answer statement. " +
  "Send it in a dataflow call: `answer <id>` returns that table, or `answer <key>=<id>, <key>=<id>` returns one object with a key per table, " +
  "rendered from the computed results as the JSON the request asks for.";

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
  /** Each step's children, in the order they were added (lastStepShowing, checkoutVersion). */
  private childStepIds: Map<string, string[]> = new Map();
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
  /**
   * Earlier requests (by global request number) a request's context shows,
   * when its sender chose them; requests without a choice show the whole
   * path. Kept per request, so each request's context stays what it was.
   */
  private contextRequestsByMessage = new Map<string, ReadonlySet<number>>();
  /**
   * The table context a request's sender asked for (sendMessage
   * `contextTables`), rendered once as the request starts. It is shown with
   * that request only: the request's stored text stays as it was sent.
   */
  private contextBlockByMessage = new Map<string, string>();
  /** The reply an answer statement rendered, by message (AgentSettings.answerStatement). */
  private answerByMessage = new Map<string, string>();

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
  private progressCallback: ProgressCallback | null = null;

  private messageCounter = 0;

  private tools: Record<string, any>;

  private abortController: AbortController | null = null;

  private workflowChangeSubscription: Subscription | null = null;

  private log: Logger;

  private trace?: TraceStore;

  constructor(config: TexeraAgentConfig) {
    this.trace = config.trace;
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
    this.snapshotStorage.listener = {
      onSnapshot: snapshot => this.trace?.snapshot(this.agentId, snapshot),
      onResult: (snapshot, operatorId, info) =>
        this.trace?.operatorResult({
          agentId: this.agentId,
          snapshotId: snapshot.id,
          stepId: snapshot.reactStepId,
          operatorId,
          info,
          at: Date.now(),
        }),
    };

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
          onExecution: run => this.trace?.execution({ agentId: this.agentId, run }),
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
    // child of the storage's empty root. It is v0, the dataflow the agent
    // starts from, even when that is empty.
    this.snapshotStorage.createSnapshot(stepId, workflowContent, { action: { kind: "start", author: "agent" } });
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
        dataEvidence: this.settings.dataEvidence === true,
        flowEvidence: this.settings.flowEvidence === true,
        operatorDoc: this.settings.operatorDoc === true,
        answerStatement: this.settings.answerStatement === true,
        retrievalViews: availableRetrievalViews(this.settings),
        fullResultCharLimit: this.settings.fullResultCharLimit,
        maxOperatorResultCharLimit: this.settings.maxOperatorResultCharLimit,
        maxResultRows: this.settings.maxResultRows,
        dataEvidenceCharLimit: this.settings.dataEvidenceCharLimit,
        flowEvidenceCharLimit: this.settings.flowEvidenceCharLimit,
        multiRequest: this.settings.multiRequest,
        catalogSource: this.settings.catalogSource,
        catalogRecent: this.settings.catalogRecent,
      });
    } else {
      this.systemPrompt = buildCodeModeSystemPrompt(
        this.settings.contextMode,
        compactionEnabled,
        false,
        this.settings.enableRenderPrefs === true,
        this.settings.enableCodeInSnapshot === true,
        this.settings.sourceProvenanceHint === true
      );
    }
    // W2: append worked per-step best-practice examples (few-shot). Examples,
    // not just the instruction (which got poor .copy() adherence). Off by default.
    if (this.settings.fewShotPrompt && this.settings.agentMode === AgentMode.CODE && !this.systemPromptBuilder) {
      this.systemPrompt += FEW_SHOT_BEST_PRACTICES;
    }
    this.systemPrompt = withSessionInstructions(this.systemPrompt, this.settings.instructions);
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
      settings: {
        maxOperatorResultCharLimit: this.settings.maxOperatorResultCharLimit,
        toolTimeoutMs: this.settings.toolTimeoutMs,
        executionTimeoutMs: this.settings.executionTimeoutMs,
        nativeProfileCollection: this.settings.nativeProfileCollection,
        nativeProfileScope: this.settings.nativeProfileScope,
        nativeChecks: this.settings.nativeChecks === true,
        flowEvidence: this.settings.flowEvidence === true,
        dataHygiene: this.settings.dataHygiene === true,
        pandasRound: this.settings.pandasRound === true,
        operatorDoc: this.settings.operatorDoc === true,
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
        this.isCodeShownToAgent()
      );
    } else {
      tools[TOOL_NAME_DATAFLOW] = createDataflowTool(
        availableRetrievalViews(this.settings),
        this.settings.answerStatement === true,
        this.settings.optionalPython === true
      );
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
   * Build a tool registry for `importReActSteps` replay: the code-mode CRUD
   * tools. Native `dataflow` calls replay the edits recorded in their saved
   * results instead. No scheduler wrapping; the replay loop awaits each call.
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
        nativeProfileCollection: this.settings.nativeProfileCollection,
        nativeProfileScope: this.settings.nativeProfileScope,
        nativeChecks: this.settings.nativeChecks === true,
        flowEvidence: this.settings.flowEvidence === true,
        dataHygiene: this.settings.dataHygiene === true,
        pandasRound: this.settings.pandasRound === true,
        operatorDoc: this.settings.operatorDoc === true,
      },
    };

    return {
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
    for (let current: string | undefined = target; current; current = this.stepsById.get(current)?.parentId)
      chain.push(current);
    return chain.reverse();
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
   * The steps the model's context is built from: the visible path, less the
   * earlier requests the current request's sender left out of its context
   * (sendMessage `contextRequests`). The bootstrap step and the current
   * request always stay. Each step renders from its own snapshot, so leaving
   * requests out changes nothing about the ones kept.
   */
  private contextSteps(): ReActStep[] {
    const steps = this.getVisibleReActSteps();
    const current = steps[steps.length - 1]?.messageId;
    const chosen = current ? this.contextRequestsByMessage.get(current) : undefined;
    if (!chosen) return steps;
    const numbers = this.turnNumberMap();
    const block = current ? this.contextBlockByMessage.get(current) : undefined;
    return steps
      .filter(
        step =>
          TexeraAgent.isInitializationStep(step) ||
          step.messageId === current ||
          chosen.has(numbers.get(step.messageId) ?? -1)
      )
      .map(step =>
        // The block goes before the current request's own text, in this context only.
        block && step.messageId === current && step.role === "user" && step.isBegin
          ? { ...step, content: `${block}\n\n${step.content}` }
          : step
      );
  }

  /**
   * GLOBAL turn order: the messageIds of every turn ever asked, in the order
   * they were asked, with the synthetic `initialize` bootstrap excluded.
   *
   * Numbering must not depend on the current branch: after a checkout, turns on
   * abandoned branches are no longer ancestors of HEAD, so numbering by path
   * position would renumber everything. `stepsById` is a Map, so its insertion
   * order is creation order, which is exactly the ask order.
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

  getCurrentMessageId(): string | undefined {
    return this.currentMessageId;
  }

  /** messageId -> global turn number, for the renderer. */
  turnNumberMap(): Map<string, number> {
    const m = new Map<string, number>();
    this.turnOrder().forEach((id, i) => m.set(id, i + 1));
    return m;
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
    const snapshot = this.snapshotStorage.getAssociatedSnapshot(stepId);
    this.workflowState.setWorkflowContent(snapshot.workflow);
    this.snapshotStorage.compact(snapshot.id);
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

  /**
   * Subscribe to the versions a running `dataflow` call records, action by
   * action (DataflowActionRuntime.onProgress): the websocket layer streams
   * them so clients show each edit, run and show as it happens.
   */
  setProgressCallback(callback: ProgressCallback | null): void {
    this.progressCallback = callback;
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
    if (step.parentId !== undefined) {
      const siblings = this.childStepIds.get(step.parentId);
      if (siblings) siblings.push(step.id);
      else this.childStepIds.set(step.parentId, [step.id]);
    }
    // The step before this one is done: results off its path can go to disk.
    this.snapshotStorage.compact(this.snapshotStorage.getAssociatedSnapshot(step.parentId).id);
    this.trace?.step(this.agentId, step);
    if (this.stepCallback) {
      this.stepCallback(step);
    }
  }

  /** The reply a turn ended with: its last agent step's text, if any. */
  private replyOf(messageId: string): string | undefined {
    const steps = this.reActStepsByMessageId.get(messageId) ?? [];
    return [...steps].reverse().find(step => step.role === "agent" && step.content.trim())?.content;
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
      operatorDoc?: boolean;
      respondToCanvasRuns?: boolean;
      instructions?: string;
      answerStatement?: boolean;
      nativeChecks?: boolean;
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
      staticCompaction?: boolean;
      userTaskPlacement?: "top" | "bottom";
      messageLayout?: AgentSettings["messageLayout"];
      tunerConfig?: TunerConfig | null;
      multiRequest?: AgentSettings["multiRequest"];
      catalogSource?: AgentSettings["catalogSource"];
      catalogRecent?: AgentSettings["catalogRecent"];
    } & RetrievalSettings &
      ObservationFormatOptions
  ): void {
    // Validate the effective combination before mutating ANY setting. In
    // particular a rejected mode change must not leave the prompt/tools split.
    validateNativeSettings(updates);
    // Anthropic's strict tool mode accepts a field that is not required; OpenAI's
    // rejects every request whose schema leaves one out.
    if (updates.optionalPython === true && !this.modelType.startsWith("claude"))
      throw new NativeCatalogSettingsError(
        `optionalPython needs a Claude model: strict tool schemas for ${this.modelType} must require every field.`
      );
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
    // The system prompt and the layout of earlier requests depend on these,
    // so they are decided before the first request and kept for the session.
    const sessionLayout = ["multiRequest", "catalogSource", "catalogRecent"] as const;
    for (const key of sessionLayout)
      if (updates[key] !== undefined && updates[key] !== this.settings[key] && this.turnOrder().length > 0)
        throw new NativeCatalogSettingsError(`${key} is decided before the first request of a session`);
    let promptNeedsRebuild = false;
    if (updates.multiRequest !== undefined && updates.multiRequest !== this.settings.multiRequest) {
      this.settings.multiRequest = updates.multiRequest;
      promptNeedsRebuild = true;
    }
    if (updates.catalogSource !== undefined && updates.catalogSource !== this.settings.catalogSource) {
      this.settings.catalogSource = updates.catalogSource;
      promptNeedsRebuild = true;
    }
    if (updates.catalogRecent !== undefined && updates.catalogRecent !== this.settings.catalogRecent) {
      this.settings.catalogRecent = updates.catalogRecent;
      promptNeedsRebuild = true;
    }
    const formatUpdates = observationFormatPatch(updates);
    if (Object.keys(formatUpdates).length) {
      Object.assign(this.settings, formatUpdates);
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
    // The native prompt asks for operator docs and shows them in its examples.
    if (updates.operatorDoc !== undefined && updates.operatorDoc !== this.settings.operatorDoc) {
      this.settings.operatorDoc = updates.operatorDoc;
      promptNeedsRebuild = true;
    }
    if (updates.nativeChecks !== undefined && updates.nativeChecks !== this.settings.nativeChecks) {
      this.settings.nativeChecks = updates.nativeChecks;
      promptNeedsRebuild = true;
    }
    if (updates.respondToCanvasRuns !== undefined) this.settings.respondToCanvasRuns = updates.respondToCanvasRuns;
    if (updates.instructions !== undefined && updates.instructions !== this.settings.instructions) {
      this.settings.instructions = updates.instructions;
      promptNeedsRebuild = true;
    }
    if (updates.answerStatement !== undefined && updates.answerStatement !== this.settings.answerStatement) {
      this.settings.answerStatement = updates.answerStatement;
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
    if (this.settings.agentMode === AgentMode.NATIVE) this.settings.parallelToolCalls = false;
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
    if (updates.staticCompaction !== undefined) {
      this.settings.staticCompaction = updates.staticCompaction;
    }
    if (updates.userTaskPlacement !== undefined) {
      // Pure render-time: where the `# User Task` block goes.
      this.settings.userTaskPlacement = updates.userTaskPlacement;
    }
    if (updates.messageLayout !== undefined && updates.messageLayout !== this.settings.messageLayout) {
      this.settings.messageLayout = updates.messageLayout;
      if (this.settings.agentMode === AgentMode.NATIVE) {
        promptNeedsRebuild = true;
      }
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
    messageSource?: "chat" | "feedback" | "action",
    options: {
      contextRequests?: readonly number[];
      contextTables?: readonly string[];
      contextUpstream?: boolean;
      contextTasks?: readonly number[];
      /** A recorded canvas action this turn responds to; no new message is recorded. */
      respondTo?: ReActStep;
    } = {}
  ): Promise<AgentMessageResult> {
    const messageId = options.respondTo?.messageId ?? `msg-${this.agentId}-${++this.messageCounter}-${Date.now()}`;
    // A turn answering a recorded canvas action keeps that action's turn.
    this.trace?.turnStarted({
      agentId: this.agentId,
      messageId,
      channel: options.respondTo ? "action" : "message",
      source: messageSource ?? "chat",
      text: userMessage,
      startedAt: Date.now(),
    });
    let turnEnd: Pick<TraceTurnEnd, "status" | "error"> = { status: "ok" };
    if (options.contextRequests) this.contextRequestsByMessage.set(messageId, new Set(options.contextRequests));
    let stepIndex = 0;
    // Failed/stopped turns still consumed model responses. Preserve their
    // reported usage; absent provider fields remain unknown rather than zero.
    const recordedUsage: TokenUsage = {};

    await this.refreshWorkflowFromBackend();

    if (options.contextTables || options.contextTasks) {
      // No earlier request stays in view; one block, rendered now from the
      // graph, stands for them: the earlier tasks with the ones the request
      // builds on in detail, or the earlier tables with the named ones in full.
      const earlier = sessionRequests(
        this.getVisibleReActSteps().filter(step => !TexeraAgent.isInitializationStep(step)),
        this.turnNumberMap()
      );
      const block = options.contextTables
        ? renderTableContext({
            storage: this.snapshotStorage,
            requests: earlier,
            head: this.head,
            tables: options.contextTables,
            upstream: options.contextUpstream,
            options: observationFormatPatch(this.settings),
          })
        : renderTaskCatalog({
            storage: this.snapshotStorage,
            requests: earlier,
            head: this.head,
            tasks: options.contextTasks!,
            options: observationFormatPatch(this.settings),
          });
      this.contextBlockByMessage.set(messageId, block);
      this.contextRequestsByMessage.set(messageId, new Set());
    }

    this.abortController = new AbortController();

    this.state = AgentStateEnum.GENERATING;

    this.currentMessageId = messageId;

    try {
      if (!options.respondTo) {
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
      }
      if (this.settings.agentMode === AgentMode.NATIVE) this.rebuildSystemPrompt();
      // User steps carry no tool calls and therefore own no snapshot — the
      // workflow visible here resolves to the nearest action-bearing
      // ancestor via `WorkflowSnapshotStorage.getAssociatedSnapshot`.

      let isFirstStep = stepIndex === 0;
      let lastPreparedMessages: ModelMessage[] | undefined;

      // Pass only the current user turn; prepareStep rebuilds full context each step
      // (historical interactions + DAG + this message).
      const currentUserMessage: ModelMessage[] = [{ role: "user", content: userMessage }];
      // Step lifecycle logs (ported from feat/state-registry cc16aedf4) place a
      // stall: preparing / requesting model / model step finished / post-step done,
      // each with its duration.
      let requestedAt = 0;
      let preparedAt = 0;
      let compiledAt = 0;
      const turnStartStepIndex = stepIndex;
      let protocolFeedbackSteps = 0;
      let budgetFeedbackSteps = 0;
      let repeatedFailureFeedbackSteps = 0;
      // A text reply where the answer is an answer statement is sent back once.
      let answerCorrected = false;
      // So is a reply naming tables that still have no result after the agent computed them.
      let namedResultsCorrected = false;
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
          requireShownResult: this.settings.agentMode === AgentMode.NATIVE,
          resultShown: () => this.resultShownFor(messageId),
          ...(this.settings.answerStatement === true
            ? {
                answered: () => this.answerByMessage.has(messageId),
                // Sent back only while a correction is left; otherwise a reply stands as before.
                answerByStatement: !answerCorrected && protocolFeedbackSteps < 2,
              }
            : {}),
          toolDialect: this.settings.toolDialect,
          abortSignal: this.abortController?.signal,
          prepareStep: async ({ stepNumber, messages: _currentMessages }) => {
            // Stop before another request, after the failed step is fully saved.
            if (lastFailure && failureStreak >= REPEATED_FAILURE_LIMIT)
              throw new Error(repeatedFailureError(lastFailure));
            const preparing = Date.now();
            preparedAt = preparing;
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
                  ? "1 model call remains in this turn. Reply with the final answer now, without the tool, based on the results already shown. State any unresolved limitation in the reply."
                  : "3 model calls remain in this turn. Reserve one for the final reply. Put any necessary definitions, statements and show result lines in one call; verify only unresolved questions. Reply with the answer now if the requested result is supported.";
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
                messageSource: "correction",
                correction: "step-budget",
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
            compiledAt = compiled;

            const visibleSteps = this.contextSteps();
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
            // DeepInfra returned 62 copies of one dataflow call). Identical
            // copies are one decision: keep the first call and its result, so
            // the copies neither run nor enter the replayed context.
            const seenInputs = new Set<string>();
            const keptCallIds = new Set<string>();
            const formattedToolCalls = toolCalls
              ?.filter(tc => {
                const key = `${tc.toolName}\u0000${JSON.stringify(tc.input ?? null)}`;
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
            if (duplicateCalls > 0)
              this.log.info({ messageId, stepIndex, duplicateCalls }, "dropped duplicate tool calls");

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
              inputMessages: this.shareInputMessages(lastPreparedMessages),
              timing: {
                preparedAt,
                requestedAt,
                compileMs: compiledAt - preparedAt,
                contextMs: requestedAt - compiledAt,
                modelMs: finishing - requestedAt,
              },
            };
            lastPreparedMessages = undefined;
            this.addStep(agentStep);
            this.head = agentStepId;
            this.trace?.llmCall({
              agentId: this.agentId,
              messageId,
              stepId: agentStepId,
              model: this.modelType,
              startedAt: requestedAt,
              endedAt: finishing,
              inputMessages: agentStep.inputMessages?.length,
              inputChars: this.lastRenderedContext?.length,
              outputChars: (text?.length ?? 0) + (formattedToolCalls ? JSON.stringify(formattedToolCalls).length : 0),
              usage: agentStep.usage,
            });
            // Snapshot iff the model emitted tool calls this step; thinking
            // turns and final summaries don't own a snapshot.
            this.maybeCreateSnapshotForHead(afterStepContent);

            await this.runPostStepExecution(formattedToolCalls, formattedToolResults);
            agentStep.timing!.postStepMs = Date.now() - finishing;
            this.trace?.step(this.agentId, agentStep);
            this.log.info({ messageId, stepIndex, postStepMs: agentStep.timing!.postStepMs }, "post-step done");

            // Identical failures in a row spend the turn's budget on nothing:
            // one correction after two, and the turn ends after four. Counted
            // per model decision; a success, a different failure, or a changed
            // graph resets the streak.
            const failure =
              this.settings.agentMode === AgentMode.NATIVE
                ? repeatedFailure(agentStep, this.workflowState.getWorkflowContent())
                : undefined;
            failureStreak =
              failure && failure.signature === lastFailure?.signature ? failureStreak + 1 : failure ? 1 : 0;
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
                messageSource: "correction",
                correction: "repeated-failure",
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
            // The reply may hand over tables by naming them; compute the named
            // ones that have no result, and send the reply back once if one
            // still has none.
            const missing =
              this.settings.agentMode === AgentMode.NATIVE &&
              !this.answerByMessage.has(messageId) &&
              !this.abortController?.signal.aborted
                ? await this.completeNamedResults(result.text)
                : undefined;
            if (missing && !namedResultsCorrected && protocolFeedbackSteps < 2) {
              namedResultsCorrected = true;
              partials.push(result);
              const feedback = namedResultsFeedback(missing);
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
              this.log.info(
                { messageId, missing: missing.map(item => item.id) },
                "sent back a reply naming tables without a result"
              );
              continue;
            }
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
              protocolFeedbackSteps < 2 &&
              !this.abortController?.signal.aborted
            ) {
              partials.push(error.partial);
              const feedback = error.cut
                ? "That reply was cut off at the output limit before it finished, so it was not taken as the answer. Reply again with the final answer only, briefly, or make one more call if a result is still missing."
                : error.answerStatement
                  ? ANSWER_STATEMENT_FEEDBACK
                  : this.lapseFeedback();
              if (error.answerStatement) answerCorrected = true;
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
                messageSource: "correction",
                correction: error.cut ? "cut-off" : error.answerStatement ? "answer-statement" : "missing-action",
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
      const result = await runDriverWithRetry(currentUserMessage);

      const answer = this.answerByMessage.get(messageId);
      if (answer !== undefined) {
        // The answer statement's rendering is the request's reply, recorded as
        // the final step like a reply without the tool.
        const answerStepId = this.generateStepId();
        this.addStep({
          id: answerStepId,
          parentId: this.head,
          messageId,
          stepId: ++stepIndex,
          timestamp: Date.now(),
          role: "agent",
          content: answer,
          isBegin: false,
          isEnd: true,
        });
        this.head = answerStepId;
        return { response: answer, messages: result.messages, usage: result.usage, stopped: false };
      }

      const msgSteps = this.reActStepsByMessageId.get(messageId);
      if (msgSteps && msgSteps.length > 0) {
        const lastStep = msgSteps[msgSteps.length - 1];
        if (lastStep.role === "agent") {
          lastStep.isEnd = true;
          this.trace?.step(this.agentId, lastStep);
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
      turnEnd = isAborted ? { status: "stopped" } : { status: "error", error: error.message || String(error) };

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
          endReason: "stopped",
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
        endReason: "error",
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
      this.trace?.turnEnded({
        agentId: this.agentId,
        messageId,
        endedAt: Date.now(),
        ...turnEnd,
        reply: this.replyOf(messageId),
      });
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
    const visibleSteps = this.contextSteps();
    const processed = this.contextAssembler({
      visibleSteps,
      workflowState: this.workflowState,
      snapshotStorage: this.snapshotStorage,
      settings: this.settings,
      compilationResult: null,
      turnNumberByMessageId: this.turnNumberMap(),
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
    this.reActStepsByMessageId.clear();
    this.stepsById.clear();
    this.childStepIds.clear();
    this.currentMessageId = undefined;
    this.head = undefined;
    this.snapshotStorage.clear();
    // The trace keeps what came before, marked as no longer the agent's: a restore leaves it out.
    this.trace?.historyCleared(this.agentId);
  }

  /** Trace from here on: an agent restored from the store is rebuilt untraced, then attached. */
  attachTrace(trace: TraceStore | undefined): void {
    this.trace = trace;
  }

  /**
   * Execute every operator and put the results on the snapshot HEAD reads:
   * after an import, the archive's results become this workflow's own, with
   * the execution proof a later run checks, so nothing is recomputed or
   * invalidated on the first question. The agent is busy while it runs.
   */
  async executeAllForHead(): Promise<{ success: boolean; state: string; errorText?: string } | undefined> {
    const execConfig = this.buildExecutionConfig();
    const stepId = this.snapshotStorage.getAssociatedSnapshot(this.head).reactStepId;
    if (!execConfig || !stepId || this.workflowState.getAllOperators().length === 0) return undefined;
    if (this.state !== AgentStateEnum.AVAILABLE) throw new Error("The agent is working; try again when it finishes.");
    this.state = AgentStateEnum.GENERATING;
    try {
      const outcome = await executeWorkflowAndPersist(this.workflowState, execConfig, {
        opsToViewResult: this.workflowState.getAllOperators().map(op => op.operatorID),
        onExecution: run => this.trace?.execution({ agentId: this.agentId, stepId, run }),
        onResult: (opId, info) => this.snapshotStorage.setOperatorResult(stepId, opId, info),
      });
      return { success: outcome.success, state: outcome.state, errorText: outcome.errorText };
    } finally {
      this.state = AgentStateEnum.AVAILABLE;
    }
  }

  /**
   * Each rendered step's own operator results, as an import archive carries
   * them: `{ [stepId]: { [operatorId]: OperatorInfo } }` for every step that
   * owns a snapshot. `restoreOperatorResults` is the inverse.
   */
  exportOperatorResults(): Record<string, Record<string, OperatorInfo>> {
    const results: Record<string, Record<string, OperatorInfo>> = {};
    for (const step of this.getRenderableReActSteps()) {
      const snapshot = this.snapshotStorage.getOwnedSnapshot(step.id);
      if (!snapshot) continue;
      for (const [operatorId, entry] of snapshot.results)
        if (entry.sourceStepId === step.id) (results[step.id] ??= {})[operatorId] = entry.info;
    }
    return results;
  }

  /**
   * Put stored operator results back on the snapshots their steps own (after
   * `importReActSteps`), and on each step's earlier versions whose runs
   * computed them, then let descendants inherit them, as a live run leaves
   * them. A result whose step owns no snapshot is skipped. A result
   * another workflow produced (an archive imported here) loses the execution
   * proof that tied it to that workflow and binds as a current value, as a
   * result parsed from an old context does.
   */
  restoreOperatorResults(results: ReadonlyArray<{ stepId: string; operatorId: string; info: OperatorInfo }>): void {
    const here = this.delegateConfig?.workflowId;
    for (const { stepId, operatorId, info } of results) {
      if (!this.snapshotStorage.hasSnapshotFor(stepId)) continue;
      const foreign = info.executionContext && here !== undefined && info.executionContext.workflowId !== here;
      const { executionContext, materialization, ...local } = info;
      try {
        this.snapshotStorage.setOperatorResult(stepId, operatorId, foreign ? (local as OperatorInfo) : info);
      } catch (err) {
        this.log.warn({ err, stepId, operatorId }, "restore: failed to set operator result, skipping");
      }
    }
    // Each step's earlier versions computed some of them on the way; going back to one shows those.
    for (const stepId of new Set(results.map(result => result.stepId))) this.snapshotStorage.spreadStepResults(stepId);
    this.snapshotStorage.propagateInheritedResults();
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
    snapshots?: Record<string, WorkflowContent>,
    restore: {
      /** The version tree a trace kept, put back as it was in place of a replay. */
      tree?: { snapshots: RestoredSnapshot[]; results: RestoredResult[] };
      /** The step HEAD was last on, when it is not the newest leaf. */
      head?: string;
    } = {}
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
    // A trace's own tree comes back as it was, each version with its results; nothing is replayed.
    const tree = restore.tree;
    const restoring = !!tree?.snapshots.length;
    if (tree && restoring)
      this.snapshotStorage.restoreTree(
        tree.snapshots.map(snapshot => ({ ...snapshot, workflow: withCurrentLayout(snapshot.workflow) })),
        tree.results,
        seenIds
      );
    type ReplayFrame = { id: string; parentContent: WorkflowContent };
    const frames: ReplayFrame[] = [];
    const emptyRoot = createEmptyWorkflowContent();
    for (const rootId of restoring ? [] : (childrenOf.get(VIRTUAL_ROOT) ?? [])) {
      frames.push({ id: rootId, parentContent: emptyRoot });
    }
    while (frames.length > 0) {
      const { id, parentContent } = frames.pop()!;
      const step = stepById.get(id)!;
      let myContent = parentContent;
      let ownsSnapshot = false;

      if (explicitSnapshots[id] !== undefined) {
        // A stored version keeps its dataflow and takes today's layout, as a replayed one does.
        myContent = withCurrentLayout(explicitSnapshots[id]);
        this.snapshotStorage.createSnapshot(id, myContent);
        ownsSnapshot = true;
      } else if (step.toolCalls && step.toolCalls.length > 0) {
        this.workflowState.setWorkflowContent(parentContent);
        // One version per replayed action, as the live run recorded them.
        const versions: Array<{
          action: VersionAction;
          workflow?: WorkflowContent;
          createdAt: number;
          number?: number;
        }> = [];
        const author = step.role === "user" ? "user" : "agent";
        for (const tc of step.toolCalls) {
          if (tc.toolName === "initialize" || tc.toolName === TOOL_NAME_EXECUTE_OPERATOR) continue;
          if (tc.toolName === TOOL_NAME_DATAFLOW) {
            const saved = asDataflowActionsResult(step.toolResults?.find(r => r.toolCallId === tc.toolCallId)?.output);
            // Replay recorded edits only. Never execute a saved workflow or
            // apply an action that the original run skipped after a failure;
            // a run or a show that happened is a version without a change.
            try {
              for (const item of saved?.actions ?? []) {
                if (item.status === "pending") break;
                if (item.status === "skipped") continue;
                const output = item.output as
                  | {
                      versions?: Array<{ timestamp?: number; version?: number }>;
                      version?: { timestamp?: number; version?: number };
                    }
                  | undefined;
                if (item.action.type === "edit" && item.status === "ok") {
                  const before = this.workflowState.getWorkflowContent();
                  const plan = await planRegisteredGraphEdit(before, item.action.python, item.action.changes, {
                    metadataStore: this.metadataStore,
                    settings: this.settings,
                  });
                  this.workflowState.setWorkflowContent(plan.workflow);
                  const times = output?.versions ?? [];
                  const edits = editVersions(before, plan, author);
                  versions.push(
                    ...edits.map((version, index) => ({
                      ...version,
                      createdAt: times[index]?.timestamp ?? step.timestamp,
                      // The number the session gave it, so the step's chips and the tree agree.
                      ...(times.length === edits.length ? { number: times[index]?.version } : {}),
                    }))
                  );
                }
                const request = importedRequest(item, author);
                if (request)
                  versions.push({
                    action: request,
                    createdAt: output?.version?.timestamp ?? step.timestamp,
                    number: output?.version?.version,
                  });
              }
            } catch (err) {
              this.log.warn({ err, stepId: id, toolName: tc.toolName }, "import replay: edit replay threw, continuing");
            }
            continue;
          }
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
        this.snapshotStorage.createSnapshot(id, myContent, {
          createdAt: step.timestamp,
          ...(TexeraAgent.isInitializationStep(step)
            ? { action: { kind: "start", author: "agent" } }
            : versions.length
              ? { action: false }
              : {}),
        });
        this.snapshotStorage.recordVersions(id, versions);
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
    for (const step of restoring ? [] : order) {
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
    if (!restoring) this.snapshotStorage.propagateInheritedResults();

    // Pick HEAD: where the trace says it was last put, else the leaf with the latest timestamp on its branch.
    const leaves = order.filter(s => (childrenOf.get(s.id) ?? []).length === 0);
    if (leaves.length === 0) {
      throw new Error("import has no leaf steps (impossible after structure check)");
    }
    // A traced `initialize` step is a root of its own, newer than imported steps that keep their
    // original times; it is never the head while any other step exists, or a restored agent
    // would open on its empty bootstrap workflow instead of its last step.
    const conversational = leaves.filter(s => !TexeraAgent.isInitializationStep(s));
    const candidates = conversational.length > 0 ? conversational : leaves;
    candidates.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    const headStep = (restore.head !== undefined ? stepById.get(restore.head) : undefined) ?? candidates[0];
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
  /** A final reply can hand over tables by naming their operators in a JSON
   * object (a file-to-operator mapping). `set` only declares an operator, so a
   * named table can be one nothing computed; compute those now, on the
   * snapshot the reply reads, without another model call. Returns the named
   * operators still without a current result. */
  private async completeNamedResults(text: string): Promise<Array<{ id: string; error?: string }> | undefined> {
    const operators = new Map(this.workflowState.getAllOperators().map(op => [op.operatorID, op]));
    const named = namedOperatorIds(text, new Set(operators.keys()));
    const owner = this.snapshotStorage.getAssociatedSnapshot(this.head).reactStepId;
    if (!named.length || !owner) return undefined;
    const current = (id: string) =>
      hasCurrentResult(operators.get(id), this.snapshotStorage.getOperatorResult(owner, id));
    const pending = named.filter(id => !current(id));
    if (!pending.length) return undefined;
    let failure: string | undefined;
    try {
      await this.executePostStepChanges([], [], true, pending, undefined, owner);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    this.snapshotCallback?.(owner, this.workflowState.getWorkflowContent());
    const missing = pending.filter(id => !current(id));
    this.log.info({ named, computed: pending.filter(id => current(id)), missing }, "computed the tables a reply names");
    if (!missing.length) return undefined;
    return missing.map(id => ({ id, error: this.snapshotStorage.getOperatorResult(owner, id)?.error ?? failure }));
  }

  /** Has a result been shown that a reply without a tool call can rest on?
   * Only then is such a reply the answer; before it, nothing was computed. A
   * conversation refines one task over its messages, so any result shown on
   * its branch counts, the user's canvas runs included: a question or
   * feedback after the task was solved is answered in words. In a session of
   * separate requests (multiRequest), each request shows its own. */
  private resultShownFor(messageId: string): boolean {
    const steps =
      (this.settings.multiRequest ?? "off") === "off"
        ? this.getVisibleReActSteps()
        : (this.reActStepsByMessageId.get(messageId) ?? []);
    return steps.some(step =>
      (step.toolResults ?? []).some(tr =>
        (asDataflowActionsResult(tr.output)?.actions ?? []).some(
          item => item.action.type === "retrieve" && item.status === "ok"
        )
      )
    );
  }

  /** Several dataflow calls in one response (DeepSeek splits a step into a
   * statements call and a definitions call) run as one call: every definition
   * registers first, the set and delete lines apply together, then the requests
   * run in call order. The first call's result becomes the merged receipt; each
   * later call's result points to it. */
  private mergeResponseCalls(
    toolCalls: ReadonlyArray<{ toolName: string; toolCallId: string; input: any }> | undefined,
    toolResults: ReadonlyArray<{ toolCallId: string; output: any; isError?: boolean }>
  ): void {
    const calls = (toolCalls ?? []).filter(tc => tc.toolName === TOOL_NAME_DATAFLOW);
    if (calls.length < 2) return;
    const results = calls.map(tc =>
      asDataflowActionsResult(toolResults.find(tr => tr.toolCallId === tc.toolCallId)?.output)
    );
    if (results.some(result => !result)) return;
    const merged = mergeDataflowCalls(
      calls.map(tc => tc.input),
      availableRetrievalViews(this.settings),
      this.settings.answerStatement === true
    );
    if (!merged) return;
    const replace = (target: DataflowActionsResult, source: DataflowActionsResult) => {
      for (const key of Object.keys(target)) delete (target as unknown as Record<string, unknown>)[key];
      Object.assign(target, source);
    };
    replace(results[0]!, merged);
    for (const result of results.slice(1))
      replace(result!, {
        kind: "dataflow-actions",
        protocol: "registered-python-v1",
        status: "completed",
        actions: [],
        operators: [],
        observe: [],
        observationErrors: [],
        mergedInto: calls[0].toolCallId,
      });
    this.log.info({ stepId: this.head, calls: calls.length }, "merged several dataflow calls from one response");
  }

  /** A reply without a tool call before any result was shown computed
   * nothing. The correction names the first call to make, with a path from the
   * request when it has one, so a model that hesitates has a call to copy. */
  private lapseFeedback(): string {
    const request = [...this.getVisibleReActSteps()].reverse().find(step => step.role === "user" && step.isBegin);
    const starter = JSON.stringify({
      python: "",
      statements: `set data: scan(files='${requestFilePath(String(request?.content ?? ""))}')\nshow result data`,
    });
    return (
      "That reply was text, so nothing was computed and no result has been shown yet. The engine reads the task's files; " +
      `call the dataflow tool, for example ${starter}. ` +
      (this.settings.answerStatement === true
        ? "Compute in further calls, and give the final answer with an answer statement."
        : "Compute in further calls, and reply without the tool only to give the final answer, after show result has displayed what it rests on.")
    );
  }

  /** A call's answer statement renders its tables as the request's reply
   * (AgentSettings.answerStatement); the turn ends after this step. A call
   * whose other statements failed, or whose tables cannot be rendered whole,
   * answers nothing, and its receipt says why. */
  private renderAnswerStatement(result: DataflowActionsResult, stepId: string): void {
    const statement = result.turn?.statements.find(item => item.kind === "answer");
    if (!statement?.answer || !statement.ids) return;
    const failed = result.actions.find(item => item.status === "error");
    const rendering = failed
      ? { ok: false as const, error: "a statement of this call failed; fix it, then answer." }
      : renderAnswer({ ids: statement.ids, ...statement.answer }, id =>
          this.snapshotStorage.getOperatorResult(stepId, id)
        );
    if (rendering.ok) {
      result.answer = rendering.text;
      if (this.currentMessageId) this.answerByMessage.set(this.currentMessageId, rendering.text);
    } else result.answerError = rendering.error;
  }

  private async runPostStepExecution(
    toolCalls: ReadonlyArray<{ toolName: string; toolCallId: string; input: any }> | undefined,
    toolResults: ReadonlyArray<{ toolCallId: string; output: any; isError?: boolean }> | undefined,
    overrides?: { maxChars?: number; author?: "agent" | "user" }
  ): Promise<void> {
    if (toolResults?.some(tr => asDataflowActionsResult(tr.output)) && this.head)
      this.mergeResponseCalls(toolCalls, toolResults);
    const actions = (toolResults ?? []).map(tr => asDataflowActionsResult(tr.output)).filter(r => r !== undefined);
    if (actions.length && this.head) {
      const stepId = this.head;
      for (const result of actions) {
        // A call merged into the response's first call has nothing left to run.
        if (result.mergedInto) continue;
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
            settings: this.settings,
          },
          execute: (operatorIds, onExecution) => this.executePostStepChanges([], [], true, operatorIds, onExecution),
          isCurrent: () => this.head === stepId && this.snapshotStorage.hasSnapshotFor(stepId),
          signal: this.abortController?.signal,
          author: overrides?.author,
          onProgress: progress => this.progressCallback?.(stepId, progress),
          onActionDone: () => {
            const step = this.stepsById.get(stepId);
            if (step) this.stepCallback?.(step);
          },
        });
        this.renderAnswerStatement(result, stepId);
      }
      const step = this.stepsById.get(stepId);
      if (step) {
        step.operatorAccess = computeOperatorAccess(step.toolCalls, step.toolResults);
        for (const tr of step.toolResults ?? []) {
          const result = asDataflowActionsResult(tr.output);
          if (result) tr.isError = result.status === "error";
        }
        this.stepCallback?.(step);
      }
      this.snapshotCallback?.(stepId, this.workflowState.getWorkflowContent());
      return;
    }
    // Code mode: execute what the step's operator edits changed.
    await this.executePostStepChanges(toolCalls, toolResults);
  }

  private async executePostStepChanges(
    toolCalls: ReadonlyArray<{ toolName: string; toolCallId: string; input: any }> | undefined,
    toolResults: ReadonlyArray<{ toolCallId: string; output: any; isError?: boolean }> | undefined,
    executeAll = false,
    operatorIds?: readonly string[],
    onExecution?: (run: ExecutionRunMetrics) => void,
    /** Persist the results on this step's snapshot instead of HEAD's (HEAD is then a reply without one). */
    owner?: string
  ): Promise<void> {
    if (!toolCalls || !toolResults) return;

    // Collect every operator successfully edited in this step.
    const editedOpIds: string[] = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      const tr = toolResults.find(result => result.toolCallId === tc.toolCallId);
      if (!EXECUTE_AFTER_TOOLS.has(tc.toolName)) continue;
      if (tr?.isError) continue;
      const resultText = typeof tr?.output === "string" ? tr.output : String(tr?.output ?? "");
      if (resultText.startsWith("[ERROR]")) continue;
      const operatorId = (tc.input as any)?.operatorId;
      if (operatorId) editedOpIds.push(operatorId);
    }
    if (editedOpIds.length === 0 && !executeAll) return;
    const execConfig = this.buildExecutionConfig();
    if (!execConfig) {
      if (executeAll) throw new Error("Execution is unavailable: this agent has no backend workflow connection.");
      return;
    }

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
    const owningStepId = owner ?? this.head;
    const owningSignal = this.abortController?.signal;
    const stillOwned = () =>
      owningStepId !== undefined &&
      (owner !== undefined || this.head === owningStepId) &&
      !owningSignal?.aborted &&
      this.snapshotStorage.hasSnapshotFor(owningStepId);

    if (targets.size === 0) return;

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
          this.trace?.execution({ agentId: this.agentId, messageId: this.currentMessageId, stepId: owningStepId, run });
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
      // A canvas action is a finished report, not a task to continue.
      if (group.some(s => s.messageSource === "action")) return undefined;
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
   *   auto-execution runs identically to the LLM path. Lines before the call
   *   are the step's visible reasoning.
   * - `Reply(text='...')` → the agent's reply, recorded as the step that ends
   *   the ongoing task, as a reply without a tool call would.
   *
   * Tool execution and post-step execution happen exactly as they would after
   * an LLM-produced tool call — only the model call and the ReAct loop are skipped.
   */
  async handleDebugInput(
    content: string,
    messageSource?: "chat" | "feedback"
  ): Promise<{
    kind: "user_message" | "function_call" | "reply";
    stopped: boolean;
    error?: string;
  }> {
    this.abortController = new AbortController();
    this.state = AgentStateEnum.GENERATING;

    try {
      // Plain user text → start a new task (fresh messageId, stepId 0).
      if (!looksLikeAgentInput(content)) {
        const messageId = `dbg-${this.agentId}-${++this.messageCounter}-${Date.now()}`;
        this.currentMessageId = messageId;
        this.trace?.turnStarted({
          agentId: this.agentId,
          messageId,
          channel: "debug",
          source: messageSource ?? "chat",
          text: content,
          startedAt: Date.now(),
        });

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
        this.trace?.turnStarted({
          agentId: this.agentId,
          messageId,
          channel: "debug",
          text: content,
          startedAt: Date.now(),
        });
      }
      this.currentMessageId = messageId;

      let parsed: DebugAgentInput;
      try {
        parsed = parseDebugInput(content);
      } catch (e: any) {
        const message = `Failed to parse the agent input: ${e?.message || String(e)}`;
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

      // Reply(...) → the agent's reply ends the task; no tool call, no snapshot.
      if (parsed.reply !== undefined) {
        const replyStepId = this.generateStepId();
        this.addStep({
          id: replyStepId,
          parentId: this.head,
          messageId,
          stepId,
          timestamp: Date.now(),
          role: "agent",
          content: parsed.reply,
          isBegin,
          isEnd: true,
        });
        this.head = replyStepId;
        this.trace?.turnEnded({
          agentId: this.agentId,
          messageId,
          endedAt: Date.now(),
          status: "ok",
          reply: parsed.reply,
        });
        return { kind: "reply", stopped: false };
      }
      const call = parsed.call!;

      const toolCallId = `dbg-tc-${this.stepCounter}-${Date.now()}`;
      let output: any;
      let isError = false;
      try {
        output = await this.executeTool(call.name, call.arguments);
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

      const formattedToolCalls = [{ toolName: call.name, toolCallId, input: call.arguments }];
      const formattedToolResults = [{ toolCallId, output, isError }];

      const agentStepId = this.generateStepId();
      const agentStep: ReActStep = {
        id: agentStepId,
        parentId: this.head,
        messageId,
        stepId,
        timestamp: Date.now(),
        role: "agent",
        content: parsed.thought ?? "",
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

  /**
   * Apply a canvas action: the user edited or ran one native operator. It is
   * recorded as a user step carrying the equivalent `dataflow` call, which runs
   * exactly as the agent's own calls do (snapshot, edit, execution, receipt).
   * The step's content tells the model what the user did and what came of it,
   * where it happened in the conversation; the agent is not asked to respond.
   *
   * An edit is checked first: one `set` statement for this operator that the
   * planner accepts. A rejected edit throws a UserActionError and records
   * nothing, and an edit that changes nothing records nothing (with `run`, it
   * records a run). `onRecord` runs just before the step is recorded.
   */
  async applyUserAction(
    action: UserActionRequest,
    onRecord?: () => void
  ): Promise<{ status: "ok" | "error" | "unchanged"; step?: ReActStep; respond?: boolean }> {
    if (this.settings.agentMode !== AgentMode.NATIVE)
      throw new UserActionError(400, "Canvas actions apply to dataflows the agent builds in native mode.");
    if (this.state !== AgentStateEnum.AVAILABLE)
      throw new UserActionError(409, "The agent is working; try again when it finishes.");
    const operator = this.workflowState.getOperator(action.operatorId);
    if (!operator?.nativeOp) throw new UserActionError(404, `There is no native operator \`${action.operatorId}\`.`);
    const previous = nativeAssignmentText(action.operatorId, operator.nativeOp);
    // Reserved until the action is done: no turn starts while it is checked or runs.
    this.state = AgentStateEnum.GENERATING;
    try {
      let request = action;
      if (action.kind === "edit" && (await this.checkUserEdit(action))) {
        if (!action.run) return { status: "unchanged" };
        request = { kind: "run", operatorId: action.operatorId };
      }
      const call = userActionCall(request);
      const result = prepareDataflowCall(call, availableRetrievalViews(this.settings));
      // A run is answered by the agent, unless the user switched that off.
      const respond = this.settings.respondToCanvasRuns !== false && (request.kind === "run" || request.run === true);
      if (result.status === "error") throw new UserActionError(400, result.error ?? "The action was rejected.");
      onRecord?.();

      const messageId = `act-${this.agentId}-${++this.messageCounter}-${Date.now()}`;
      const toolCallId = `act-tc-${this.stepCounter}-${Date.now()}`;
      const toolCalls = [{ toolName: TOOL_NAME_DATAFLOW, toolCallId, input: call }];
      const toolResults = [{ toolCallId, output: result as unknown, isError: false }];
      const info: UserActionInfo =
        request.kind === "edit"
          ? {
              kind: "edit",
              operatorId: request.operatorId,
              statement: request.statement.trim(),
              ...(previous ? { previous } : {}),
              ...(request.run ? { run: true } : {}),
              status: "running",
            }
          : { kind: "run", operatorId: request.operatorId, status: "running" };
      this.abortController = new AbortController();
      this.currentMessageId = messageId;
      const step: ReActStep = {
        id: this.generateStepId(),
        parentId: this.head,
        messageId,
        stepId: 0,
        timestamp: Date.now(),
        role: "user",
        content: userActionContent(request, previous),
        isBegin: true,
        isEnd: true,
        messageSource: "action",
        toolCalls,
        toolResults,
        userAction: info,
      };
      this.trace?.turnStarted({
        agentId: this.agentId,
        messageId,
        channel: "action",
        source: "action",
        text: step.content,
        startedAt: step.timestamp,
      });
      this.addStep(step);
      this.head = step.id;
      this.maybeCreateSnapshotForHead(this.workflowState.getWorkflowContent());
      try {
        await this.runPostStepExecution(toolCalls, toolResults, { author: "user" });
      } catch (error) {
        result.status = "error";
        result.error ??= error instanceof Error ? error.message : String(error);
      }
      // A reminder to write docs is for the agent's own statements, not the user's.
      for (const item of result.actions)
        if (item.action.type === "edit" && item.output && typeof item.output === "object")
          delete (item.output as { missing_docs?: unknown }).missing_docs;
      const before = operator.nativeOp;
      const after = this.workflowState.getOperator(request.operatorId)?.nativeOp;
      const staleDoc =
        request.kind === "edit" &&
        !!before.doc?.trim() &&
        after?.doc === before.doc &&
        after.revision !== before.revision;
      step.content = userActionContent(request, previous, result, respond, staleDoc);
      info.status = result.status === "error" ? "error" : "ok";
      const rows = userActionRows(result, request.operatorId);
      if (rows !== undefined) info.rows = rows;
      const version = userActionVersion(result);
      if (version !== undefined) info.version = version;
      if (result.error) info.error = result.error;
      this.trace?.step(this.agentId, step);
      // Answered by the agent, the turn ends again with its reply.
      this.trace?.turnEnded({
        agentId: this.agentId,
        messageId,
        endedAt: Date.now(),
        status: info.status === "error" ? "error" : "ok",
        error: info.error,
      });
      this.stepCallback?.(step);
      return { status: info.status, step, respond };
    } finally {
      this.abortController = null;
      this.currentMessageId = undefined;
      this.state = AgentStateEnum.AVAILABLE;
    }
  }

  /**
   * Respond to a canvas action already recorded (the user ran an operator):
   * a turn whose request is that action. The agent reads it as the newest
   * event and replies, or works further, as it would for a message.
   */
  async respondToUserAction(step: ReActStep): Promise<AgentMessageResult> {
    if (this.state !== AgentStateEnum.AVAILABLE)
      throw new UserActionError(409, "The agent is working; try again when it finishes.");
    if (this.head !== step.id || step.messageSource !== "action")
      throw new UserActionError(409, "The action is no longer the newest step.");
    this.state = AgentStateEnum.GENERATING;
    return this.sendMessage(step.content, "action", { respondTo: step });
  }

  /**
   * Check out a dataflow version (a snapshot an action made), so the canvas
   * shows exactly that version: its dataflow and the results it had. A step's
   * newest version checks out the step, and the replies after it in its turn
   * that make no version of their own come along. An earlier version of a
   * step — an edit a later edit of the call changed, or a run or a show the
   * call went on from — is restored: HEAD moves to that step, and a user step
   * under it records the restore with that version as its dataflow, so the
   * agent reads what was undone. Going back to a version restored before
   * reuses that restore. Returns the new HEAD, or undefined when there is no
   * such version.
   */
  checkoutVersion(snapshotId: string): string | undefined {
    const version = this.snapshotStorage.getSnapshotById(snapshotId);
    if (!version?.reactStepId || version.version === undefined || !this.stepsById.has(version.reactStepId))
      return undefined;
    const owner = version.reactStepId;
    if (this.snapshotStorage.getOwnedSnapshot(owner)?.id === version.id) {
      const target = this.lastStepShowing(owner);
      this.checkout(target);
      return target;
    }
    const restored = this.childSteps(owner)
      .filter(
        step =>
          step.userAction?.kind === "restore" && this.snapshotStorage.getOwnedSnapshot(step.id)?.parentId === version.id
      )
      .at(-1);
    if (restored) {
      this.checkout(restored.id);
      return restored.id;
    }
    this.checkout(owner);
    const undone = this.workflowState.getWorkflowContent();
    const stepId = this.generateStepId();
    this.addStep({
      id: stepId,
      parentId: owner,
      messageId: `act-${this.agentId}-${++this.messageCounter}-${Date.now()}`,
      stepId: 0,
      timestamp: Date.now(),
      role: "user",
      content: restoreContent(version.version, version.action, version.workflow, undone),
      isBegin: true,
      isEnd: true,
      messageSource: "action",
      userAction: {
        kind: "restore",
        ...(version.action?.operatorId ? { operatorId: version.action.operatorId } : {}),
        version: version.version,
        status: "ok",
      },
    });
    this.head = stepId;
    // The restore is not a new version: it continues from the restored one.
    this.snapshotStorage.createSnapshot(stepId, version.workflow, { parentSnapshotId: version.id });
    this.workflowState.setWorkflowContent(this.snapshotStorage.getWorkflow(stepId));
    return stepId;
  }

  /** The last step of `stepId`'s turn that still shows its newest version:
   * the replies after it that make no version, along HEAD's branch where it
   * passes through, else the newest branch. */
  private lastStepShowing(stepId: string): string {
    const onHead = new Set(this.getAncestorPath());
    const turn = this.stepsById.get(stepId)!.messageId;
    let current = stepId;
    for (;;) {
      const next = this.childSteps(current).filter(
        child => child.messageId === turn && !this.snapshotStorage.getStepVersions(child.id).length
      );
      if (!next.length) return current;
      current = (next.find(child => onHead.has(child.id)) ?? next[next.length - 1]).id;
    }
  }

  /**
   * `messages`, the model input of a step about to be added under HEAD, with
   * every message whose content the nearest earlier input on the path also has,
   * at the same place, sharing that content. The context grows by appending, so
   * a step holds only what its call added, not another copy of the conversation.
   */
  private shareInputMessages(messages: ModelMessage[] | undefined): ModelMessage[] | undefined {
    let previous: any[] | undefined;
    for (let id = this.head; id !== undefined && !previous; id = this.stepsById.get(id)?.parentId)
      previous = this.stepsById.get(id)?.inputMessages;
    if (!messages || !previous) return messages;
    return messages.map((message, i) => {
      const before = previous![i];
      if (!before || before.role !== message.role || !isDeepStrictEqual(before.content, message.content))
        return message;
      return isDeepStrictEqual(before, message) ? before : ({ ...message, content: before.content } as ModelMessage);
    });
  }

  /** The steps whose parent is `stepId`, in the order they were added. */
  private childSteps(stepId: string): ReActStep[] {
    return (this.childStepIds.get(stepId) ?? []).map(id => this.stepsById.get(id)!);
  }

  /** Check a canvas edit without changing anything. True when it would change nothing. */
  private async checkUserEdit(action: Extract<UserActionRequest, { kind: "edit" }>): Promise<boolean> {
    const statement = action.statement.trim();
    const defined = /^set\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(statement)?.[1];
    if (defined !== action.operatorId)
      throw new UserActionError(
        400,
        `Write one statement that defines \`${action.operatorId}\`: set ${action.operatorId}: type(inputs, settings).`
      );
    let plan;
    try {
      plan = await planRegisteredGraphEdit(this.workflowState.getWorkflowContent(), action.python ?? "", statement, {
        metadataStore: this.metadataStore,
        settings: this.settings,
      });
    } catch (error) {
      // The reason without the Python exception's class name ("ValueError: ").
      const reason = (error instanceof Error ? error.message : String(error)).replace(/^[A-Za-z]*Error: /, "");
      throw new UserActionError(400, reason);
    }
    const changed = plan.changes.filter(change => change.change === "operator" && change.action !== "unchanged");
    const other = changed.find(change => change.change === "operator" && change.operator_id !== action.operatorId);
    if (other?.change === "operator")
      throw new UserActionError(
        400,
        `Only \`${action.operatorId}\` can change here; the statement also changes \`${other.operator_id}\`.`
      );
    return !changed.length && !plan.registrations?.length && !plan.changes.some(change => change.change === "edge");
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
    this.childStepIds.clear();
    this.currentMessageId = undefined;
  }
}
