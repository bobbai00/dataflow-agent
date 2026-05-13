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
import { __forTesting, createCreateOrModifyOperatorTool, validateOperatorId } from "./code-op-tools";
import { WorkflowState } from "../workflow-state";

const { regexContractCheck, stripPythonCommentsAndStrings } = __forTesting;

describe("validateOperatorId — camelCase enforcement", () => {
  test("accepts simple lowercase word", () => {
    expect(validateOperatorId("customers")).toBeNull();
  });

  test("accepts camelCase with multiple words", () => {
    expect(validateOperatorId("lowHumidityFilter")).toBeNull();
    expect(validateOperatorId("filteredCustomers")).toBeNull();
    expect(validateOperatorId("avgFatalitiesByYear")).toBeNull();
  });

  test("accepts camelCase with trailing digits", () => {
    expect(validateOperatorId("top5")).toBeNull();
    expect(validateOperatorId("region2")).toBeNull();
  });

  test("rejects empty string", () => {
    const err = validateOperatorId("");
    expect(err).not.toBeNull();
    expect(err).toContain("cannot be empty");
  });

  test("rejects snake_case (underscores forbidden)", () => {
    const err = validateOperatorId("low_humidity_filter");
    expect(err).not.toBeNull();
    expect(err).toContain("camelCase");
  });

  test("rejects a single trailing underscore", () => {
    const err = validateOperatorId("customers_");
    expect(err).not.toBeNull();
    expect(err).toContain("camelCase");
  });

  test("rejects a leading underscore", () => {
    const err = validateOperatorId("_priv");
    expect(err).not.toBeNull();
    expect(err).toContain("camelCase");
  });

  test("rejects PascalCase (must start lowercase)", () => {
    const err = validateOperatorId("LowHumidityFilter");
    expect(err).not.toBeNull();
    expect(err).toContain("camelCase");
  });

  test("rejects kebab-case (hyphens forbidden)", () => {
    const err = validateOperatorId("low-humidity-filter");
    expect(err).not.toBeNull();
    expect(err).toContain("camelCase");
  });

  test("rejects names starting with a digit", () => {
    const err = validateOperatorId("5top");
    expect(err).not.toBeNull();
    expect(err).toContain("camelCase");
  });

  test("rejects names containing spaces", () => {
    const err = validateOperatorId("low humidity");
    expect(err).not.toBeNull();
    expect(err).toContain("camelCase");
  });

  test("rejects names containing punctuation", () => {
    expect(validateOperatorId("low.humidity")).not.toBeNull();
    expect(validateOperatorId("low$humidity")).not.toBeNull();
  });

  test("rejects Python reserved keywords", () => {
    const err = validateOperatorId("class");
    expect(err).not.toBeNull();
    expect(err).toContain("reserved keyword");
  });

  test("rejects another Python keyword", () => {
    const err = validateOperatorId("return");
    expect(err).not.toBeNull();
    expect(err).toContain("reserved keyword");
  });
});

describe("regexContractCheck — rejects print()", () => {
  test("flags a bare print() call", () => {
    const err = regexContractCheck(`def process(df):
    print(df.columns)
    return df`);
    expect(err).not.toBeNull();
    expect(err).toContain("print(...)");
  });

  test("flags print() with whitespace before the paren", () => {
    const err = regexContractCheck(`def process(df):
    print (df.columns)
    return df`);
    expect(err).not.toBeNull();
    expect(err).toContain("print(...)");
  });

  test("allows the word `print` inside a string literal", () => {
    const err = regexContractCheck(`def process(df):
    return df.assign(note="please print() this row")`);
    expect(err).toBeNull();
  });

  test("allows the word `print` inside a comment", () => {
    const err = regexContractCheck(`def process(df):
    # remember to print(...) for the demo
    return df`);
    expect(err).toBeNull();
  });
});

describe("regexContractCheck — requires a value-returning return", () => {
  test("flags a function with no return at all", () => {
    const err = regexContractCheck(`def process(df):
    x = df.head()
    x.describe()`);
    expect(err).not.toBeNull();
    expect(err).toContain("`process`");
    expect(err).toContain("return");
  });

  test("flags a function whose only return is a bare `return`", () => {
    const err = regexContractCheck(`def process(df):
    if df.empty:
        return
    df.describe()`);
    expect(err).not.toBeNull();
    expect(err).toContain("`process`");
  });

  test("accepts a function with a value-returning return", () => {
    const err = regexContractCheck(`def load() -> pd.DataFrame:
    return pd.read_csv('/data/file.csv')`);
    expect(err).toBeNull();
  });

  test("accepts a function whose return value is wrapped over multiple lines", () => {
    const err = regexContractCheck(`def process(df):
    return df.assign(
        col=df['a'] + df['b']
    )`);
    expect(err).toBeNull();
  });
});

/* ============================================================================
 *  End-to-end: createOrModifyOperator rejects bad code WITHOUT mutating state
 * ========================================================================= */

