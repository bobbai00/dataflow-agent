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
import { parseReActText } from "./react-text-parser";

describe("parseReActText (Qwen3-Coder tool-call format)", () => {
  test("terminal turn: free text, no tool call", () => {
    const out = parseReActText("The answer is 42.\n\n**Final Answer: 42**\n");
    expect(out.thought).toBe("The answer is 42.\n\n**Final Answer: 42**");
    expect(out.actions).toEqual([]);
  });

  test("single tool call with multi-line code preserves interior indentation", () => {
    const raw = `I will load the data.
<tool_call>
<function=createOrModifyOperator>
<parameter=operatorId>
loadData
</parameter>
<parameter=code>
def load() -> pd.DataFrame:
    return pd.read_csv('/data/x.csv')
</parameter>
<parameter=summary>
Load x.csv
</parameter>
</function>
</tool_call>`;
    const out = parseReActText(raw);
    expect(out.thought).toBe("I will load the data.");
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0].name).toBe("createOrModifyOperator");
    expect(out.actions[0].input).toEqual({
      operatorId: "loadData",
      code: "def load() -> pd.DataFrame:\n    return pd.read_csv('/data/x.csv')",
      summary: "Load x.csv",
    });
  });

  test("multiple <tool_call> blocks in one turn map to ordered actions", () => {
    const raw = `Load both files.
<tool_call>
<function=createOrModifyOperator>
<parameter=operatorId>
a
</parameter>
<parameter=summary>
first
</parameter>
</function>
</tool_call>
<tool_call>
<function=createOrModifyOperator>
<parameter=operatorId>
b
</parameter>
<parameter=summary>
second
</parameter>
</function>
</tool_call>`;
    const out = parseReActText(raw);
    expect(out.thought).toBe("Load both files.");
    expect(out.actions).toHaveLength(2);
    expect(out.actions[0].input).toEqual({ operatorId: "a", summary: "first" });
    expect(out.actions[1].input).toEqual({ operatorId: "b", summary: "second" });
  });

  test("deleteOperator single-parameter call", () => {
    const raw = `Removing the orphan.
<tool_call>
<function=deleteOperator>
<parameter=operatorId>
badLoader
</parameter>
</function>
</tool_call>`;
    const out = parseReActText(raw);
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0].name).toBe("deleteOperator");
    expect(out.actions[0].input).toEqual({ operatorId: "badLoader" });
  });

  test("code containing single + double quotes and braces is preserved verbatim", () => {
    const raw = `<tool_call>
<function=createOrModifyOperator>
<parameter=operatorId>
filterCands
</parameter>
<parameter=code>
def process(d) -> pd.DataFrame:
    return d[~d['Candidate'].isin(['A', 'B'])]
</parameter>
<parameter=summary>
Filter out candidates A and B
</parameter>
</function>
</tool_call>`;
    const out = parseReActText(raw);
    const inp = out.actions[0].input;
    expect(inp.operatorId).toBe("filterCands");
    expect(inp.code).toContain("def process(d)");
    expect(inp.code).toContain("d[~d['Candidate'].isin(['A', 'B'])]");
    expect(inp.summary).toBe("Filter out candidates A and B");
  });

  test("inline parameter value (no surrounding newlines)", () => {
    const raw = `<tool_call>
<function=deleteOperator>
<parameter=operatorId>orphan</parameter>
</function>
</tool_call>`;
    const out = parseReActText(raw);
    expect(out.actions[0].input).toEqual({ operatorId: "orphan" });
  });

  test("<think> reasoning block is stripped from the thought", () => {
    const raw = `<think>
The user wants the 2009-10 row. Let me filter.
</think>
Filtering to the 2009-10 season.
<tool_call>
<function=createOrModifyOperator>
<parameter=operatorId>
filterSeason
</parameter>
<parameter=summary>
Filter to 2009-10
</parameter>
</function>
</tool_call>`;
    const out = parseReActText(raw);
    expect(out.thought).toBe("Filtering to the 2009-10 season.");
    expect(out.thought).not.toContain("<think>");
    expect(out.thought).not.toContain("Let me filter");
    expect(out.actions[0].input).toEqual({ operatorId: "filterSeason", summary: "Filter to 2009-10" });
  });

  test("leading 'Thought:' label is stripped even when the model mimics the context format", () => {
    const raw = `Thought: building the loader now.
<tool_call>
<function=createOrModifyOperator>
<parameter=operatorId>
src
</parameter>
<parameter=summary>
load src.csv
</parameter>
</function>
</tool_call>`;
    const out = parseReActText(raw);
    expect(out.thought).toBe("building the loader now.");
  });

  test("action-only turn yields an empty thought", () => {
    const raw = `<tool_call>
<function=deleteOperator>
<parameter=operatorId>
x
</parameter>
</function>
</tool_call>`;
    const out = parseReActText(raw);
    expect(out.thought).toBe("");
    expect(out.actions).toHaveLength(1);
  });

  test("text emitted after the call (illegal suffix) is ignored, not folded into the thought", () => {
    const raw = `Reason.
<tool_call>
<function=deleteOperator>
<parameter=operatorId>
x
</parameter>
</function>
</tool_call>
Some trailing chatter that should be dropped.`;
    const out = parseReActText(raw);
    expect(out.thought).toBe("Reason.");
    expect(out.thought).not.toContain("trailing chatter");
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0].input).toEqual({ operatorId: "x" });
  });

  test("truncated output (missing closing </parameter> and </function>) still parses", () => {
    const raw = `<tool_call>
<function=createOrModifyOperator>
<parameter=operatorId>
loadData
</parameter>
<parameter=code>
def load() -> pd.DataFrame:
    return pd.read_csv('/data/x.csv')`;
    const out = parseReActText(raw);
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0].name).toBe("createOrModifyOperator");
    expect(out.actions[0].input.operatorId).toBe("loadData");
    expect(out.actions[0].input.code).toContain("pd.read_csv('/data/x.csv')");
  });

  test("bare <function=> without the <tool_call> wrapper is still extracted", () => {
    const raw = `<function=deleteOperator>
<parameter=operatorId>
x
</parameter>
</function>`;
    const out = parseReActText(raw);
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0].name).toBe("deleteOperator");
    expect(out.actions[0].input).toEqual({ operatorId: "x" });
  });

  test("malformed tool call surfaces __parseError so the loop never terminates silently", () => {
    const raw = `Doing a thing.
<tool_call>
this block has no function tag at all
</tool_call>`;
    const out = parseReActText(raw);
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0].input.__parseError).toBeDefined();
    expect(out.actions[0].input.__rawInput).toContain("no function tag");
    // thought is still recovered
    expect(out.thought).toBe("Doing a thing.");
  });
});
