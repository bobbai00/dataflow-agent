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

import { env } from "../config/env";
import type { AgentInfo, AgentSettingsApi, ReActStep } from "../types/agent";
import type { WorkflowContent } from "../types/workflow";
import type { NativeObservation } from "../agent/native/evidence";
import type { NativeErrorQuery, NativeErrorSummary } from "../agent/native/diagnostics";

/**
 * Client for the agent-service's own HTTP + WebSocket surface.
 *
 * Lets external drivers (benchmarks, training-data generators, evals) treat
 * the agent the same way the frontend does: create one in delegate mode,
 * push a single user message over WS, collect the streamed ReAct trace, and
 * tear it down.
 */

const DEFAULT_BASE = process.env.TEXERA_AGENT_SERVICE_ENDPOINT ?? `http://localhost:${env.PORT}`;
const API_PREFIX = env.API_PREFIX;

function agentBase(baseUrl: string = DEFAULT_BASE): string {
  return `${baseUrl}${API_PREFIX}/agents`;
}

function wsBase(baseUrl: string = DEFAULT_BASE): string {
  return `${baseUrl.replace(/^http/, "ws")}${API_PREFIX}/agents`;
}

export interface CreateAgentOptions {
  modelType: string;
  name?: string;
  userToken?: string;
  workflowId?: number;
  computingUnitId?: number;
  settings?: AgentSettingsApi;
  baseUrl?: string;
}

export async function createAgent(opts: CreateAgentOptions): Promise<AgentInfo> {
  const body: Record<string, unknown> = {
    modelType: opts.modelType,
    name: opts.name,
    workflowId: opts.workflowId,
    computingUnitId: opts.computingUnitId,
    settings: opts.settings,
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];

  // The agent service reads the delegating user's JWT from the Authorization
  // header (apache/texera#5421), not the request body.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.userToken) headers["Authorization"] = `Bearer ${opts.userToken}`;

  const response = await fetch(`${agentBase(opts.baseUrl)}/`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create agent: ${response.status} ${response.statusText} - ${errorText}`);
  }
  return (await response.json()) as AgentInfo;
}

export async function deleteAgent(agentId: string, baseUrl?: string): Promise<void> {
  const response = await fetch(`${agentBase(baseUrl)}/${encodeURIComponent(agentId)}`, { method: "DELETE" });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to delete agent ${agentId}: ${response.status} ${response.statusText} - ${errorText}`);
  }
}

export async function clearAgentHistory(agentId: string, baseUrl?: string): Promise<void> {
  const response = await fetch(`${agentBase(baseUrl)}/${encodeURIComponent(agentId)}/clear`, { method: "POST" });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to clear agent ${agentId}: ${response.status} ${response.statusText} - ${errorText}`);
  }
}

export async function getReActSteps(agentId: string, baseUrl?: string): Promise<{ steps: ReActStep[]; state: string }> {
  const response = await fetch(`${agentBase(baseUrl)}/${encodeURIComponent(agentId)}/react-steps`);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to fetch react-steps for ${agentId}: ${response.status} ${response.statusText} - ${errorText}`
    );
  }
  return (await response.json()) as { steps: ReActStep[]; state: string };
}

export interface AgentSnapshot {
  stepId: string | null;
  workflow: WorkflowContent | null;
  workflowSourceStepId: string | null;
  results: Record<string, unknown>;
  /** Event-pinned V2 successful observations, including selection audit data. */
  nativeObservations?: Record<string, NativeObservation>;
}

export interface AgentErrorInspection {
  found: boolean;
  text: string;
  summary?: NativeErrorSummary;
}

/** Read a bounded diagnostic using the caller's current workflow permission.
 * No token in URL/body and no fallback to the service's delegated credential. */
export async function inspectAgentError(
  agentId: string,
  query: NativeErrorQuery,
  userToken: string,
  baseUrl?: string
): Promise<AgentErrorInspection> {
  const response = await fetch(`${agentBase(baseUrl)}/${encodeURIComponent(agentId)}/inspect-error`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
    body: JSON.stringify(query),
  });
  if (!response.ok && response.status !== 404)
    throw new Error(`Diagnostic inspection failed (HTTP ${response.status}).`);
  const body = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("found" in body) ||
    typeof body.found !== "boolean" ||
    !("text" in body) ||
    typeof body.text !== "string"
  )
    throw new Error(`Diagnostic inspection unavailable (HTTP ${response.status}).`);
  return body as AgentErrorInspection;
}

