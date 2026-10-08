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
import { expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeGenerationProvenance,
  nativeModelCapabilityOptions,
  nativeModelRequestTimeoutOptions,
  nativeRequestTimeoutProvenance,
} from "./native_capabilities";

test("absent capability leaves legacy create request unchanged", () => {
  for (const value of [
    undefined,
    null,
    {},
    { structured_output_transport: "auto_tool" },
  ]) {
    const original = { modelType: "exact", settings: { maxSteps: 25 } };
    expect({ ...original, ...nativeModelCapabilityOptions(value) }).toEqual(
      original,
    );
  }
});

test("explicit model request timeout converts seconds while absent keeps native defaults", () => {
  expect(nativeModelRequestTimeoutOptions(undefined)).toEqual({});
  expect(nativeModelRequestTimeoutOptions(240)).toEqual({
    modelRequestTimeoutMs: 240000,
  });
  expect(nativeModelRequestTimeoutOptions(0.125)).toEqual({
    modelRequestTimeoutMs: 125,
  });
  for (const value of [null, true, "240", 0, -1, NaN, Infinity, 0.00001]) {
    expect(() => nativeModelRequestTimeoutOptions(value)).toThrow(
      "positive seconds with integer millisecond precision",
    );
  }
});

test("millisecond timeout conversion tolerates binary product noise without accepting fractional milliseconds", () => {
  for (const [seconds, milliseconds] of [
    [1.001, 1001],
    [4.001, 4001],
    [2_147_483.647, 2_147_483_647],
  ]) {
    expect(nativeModelRequestTimeoutOptions(seconds)).toEqual({
      modelRequestTimeoutMs: milliseconds,
    });
  }
  for (const value of [1.0005, 1.001 + Number.EPSILON, 1e308]) {
    expect(() => nativeModelRequestTimeoutOptions(value)).toThrow(
      "positive seconds",
    );
  }
});

test("request timeout provenance uses actual resolved API fields separately from generation facts", () => {
  expect(
    nativeRequestTimeoutProvenance(
      { model_request_timeout_seconds: 240 },
      {
        modelRequestTimeoutMs: 240000,
        modelRequestTimeoutSource: "explicit",
        modelRequestTimeoutMethod: "abort_signal_fetch_deadline",
      },
    ),
  ).toEqual({
    schema_version: 1,
    requested_seconds: 240,
    requested_ms: 240000,
    resolved_ms: 240000,
    resolution_source: "explicit",
    enforcement_method: "abort_signal_fetch_deadline",
  });
  expect(nativeRequestTimeoutProvenance({})).toMatchObject({
    requested_ms: null,
    resolved_ms: null,
    resolution_source: "not_reported",
  });
});

test("explicit forced-tool capability reaches native create fields", () => {
  for (const forced of [false, true]) {
    const fact = {
      forced_tool_choice: forced,
      structured_output_transport: "auto_tool",
    };
    const seen: unknown[] = [];
    const create = (options: unknown) => seen.push(options);
    create({
      modelType: "exact-provider-id",
      settings: { maxSteps: 25 },
      ...nativeModelCapabilityOptions(fact),
    });
    expect(seen).toEqual([
      {
        modelType: "exact-provider-id",
        settings: { maxSteps: 25 },
        modelCapabilities: { forcedToolChoice: forced },
      },
    ]);
    expect(fact).toEqual({
      forced_tool_choice: forced,
      structured_output_transport: "auto_tool",
    });
  }
});

test("invalid explicit forced-tool capability fails before creating native agent", () => {
  for (const value of ["false", null, 0, {}, []]) {
    let created = false;
    const create = (options: unknown) => {
      created = true;
    };
    expect(() =>
      create({
        modelType: "exact",
        ...nativeModelCapabilityOptions({ forced_tool_choice: value }),
      }),
    ).toThrow("forced_tool_choice must be boolean");
    expect(created).toBe(false);
  }
});

test("native generation facts preserve requested parameters without claiming overrides", () => {
  const parameters = { reasoning_effort: "high", temperature: 0.7 };
  const config = {
    model: "exact-provider-route",
    model_parameters: parameters,
  };
  const provenance = nativeGenerationProvenance(config);
  expect(provenance).toEqual({
    schema_version: 1,
    requested_model_parameters: parameters,
    native_api_parameter_overrides: { applied: false },
    generation_profile: {
      source: "gateway_model_profile",
      model_route: "exact-provider-route",
    },
    provider_request_evidence: "model-requests.jsonl",
  });
  expect(config).toEqual({
    model: "exact-provider-route",
    model_parameters: parameters,
  });
  expect(
    nativeGenerationProvenance({ model: "legacy" }).requested_model_parameters,
  ).toBeNull();
});

