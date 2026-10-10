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

/**
 * summarize() — THE centralized context renderer.
 *
 * One pure function from (agent data, parameters) to the assembled context
 * text. The legacy LATEST / DELTA context modes are implemented as two preset
 * parameter points (see params.ts `latestPreset` / `deltaPreset` /
 * `mapLegacyToParams`); `assembleContext` in context-utils delegates here, so
 * every context the agent ever sends flows through this function.
 *
 *   Output: the trajectory (events + observations) and/or the current
 *           dataflow (operator list), per params — as one markdown text,
 *           plus a per-section token breakdown for cost attribution.
 *   Input:  data parameters (steps + snapshot tree + optional compilation),
 *           from which the DOSSIER derives per-operator code/result versions;
 *           and the tunable params (see params.ts).
 *
 * Purity: no I/O, no wall clock — a recorded trace re-renders offline under
 * any params (the knob-probing instrument).
 */

import type { ModelMessage } from "ai";
import { AgentMode, ContextMode, type ReActStep } from "../../../types/agent";
import type { WorkflowState } from "../../workflow-state";
import type { WorkflowSnapshotStorage } from "../../workflow-snapshot-storage";
import type { WorkflowCompilationResponse } from "../../../api/compile-api";
import { estimateTokens, renderContextCore, type AssembleContextOptions } from "../../util/context-utils";
import { buildNativeFrames, splitTrailingState, splitOperators, splitTurns } from "./native-frames";
import { buildDossier, type CodeVersion, type Dossier, type ResultVersion } from "./dossier";
import {
  resolveOperatorParams,
  type ColumnParams,
  type ResultRender,
  type SummarizeParams,
  type TupleParams,
} from "./params";

export interface SummarizeInput {
  visibleSteps: ReActStep[];
  workflowState: WorkflowState;
  snapshotStorage: WorkflowSnapshotStorage;
  compilationResult?: WorkflowCompilationResponse | null;
  /** Optional prebuilt dossier. The selector builds the dossier to choose
   *  params, then passes it here so summarize() reuses it instead of rebuilding
   *  (a per-step saving on the hot path). Omit ⇒ summarize builds it lazily. */
  dossier?: Dossier;
}

/**
 * Per-operator render extras resolved from (params defaults ⊕ overrides) +
 * the dossier. Consumed by the operator serializers in context-utils via
 * `options.opExtras`. Only present when the params deviate from the pure
 * legacy surface — so legacy renders never take this path (byte-parity by
 * construction).
 */
export interface OperatorRenderExtras {
  detail: "omit" | "shape" | "sample";
  tuple: TupleParams;
  column: ColumnParams;
  includeProperties: boolean;
  includeCode: boolean;
  /** Char budget for the `Code:` block; 0 ⇒ unlimited. */
  codeMaxChars: number;
  /** Prior code versions to render, newest-first (current version excluded). */
  codeHistory: CodeVersion[];
  /** Prior result versions to render, newest-first (latest excluded). */
  resultHistory: Array<{ version: ResultVersion; render: ResultRender }>;
  /** Rank-4 probe retirement: renders as the Result body (plus the Schema line
   *  when on) instead of the table/stats. */
  retirementFact?: string;
}

export interface SummarizeSection {
  title: string;
  tokens: number;
}

export interface SummarizeResult {
  text: string;
  /** The wire shape `prepareStep` expects: one user message carrying `text`. */
  messages: ModelMessage[];
  breakdown: { totalTokens: number; sections: SummarizeSection[] };
}

export function summarize(input: SummarizeInput, params: SummarizeParams): SummarizeResult {
  const interleaved = params.trajectory.events === "interleaved";
  const mode = interleaved ? ContextMode.DELTA : ContextMode.LATEST;
  const options = paramsToRenderOptions(params, input.compilationResult ?? null);

  if (needsExtras(params)) {
    // Reuse a caller-supplied dossier (selector path); else build it lazily —
    // only when a non-legacy capability is on.
    const dossier = input.dossier ?? buildDossier(input.visibleSteps, input.snapshotStorage);
    const cache = new Map<string, OperatorRenderExtras>();
    options.opExtras = (opId: string) => {
      let ex = cache.get(opId);
      if (!ex) {
        ex = resolveExtras(params, dossier, opId, interleaved);
        cache.set(opId, ex);
      }
      return ex;
    };
  }

  // NATIVE FRAMES: collect which step produced each rendered event so the
  // transcript can carry that step's REAL tool calls (true toolCallIds).
  const stepByEvent = new Map<number, ReActStep>();
  if (params.messageLayout === "native") {
    options.eventStepSink = (eventIndex, step) => stepByEvent.set(eventIndex, step);
  }
  const text = renderContextCore(input.visibleSteps, input.workflowState, input.snapshotStorage, mode, options);
  const messages: ModelMessage[] = buildMessages(params.messageLayout, text, stepByEvent);
  return {
    text,
    messages,
    breakdown: computeBreakdown(text),
  };
}

