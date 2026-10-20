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
  verifyLoadedService,
  nativeFormatSettings,
  verifyNativeProtocol,
  verifyNativeRetrievalViews,
} from "./native_integrity";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const hashes = Object.fromEntries(
  [
    "src/server.ts",
    "src/agent/texera-agent.ts",
    "src/agent/prompts/native-mode-single.md",
    "src/agent/native/catalog.ts",
    "src/agent/native/python/runtime.py",
    "src/agent/util/context-utils.ts",
    "package.json",
    "bun.lock",
  ].map((key) => [key, "abc"]),
);
const ledger = {
  version: 1,
  source: "transport",
  attemptedRequests: 0,
  serviceRuntime: {
    version: 1,
    pid: 123,
    sourceHashes: hashes,
  },
};

test("native format is an explicit validated setting before provisioning", () => {
  expect(nativeFormatSettings({ settings: { maxSteps: 25 } })).toEqual({
    maxSteps: 25,
  });
  expect(
    nativeFormatSettings({ native_format: "json", settings: { maxSteps: 25 } }),
  ).toEqual({ maxSteps: 25, nativeFormat: "json" });
  for (const config of [
    { native_format: "tags" },
    { native_format: null },
    { native_format: "json", settings: { nativeFormat: "expression" } },
    { native_format_schema_sha256: "a".repeat(64) },
    { native_format: "json", native_format_schema_sha256: "bad" },
  ])
    expect(() => nativeFormatSettings(config)).toThrow("native format");
});

test("format protocol matches actual model-facing schema and prompt before inference", () => {
  const info = {
    systemPrompt: "role",
    tools: [
      {
        name: "dataflow",
        strict: false,
        inputSchema: { type: "object", properties: { actions: {} } },
      },
    ],
  };
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const protocol = {
    format: "json",
    toolSchemaSha256: hash(
      JSON.stringify({
        inputSchema: info.tools[0].inputSchema,
        strict: info.tools[0].strict,
      }),
    ),
    systemPromptSha256: hash(info.systemPrompt),
  };
  expect(
    verifyNativeProtocol(protocol, info, "json", protocol.toolSchemaSha256),
  ).toEqual(protocol);
  expect(() => verifyNativeProtocol(protocol, info, "expression")).toThrow(
    "native format",
  );
  expect(() => verifyNativeProtocol(undefined, info, "json")).toThrow(
    "native format",
  );
  expect(() =>
    verifyNativeProtocol(protocol, info, "json", "a".repeat(64)),
  ).toThrow("schema hash");
  expect(() =>
    verifyNativeProtocol(protocol, { ...info, systemPrompt: "drift" }, "json"),
  ).toThrow("prompt hash");
  expect(() =>
    verifyNativeProtocol(
      { ...protocol, toolSchemaSha256: "a".repeat(64) },
      info,
      "json",
    ),
  ).toThrow("schema hash");
});

test("JSON attestation binds the boolean strict flag while expression hashes stay unchanged", () => {
  const tool = {
    name: "dataflow",
    strict: false,
    inputSchema: { type: "object", properties: { actions: {} } },
  };
  const info = { systemPrompt: "role", tools: [tool] };
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const protocol = {
    format: "json",
    toolSchemaSha256: hash(
      JSON.stringify({ inputSchema: tool.inputSchema, strict: false }),
    ),
    systemPromptSha256: hash(info.systemPrompt),
  };
  expect(verifyNativeProtocol(protocol, info, "json")).toEqual(protocol);
  expect(() =>
    verifyNativeProtocol(
      protocol,
      {
        ...info,
        tools: [{ ...tool, strict: true }],
      },
      "json",
    ),
  ).toThrow("schema hash");
  const strictProtocol = {
    ...protocol,
    toolSchemaSha256: hash(
      JSON.stringify({ inputSchema: tool.inputSchema, strict: true }),
    ),
  };
  expect(
    verifyNativeProtocol(
      strictProtocol,
      {
        ...info,
        tools: [{ ...tool, strict: true }],
      },
      "json",
    ).toolSchemaSha256,
  ).not.toBe(protocol.toolSchemaSha256);
  for (const invalidStrict of [undefined, null, 0, "false"])
    expect(() =>
      verifyNativeProtocol(
        protocol,
        {
          ...info,
          tools: [{ ...tool, strict: invalidStrict }],
        },
        "json",
      ),
    ).toThrow("strict flag must be boolean");
  const expressionProtocol = {
    ...protocol,
    format: "expression",
    toolSchemaSha256: hash(JSON.stringify(tool.inputSchema)),
  };
  for (const strict of [undefined, false, true])
    expect(
      verifyNativeProtocol(
        expressionProtocol,
        {
          ...info,
          tools: [{ name: "dataflow", inputSchema: tool.inputSchema, strict }],
        },
        "expression",
      ),
    ).toEqual(expressionProtocol);
});