test("native job rejects malformed capabilities before SDK imports or network creation", () => {
  const directory = mkdtempSync(join(tmpdir(), "native-capabilities-offline-"));
  try {
    const configPath = join(directory, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        output_dir: directory,
        endpoint: "http://127.0.0.1:1",
        model: "exact-provider-route",
        model_capabilities: { forced_tool_choice: "false" },
      }),
    );
    const result = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, "native_job.ts"),
      configPath,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      "forced_tool_choice must be boolean",
    );
    expect(result.stderr.toString()).not.toContain("Cannot find package");
    expect(result.stderr.toString()).not.toContain("Failed to create");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("actual native job forwards capabilities and records unapplied generation facts offline", () => {
  const directory = mkdtempSync(join(tmpdir(), "native-create-offline-"));
  try {
    const jobDirectory = join(directory, "benchmark/dsbench");
    mkdirSync(jobDirectory, { recursive: true });
    for (const name of [
      "native_job.ts",
      "native_integrity.ts",
      "native_capabilities.ts",
    ]) {
      copyFileSync(join(import.meta.dir, name), join(jobDirectory, name));
    }
    const stubs: Record<string, string> = {
      "agent-service/src/api/index.ts": `export async function login() { return "offline"; }
        export async function createComputingUnit() { return { computingUnit: { cuid: 123 } }; }
        export async function createWorkflow() { return 456; }`,
      "agent-service/src/api/agent-service-api.ts": `import { writeFileSync } from "node:fs";
        export async function createAgent(options) {
          writeFileSync(process.env.NATIVE_OFFLINE_CAPTURE, JSON.stringify(options));
          throw new Error("offline create payload captured");
        }`,
      "agent-service/src/agent/workflow-state.ts": `export class WorkflowState { getWorkflowContent() { return {}; } }`,
      "agent-service/benchmark/e2e/native-cleanup.ts": `export function assertNativeCleanupSafe() { throw new Error("offline cleanup must not execute"); }`,
    };
    for (const [path, source] of Object.entries(stubs)) {
      const target = join(directory, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, source);
    }
    for (const forced of [undefined, false, true]) {
      const output = join(directory, String(forced));
      mkdirSync(output);
      const config = {
        output_dir: output,
        endpoint: "http://127.0.0.1:1",
        model: "exact-route",
        model_parameters: { reasoning_effort: "medium" },
        ...(forced === undefined
          ? {}
          : { model_request_timeout_seconds: forced ? 125 : 240 }),
        model_capabilities:
          forced === undefined ? {} : { forced_tool_choice: forced },
        settings: { maxSteps: 25 },
        arm: "offline",
        task_id: "offline",
      };
      const configPath = join(output, "config.json");
      const capturePath = join(output, "create-payload.json");
      writeFileSync(configPath, JSON.stringify(config));
      const result = Bun.spawnSync(
        [process.execPath, join(jobDirectory, "native_job.ts"), configPath],
        {
          env: {
            ...process.env,
            NATIVE_WORKSPACE: join(output, "workspace"),
            NATIVE_OFFLINE_CAPTURE: capturePath,
          },
        },
      );
      expect(result.exitCode).toBe(0);
      const actual = JSON.parse(readFileSync(capturePath, "utf8"));
      expect(actual).toEqual({
        baseUrl: config.endpoint,
        userToken: "offline",
        modelType: config.model,
        workflowId: 456,
        computingUnitId: 123,
        settings: config.settings,
        ...(forced === undefined
          ? {}
          : { modelCapabilities: { forcedToolChoice: forced } }),
        ...(forced === undefined
          ? {}
          : { modelRequestTimeoutMs: forced ? 125000 : 240000 }),
      });
      expect(actual).not.toHaveProperty("model_parameters");
      expect(
        JSON.parse(
          readFileSync(
            join(output, "native-generation-provenance.json"),
            "utf8",
          ),
        ),
      ).toEqual(nativeGenerationProvenance(config));
      expect(
        JSON.parse(readFileSync(join(output, "harness-error.json"), "utf8"))
          .error,
      ).toContain("offline create payload captured");
    }
    // An old/drifting service must be rejected before inference, with its agent ID retained.
    const mismatch = join(directory, "mismatched-timeout");
    mkdirSync(mismatch);
    writeFileSync(
      join(directory, "agent-service/src/api/agent-service-api.ts"),
      `
      globalThis.fetch = async () => Response.json({version:1,source:"transport",requests:[],attemptedRequests:0,succeededRequests:0,failedRequests:0,usageStatus:"complete"});
      export async function createAgent() { return {id:"offline-created",modelRequestTimeoutMs:180000,modelRequestTimeoutSource:"default",modelRequestTimeoutMethod:"abort_signal_fetch_deadline"}; }
      export async function getReActSteps() { return {steps:[]}; }
    `,
    );
    const mismatchConfig = join(mismatch, "config.json");
    writeFileSync(
      mismatchConfig,
      JSON.stringify({
        output_dir: mismatch,
        endpoint: "http://127.0.0.1:1",
        model: "exact-route",
        model_request_timeout_seconds: 240,
        settings: {},
        arm: "offline",
        task_id: "offline",
      }),
    );
    const mismatchResult = Bun.spawnSync(
      [process.execPath, join(jobDirectory, "native_job.ts"), mismatchConfig],
      {
        env: { ...process.env, NATIVE_WORKSPACE: join(mismatch, "workspace") },
      },
    );
    expect(mismatchResult.exitCode).toBe(0);
    expect(
      JSON.parse(readFileSync(join(mismatch, "harness-error.json"), "utf8"))
        .error,
    ).toContain("Model request timeout drift");
    expect(
      JSON.parse(readFileSync(join(mismatch, "resource.json"), "utf8")).agentId,
    ).toBe("offline-created");
    expect(
      JSON.parse(
        readFileSync(join(mismatch, "model-request-timeout.json"), "utf8"),
      ),
    ).toMatchObject({ requested_ms: 240000, resolved_ms: 180000 });
    expect(
      JSON.parse(readFileSync(join(mismatch, "model-accounting.json"), "utf8"))
        .attemptedRequests,
    ).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
