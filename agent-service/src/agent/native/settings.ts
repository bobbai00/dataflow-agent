/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { AgentMode, DEFAULT_AGENT_SETTINGS } from "../../types/agent";
import type { NativeCatalogVersion } from "./catalog";

/** A rejected catalog configuration is a client error, not a server failure. */
export class NativeCatalogSettingsError extends Error {}

/** Shared by creation (before allocating an agent) and atomic settings updates. */
export function validateNativeCatalogSettings(
  settings: {
    nativeCatalogVersion?: string;
    agentMode?: string;
    nativeToolMode?: string;
  } = {}
): NativeCatalogVersion {
  const version = settings.nativeCatalogVersion ?? DEFAULT_AGENT_SETTINGS.nativeCatalogVersion ?? "v1";
  if (version !== "v1" && version !== "v2") {
    throw new NativeCatalogSettingsError("Unknown native catalog version");
  }
  if (
    version === "v2" &&
    ((settings.agentMode ?? DEFAULT_AGENT_SETTINGS.agentMode) !== AgentMode.NATIVE ||
      (settings.nativeToolMode ?? DEFAULT_AGENT_SETTINGS.nativeToolMode) !== "batch")
  ) {
    throw new NativeCatalogSettingsError("Native catalog v2 requires agentMode:native and nativeToolMode:batch");
  }
  return version;
}
