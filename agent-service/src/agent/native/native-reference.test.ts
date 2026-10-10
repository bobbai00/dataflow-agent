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

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderAll, renderToolDefinitions } from "../../../scripts/render-native-reference";

const root = fileURLToPath(new URL("../../../../native-mode/", import.meta.url));

test("native-mode/ reference documents match the code that produces them", () => {
  for (const [name, text] of Object.entries(renderAll())) {
    const committed = readFileSync(root + name, "utf8");
    expect(
      committed === text,
      `native-mode/${name} is stale; run \`bun run render:native-reference\` in agent-service/`
    ).toBe(true);
  }
});

test("the tool definition is the one native tool with its schema", () => {
  const tools = renderToolDefinitions();
  expect(tools.map(t => t.name)).toEqual(["dataflow"]);
  for (const t of tools) {
    expect(t.description.length).toBeGreaterThan(40);
    expect((t.schema as any).type).toBe("object");
  }
  const dataflow = tools[0].schema as any;
  expect(Object.keys(dataflow.properties)).toEqual(["python", "statements"]);
  expect(dataflow.required).toEqual(["python", "statements"]);
  expect(tools[0].strict).toBe(true);
});