export interface CurrentWorkflowResponse {
  headId: string | null;
  workflow: WorkflowContent;
}

/**
 * Fetch the workflow the agent is currently editing. Cheaper than
 * `getSnapshot(id, "head")` when the caller doesn't need per-operator results.
 */
export async function getCurrentWorkflow(agentId: string, baseUrl?: string): Promise<CurrentWorkflowResponse> {
  const response = await fetch(`${agentBase(baseUrl)}/${encodeURIComponent(agentId)}/workflow`);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to fetch workflow for ${agentId}: ${response.status} ${response.statusText} - ${errorText}`
    );
  }
  return (await response.json()) as CurrentWorkflowResponse;
}

export async function getSnapshot(agentId: string, stepId: string | "head", baseUrl?: string): Promise<AgentSnapshot> {
  const response = await fetch(
    `${agentBase(baseUrl)}/${encodeURIComponent(agentId)}/snapshots/${encodeURIComponent(stepId)}`
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to fetch snapshot ${stepId} for ${agentId}: ${response.status} ${response.statusText} - ${errorText}`
    );
  }
  return (await response.json()) as AgentSnapshot;
}

/* ---------------- WebSocket runner ---------------- */

export interface AgentTurnSnapshotEvent {
  stepId: string;
  workflow: WorkflowContent;
}

export interface AgentTurnResult {
  /** Every ReAct step the agent emitted during this turn. */
  steps: ReActStep[];
  /** Final agent.state after the turn (e.g. "AVAILABLE"). */
  finalState: string;
  /** Last agent step's content if it has no toolCalls — i.e. the natural-language answer. */
  finalAnswer: string;
  /** Per-step workflow snapshots emitted via the `snapshot` event stream. */
  snapshots: AgentTurnSnapshotEvent[];
  /** True after a complete frame or REST confirmation of this request's terminal step. */
  completed: boolean;
  completionSource?: "websocket" | "rest";
  errors: string[];
}

interface RunAgentTurnOptions {
  /** Hard ceiling. Trips the resolver and returns a partial trace. Default 10 min. */
  timeoutMs?: number;
  /** Optional progress callback fired once per ReAct step. */
  onStep?: (step: ReActStep) => void;
  /** Optional snapshot callback fired once per snapshot frame. */
  onSnapshot?: (snapshot: AgentTurnSnapshotEvent) => void;
  baseUrl?: string;
}

interface IncomingFrame {
  type: "init" | "step" | "state" | "complete" | "error" | "headChange" | "nextContext" | "snapshot" | string;
  step?: ReActStep;
  steps?: ReActStep[];
  state?: string;
  error?: string;
  stepId?: string;
  workflow?: WorkflowContent;
}

/**
 * Send one user message, drain the ReAct trace, resolve when the WS sends
 * `complete` (or `error`, or the timeout fires).
 *
 * Doesn't throw on backend errors during the turn — surfaces them in
 * `errors[]` and returns a partial trace, so a batch driver can save what it
 * has and move on.
 */