test("format-specific retrieval schema preserves the same evidence views", () => {
  const views = ["full", "sample", "sample_stats"];
  for (const format of ["expression", "json"] as const) {
    const info = {
      tools: [
        {
          name: "dataflow",
          inputSchema: {
            properties: {
              actions: {
                items: {
                  anyOf: [
                    {
                      properties: {
                        type: {
                          const: format === "json" ? "read" : "retrieve",
                        },
                        view: { enum: views },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      ],
    };
    expect(() => verifyNativeRetrievalViews(info, format, views)).not.toThrow();
    expect(() => verifyNativeRetrievalViews(info, format, ["sample"])).toThrow(
      "Retrieval views",
    );
    expect(() =>
      verifyNativeRetrievalViews(
        info,
        format === "json" ? "expression" : "json",
        views,
      ),
    ).toThrow("retrieval action");
  }
});

test("actual native adapter forwards each format and rejects protocol drift before inference offline", () => {
  const directory = mkdtempSync(join(tmpdir(), "native-format-offline-"));
  try {
    const jobDirectory = join(directory, "benchmark/dsbench");
    mkdirSync(jobDirectory, { recursive: true });
    for (const name of [
      "native_job.ts",
      "native_integrity.ts",
      "native_capabilities.ts",
    ])
      copyFileSync(join(import.meta.dir, name), join(jobDirectory, name));
    const stubs: Record<string, string> = {
      "agent-service/src/api/index.ts": `export async function login() { return "offline"; }
        export async function createComputingUnit() { return { computingUnit: { cuid: 123 } }; }
        export async function createWorkflow() { return 456; }`,
      "agent-service/src/agent/workflow-state.ts": `export class WorkflowState { getWorkflowContent() { return {}; } }`,
      "agent-service/benchmark/e2e/native-cleanup.ts": `export function assertNativeCleanupSafe() { throw new Error("offline retained"); }`,
    };
    for (const [path, source] of Object.entries(stubs)) {
      mkdirSync(join(directory, path, ".."), { recursive: true });
      writeFileSync(join(directory, path), source);
    }
    for (const variant of [
      "legacy",
      "expression",
      "json",
      "drift",
      "strict-drift",
    ]) {
      const output = join(directory, variant);
      mkdirSync(output);
      const format =
        variant === "legacy"
          ? undefined
          : variant === "drift" || variant === "strict-drift"
            ? "json"
            : variant;
      const settings = {
        maxSteps: 25,
        retrievalViews: ["full", "sample", "sample_stats"],
        ...(format ? { nativeFormat: format } : {}),
      };
      const info = {
        systemPrompt: "role\n## Analysis principles\nPreserved.",
        tools: [
          {
            name: "dataflow",
            strict: variant === "strict-drift",
            inputSchema: {
              properties: {
                actions: {
                  items: {
                    anyOf: [
                      {
                        properties: {
                          type: {
                            const: format === "json" ? "read" : "retrieve",
                          },
                          view: { enum: settings.retrievalViews },
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        ],
      };
      const hash = (value: string) =>
        createHash("sha256").update(value).digest("hex");
      const protocol = {
        format: variant === "drift" ? "expression" : format,
        toolSchemaSha256: hash(
          JSON.stringify(
            format === "json"
              ? {
                  inputSchema: info.tools[0].inputSchema,
                  strict: false,
                }
              : info.tools[0].inputSchema,
          ),
        ),
        systemPromptSha256: hash(info.systemPrompt),
      };
      writeFileSync(
        join(directory, "agent-service/src/api/agent-service-api.ts"),
        `
        import {writeFileSync} from "node:fs";
        const settings = ${JSON.stringify(settings)};
        const info = ${JSON.stringify(info)};
        globalThis.fetch = async (url) => Response.json(String(url).endsWith("/settings") ? settings : String(url).endsWith("/system-info") ? info : {version:1,source:"transport",requests:[],attemptedRequests:0,succeededRequests:0,failedRequests:0,usageStatus:"complete"});
        export async function createAgent(options) { writeFileSync(process.env.NATIVE_OFFLINE_CAPTURE, JSON.stringify(options)); return {id:"offline-created",nativeProtocol:${JSON.stringify(protocol)}}; }
        export async function getReActSteps() { return {steps:[]}; }
        export async function runAgentTurn() { writeFileSync(process.env.NATIVE_OFFLINE_TURN, "called"); throw new Error("offline inference reached"); }
      `,
      );
      const config = {
        output_dir: output,
        endpoint: "http://offline.invalid",
        model: "exact",
        settings,
        arm: "offline",
        task_id: "offline",
        prompt: "identical task prompt",
        shared_principles: "## Analysis principles\nPreserved.",
        task_timeout_seconds: 900,
        ...(format
          ? {
              native_format: format,
              native_format_schema_sha256: protocol.toolSchemaSha256,
              native_format_prompt_sha256: protocol.systemPromptSha256,
            }
          : {}),
      };
      const configPath = join(output, "config.json");
      writeFileSync(configPath, JSON.stringify(config));
      const capturePath = join(output, "create-payload.json");
      const turnPath = join(output, "offline-turn.txt");
      const result = Bun.spawnSync(
        [process.execPath, join(jobDirectory, "native_job.ts"), configPath],
        {
          env: {
            ...process.env,
            NATIVE_WORKSPACE: join(output, "workspace"),
            NATIVE_OFFLINE_CAPTURE: capturePath,
            NATIVE_OFFLINE_TURN: turnPath,
          },
        },
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(capturePath, "utf8")).settings).toEqual(
        settings,
      );
      expect(existsSync(turnPath)).toBe(
        variant !== "drift" && variant !== "strict-drift",
      );
      expect(existsSync(join(output, "native-format-protocol.json"))).toBe(
        format !== undefined,
      );
      if (variant === "drift" || variant === "strict-drift") {
        expect(
          JSON.parse(readFileSync(join(output, "status.json"), "utf8"))
            .integrity_failure,
        ).toBe(true);
        expect(
          JSON.parse(readFileSync(join(output, "resource.json"), "utf8"))
            .agentId,
        ).toBe("offline-created");
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("loaded service hashes and owned PID match before any inference", () => {
  expect(() => verifyLoadedService(ledger, hashes, 123)).not.toThrow();
});
test("stale process or disk source drift stops inference", () => {
  expect(() =>
    verifyLoadedService(ledger, { ...hashes, "src/server.ts": "changed" }, 123),
  ).toThrow("Loaded source drift");
  expect(() => verifyLoadedService(ledger, hashes, 456)).toThrow(
    "Owned agent-service PID",
  );
  expect(() =>
    verifyLoadedService({ ...ledger, source: "trace" }, {}, 123),
  ).toThrow("transport");
});
test("partial startup maps cannot omit native prompts, catalog or context", () => {
  expect(() =>
    verifyLoadedService(
      {
        ...ledger,
        serviceRuntime: {
          ...ledger.serviceRuntime,
          sourceHashes: { "src/server.ts": "abc" },
        },
      },
      hashes,
      123,
    ),
  ).toThrow("Loaded source drift");
  expect(() =>
    verifyLoadedService(ledger, { "src/server.ts": "abc" }, 123),
  ).toThrow("Incomplete expected startup inventory");
});
