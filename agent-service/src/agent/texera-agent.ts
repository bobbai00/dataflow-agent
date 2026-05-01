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

import { generateText, type ModelMessage, type LanguageModel, stepCountIs } from "ai";
import { Subscription } from "rxjs";
import { debounceTime } from "rxjs/operators";
import { WorkflowState } from "./workflow-state";
import { WorkflowSystemMetadata } from "./util/workflow-system-metadata";
import { WorkflowResultState } from "./workflow-result-state";
import { formatOperatorResult } from "./tools/result-formatting";
import type { AgentSettings, ReActStep, TokenUsage, UserInfo } from "../types/agent";
import {
  AgentMode,
  AgentState as AgentStateEnum,
  DEFAULT_AGENT_SETTINGS,
  OperatorResultSerializationMode,
  INITIAL_STEP_ID,
} from "../types/agent";
import { buildCodeModeSystemPrompt, buildGeneralModeSystemPrompt } from "./prompts";
import {
  createDeleteOperatorTool,
  TOOL_NAME_DELETE_OPERATOR,
  type ToolContext,
} from "./tools/workflow-crud-tools";
import {
  createAddOperatorTool,
  createModifyOperatorTool,
  TOOL_NAME_ADD_OPERATOR,
  TOOL_NAME_MODIFY_OPERATOR,
} from "./tools/general-op-tools";
import {
  createCreateOrModifyOperatorTool,
  TOOL_NAME_CREATE_OR_MODIFY_OPERATOR,
} from "./tools/code-op-tools";
import {
  createExecuteOperatorTool,
  executeOperatorAndFormat,
  TOOL_NAME_EXECUTE_OPERATOR,
  type ExecutionConfig,
} from "./tools/workflow-execution-tools";
import { assembleContext } from "./util/context-utils";
import { compileWorkflowAsync, type WorkflowCompilationResponse } from "../api/compile-api";
import { createLogger } from "../logger";
import type { Logger } from "pino";
import { looksLikeFunctionCall, parseFunctionCall } from "./debug-parser";

const PERSIST_DEBOUNCE_MS = 500;

/** Tool names whose successful invocation triggers post-step operator execution. */
const EXECUTE_AFTER_TOOLS: ReadonlySet<string> = new Set([
  TOOL_NAME_ADD_OPERATOR,
  TOOL_NAME_MODIFY_OPERATOR,
  TOOL_NAME_CREATE_OR_MODIFY_OPERATOR,
]);

export interface TexeraAgentConfig {
  model: LanguageModel;
  modelType: string;
  agentId: string;
  agentName?: string;
  systemPrompt?: string;
}

export interface AgentMessageResult {
  response: string;
  messages: ModelMessage[];
  usage: TokenUsage;
  stopped: boolean;
  error?: string;
}

type ReActStepCallback = (step: ReActStep) => void;

/**
 * A single Texera agent instance.
 *
 * Owns the conversation (ReAct step tree with HEAD/checkout semantics), the
 * workflow being edited (`WorkflowState`), cached operator execution results
 * (`WorkflowResultState`), and the tool surface exposed to the LLM. Each call
 * to `sendMessage` drives one multi-step generation via the Vercel AI SDK,
 * streaming step updates to subscribed websockets.
 */
export class TexeraAgent {
  readonly agentId: string;
  readonly agentName: string;
  readonly modelType: string;
  readonly createdAt: Date;

  private state: AgentStateEnum = AgentStateEnum.AVAILABLE;
  private workflowState: WorkflowState;
  private metadataStore: WorkflowSystemMetadata;
  private head: string = INITIAL_STEP_ID;
  private stepsById: Map<string, ReActStep> = new Map();
  private stepCounter = 0;
  private workflowResultState: WorkflowResultState;

  private websockets: Set<any> = new Set();

  private model: LanguageModel;
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
    this.model = config.model;
    this.systemPrompt = config.systemPrompt || "";
    this.log = createLogger("TexeraAgent", { agentId: this.agentId });

    this.workflowState = new WorkflowState();
    this.metadataStore = WorkflowSystemMetadata.getInstance();
    this.workflowResultState = new WorkflowResultState(() => this.getAncestorPath());

    const initialStep: ReActStep = {
      id: INITIAL_STEP_ID,
      messageId: "initial",
      stepId: -1,
      timestamp: Date.now(),
      role: "user",
      content: "",
      isBegin: true,
      isEnd: true,
      parentId: undefined,
    };
    this.stepsById.set(INITIAL_STEP_ID, initialStep);

    this.settings = {
      ...DEFAULT_AGENT_SETTINGS,
      systemPrompt: this.systemPrompt,
    };