/**
 * Frame the rendered context as wire messages.
 *
 *   block      one user message — the original shape. Uncacheable: the whole
 *              thing is re-rendered every step, so no prefix ever repeats.
 *   blockSplit same bytes, cut into [history][current state] so the history is
 *              a stable prefix a cache breakpoint can sit on.
 *   native     a real tool-calling transcript (see native-frames).
 *
 * blockSplit and native are cacheable for the same reason — an append-only
 * prefix with the volatile current-state section pushed last. They differ only
 * in whether the history is prose in a user turn or real assistant/tool turns,
 * which is what isolates "does the framing change accuracy" from "does it
 * change cost".
 */
function buildMessages(layout: string | undefined, text: string, stepByEvent: Map<number, ReActStep>): ModelMessage[] {
  if (layout === "native") return buildNativeFrames(text, stepByEvent).messages;
  if (layout === "turnSplit") {
    const parts = splitTurns(text);
    if (parts.length > 1) {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      if (norm(parts.join("\n\n")) === norm(text)) {
        return parts.map(content => ({ role: "user" as const, content }));
      }
    }
    return [{ role: "user", content: text }];
  }
  // opBlock shares opSplit's cut points (`### <type> operator \`id\``); it
  // differs in what the RENDERER puts inside each block, not in how the text
  // is framed — see serializeOperatorFull's operator-block contract.
  if (layout === "opSplit" || layout === "opBlock") {
    // An empty dataflow (step 1) still ends with the `# Current Dataflow`
    // header, so the first message is byte-identical from step 1 onwards.
    if (
      !/^# Current Dataflow$/m.test(text) &&
      !/^### /m.test(text) &&
      !/^- \*\*[A-Za-z_][A-Za-z0-9_]*\*\* \(/m.test(text)
    ) {
      return [{ role: "user", content: text.trimEnd() + "\n\n# Current Dataflow\n## Operators" }];
    }
    const parts = splitOperators(text);
    // Same byte-parity contract as blockSplit: a framing change, never a
    // content change. If the parts do not reconstruct the render, ship the
    // single block rather than send the model something the renderer
    // did not produce.
    if (parts.length > 1) {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      if (norm(parts.join("\n\n")) === norm(text)) {
        return parts.map(content => ({ role: "user" as const, content }));
      }
    }
  }
  if (layout === "blockSplit") {
    const { head, tail } = splitTrailingState(text);
    // Structure must be preserved EXACTLY: blockSplit is a wire-framing change
    // for cache purposes, never a content change. If the two halves do not
    // reconstruct the render byte-for-byte (ignoring the join whitespace), the
    // split is wrong and we ship the original single block rather than send the
    // model something the renderer did not produce.
    if (tail) {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim();
      if (norm(head + "\n\n" + tail) === norm(text)) {
        return [
          { role: "user", content: head },
          { role: "user", content: tail },
        ];
      }
    }
  }
  return [{ role: "user", content: text }];
}

/* ============================================================================
 *  params → legacy render-option bag (the parity-critical inverse mapping)
 * ========================================================================= */

/**
 * Convert the parameter object into the internal render-option bag the
 * renderers consume. Together with `mapLegacyToParams` this must round-trip:
 * legacy options → params → options must render byte-identically (enforced by
 * the golden characterization tests).
 */
export function paramsToRenderOptions(
  params: SummarizeParams,
  compilationResult: WorkflowCompilationResponse | null
): AssembleContextOptions {
  const d = params.operators.defaults;
  const col = d.result.latest.column;
  const interleaved = params.trajectory.events === "interleaved";
  return {
    compilationResult,
    nativeEvidence: params.nativeEvidence,
    agentMode: AgentMode.CODE,
    resultSelection: params.resultSelection,
    // The renderer needs the layout for one decision: in the native transcript
    // a later turn's request is also rendered inline (see renderAgentEvents).
    messageLayout: params.messageLayout,
    agentTurns: params.trajectory.agentTurns,
    contextWindowTokens: params.trajectory.windowTokens > 0 ? params.trajectory.windowTokens : undefined,
    compactionStrategy: params.trajectory.compaction,
    deckSampleRatio: params.trajectory.deckSampleRatio,
    staticCompaction: params.trajectory.staticCompaction,
    compactionRule: params.trajectory.compactionRule,
    compactBoundaryFloor: params.trajectory.compactBoundaryFloor,
    foldResolvedRevisions: params.trajectory.foldResolvedRevisions,
    foldGraceEvents: params.trajectory.foldGraceEvents,
    userTaskPlacement: params.trajectory.userTaskPlacement,
    renderPrefsEnabled: params.trajectory.renderPrefs,
    includeOperatorProperties: d.property.includeProperties,
    schemaInResult: col.schema,
    maxResultRows: d.result.latest.tuple.sampleRows,
    maxResultChars: d.result.latest.tuple.maxChars,
    maxOperatorResultCellCharLimit: params.maxCellChars > 0 ? params.maxCellChars : undefined,
    thoughtReplay: params.trajectory.reasoningReplayK > 0,
    thoughtReplayK: params.trajectory.reasoningReplayK > 0 ? params.trajectory.reasoningReplayK : undefined,
    errorReflection: params.flow.errorReflection,
    errorReflectionThreshold: params.flow.errorReflectionThreshold,
    attemptReflection: params.flow.attemptReflection,
    // New orthogonal combinations (no legacy analog):
    omitObservations: params.trajectory.observations === "none",
    appendCurrentSnapshot: interleaved && params.currentSnapshot,
    omitCurrentSnapshot: !interleaved && !params.currentSnapshot,
  };
}

/** True when the params use any capability beyond the legacy flag surface —
 *  the gate for the per-operator extras path. Legacy-mapped params always
 *  return false here, keeping the golden-parity path untouched. */
export function needsExtras(params: SummarizeParams): boolean {
  if (Object.keys(params.operators.overrides).length > 0) return true;
  const d = params.operators.defaults;
  if (d.property.includeCode || d.property.codeHistory > 0) return true;
  if (d.result.latest.detail !== "sample") return true;
  if (d.result.latest.tuple.duplicates || d.result.latest.tuple.fdHints) return true;
  if (d.result.latest.tuple.maxChars > 0) return true;
  if (d.result.latest.column.schemaTypes === false) return true;
  if (d.result.history.lastK > 0) return true;
  return false;
}

/* ============================================================================
 *  Per-operator extras resolution
 * ========================================================================= */

function resolveExtras(
  params: SummarizeParams,
  dossier: Dossier,
  opId: string,
  interleaved: boolean
): OperatorRenderExtras {
  const op = resolveOperatorParams(params, opId);
  const d = dossier.operators.get(opId);

  const codeHistory: CodeVersion[] = [];
  const resultHistory: Array<{ version: ResultVersion; render: ResultRender }> = [];
  // Precedence rule (see params.ts): an interleaved trajectory IS the
  // history — per-operator history sections render only without one.
  if (!interleaved && d) {
    if (op.property.codeHistory > 0 && d.codeVersions.length > 1) {
      const prior = d.codeVersions.slice(0, -1);
      codeHistory.push(...prior.slice(-op.property.codeHistory).reverse());
    }
    if (op.result.history.lastK > 0 && op.result.history.render.detail !== "omit" && d.resultVersions.length > 1) {
      const prior = d.resultVersions.slice(0, -1);
      resultHistory.push(
        ...prior
          .slice(-op.result.history.lastK)
          .reverse()
          .map(version => ({ version, render: op.result.history.render }))
      );
    }
  }

  return {
    detail: op.result.latest.detail,
    tuple: op.result.latest.tuple,
    column: op.result.latest.column,
    includeProperties: op.property.includeProperties,
    includeCode: op.property.includeCode,
    codeMaxChars: op.property.codeMaxChars,
    codeHistory,
    resultHistory,
    retirementFact: op.result.latest.retirementFact,
  };
}

/* ============================================================================
 *  Breakdown
 * ========================================================================= */

/** Token attribution per top-level (`# `) section of the rendered text. */
export function computeBreakdown(text: string): SummarizeResult["breakdown"] {
  const sections: SummarizeSection[] = [];
  const lines = text.split("\n");
  let title = "(preamble)";
  let buf: string[] = [];
  const flush = () => {
    if (buf.length === 0) return;
    const body = buf.join("\n");
    if (body.trim().length > 0) sections.push({ title, tokens: estimateTokens(body) });
    buf = [];
  };
  for (const line of lines) {
    if (line.startsWith("# ")) {
      flush();
      title = line.slice(2).trim();
    }
    buf.push(line);
  }
  flush();
  return { totalTokens: estimateTokens(text), sections };
}
