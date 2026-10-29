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
 * CHARACTERIZATION (golden) tests for the context renderer.
 *
 * These snapshots freeze the byte-exact text the renderer produces, before the
 * transcript frames it, across a matrix of representative configurations. They
 * are the parity oracle for refactors of the renderer — they must keep passing
 * UNCHANGED. If a snapshot diff ever appears here, the refactor changed
 * rendering behavior and must be fixed (or the change must be a deliberate,
 * reviewed decision).
 *
 * The fixture (buildRichScenario) exercises every serializer branch: see
 * fixtures.ts.
 */

import { describe, expect, test } from "bun:test";
import type { AssembleContextOptions } from "../../util/context-utils";
import { buildRichScenario, renderText } from "./fixtures";

function render(options: AssembleContextOptions): string {
  return renderText(buildRichScenario(), options);
}

describe("golden — DELTA", () => {
  test("default (lossless)", () => {
    expect(render({})).toMatchSnapshot();
  });

  test("Schema line in observations", () => {
    expect(render({ schemaInResult: true })).toMatchSnapshot();
  });

  test("windowed — sliding compaction", () => {
    expect(render({ contextWindowTokens: 400, compactionStrategy: "sliding" })).toMatchSnapshot();
  });

  test("windowed — compress compaction (stats deck)", () => {
    expect(
      render({ contextWindowTokens: 400, compactionStrategy: "compress", deckSampleRatio: 0.1 })
    ).toMatchSnapshot();
  });
});