    this.tools = this.createTools();
  }

  async initialize(): Promise<void> {
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
  }

  private rebuildSystemPrompt(): void {
    if (this.settings.agentMode === AgentMode.GENERAL) {
      this.systemPrompt = buildGeneralModeSystemPrompt(this.metadataStore, this.settings.allowedOperatorTypes);
    } else {
      this.systemPrompt = buildCodeModeSystemPrompt();
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

    const getExecutionConfig = this.delegateConfig ? () => this.buildExecutionConfig()! : undefined;

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
        context
      );
    } else {
      tools[TOOL_NAME_ADD_OPERATOR] = createAddOperatorTool(this.workflowState, operatorSchemas, context);
      tools[TOOL_NAME_MODIFY_OPERATOR] = createModifyOperatorTool(this.workflowState, context);
    }

    if (getExecutionConfig) {
      tools[TOOL_NAME_EXECUTE_OPERATOR] = createExecuteOperatorTool(
        this.workflowState,
        getExecutionConfig,
        (opId, operatorInfo) => {
          this.workflowResultState.set(opId, this.head, operatorInfo);
        }
      );
    }

    return tools;
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

  getHead(): string {
    return this.head;
  }

  getAncestorPath(stepId?: string): string[] {
    const target = stepId ?? this.head;
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

  getWorkflowResultState(): WorkflowResultState {
    return this.workflowResultState;
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
    const path = this.getAncestorPath();
    return path
      .filter(id => id !== INITIAL_STEP_ID)
      .map(id => this.stepsById.get(id)!)
      .filter(Boolean);
  }

  getAllSteps(): ReActStep[] {
    return Array.from(this.stepsById.values()).filter(s => s.id !== INITIAL_STEP_ID);
  }

  checkout(stepId: string): boolean {
    const step = this.stepsById.get(stepId);
    if (!step && stepId !== INITIAL_STEP_ID) return false;
    this.head = stepId;
    if (step?.afterWorkflowContent) {
      this.workflowState.setWorkflowContent(step.afterWorkflowContent);
    }
    return true;
  }

  setStepCallback(callback: ReActStepCallback | null): void {
    this.stepCallback = callback;
  }

  private generateStepId(): string {
    return `step-${this.agentId}-${++this.stepCounter}-${Date.now()}`;
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
    allowedOperatorTypes?: string[];
    agentMode?: AgentMode;
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
    if (updates.allowedOperatorTypes !== undefined) {
      this.settings.allowedOperatorTypes = updates.allowedOperatorTypes;
      promptNeedsRebuild = true;
    }
    if (updates.agentMode !== undefined && updates.agentMode !== this.settings.agentMode) {
      this.settings.agentMode = updates.agentMode;
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
    // HEAD at a real step means the workflow is determined by that step's snapshot;
    // only reload from backend when HEAD is the initial sentinel.
    if (this.head !== INITIAL_STEP_ID) {
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
      let beforeStepContent = this.workflowState.getWorkflowContent();

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
        beforeWorkflowContent: beforeStepContent,
        afterWorkflowContent: beforeStepContent,
        usage: {
          inputTokens: estimatedInputTokens,
          outputTokens: 0,
          totalTokens: estimatedInputTokens,
        },
      };
      this.addStep(userStep);
      this.head = userStepId;

      let isFirstStep = true;
      let lastPreparedMessages: ModelMessage[] | undefined;

      // Pass only the current user turn; prepareStep rebuilds full context each step
      // (historical interactions + DAG + this message).
      const currentUserMessage: ModelMessage[] = [{ role: "user", content: userMessage }];
      const result = await generateText({
        model: this.model,
        system: this.systemPrompt,
        messages: currentUserMessage,
        tools: this.tools,
        temperature: 0.2,
        stopWhen: stepCountIs(this.settings.maxSteps),
        prepareStep: async ({ stepNumber, messages: currentMessages }) => {
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
          const processed = assembleContext(
            visibleSteps,
            this.workflowState,
            this.getFormattedResultsForDAG(),
            false,
            compilationResult,
            this.settings.agentMode
          );
          lastPreparedMessages = processed;
          return { messages: processed };
        },
        abortSignal: this.abortController?.signal,
        // reasoning_effort is configured per-model in litellm-config.yaml via extra_body
        // to bypass LiteLLM's param validation — do not pass it here.
        providerOptions: {
          openai: { parallelToolCalls: false },
          anthropic: { disableParallelToolUse: true },
          mistral: { parallelToolCalls: false },
        },
        onStepFinish: async ({ text, toolCalls, toolResults, usage }) => {
          stepIndex++;

          const formattedToolCalls = toolCalls?.map(tc => ({
            toolName: tc.toolName,
            toolCallId: tc.toolCallId,
            input: tc.input,
          }));

          const formattedToolResults = toolResults?.map(tr => {
            // Workflow tools return plain strings; an `[ERROR] ...` prefix is the
            // failure signal. Also keep the legacy structured-error check so a
            // tool that returns `{ error: ... }` still flags as failed.
            const outputStr = typeof tr.output === "string" ? tr.output : "";
            const isError = !!(tr.output as any)?.error || outputStr.startsWith("[ERROR]");
            return {
              toolCallId: tr.toolCallId,
              output: tr.output,
              isError,
            };
          });

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
            beforeWorkflowContent: beforeStepContent,
            afterWorkflowContent: afterStepContent,
          };
          lastPreparedMessages = undefined;
          this.addStep(agentStep);
          this.head = agentStepId;

          await this.runPostStepExecution(toolCalls, toolResults);

          beforeStepContent = afterStepContent;
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

      const finalUsage = (result as any).totalUsage || result.usage;
      const usage: TokenUsage = {
        inputTokens: finalUsage?.inputTokens ?? finalUsage?.promptTokens ?? 0,
        outputTokens: finalUsage?.outputTokens ?? finalUsage?.completionTokens ?? 0,
        totalTokens: finalUsage?.totalTokens ?? 0,
      };

      return {
        response: result.text,
        messages: result.response.messages,
        usage,
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

  private getFormattedResultsForDAG(): Map<string, string> {
    const result = new Map<string, string>();
    const visible = this.workflowResultState.getAllVisible();
    for (const [operatorId, entry] of visible) {
      result.set(operatorId, formatOperatorResult(operatorId, entry.operatorInfo, this.workflowState));
    }
    return result;
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
    const processed = assembleContext(
      visibleSteps,
      this.workflowState,
      this.getFormattedResultsForDAG(),
      false,
      null,
      this.settings.agentMode
    );
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
    this.head = INITIAL_STEP_ID;
    const initialStep: ReActStep = {
      id: INITIAL_STEP_ID,
      messageId: "initial",
      stepId: -1,
      timestamp: Date.now(),
      role: "user",
      content: "",
      isBegin: true,
      isEnd: true,
    };
    this.stepsById.set(INITIAL_STEP_ID, initialStep);
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
   * Run the post-step operator-execution loop for tool calls that just modified
   * the workflow. Skips when there's no execution config (no delegate mode),
   * when the tool isn't in EXECUTE_AFTER_TOOLS, or when the tool result was an
   * error. Results are stored at the current HEAD via workflowResultState.
   *
   * Used by both `sendMessage` (LLM path) and `handleDebugInput` (debug path)
   * so a Function(...) tool call has identical post-step behaviour to an
   * LLM-emitted one.
   */
  private async runPostStepExecution(
    toolCalls: ReadonlyArray<{ toolName: string; toolCallId: string; input: any }> | undefined,
    toolResults: ReadonlyArray<{ toolCallId: string; output: any; isError?: boolean }> | undefined
  ): Promise<void> {
    const execConfig = this.buildExecutionConfig();
    if (!execConfig || !toolCalls || !toolResults) return;

    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      const tr = toolResults[i];
      if (!EXECUTE_AFTER_TOOLS.has(tc.toolName)) continue;

      if (tr?.isError) continue;
      const resultText = typeof tr?.output === "string" ? tr.output : String(tr?.output ?? "");
      if (resultText.startsWith("[ERROR]")) continue;

      const operatorId = (tc.input as any)?.operatorId;
      if (!operatorId) continue;

      try {
        await executeOperatorAndFormat(this.workflowState, execConfig, operatorId, {
          abortSignal: this.abortController?.signal,
          onResult: (opId, operatorInfo) => {
            this.workflowResultState.set(opId, this.head, operatorInfo);
          },
        });
      } catch (e: any) {
        this.log.warn({ operatorId, err: e?.message || e }, "post-step execution failed");
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
      const beforeContent = this.workflowState.getWorkflowContent();

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
          beforeWorkflowContent: beforeContent,
          afterWorkflowContent: beforeContent,
        };
        this.addStep(userStep);
        this.head = userStepId;
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
          beforeWorkflowContent: beforeContent,
          afterWorkflowContent: beforeContent,
        };
        this.addStep(errorStep);
        this.head = errorStepId;
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
        beforeWorkflowContent: beforeContent,
        afterWorkflowContent: afterContent,
      };
      this.addStep(agentStep);
      this.head = agentStepId;

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
