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
 * CHARACTERIZATION (golden) tests for the context assembler.
 *
 * These snapshots freeze the byte-exact output of `assembleContext` across a
 * matrix of representative configurations BEFORE the summarize() refactor.
 * The refactor routes assembleContext through the centralized summarize()
 * function; these tests are the parity oracle — they must keep passing
 * UNCHANGED. If a snapshot diff ever appears here, the refactor changed
 * rendering behavior and must be fixed (or the change must be a deliberate,
 * reviewed decision).
 *
 * The fixture (buildRichScenario) exercises every serializer branch: see
 * fixtures.ts. Each test passes a FRESH options object because
 * assembleContext mutates its options bag (reasoning / editCountsByOp / ...).
 */

import { describe, expect, test } from "bun:test";
import { assembleContext } from "../../util/context-utils";
import { AgentMode, ContextMode } from "../../../types/agent";
import type { AssembleContextOptions } from "../../util/context-utils";
import { buildRichScenario, contentOf } from "./fixtures";

function render(mode: ContextMode, options: AssembleContextOptions): string {
  const { steps, storage, workflowState } = buildRichScenario();
  return contentOf(assembleContext(steps, workflowState, storage, mode, options));
}

/** Server-default base: what buildContextAssembler passes for a fresh agent
 *  (minus the mode-specific knobs each test sets explicitly). */
function base(): AssembleContextOptions {
  return {
    compilationResult: null,
    agentMode: AgentMode.CODE,
    includeOperatorProperties: true,
    maxOperatorResultCellCharLimit: 2000,
  };
}

describe("golden — LATEST", () => {
  test("default (thoughtReplay on, as DEFAULT_AGENT_SETTINGS)", () => {
    expect(render(ContextMode.LATEST, { ...base(), thoughtReplay: true, thoughtReplayK: 10 })).toMatchSnapshot();
  });

  test("plain (no reinjection rungs)", () => {
    expect(render(ContextMode.LATEST, base())).toMatchSnapshot();
  });

  test("agentTurns trajectory section", () => {
    expect(render(ContextMode.LATEST, { ...base(), agentTurns: true })).toMatchSnapshot();
  });

  test("reflection rungs (errorReflection + attemptReflection)", () => {
    expect(
      render(ContextMode.LATEST, {
        ...base(),
        errorReflection: true,
        errorReflectionThreshold: 3,
        attemptReflection: true,
      })
    ).toMatchSnapshot();
  });
});

describe("golden — DELTA", () => {
  test("default (lossless)", () => {
    expect(render(ContextMode.DELTA, base())).toMatchSnapshot();
  });

  test("Schema line in observations", () => {
    expect(render(ContextMode.DELTA, { ...base(), schemaInResult: true })).toMatchSnapshot();
  });

  test("windowed — sliding compaction", () => {
    expect(
      render(ContextMode.DELTA, { ...base(), contextWindowTokens: 400, compactionStrategy: "sliding" })
    ).toMatchSnapshot();
  });

  test("windowed — compress compaction (stats deck)", () => {
    expect(
      render(ContextMode.DELTA, {
        ...base(),
        contextWindowTokens: 400,
        compactionStrategy: "compress",
        deckSampleRatio: 0.1,
      })
    ).toMatchSnapshot();
  });
});