export function runAgentTurn(
  agentId: string,
  message: string,
  options: RunAgentTurnOptions = {}
): Promise<AgentTurnResult> {
  const url = `${wsBase(options.baseUrl)}/${encodeURIComponent(agentId)}/react`;
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;

  return new Promise<AgentTurnResult>(resolve => {
    const stepsByMessageId = new Map<string, ReActStep>();
    const orderedStepIds: string[] = [];
    const snapshots: AgentTurnSnapshotEvent[] = [];
    const errors: string[] = [];
    let finalState = "UNKNOWN";
    let completed = false;
    let completionSource: AgentTurnResult["completionSource"];
    let resolved = false;
    let initSeen = false;
    let currentMessageId: string | undefined;
    let completionCheck: ReturnType<typeof setTimeout> | undefined;

    const ws = new WebSocket(url);

    const finish = () => {
      if (resolved) return;
      resolved = true;
      try {
        ws.close();
      } catch {
        // ignore — already closed
      }
      clearTimeout(timer);
      clearTimeout(completionCheck);

      const steps = orderedStepIds.map(id => stepsByMessageId.get(id)).filter((s): s is ReActStep => Boolean(s));
      // Init includes old answers. Retain that trace, but never return a prior
      // task's answer when the current request times out or is unacknowledged.
      const currentSteps = steps.filter(s => s.messageId === currentMessageId);

      // Prefer the step the server explicitly flagged as terminal (`isEnd`).
      // Fall back to the last agent step that has free-text content even if
      // it carried tool calls — the agent often emits its final summary in a
      // step that also fired one last tool call.
      const endStep = [...currentSteps].reverse().find(s => s.role === "agent" && s.isEnd);
      const lastWithContent = [...currentSteps]
        .reverse()
        .find(s => s.role === "agent" && (s.content ?? "").trim().length > 0);
      const finalAnswer = (endStep?.content ?? lastWithContent?.content ?? "").trim();

      resolve({ steps, finalState, finalAnswer, snapshots, completed, completionSource, errors });
    };

    const timer = setTimeout(() => {
      errors.push(`Timed out after ${timeoutMs}ms waiting for completion.`);
      finish();
    }, timeoutMs);

    const recordStep = (step: ReActStep) => {
      if (!stepsByMessageId.has(step.id)) orderedStepIds.push(step.id);
      stepsByMessageId.set(step.id, step);
      options.onStep?.(step);
    };

    // A large snapshot burst can leave a client without its complete frame.
    // Confirm the acknowledged request even if its terminal step was dropped;
    // never resend it or accept an old answer from the init frame.
    const confirmCompletion = async () => {
      completionCheck = undefined;
      if (resolved || !currentMessageId) return;
      try {
        const response = await fetch(`${agentBase(options.baseUrl)}/${encodeURIComponent(agentId)}/react-steps`, {
          signal: AbortSignal.timeout(5000),
        });
        if (resolved) return;
        if (response.ok) {
          const saved = (await response.json()) as { state: string; steps: ReActStep[] };
          if (resolved) return;
          const last = saved.steps.at(-1);
          if (
            saved.state === "AVAILABLE" &&
            last?.messageId === currentMessageId &&
            last.role === "agent" &&
            last.isEnd
          ) {
            for (const step of saved.steps) if (step.messageId === currentMessageId) recordStep(step);
            completed = true;
            completionSource = "rest";
            finalState = saved.state;
            finish();
            return;
          }
        }
      } catch {
        // The normal websocket and hard timeout remain authoritative when
        // the read cannot confirm completion.
      }
      if (!resolved && !completionCheck) completionCheck = setTimeout(confirmCompletion, 5000);
    };

    ws.onopen = () => {
      // Server expects {type:"message", content}. Sent right after the `init`
      // frame to keep ordering predictable, but Elysia is fine if it arrives
      // first.
    };

    ws.onmessage = ev => {
      let frame: IncomingFrame;
      try {
        frame = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
      } catch (err) {
        errors.push(`failed to parse WS frame: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      switch (frame.type) {
        case "init":
          // Server sends `init` with current state + steps. After this, send.
          if (frame.steps) for (const s of frame.steps) recordStep(s);
          if (!initSeen) {
            initSeen = true;
            try {
              ws.send(JSON.stringify({ type: "message", content: message }));
            } catch (err) {
              errors.push(`failed to send message: ${err instanceof Error ? err.message : String(err)}`);
              finish();
            }
          }
          break;
        case "step":
          if (frame.step) {
            if (!currentMessageId && frame.step.role === "user" && frame.step.content === message)
              currentMessageId = frame.step.messageId;
            recordStep(frame.step);
            if (currentMessageId && frame.step.messageId === currentMessageId && !resolved) {
              clearTimeout(completionCheck);
              completionCheck = setTimeout(
                confirmCompletion,
                frame.step.role === "agent" && frame.step.isEnd ? 1000 : 5000
              );
            }
          }
          break;
        case "state":
          if (frame.state) finalState = frame.state;
          break;
        case "snapshot":
          if (frame.stepId && frame.workflow) {
            const snap = { stepId: frame.stepId, workflow: frame.workflow };
            snapshots.push(snap);
            options.onSnapshot?.(snap);
          }
          break;
        case "complete":
          completed = true;
          completionSource = "websocket";
          if (frame.state) finalState = frame.state;
          finish();
          break;
        case "error":
          errors.push(frame.error ?? "unknown WS error");
          finish();
          break;
        // headChange / nextContext: not required for trace generation
        default:
          break;
      }
    };

    ws.onerror = ev => {
      const msg = (ev as ErrorEvent)?.message ?? "websocket error";
      errors.push(msg);
    };

    ws.onclose = () => {
      if (!resolved) {
        if (!completed) errors.push("websocket closed before complete frame");
        finish();
      }
    };
  });
}
