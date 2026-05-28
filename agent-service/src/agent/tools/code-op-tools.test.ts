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

const {
  regexContractCheck,
  stripPythonCommentsAndStrings,
  stripDocstringsAndComments,
  normalizeCodeForCompare,
  formatNoOpWarning,
} = __forTesting;

describe("validateOperatorId — Python identifier shape", () => {
  test("accepts simple lowercase word", () => {
    expect(validateOperatorId("customers")).toBeNull();
  });

  test("accepts camelCase with multiple words", () => {
    expect(validateOperatorId("lowHumidityFilter")).toBeNull();
    expect(validateOperatorId("filteredCustomers")).toBeNull();
    expect(validateOperatorId("avgFatalitiesByYear")).toBeNull();
  });

  test("accepts snake_case (underscores allowed since engine guard was removed)", () => {
    expect(validateOperatorId("low_humidity_filter")).toBeNull();
    expect(validateOperatorId("filter_2012_violations")).toBeNull();
  });

  test("accepts PascalCase", () => {
    expect(validateOperatorId("LowHumidityFilter")).toBeNull();
  });

  test("accepts trailing underscore and leading underscore", () => {
    expect(validateOperatorId("customers_")).toBeNull();
    expect(validateOperatorId("_priv")).toBeNull();
  });

  test("accepts trailing digits", () => {
    expect(validateOperatorId("top5")).toBeNull();
    expect(validateOperatorId("region2")).toBeNull();
  });

  test("rejects empty string", () => {
    const err = validateOperatorId("");
    expect(err).not.toBeNull();
    expect(err).toContain("cannot be empty");
  });

  test("rejects kebab-case (hyphens are not Python identifier chars)", () => {
    const err = validateOperatorId("low-humidity-filter");
    expect(err).not.toBeNull();
    expect(err).toContain("Python variable name");
  });

  test("rejects names starting with a digit", () => {
    const err = validateOperatorId("5top");
    expect(err).not.toBeNull();
    expect(err).toContain("Python variable name");
  });

  test("rejects names containing spaces", () => {
    const err = validateOperatorId("low humidity");
    expect(err).not.toBeNull();
    expect(err).toContain("Python variable name");
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

describe("regexContractCheck — warns on print()", () => {
  test("flags a bare print() call as a warning (not an error)", () => {
    const res = regexContractCheck(`def process(df):
    print(df.columns)
    return df`);
    expect(res).not.toBeNull();
    expect(res!.kind).toBe("warning");
    expect(res!.message).toContain("print(...)");
  });

  test("flags print() with whitespace before the paren", () => {
    const res = regexContractCheck(`def process(df):
    print (df.columns)
    return df`);
    expect(res).not.toBeNull();
    expect(res!.kind).toBe("warning");
    expect(res!.message).toContain("print(...)");
  });

  test("allows the word `print` inside a string literal", () => {
    const res = regexContractCheck(`def process(df):
    return df.assign(note="please print() this row")`);
    expect(res).toBeNull();
  });

  test("allows the word `print` inside a comment", () => {
    const res = regexContractCheck(`def process(df):
    # remember to print(...) for the demo
    return df`);
    expect(res).toBeNull();
  });
});

describe("regexContractCheck — requires a value-returning return", () => {
  test("flags a function with no return at all as an error", () => {
    const res = regexContractCheck(`def process(df):
    x = df.head()
    x.describe()`);
    expect(res).not.toBeNull();
    expect(res!.kind).toBe("error");
    expect(res!.message).toContain("`process`");
    expect(res!.message).toContain("return");
  });

  test("flags a function whose only return is a bare `return`", () => {
    const res = regexContractCheck(`def process(df):
    if df.empty:
        return
    df.describe()`);
    expect(res).not.toBeNull();
    expect(res!.kind).toBe("error");
    expect(res!.message).toContain("`process`");
  });

  test("missing-return wins over print() when both are present", () => {
    const res = regexContractCheck(`def process(df):
    print(df)
    df.describe()`);
    expect(res).not.toBeNull();
    expect(res!.kind).toBe("error");
    expect(res!.message).toContain("`process`");
  });

  test("accepts a function with a value-returning return", () => {
    const res = regexContractCheck(`def load() -> pd.DataFrame:
    return pd.read_csv('/data/file.csv')`);
    expect(res).toBeNull();
  });

  test("accepts a function whose return value is wrapped over multiple lines", () => {
    const res = regexContractCheck(`def process(df):
    return df.assign(
        col=df['a'] + df['b']
    )`);
    expect(res).toBeNull();
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

  // Note: there is no separate "add new operator with print()" test because
  // the ADD path requires a populated operator-schema map and metadata store
  // that the test harness can't easily provide without coupling to runtime
  // wiring. The "DOES replace an existing operator's code when the new code
  // only triggers a print() warning" test below covers the same warning
  // behavior end-to-end on the MODIFY path.

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

  test("does NOT replace an existing operator's code when the new code fails the hard contract (no return)", async () => {
    // Pre-seed the workflow with a valid DataLoading operator. The agent then
    // attempts to "modify" it with code that has no value-returning return —
    // a hard error. The contract check must reject the modification AND leave
    // the original `code` property intact.
    const { ws, execute } = buildTool();
    const opId = "loadCsv";
    const goodCode = `def load() -> pd.DataFrame:
    return pd.read_csv('/data/x.csv')`;
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

    const noReturnCode = `def load() -> pd.DataFrame:
    df = pd.read_csv('/data/x.csv')
    df.describe()`;
    const result = await execute({ operatorId: opId, code: noReturnCode, summary: "no-return summary" });
    expect(result).toMatch(/^\[ERROR\] /);
    expect(result).toContain("`load`");
    // Original code is still in place — the rejected modification didn't land.
    const op = ws.getOperator(opId);
    expect(op).toBeDefined();
    expect((op!.operatorProperties as any).code).toBe(goodCode);
  });

  test("DOES replace an existing operator's code when the new code only triggers a print() warning", async () => {
    // Same pre-seed as the hard-error case above, but this time the new code
    // contains a print() — soft warning, not a blocker. The modification
    // should land (new code replaces old) and the result should carry
    // `[WARNING] …`.
    const { ws, execute } = buildTool();
    const opId = "loadCsv";
    const goodCode = `def load() -> pd.DataFrame:
    return pd.read_csv('/data/x.csv')`;
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

    const printCode = `def load() -> pd.DataFrame:
    print('loading...')
    return pd.read_csv('/data/x.csv')`;
    const result = await execute({ operatorId: opId, code: printCode, summary: "with debug print" });
    expect(result).toMatch(/^\[WARNING\] /);
    expect(result).toContain("print(...)");
    // The modification DID land — `code` is the new code now.
    const op = ws.getOperator(opId);
    expect(op).toBeDefined();
    expect((op!.operatorProperties as any).code).toBe(printCode);
  });

  test("the no-return error message is a single sentence", async () => {
    const { execute } = buildTool();
    const noReturnResult = await execute({
      operatorId: "n",
      code: `def load() -> pd.DataFrame:
    pd.read_csv('/data/x.csv')`,
      summary: "x",
    });
    expect(typeof noReturnResult).toBe("string");
    const body = (noReturnResult as string).replace(/^\[ERROR\]\s*/, "").trim();
    expect(body).not.toContain("\n");
    const terminators = body.match(/[.!?](?:\s|$)/g) || [];
    expect(terminators.length).toBe(1);
  });

  test("the print() warning line is a single sentence", async () => {
    // Pre-seed an existing operator so we exercise the MODIFY path (the ADD
    // path needs schema/metadata wiring this harness doesn't provide).
    const { ws, execute } = buildTool();
    const opId = "p";
    ws.addOperator({
      operatorID: opId,
      operatorType: "DataLoading",
      operatorVersion: "v1",
      operatorProperties: { code: "def load() -> pd.DataFrame:\n    return pd.read_csv('/data/x.csv')" },
      inputPorts: [],
      outputPorts: [{ portID: "output-0", displayName: "" }],
      showAdvanced: false,
      isDisabled: false,
      customDisplayName: opId,
      dynamicInputPorts: false,
      dynamicOutputPorts: false,
    } as any);

    const result = await execute({
      operatorId: opId,
      code: `def load() -> pd.DataFrame:
    print("hi")
    return pd.read_csv('/data/x.csv')`,
      summary: "x",
    });
    expect(typeof result).toBe("string");
    // The warning is the FIRST line of the result; the rest is the normal
    // success message. We test only the warning line itself.
    const firstLine = (result as string).split("\n", 1)[0];
    expect(firstLine).toMatch(/^\[WARNING\] /);
    const body = firstLine.replace(/^\[WARNING\]\s*/, "").trim();
    const terminators = body.match(/[.!?](?:\s|$)/g) || [];
    expect(terminators.length).toBe(1);
  });
});

describe("stripDocstringsAndComments", () => {
  test("blanks triple-quoted docstrings", () => {
    const out = stripDocstringsAndComments(`def f():
    """First line of docstring.
    Second line."""
    return 1`);
    expect(out).not.toContain("First line");
    expect(out).not.toContain("Second line");
    expect(out).toContain("return 1");
  });

  test("blanks # line comments", () => {
    const out = stripDocstringsAndComments(`x = 1  # this is a comment with read_csv inside
y = 2`);
    expect(out).not.toContain("this is a comment");
    expect(out).not.toContain("read_csv inside");
    expect(out).toContain("x = 1");
    expect(out).toContain("y = 2");
  });

  test("keeps regular single/double-quoted strings verbatim (they carry data)", () => {
    const out = stripDocstringsAndComments(`return pd.read_csv('/data/x.csv', sep=';', encoding="utf-8")`);
    expect(out).toContain("'/data/x.csv'");
    expect(out).toContain("';'");
    expect(out).toContain('"utf-8"');
  });

  test("preserves line numbers (blanked region keeps newlines)", () => {
    const orig = `def f():\n    """doc"""\n    return 1`;
    const out = stripDocstringsAndComments(orig);
    expect(out.split("\n").length).toBe(orig.split("\n").length);
  });
});

describe("normalizeCodeForCompare", () => {
  test("treats identical code as identical", () => {
    const a = "def load():\n    return pd.read_csv('x.csv')";
    expect(normalizeCodeForCompare(a)).toBe(normalizeCodeForCompare(a));
  });

  test("ignores whitespace differences (extra spaces, blank lines, indentation noise)", () => {
    const a = "def load():\n    return pd.read_csv('x.csv', skiprows=2)";
    const b = "def load():\n\n        return  pd.read_csv('x.csv',    skiprows=2)\n";
    expect(normalizeCodeForCompare(a)).toBe(normalizeCodeForCompare(b));
  });

  test("treats docstring-only changes as equal (logic is the no-op signal)", () => {
    const a = `def load():\n    """Load X."""\n    return pd.read_csv('x.csv')`;
    const b = `def load():\n    """Reload X with extra explanation about provenance."""\n    return pd.read_csv('x.csv')`;
    expect(normalizeCodeForCompare(a)).toBe(normalizeCodeForCompare(b));
  });

  test("treats comment-only changes as equal", () => {
    const a = `def load():\n    # try the obvious read first\n    return pd.read_csv('x.csv')`;
    const b = `def load():\n    # NOTE: this should match the user-given path exactly\n    return pd.read_csv('x.csv')`;
    expect(normalizeCodeForCompare(a)).toBe(normalizeCodeForCompare(b));
  });

  test("detects an actual kwarg change as different", () => {
    const a = "def load():\n    return pd.read_csv('x.csv', skiprows=2)";
    const b = "def load():\n    return pd.read_csv('x.csv', skiprows=3)";
    expect(normalizeCodeForCompare(a)).not.toBe(normalizeCodeForCompare(b));
  });

  test("a real string-literal change (separator, path) is detected as different", () => {
    const a = "def load():\n    return pd.read_csv('x.csv', sep=',')";
    const b = "def load():\n    return pd.read_csv('x.csv', sep=';')";
    expect(normalizeCodeForCompare(a)).not.toBe(normalizeCodeForCompare(b));
  });
});

describe("formatNoOpWarning", () => {
  test("returns a single-paragraph WARNING line mentioning no-op, pivot, thrashing", () => {
    const out = formatNoOpWarning();
    expect(out.startsWith("WARNING:")).toBe(true);
    expect(out).toContain("no-op");
    expect(out).toContain("pivot");
    expect(out).toContain("thrashing");
  });
});

describe("createOrModifyOperator — modify result shape (post-cleanup)", () => {
  function buildTool() {
    const ws = new WorkflowState();
    const tool = createCreateOrModifyOperatorTool(ws, new Map(), undefined);
    const execute = (args: { operatorId: string; code: string; summary?: string }): Promise<string> =>
      (tool.execute as any)(args, {} as any);
    return { ws, execute };
  }

  function seedOp(ws: WorkflowState, opId: string, code: string) {
    ws.addOperator({
      operatorID: opId,
      operatorType: "DataLoading",
      operatorVersion: "v1",
      operatorProperties: { code },
      inputPorts: [],
      outputPorts: [{ portID: "output-0", displayName: "" }],
      showAdvanced: false,
      isDisabled: false,
      customDisplayName: opId,
      dynamicInputPorts: false,
      dynamicOutputPorts: false,
    } as any);
  }

  test("a real code change emits ONLY 'Operator X modified' — no diff body, no WARNING", async () => {
    const { ws, execute } = buildTool();
    const opId = "csvLoader";
    seedOp(ws, opId, "def load() -> pd.DataFrame:\n    return pd.read_csv('/data/x.csv')");
    const result = await execute({
      operatorId: opId,
      code: "def load() -> pd.DataFrame:\n    return pd.read_csv('/data/x.csv', skiprows=2)",
      summary: "with skiprows=2",
    });
    expect(result).toContain(opId);
    expect(result).toContain("modified");
    expect(result).not.toContain("WARNING");
    expect(result).not.toContain("@@");
    expect(result).not.toContain("Code diff");
    expect(result).not.toContain("Before code:");
    expect(result).not.toContain("After code:");
  });

  test("submitting code byte-identical to the prior version triggers the no-op WARNING", async () => {
    const { ws, execute } = buildTool();
    const opId = "csvLoader";
    const code = "def load() -> pd.DataFrame:\n    return pd.read_csv('/data/x.csv', skiprows=2)";
    seedOp(ws, opId, code);
    const result = await execute({ operatorId: opId, code, summary: "still skiprows=2" });
    expect(result).toContain("WARNING");
    expect(result).toContain("no-op");
    expect(result).toContain("pivot");
  });

  test("docstring-only edit counts as a no-op (the most common thrash leak)", async () => {
    const { ws, execute } = buildTool();
    const opId = "csvLoader";
    seedOp(
      ws,
      opId,
      'def load() -> pd.DataFrame:\n    """Load X."""\n    return pd.read_csv("x.csv", skiprows=2)'
    );
    const result = await execute({
      operatorId: opId,
      code:
        'def load() -> pd.DataFrame:\n    """Reload X with extra notes about provenance."""\n    return pd.read_csv("x.csv", skiprows=2)',
      summary: "rewrote docstring only",
    });
    expect(result).toContain("WARNING");
    expect(result).toContain("no-op");
  });

  test("whitespace-only differences also count as a no-op", async () => {
    const { ws, execute } = buildTool();
    const opId = "csvLoader";
    seedOp(
      ws,
      opId,
      "def load() -> pd.DataFrame:\n    return pd.read_csv('/data/x.csv', skiprows=2)"
    );
    const result = await execute({
      operatorId: opId,
      code:
        "def load() -> pd.DataFrame:\n\n        return  pd.read_csv('/data/x.csv',    skiprows=2)\n",
      summary: "reformatted only",
    });
    expect(result).toContain("WARNING");
    expect(result).toContain("no-op");
  });

  test("a real kwarg change does NOT trigger the no-op WARNING", async () => {
    const { ws, execute } = buildTool();
    const opId = "csvLoader";
    seedOp(
      ws,
      opId,
      "def load() -> pd.DataFrame:\n    return pd.read_csv('/data/x.csv', skiprows=2)"
    );
    const result = await execute({
      operatorId: opId,
      code: "def load() -> pd.DataFrame:\n    return pd.read_csv('/data/x.csv', skiprows=3)",
      summary: "skiprows=3",
    });
    expect(result).not.toContain("WARNING");
    expect(result).toContain("modified");
  });

  test("convergence guard callback blocks an existing-operator modify before mutation", async () => {
    const ws = new WorkflowState();
    const opId = "csvLoader";
    const originalCode = "def load() -> pd.DataFrame:\n    return pd.read_csv('/data/x.csv')";
    seedOp(ws, opId, originalCode);
    const tool = createCreateOrModifyOperatorTool(ws, new Map(), {
      onBeforeCodeOperatorChange: ({ operatorId, isModify }) =>
        isModify && operatorId === opId ? "CONVERGENCE_GUARD: pivot before editing again." : null,
    });
    const execute = (args: { operatorId: string; code: string; summary?: string }): Promise<string> =>
      (tool.execute as any)(args, {} as any);

    const result = await execute({
      operatorId: opId,
      code: "def load() -> pd.DataFrame:\n    return pd.read_csv('/data/x.csv', skiprows=3)",
      summary: "skiprows=3",
    });

    expect(result).toMatch(/^\[ERROR\] /);
    expect(result).toContain("CONVERGENCE_GUARD");
    expect((ws.getOperator(opId)!.operatorProperties as any).code).toBe(originalCode);
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
