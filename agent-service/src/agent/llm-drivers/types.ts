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
import type { ReActStep, TokenUsage, AgentSettings } from "../../types/agent";
import type { WorkflowState } from "../workflow-state";
import type { WorkflowSnapshotStorage } from "../workflow-snapshot-storage";

/** Bag of agent state a context assembler reads from when rendering the
 * next prepareStep message. */
export interface ContextAssemblerInput {
  visibleSteps: ReActStep[];
  workflowState: WorkflowState;
  snapshotStorage: WorkflowSnapshotStorage;
  settings: AgentSettings;
}

/**
 * Renderer that converts the agent's current state into the message array the
 * driver should send on the wire. Bound at agent construction; travels paired
 * with the driver.
 */
export type ContextAssembler = (input: ContextAssemblerInput) => ModelMessage[];

/**
 * Per-step callback the driver invokes after each model turn. Matches the
 * shape of the Vercel AI SDK's `generateText({ onStepFinish })` payload so
 * the closure inside `TexeraAgent.sendMessage` is driver-agnostic — it
 * records the step, snapshots HEAD, fires post-step execution, etc.
 *
 * The contract: one call per emitted assistant turn. A turn with zero tool
 * calls (the model's final text-only reply) is still a step.
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
 * Mirrors the Vercel AI SDK's `prepareStep` signature.
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
  systemPrompt: string | undefined;
  /** Executable tool registry, keyed by toolName; the SDK driver passes it
   *  to `generateText({ tools })`. */
  tools: Record<string, any>;
  /** Hard cap on the number of model turns per `sendMessage` invocation. */
  maxSteps: number;
  /** Whether a result of this task has been displayed (a retrieval succeeded).
   *  The final answer is a reply without a tool call, accepted once a result
   *  of this task has been shown. Before that, such a reply is a lapse the
   *  agent corrects. */
  resultShown?: () => boolean;
  abortSignal?: AbortSignal;
  prepareStep: DriverPrepareStep;
  onStepFinish: (args: DriverStepFinish) => Promise<void>;
}

export interface DriverRunTurnResult {
  /** Final text the driver produces: `result.text` from `generateText`. */
  text: string;
  /** Final transcript: `result.response.messages`. */
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

/** The provider refused the request: an empty reply ended by its content
 * filter. Retried with the turn like a dropped connection. */
export class ProviderRefusalError extends Error {
  constructor() {
    super("The provider refused the request (content filter): the model returned no reply and no tool call.");
    this.name = "ProviderRefusalError";
  }
}

/**
 * Strategy interface that hides the LLM call style from `TexeraAgent`. An
 * implementation preserves the agent's bookkeeping invariants: it calls
 * `prepareStep` before every model request and `onStepFinish` after every
 * emitted assistant turn.
 */
export interface LLMDriver {
  runTurn(input: DriverRunTurnInput): Promise<DriverRunTurnResult>;
}
