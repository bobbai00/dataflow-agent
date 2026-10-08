/**
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/** Translate only the explicitly supported native API capability. */
export function nativeModelCapabilityOptions(capabilities: unknown): {
  modelCapabilities?: { forcedToolChoice: boolean };
} {
  if (capabilities == null) return {};
  if (typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new TypeError("model_capabilities must be an object");
  }
  if (
    !Object.prototype.hasOwnProperty.call(capabilities, "forced_tool_choice")
  ) {
    return {};
  }
  const forced = (capabilities as Record<string, unknown>).forced_tool_choice;
  if (typeof forced !== "boolean") {
    throw new TypeError(
      "model_capabilities.forced_tool_choice must be boolean",
    );
  }
  return { modelCapabilities: { forcedToolChoice: forced } };
}

/** Omission preserves the service's existing environment/default deadline. */
export function nativeModelRequestTimeoutOptions(value: unknown): {
  modelRequestTimeoutMs?: number;
} {
  if (value === undefined) return {};
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0.001 ||
    value > 2_147_483.647
  ) {
    throw new TypeError(
      "model_request_timeout_seconds must be positive seconds with integer millisecond precision within portable timer range",
    );
  }
  const milliseconds = Math.round(value * 1000);
  if (value !== milliseconds / 1000) {
    throw new TypeError(
      "model_request_timeout_seconds must be positive seconds with integer millisecond precision within portable timer range",
    );
  }
  return { modelRequestTimeoutMs: milliseconds };
}

export function nativeRequestTimeoutProvenance(
  config: { model_request_timeout_seconds?: unknown },
  agentInfo?: {
    modelRequestTimeoutMs?: number;
    modelRequestTimeoutSource?: string;
    modelRequestTimeoutMethod?: string;
  },
) {
  const requested = nativeModelRequestTimeoutOptions(
    config.model_request_timeout_seconds,
  );
  return {
    schema_version: 1,
    requested_seconds: config.model_request_timeout_seconds ?? null,
    requested_ms: requested.modelRequestTimeoutMs ?? null,
    resolved_ms: agentInfo?.modelRequestTimeoutMs ?? null,
    resolution_source: agentInfo?.modelRequestTimeoutSource ?? "not_reported",
    enforcement_method: agentInfo?.modelRequestTimeoutMethod ?? "not_reported",
  };
}

/** Keep requested facts separate from the gateway profile used by native runs. */
export function nativeGenerationProvenance(config: {
  model: string;
  model_parameters?: unknown;
}) {
  return {
    schema_version: 1,
    requested_model_parameters: config.model_parameters ?? null,
    native_api_parameter_overrides: { applied: false },
    generation_profile: {
      source: "gateway_model_profile",
      model_route: config.model,
    },
    provider_request_evidence: "model-requests.jsonl",
  };
}
