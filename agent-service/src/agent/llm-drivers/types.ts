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
import type { ReActStep, TokenUsage, AgentSettings, LocalToolDialect } from "../../types/agent";
import type { WorkflowState } from "../workflow-state";
import type { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";
import type { WorkflowCompilationResponse } from "../../api/compile-api";

/**
 * Bag of agent state a context assembler reads from when rendering the
 * next prepareStep message. Each assembler ignores fields it doesn't need
 * — the SDK-driver assembler uses every field; the local-react assembler
 * uses only `visibleSteps`, `workflowState`, and `snapshotStorage`.
 *
 * `compilationResult` is `null` whenever the agent intentionally skipped
 * compilation (e.g. `getNextStepContext()` previews or empty workflows).
 */
export interface ContextAssemblerInput {
  visibleSteps: ReActStep[];
  workflowState: WorkflowState;
  snapshotStorage: WorkflowSnapshotStorage;
  settings: AgentSettings;
  compilationResult: WorkflowCompilationResponse | null;
  /** GLOBAL turn number per messageId (ask order over the whole session). */
  turnNumberByMessageId?: Map<string, number>;
}

/**
 * Renderer that converts the agent's current state into the message array the
 * driver should send on the wire. Bound at agent construction; travels paired
 * with the driver. May be async: the LLM context-tuner assembler awaits a
 * teacher-model call, while the rule/legacy assemblers stay synchronous. The
 * agent awaits the result on the (async) prepareStep path; the synchronous
 * `getNextStepContext` preview returns the last rendered content when the
 * assembler is async (it cannot await).
 */
export type ContextAssembler = (input: ContextAssemblerInput) => ModelMessage[] | Promise<ModelMessage[]>;

/**
 * Per-step callback the driver invokes after each model turn. Matches the
 * shape of the Vercel AI SDK's `generateText({ onStepFinish })` payload so
 * the closure inside `TexeraAgent.sendMessage` is driver-agnostic — it
 * records the step, snapshots HEAD, fires post-step execution, etc.
 *
 * For both drivers the contract is the same: one call per emitted
 * assistant turn. A turn with zero tool calls is still a step (the model's
 * final text-only reply for the SDK driver, or the terminal "no actions"
 * step for the local-react driver).
 */
export interface DriverStepFinish {
  text: string;
  /** Provider reasoning summary for the step, when the model exposes one.
   *  Display-only — never folded into `text`, which is replayed as context. */
  reasoningText?: string;
  toolCalls?: Array<{ toolName: string; toolCallId: string; input: any }>;
  toolResults?: Array<{ toolCallId: string; output: any; isError?: boolean }>;
  usage?: TokenUsage;
}

/**
 * Per-step `prepareStep` hook. The driver calls this before each model
 * request so the agent can re-render context against the latest workflow
 * state. Returns the messages array the driver should send on the wire.
 *
 * Mirrors the Vercel AI SDK's `prepareStep` signature so the same closure
 * works for both drivers.
 */
export type DriverPrepareStep = (args: {
  stepNumber: number;
  messages: ModelMessage[];
}) => Promise<{ messages: ModelMessage[] }>;

/**
 * Input to one full `sendMessage` turn. The agent passes its tool surface
 * and lifecycle callbacks; the driver decides how to convert that into one
 * or more LLM requests, when to stop, and how to map results back through
 * `onStepFinish`.
 */
export interface DriverRunTurnInput {
  /** Initial messages — typically `[{ role: "user", content: userMessage }]`.
   *  Passed through to `prepareStep` on the first iteration. */
  initialMessages: ModelMessage[];
  /** System prompt. Drivers that don't want a system message (e.g.
   *  local-react, whose prompt is baked into the model weights) ignore this. */
  systemPrompt: string | undefined;
  /** Executable tool registry, keyed by toolName. The local-react driver
   *  uses this directly to execute parsed actions; the SDK driver passes it
   *  to `generateText({ tools })`. */
  tools: Record<string, any>;
  /** Hard cap on the number of model turns per `sendMessage` invocation. */
  maxSteps: number;
  /** When true, the SDK driver asks the provider to allow multiple tool
   *  calls per turn. The local-react driver always supports multiple Action
   *  pairs in a single turn — this flag is effectively a no-op there. */
  parallelToolCalls: boolean;
  /** Native mode: the final answer is a reply without a tool call, accepted
   *  once a result of this task has been shown. Before that, such a reply is a
   *  lapse the agent corrects. */
  requireShownResult?: boolean;
  /** Whether a result of this task has been displayed (a retrieval succeeded). */
  resultShown?: () => boolean;
  /** The answer an `answer` statement composed in this task, if any: the
   *  request ends after that step, with it as the reply. */
  answered?: () => string | undefined;
  /** Tool-call dialect for the local text-mode driver — selects which parser
   *  it applies to the model's completion (`qwen-xml` → `parseQwenToolCall`,
   *  `react-text` → `parseReActText`). The SDK driver ignores it (native tool
   *  calls). Defaults to `qwen-xml` when unset. */
  toolDialect?: LocalToolDialect;
  abortSignal?: AbortSignal;
  prepareStep: DriverPrepareStep;
  onStepFinish: (args: DriverStepFinish) => Promise<void>;
}

export interface DriverRunTurnResult {
  /** Final text the driver produces. For the SDK driver this is
   *  `result.text` from `generateText`. For the local-react driver it's the
   *  last turn's parsed thought (or the empty string if none). */
  text: string;
  /** Final transcript. The SDK driver returns `result.response.messages`;
   *  the local-react driver returns the messages array it last sent. */
  messages: ModelMessage[];
  usage: TokenUsage;
}

/** Native turns end with a reply after a shown result. Preserve billed usage
 * when a model replies before computing anything, so the agent can correct it. */
export class MissingAnswerActionError extends Error {
  constructor(
    readonly partial: DriverRunTurnResult,
    readonly canContinue: boolean,
    /** The last reply was cut off at the output limit, so it is not an answer. */
    readonly cut = false
  ) {
    super(
      cut
        ? "The turn ended before a final reply: the model's last reply was cut off at the output limit; no final answer was produced."
        : "The turn ended before a final reply: the model stopped or reached the step limit; no final answer was produced."
    );
    this.name = "MissingAnswerActionError";
  }
}

/**
 * Strategy interface that hides the LLM call style from `TexeraAgent`.
 * Both implementations preserve the agent's bookkeeping invariants — they
 * call `prepareStep` before every model request and `onStepFinish` after
 * every emitted assistant turn.
 */
export interface LLMDriver {
  runTurn(input: DriverRunTurnInput): Promise<DriverRunTurnResult>;
}
