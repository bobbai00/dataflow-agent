/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import { expect, test } from "bun:test";
import { asSchema } from "ai";
import { TexeraAgent } from "../texera-agent";
import { createLegacyNativeAgent } from "./legacy-native-agent";

test("historical agent fixtures do not change the current default tool", () => {
  const config = {
    agentId: "protocol-fixture",
    modelType: "test",
    contextAssembler: () => [],
    driver: { runTurn: async () => ({ text: "", messages: [], usage: {} }) },
  };
  const historical = createLegacyNativeAgent(config);
  const current = new TexeraAgent({ ...config, agentId: "current-protocol" });
  const schema = (agent: TexeraAgent) => asSchema((agent as any).tools.dataflow.inputSchema).jsonSchema as any;
  const edit = (agent: TexeraAgent) =>
    schema(agent).properties.actions.items.anyOf.find((action: any) => action.properties.type.const === "edit");
  expect(edit(historical).required).not.toContain("python");
  expect(edit(current).required).toContain("python");
  historical.updateSettings({ retrievalViews: ["sample"], stateHistory: true });
  expect(edit(historical).required).not.toContain("python");
  expect(edit(current).required).toContain("python");
  expect(historical.getSettings().systemPrompt).toContain("`new_name = at(name, task=N)`");
});
