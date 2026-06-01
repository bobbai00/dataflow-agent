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
import type { WorkflowContent } from "../types/workflow";
import { WorkflowSystemMetadata } from "./util/workflow-system-metadata";
import { WorkflowSnapshotStorage } from "./workflow-snapshot-storage";
import type { AgentDelegateConfig, AgentSettings, ReActStep, TokenUsage, UserInfo } from "../types/agent";
import type { OperatorInfo } from "../types/execution";
import {
  AgentMode,
  AgentState as AgentStateEnum,
  ContextMode,
  DEFAULT_AGENT_SETTINGS,
  OperatorResultSerializationMode,
} from "../types/agent";
import { buildCodeModeSystemPrompt, buildGeneralModeSystemPrompt } from "./prompts";

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
   *  system prompt unchanged. */
  systemPromptBuilder?: () => string;
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
  private readonly systemPromptBuilder: (() => string) | undefined;
  private systemPrompt: string;
  private settings: AgentSettings;

  private reActStepsByMessageId: Map<string, ReActStep[]> = new Map();

  private currentMessageId: string | undefined = undefined;

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
    if (this.systemPromptBuilder) {
      // Driver-level override (local-react). Bypass the mode-based builders
      // entirely so the wire prompt always matches the model's training
      // distribution.
      this.systemPrompt = this.systemPromptBuilder();
    } else if (this.settings.agentMode === AgentMode.GENERAL) {
      this.systemPrompt = buildGeneralModeSystemPrompt(this.metadataStore, this.settings.allowedOperatorTypes);
    } else {
      this.systemPrompt = buildCodeModeSystemPrompt();
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
        this.settings.maxLoadersPerSource,
        this.settings.loaderEscalation
      );
    } else {
      tools[TOOL_NAME_ADD_OPERATOR] = createAddOperatorTool(this.workflowState, operatorSchemas, context);
      tools[TOOL_NAME_MODIFY_OPERATOR] = createModifyOperatorTool(this.workflowState, context);
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
        context
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
    lineageTimeline?: boolean;
    fewShotPrompt?: boolean;
    loaderEscalation?: boolean;
    maxResultRows?: number;
    flowLevel?: number;
    dataLevel?: number;
    maxLoadersPerSource?: number;
    attemptReflection?: boolean;
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
    if (updates.contextMode !== undefined) {
      this.settings.contextMode = updates.contextMode;
      // Context mode does not affect the system prompt (we stripped the
      // mode-specific layout description from prompts.ts).
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
    if (updates.maxResultRows !== undefined) {
      this.settings.maxResultRows = updates.maxResultRows;
      // Pure render-time setting — caps the per-operator TSV sample rows (W1).
    }
    if (updates.lineageTimeline !== undefined) {
      this.settings.lineageTimeline = updates.lineageTimeline;
      // Pure render-time toggle — LATEST-mode construction timeline (W3).
    }
    if (updates.loaderEscalation !== undefined) {
      this.settings.loaderEscalation = updates.loaderEscalation;
      // Read by createTools() below when (re)building the code-op tool (#29).
    }
    if (updates.fewShotPrompt !== undefined) {
      this.settings.fewShotPrompt = updates.fewShotPrompt;
      promptNeedsRebuild = true; // W2: changes the SYSTEM prompt
    }
    if (updates.maxLoadersPerSource !== undefined) {
      this.settings.maxLoadersPerSource = updates.maxLoadersPerSource;
      // Read by createTools() below when (re)building the code-op tool; the
      // per-source loader budget is enforced inside that tool closure.
    }
    if (updates.attemptReflection !== undefined) {
      this.settings.attemptReflection = updates.attemptReflection;
      // Pure render-time toggle — injects an `Attempt reflection:` block on
      // heavily-edited operators. Read at the next assembleContext.
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
      const result = await this.driver.runTurn({
        initialMessages: currentUserMessage,
        systemPrompt: this.systemPrompt,
        tools: this.tools,
        maxSteps: this.settings.maxSteps,
        parallelToolCalls: this.settings.parallelToolCalls,
        abortSignal: this.abortController?.signal,
        prepareStep: async ({ stepNumber: _stepNumber, messages: _currentMessages }) => {
          let compilationResult: WorkflowCompilationResponse | null = null;
          if (this.workflowState.getAllOperators().length > 0) {
            try {
              const logicalPlan = this.workflowState.toLogicalPlan();
              compilationResult = await compileWorkflowAsync(logicalPlan);
            } catch (e: any) {
              this.log.warn({ err: e?.message || e }, "compilation failed; proceeding without schemas");
            }
          }

          const visibleSteps = this.getVisibleReActSteps();
          const processed = this.contextAssembler({
            visibleSteps,
            workflowState: this.workflowState,
            snapshotStorage: this.snapshotStorage,
            settings: this.settings,
            compilationResult,
          });
          lastPreparedMessages = processed;
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

          isFirstStep = false;
        },
      });

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
    });
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
   * Throws on structural problems (missing parent, cycle, duplicate id) so a
   * partial state is never installed.
   */
  async importReActSteps(
    steps: ReActStep[],
    snapshots?: Record<string, WorkflowContent>
  ): Promise<{ headId: string; importedCount: number }> {
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error("import requires a non-empty steps array");
    }

    // Validate ids/parents first; bail before mutating anything.
    const seenIds = new Set<string>();
    for (const s of steps) {
      if (!s || typeof s.id !== "string" || s.id.length === 0) {
        throw new Error("every step must have a non-empty 'id'");
      }
      if (seenIds.has(s.id)) throw new Error(`duplicate step id: ${s.id}`);
      seenIds.add(s.id);
    }
    const validParent = (pid: string | undefined): boolean => !pid || seenIds.has(pid);
    for (const s of steps) {
      if (!validParent(s.parentId)) {
        throw new Error(`step ${s.id} has unknown parentId ${s.parentId}`);
      }
    }

    // Build child adjacency. Roots (parentId undefined) are listed under the
    // synthetic VIRTUAL_ROOT key only for traversal/cycle bookkeeping — they
    // never become real entries in `stepsById`.
    const VIRTUAL_ROOT = "__import_root__";
    const childrenOf = new Map<string, string[]>();
    for (const s of steps) {
      const key = s.parentId ?? VIRTUAL_ROOT;
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
      stepById.set(s.id, { ...s, timestamp: toEpochMs(s.timestamp) });
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
    try {
      await executeWorkflowAndPersist(this.workflowState, execConfig, {
        abortSignal: this.abortController?.signal,
        opsToViewResult: [...targets],
        onResult: (opId, operatorInfo) => {
          if (this.head !== undefined) {
            this.snapshotStorage.setOperatorResult(this.head, opId, operatorInfo);
          }
        },
      });
    } catch (e: any) {
      this.log.warn({ err: e?.message || e, targetCount: targets.size }, "post-step batched execution failed");
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
