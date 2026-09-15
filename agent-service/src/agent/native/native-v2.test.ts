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

import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createNativeBatchTools, nativeBatchSchema } from "../tools/native-batch-tools";
import { formatNativeError } from "../tools/result-formatting";
import { WorkflowState } from "../workflow-state";
import { WorkflowSystemMetadata } from "../util/workflow-system-metadata";
import { compileNativeOp } from "./codegen";
import { TexeraAgent } from "../texera-agent";
import { AgentMode, ContextMode } from "../../types/agent";
import { buildNativeModeSystemPrompt } from "../prompts";
import { parseNativeDiagnostic, type NativeDiagnostic } from "./diagnostics";

const loader = {
  op: "udf",
  id: "source",
  code: "def load():\n    import pandas as pd\n    return pd.DataFrame({'x': [1, 3]})",
};

function batch(version: "v1" | "v2", state = new WorkflowState()) {
  const metadata = new WorkflowSystemMetadata();
  metadata.seedCodeModeDefaults();
  return { state, tool: createNativeBatchTools(state, { metadataStore: metadata }, version).dataflow };
}

describe("native V2 Python contracts", () => {
  test("the V2 compiler retains the common identifier and port guards", () => {
    for (const inputs of [[], ["source", "extra"], ["not-an-id"], ["x): pass #"]]) {
      expect(() =>
        compileNativeOp({ version: "v2", type: "Project", inputs, properties: { keep: ["x"] } }, "answer")
      ).toThrow();
    }
    expect(() =>
      compileNativeOp(
        {
          version: "v2",
          type: "UDF",
          inputs: ["source", "source"],
          properties: { code: "def process(source):\n    return source" },
        },
        "answer"
      )
    ).toThrow(/distinct/);
  });

  test("versioned schemas accept Python operators and reject legacy SQL arguments", () => {
    const v2 = new Ajv({ strict: false }).compile(nativeBatchSchema("v2"));
    const v1 = new Ajv({ strict: false }).compile(nativeBatchSchema());
    const args = {
      operators: [
        { op: "filter", id: "kept", input: "source", columns: ["x"], func: "def apply(row):\n    return row['x'] > 1" },
      ],
      observe: ["kept"],
    };
    expect(v2(args)).toBe(true);
    expect(v1(args)).toBe(false);
    expect(v2({ operators: [{ op: "compute", id: "c", input: "source", columns: { x: "x+1" } }] })).toBe(false);
    expect(v2({ operators: [{ op: "filter", id: "f", input: "source", predicate: "x > 1" }] })).toBe(false);
    expect(
      v2({ operators: [{ op: "cast", id: "c", input: "source", columns: [{ column: "x", dtype: "guess" }] }] })
    ).toBe(false);
    expect(v2({ operators: [{ op: "fill_null", id: "c", input: "source", values: { x: 0 } }] })).toBe(true);
  });

  test("V2 uses the batch scheduler for a reversed Python chain and records revisions", async () => {
    const { state, tool } = batch("v2");
    const result = await tool.execute({
      operators: [
        {
          op: "derive",
          id: "answer",
          input: "kept",
          columns: [{ as: "double", inputs: ["x"], dtype: "int64", func: "def apply(row):\n    return row['x'] * 2" }],
        },
        { op: "filter", id: "kept", input: "source", columns: ["x"], func: "def apply(row):\n    return row['x'] > 1" },
        loader,
      ],
      observe: ["answer"],
    });
    expect(result.operators.map((op: any) => op.status)).toEqual(["added", "added", "added"]);
    for (const op of state.getAllOperators()) {
      expect(op.nativeOp?.version).toBe("v2");
      expect(op.nativeOp?.revision).toMatch(/^[a-f0-9]{16}$/);
      expect(op.operatorProperties.code).not.toContain("import duckdb");
    }
    expect(
      state
        .getAllLinks()
        .map(link => `${link.source.operatorID}->${link.target.operatorID}`)
        .sort()
    ).toEqual(["kept->answer", "source->kept"]);
  });

  test("syntax failures are rejected before mutation and block dependent edits, not independent edits", async () => {
    const { state, tool } = batch("v2");
    await tool.execute({ operators: [loader], observe: [] });
    const result = await tool.execute({
      operators: [
        { op: "filter", id: "bad", input: "source", columns: [], func: "def apply(row)\n    return True" },
        { op: "project", id: "blocked", input: "bad", keep: ["x"] },
        { op: "project", id: "good", input: "source", keep: ["x"] },
      ],
      observe: [],
    });
    expect(result.operators.map((op: any) => op.status)).toEqual(["error", "blocked", "added"]);
    expect(result.operators[0].message).toContain("PYTHON_SYNTAX");
    expect(state.getOperator("bad")).toBeUndefined();
    expect(state.getOperator("good")).toBeDefined();
  });

  test("a V1 graph cannot silently accept a V2 edit", async () => {
    const { state, tool } = batch("v1");
    await tool.execute({ operators: [loader], observe: [] });
    const result = await batch("v2", state).tool.execute({
      operators: [{ op: "project", id: "new", input: "source", keep: ["x"] }],
    });
    expect(JSON.stringify(result)).toContain("catalog");
    expect(state.getAllOperators()).toHaveLength(1);
  });

  test("generated source executes with embedded runtime and keeps Python/JSON literals intact", () => {
    const compiled = compileNativeOp(
      {
        version: "v2",
        type: "Derive",
        inputs: ["source"],
        properties: {
          columns: [{ as: "literal", inputs: [], dtype: "str", func: "def apply(row):\n    return 'false null true'" }],
        },
      },
      "answer"
    );
    const python =
      process.env.UDF_PYTHON_PATH ?? fileURLToPath(new URL("../../../../.venv/bin/python", import.meta.url));
    const executed = spawnSync(
      python,
      [
        "-c",
        "import sys,json,pandas as pd\nns={}\nexec(sys.stdin.read(),ns)\nprint(ns['process'](pd.DataFrame({'x':[1,2]})).to_json(orient='records'))",
      ],
      { input: compiled.code, encoding: "utf8", timeout: 30_000 }
    );
    expect(executed.stderr).toBe("");
    expect(executed.status).toBe(0);
    expect(JSON.parse(executed.stdout)).toEqual([
      { x: 1, literal: "false null true" },
      { x: 2, literal: "false null true" },
    ]);
  });

  test("structured Python errors keep submitted source location despite hidden generated code", () => {
    const diagnostic: NativeDiagnostic = {
      version: 1,
      operatorId: "f",
      operatorRevision: "rev1",
      stage: "execute",
      code: "CALLBACK_RUNTIME",
      message: "ZeroDivisionError: division by zero",
      field: "func",
      source: { entry: "apply", line: 3, excerpt: "    return 1 / row['x']" },
    };
    const rendered = formatNativeError(
      "f",
      "Filter",
      "(line 431) `raise NativeError(...)` - NativeError: NATIVE_ERROR_V2:" + JSON.stringify(diagnostic)
    );
    expect(rendered).toContain("CALLBACK_RUNTIME");
    expect(rendered).toContain("apply line 3");
    expect(rendered).toContain("rev1");
    expect(rendered).toContain("return 1 / row['x']");
    expect(rendered).not.toContain("line 431");
    expect(rendered).not.toContain("NATIVE_ERROR_V2");
  });

  test("V2 requires native batching and settings validation is atomic", () => {
    const agent = new TexeraAgent({
      agentId: "v2-settings",
      modelType: "test",
      driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
      contextAssembler: () => [],
    });
    expect(() => agent.updateSettings({ nativeCatalogVersion: "v2" })).toThrow(/native.*batch/i);
    expect(agent.getSettings().nativeCatalogVersion).toBe("v1");
    agent.updateSettings({ agentMode: AgentMode.NATIVE, nativeToolMode: "batch", nativeCatalogVersion: "v2" });
    expect(agent.getSettings().nativeCatalogVersion).toBe("v2");
    expect(agent.getSettings().systemPrompt).toContain("def apply");
    expect(agent.getSettings().systemPrompt).not.toContain("DuckDB");
    expect(agent.getSettings().systemPrompt).not.toContain('op: "compute"');
    expect(() => agent.updateSettings({ nativeToolMode: "typed" })).toThrow(/native.*batch/i);
    expect(agent.getSettings().nativeToolMode).toBe("batch");
  });

  test("V2 prompt examples validate, compile and extend the same graph across layouts", async () => {
    const validate = new Ajv({ strict: false }).compile(nativeBatchSchema("v2"));
    for (const mode of [ContextMode.DELTA, ContextMode.LATEST]) {
      for (const layout of [
        {},
        { recall: true },
        { session: true },
        { versioned: true },
        { messageLayout: "block" as const },
      ]) {
        const prompt = buildNativeModeSystemPrompt(mode, false, "all", {
          ...layout,
          batch: true,
          nativeCatalogVersion: "v2",
        });
        expect(prompt).not.toContain("{{");
        expect(prompt).not.toContain("DuckDB");
        expect(prompt).not.toContain('op: "compute"');
        expect(prompt).toContain("MUST explicitly include its ID in `observe`");
        expect(prompt).toContain("including dependencies through unchanged existing operators");
        expect(prompt.includes("recallState")).toBe("recall" in layout);
        if (mode === ContextMode.LATEST) expect(prompt).toContain("most recent batch's requested set");
        const examples = [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
        expect(examples.length).toBeGreaterThanOrEqual(5);
        for (const example of examples) expect(validate(example)).toBe(true);
      }
    }
    const prompt = buildNativeModeSystemPrompt(ContextMode.DELTA, false, "all", {
      batch: true,
      nativeCatalogVersion: "v2",
    });
    const { state, tool } = batch("v2");
    for (const example of [...prompt.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]))) {
      const result = await tool.execute(example);
      expect(result.operators.every((op: any) => ["added", "modified"].includes(op.status))).toBe(true);
      expect(result.observationErrors).toEqual([]);
      expect(result.observe).toEqual(example.observe);
    }
    expect(state.getOperator("final")?.nativeOp?.inputs).toEqual(["rounded"]);
    expect(state.getOperator("positive")?.nativeOp?.properties.func).toContain(">= 3");
  });

  test("diagnostic decoding tolerates engine wrapping but rejects malformed payloads", () => {
    const diagnostic: NativeDiagnostic = {
      version: 1,
      operatorId: "upstream",
      operatorRevision: "rev1",
      stage: "execute",
      code: "CALLBACK_RUNTIME",
      message: 'KeyError: {"quoted": "}"}',
      field: "func",
      source: { entry: "apply", line: 3, column: 2, excerpt: '    return row["}"]' },
    };
    const payload = "NATIVE_ERROR_V2:" + JSON.stringify(diagnostic);
    expect(parseNativeDiagnostic(`Worker failed: ${payload}; during execution`)).toEqual(diagnostic);
    expect(parseNativeDiagnostic(payload.slice(0, -1))).toBeUndefined();
    for (const patch of [
      { version: 99 },
      { stage: "unknown" },
      { field: {} },
      { source: { ...diagnostic.source, column: "bad" } },
    ]) {
      expect(parseNativeDiagnostic("NATIVE_ERROR_V2:" + JSON.stringify({ ...diagnostic, ...patch }))).toBeUndefined();
    }
    expect(parseNativeDiagnostic('NATIVE_ERROR_V2:{"version":99}; ' + payload)).toEqual(diagnostic);
    const cascade = formatNativeError("downstream", "Project", payload);
    expect(cascade).toContain("not executed");
    expect(cascade).toContain("upstream `upstream` failed");
    expect(cascade).not.toContain("Project `downstream` failed");
  });
});
