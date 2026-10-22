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
import { looksLikeAgentInput, parseDebugInput, parseFunctionCall, parseReply } from "./debug-parser";

describe("debug inputs that stand for the agent", () => {
  test("a Function(...) call parses as before, with no thought", () => {
    const parsed = parseDebugInput("Function(name='dataflow', arguments='{\\'python\\': \\'\\', \\'statements\\': \\'show result a\\'}')");
    expect(parsed).toEqual({ call: { name: "dataflow", arguments: { python: "", statements: "show result a" } } });
    expect(parseFunctionCall("Function(name='x', arguments='{}')")).toEqual({ name: "x", arguments: {} });
  });

  test("lines before the call are the step's thought", () => {
    const parsed = parseDebugInput("Load the files.\nThen look at them.\n\nFunction(name='dataflow', arguments='{}')");
    expect(parsed).toEqual({ thought: "Load the files.\nThen look at them.", call: { name: "dataflow", arguments: {} } });
  });

  test("Reply(text='...') is the agent's reply, with Python string escapes", () => {
    expect(parseDebugInput("Reply(text='Pizzeria: 0.94 vs 1.17.\\nThat\\'s the gap.')")).toEqual({
      reply: "Pizzeria: 0.94 vs 1.17.\nThat's the gap.",
    });
    expect(parseReply("Reply(text='done',)")).toBe("done");
    expect(parseDebugInput("The answer follows.\nReply(text='42')")).toEqual({ thought: "The answer follows.", reply: "42" });
  });

  test("plain text is the user's, and malformed agent inputs throw", () => {
    expect(looksLikeAgentInput("hello Function( in the middle")).toBe(false);
    expect(looksLikeAgentInput("  Reply(text='x')")).toBe(true);
    expect(() => parseDebugInput("hello")).toThrow("neither");
    expect(() => parseReply("Reply(text='x'")).toThrow("closing");
    expect(() => parseReply("Reply(message='x')")).toThrow();
    expect(() => parseDebugInput("Function(name='x')")).toThrow();
  });
});
