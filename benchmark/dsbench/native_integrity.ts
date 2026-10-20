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
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";

type NativeFormat = "expression" | "json";

/** Validate the declared protocol before importing SDKs or provisioning. */
export function nativeFormatSettings(config: {
  native_format?: unknown;
  native_format_schema_sha256?: unknown;
  native_format_prompt_sha256?: unknown;
  settings?: Record<string, unknown>;
}): Record<string, unknown> {
  const format = config.native_format;
  if (format !== undefined && format !== "expression" && format !== "json")
    throw new TypeError("native format must be expression or json");
  for (const value of [
    config.native_format_schema_sha256,
    config.native_format_prompt_sha256,
  ])
    if (
      value !== undefined &&
      (format === undefined ||
        typeof value !== "string" ||
        !/^[a-f0-9]{64}$/.test(value))
    )
      throw new TypeError(
        "native format hashes require an explicit format and SHA-256 hex",
      );
  const settings = { ...config.settings };
  if (format !== undefined) {
    if (settings.nativeFormat !== undefined && settings.nativeFormat !== format)
      throw new TypeError("native format differs from recorded settings");
    settings.nativeFormat = format;
  }
  return settings;
}

/** Match the API attestation to the actual model-facing prompt and schema. */
export function verifyNativeProtocol(
  protocol: any,
  info: any,
  format: NativeFormat,
  expectedSchema?: string,
  expectedPrompt?: string,
): {
  format: NativeFormat;
  toolSchemaSha256: string;
  systemPromptSha256: string;
} {
  assert(
    protocol?.format === format,
    "Resolved native format differs or is not reported",
  );
  const tool = info?.tools?.find((item: any) => item.name === "dataflow");
  assert(
    tool?.inputSchema && typeof info?.systemPrompt === "string",
    "Model-facing native format bundle is required",
  );
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  if (format === "json")
    assert(
      typeof tool.strict === "boolean",
      "JSON native tool strict flag must be boolean",
    );
  const schema = hash(
    JSON.stringify(
      format === "json"
        ? {
            inputSchema: tool.inputSchema,
            strict: tool.strict,
          }
        : tool.inputSchema,
    ),
  );
  const prompt = hash(info.systemPrompt);
  assert.equal(
    protocol.toolSchemaSha256,
    schema,
    "Native tool schema hash differs from system-info",
  );
  assert.equal(
    protocol.systemPromptSha256,
    prompt,
    "Native system prompt hash differs from system-info",
  );
  if (expectedSchema !== undefined)
    assert.equal(
      schema,
      expectedSchema,
      "Native tool schema hash differs from frozen protocol",
    );
  if (expectedPrompt !== undefined)
    assert.equal(
      prompt,
      expectedPrompt,
      "Native system prompt hash differs from frozen protocol",
    );
  return { format, toolSchemaSha256: schema, systemPromptSha256: prompt };
}

export function verifyNativeRetrievalViews(
  info: any,
  format: NativeFormat,
  views: readonly string[],
): void {
  const tool = info?.tools?.find((item: any) => item.name === "dataflow");
  const action = format === "json" ? "read" : "retrieve";
  const retrieval = tool?.inputSchema?.properties?.actions?.items?.anyOf?.find(
    (item: any) => item.properties?.type?.const === action,
  );
  assert(
    retrieval,
    "Native format retrieval action is absent from tool schema",
  );
  assert.deepEqual(
    retrieval.properties.view.enum,
    views,
    "Retrieval views differ from frozen settings",
  );
}

export function verifyLoadedService(
  ledger: any,
  expectedSourceHashes: Record<string, string>,
  ownedPid?: number,
): void {
  assert(
    ledger.version === 1 && ledger.source === "transport",
    "Authoritative transport model accounting is required",
  );
  assert.equal(
    ledger.attemptedRequests,
    0,
    "Fresh agent has prior model requests",
  );
  for (const required of [
    "src/server.ts",
    "src/agent/texera-agent.ts",
    "src/agent/prompts/native-mode-single.md",
    "src/agent/native/catalog.ts",
    "src/agent/native/python/runtime.py",
    "src/agent/util/context-utils.ts",
    "package.json",
    "bun.lock",
  ])
    assert(
      expectedSourceHashes[required],
      `Incomplete expected startup inventory: ${required}`,
    );
  const runtime = ledger.serviceRuntime;
  assert(
    runtime?.version === 1 &&
      Object.keys(runtime.sourceHashes ?? {}).length > 0,
    "Loaded service fingerprint is required",
  );
  if (ownedPid !== undefined)
    assert.equal(
      runtime.pid,
      ownedPid,
      "Owned agent-service PID differs from loaded server",
    );
  for (const [relative, hash] of Object.entries(expectedSourceHashes))
    assert.equal(
      runtime.sourceHashes[relative],
      hash,
      `Loaded source drift: ${relative}`,
    );
  for (const [relative, hash] of Object.entries(runtime.sourceHashes))
    assert.equal(
      hash,
      expectedSourceHashes[relative],
      `Loaded source drift: ${relative}`,
    );
}
