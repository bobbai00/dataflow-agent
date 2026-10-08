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

import type { ModelCapabilities, ResolvedModelCapabilities } from "../../types/agent";

const AUTOMATIC_TOOL_MODELS = new Set(["claude-sonnet-5.5", "claude-sonnet-5-5"]);

/** Resolve once per driver; explicit route facts take precedence over defaults. */
export function resolveModelCapabilities(modelId: string, overrides?: ModelCapabilities): ResolvedModelCapabilities {
  if (overrides !== undefined) {
    if (
      !overrides ||
      typeof overrides !== "object" ||
      Array.isArray(overrides) ||
      Object.keys(overrides).some(key => key !== "forcedToolChoice") ||
      (overrides.forcedToolChoice !== undefined && typeof overrides.forcedToolChoice !== "boolean")
    )
      throw new Error("Invalid model capabilities");
    if (overrides.forcedToolChoice !== undefined)
      return {
        forcedToolChoice: overrides.forcedToolChoice,
        forcedToolChoiceSource: "explicit",
      };
  }
  if (AUTOMATIC_TOOL_MODELS.has(modelId.split("/").at(-1)!))
    return {
      forcedToolChoice: false,
      forcedToolChoiceSource: "known_model_default",
    };
  return { forcedToolChoice: true, forcedToolChoiceSource: "default" };
}
