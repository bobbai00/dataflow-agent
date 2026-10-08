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

import { describe, expect, test } from "bun:test";
import { resolveModelCapabilities } from "./model-capabilities";

describe("forced tool-choice capability resolution", () => {
  test("preserves known Sonnet alias defaults and other-model defaults", () => {
    for (const model of ["claude-sonnet-5.5", "claude-sonnet-5-5", "anthropic/claude-sonnet-5.5"])
      expect(resolveModelCapabilities(model)).toEqual({
        forcedToolChoice: false,
        forcedToolChoiceSource: "known_model_default",
      });
    expect(resolveModelCapabilities("custom-model")).toEqual({
      forcedToolChoice: true,
      forcedToolChoiceSource: "default",
    });
  });
  test("explicit capabilities apply to any model and report their provenance", () => {
    expect(resolveModelCapabilities("custom-model", { forcedToolChoice: false })).toEqual({
      forcedToolChoice: false,
      forcedToolChoiceSource: "explicit",
    });
    expect(resolveModelCapabilities("claude-sonnet-5.5", { forcedToolChoice: true })).toEqual({
      forcedToolChoice: true,
      forcedToolChoiceSource: "explicit",
    });
  });
  test("invalid capability payloads fail before model dispatch", () => {
    for (const value of [null, [], { forcedToolChoice: "false" }, { forcedToolChoice: 0 }, { temperature: 0.7 }])
      expect(() => resolveModelCapabilities("custom-model", value as any)).toThrow("Invalid model capabilities");
  });
});