describe("createOrModifyOperator — contract enforcement at the tool boundary", () => {
  // Build a tool that has the minimum it needs to *attempt* to run. We pass an
  // empty schema map and an undefined context: the contract check runs before
  // any code path that needs them, so failure cases don't touch them. (If a
  // future regression moves the mutation BEFORE the check, the empty schema map
  // would cause the call to fail with a different error — which would itself
  // surface in these tests.)
  function buildTool() {
    const ws = new WorkflowState();
    const tool = createCreateOrModifyOperatorTool(ws, new Map(), undefined);
    // The Vercel AI SDK types `execute` as optional and 2-arg; production code
    // also casts (see `TexeraAgent.executeTool` in texera-agent.ts). We just
    // want to invoke it from a test with the input the agent sends.
    const execute = (args: { operatorId: string; code: string; summary?: string }): Promise<string> =>
      (tool.execute as any)(args, {} as any);
    return { ws, execute };
  }

  test("rejects code containing print() and leaves the workflow untouched", async () => {
    const { ws, execute } = buildTool();
    const before = ws.getAllOperators().length;
    const result = await execute({
      operatorId: "inspectDf",
      code: `def process(df):
    print(df.dtypes)
    return df.head()`,
      summary: "Inspect dtypes then return head",
    });
    // The tool returns a `[ERROR] <one-sentence cause>` string.
    expect(typeof result).toBe("string");
    expect(result).toMatch(/^\[ERROR\] /);
    expect(result).toContain("print(...)");
    // No operator was added — the workflow is exactly as it was.
    expect(ws.getAllOperators().length).toBe(before);
    expect(ws.getAllOperators().length).toBe(0);
    expect(ws.getOperator("inspectDf")).toBeUndefined();
  });

  test("rejects code with no return statement and leaves the workflow untouched", async () => {
    const { ws, execute } = buildTool();
    const result = await execute({
      operatorId: "sideEffectOnly",
      code: `def process(df):
    x = df.describe()
    y = x.to_dict()`,
      summary: "Describe and convert — no return",
    });
    expect(result).toMatch(/^\[ERROR\] /);
    expect(result).toContain("`process`");
    expect(result).toContain("return");
    expect(ws.getAllOperators().length).toBe(0);
    expect(ws.getOperator("sideEffectOnly")).toBeUndefined();
  });

  test("rejects code whose only return is a bare `return` (no value) and leaves the workflow untouched", async () => {
    const { ws, execute } = buildTool();
    const result = await execute({
      operatorId: "earlyExit",
      code: `def process(df):
    if df.empty:
        return
    df.assign(x=1)`,
      summary: "Bare return then drop frame on the floor",
    });
    expect(result).toMatch(/^\[ERROR\] /);
    expect(result).toContain("`process`");
    expect(ws.getAllOperators().length).toBe(0);
    expect(ws.getOperator("earlyExit")).toBeUndefined();
  });

  test("does NOT replace an existing operator's code when the new code violates the contract", async () => {
    // Pre-seed the workflow with a valid DataLoading operator. The agent then
    // attempts to "modify" it with code that has a print. The contract check
    // should reject the modification AND leave the original `code` property
    // intact.
    const { ws, execute } = buildTool();
    const opId = "loadCsv";
    const goodCode = `def load() -> pd.DataFrame:
    return pd.read_csv('/data/x.csv')`;
    // Directly seed the workflow with a DataLoading op carrying the good code.
    // We bypass the tool here so we don't depend on schema metadata.
    ws.addOperator({
      operatorID: opId,
      operatorType: "DataLoading",
      operatorVersion: "v1",
      operatorProperties: { code: goodCode },
      inputPorts: [],
      outputPorts: [{ portID: "output-0", displayName: "" }],
      showAdvanced: false,
      isDisabled: false,
      customDisplayName: opId,
      dynamicInputPorts: false,
      dynamicOutputPorts: false,
    } as any);

    const badCode = `def load() -> pd.DataFrame:
    print('loading...')
    return pd.read_csv('/data/x.csv')`;
    const result = await execute({ operatorId: opId, code: badCode, summary: "bad summary" });
    expect(result).toMatch(/^\[ERROR\] /);
    expect(result).toContain("print(...)");
    // Original code is still in place — the rejected modification didn't land.
    const op = ws.getOperator(opId);
    expect(op).toBeDefined();
    expect((op!.operatorProperties as any).code).toBe(goodCode);
  });

  test("the error message is a single sentence", async () => {
    const { execute } = buildTool();
    const printResult = await execute({
      operatorId: "p",
      code: `def process(df):
    print(df)
    return df`,
      summary: "x",
    });
    const noReturnResult = await execute({
      operatorId: "n",
      code: `def process(df):
    df.describe()`,
      summary: "x",
    });
    for (const msg of [printResult, noReturnResult]) {
      expect(typeof msg).toBe("string");
      // Strip the `[ERROR] ` prefix the framework adds; the cause itself must
      // be one sentence — exactly one terminal `.` (or `!`/`?`), no internal
      // newlines.
      const body = (msg as string).replace(/^\[ERROR\]\s*/, "").trim();
      expect(body).not.toContain("\n");
      const sentenceTerminators = body.match(/[.!?](?:\s|$)/g) || [];
      expect(sentenceTerminators.length).toBe(1);
    }
  });
});

describe("stripPythonCommentsAndStrings", () => {
  test("blanks out single-quoted strings", () => {
    const stripped = stripPythonCommentsAndStrings(`x = 'print(hi)'\nreturn x`);
    expect(stripped).not.toContain("print(hi)");
    expect(stripped).toContain("return x");
  });

  test("blanks out triple-quoted docstrings", () => {
    const stripped = stripPythonCommentsAndStrings(`def f():
    """Doc with print() in it."""
    return 1`);
    expect(stripped).not.toContain("print()");
    expect(stripped).toContain("return 1");
  });

  test("blanks out line comments", () => {
    const stripped = stripPythonCommentsAndStrings(`x = 1  # print(x) for debug
return x`);
    expect(stripped).not.toContain("print(x)");
    expect(stripped).toContain("return x");
  });
});
