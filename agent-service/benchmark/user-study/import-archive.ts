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

/**
 * A participant's Scenario 2 workflow from an archive, over the API: a new
 * workflow and agent, the archive imported into it (steps, every operator's
 * results, the rules), and the workflow's URL to open. What the chat's Import
 * button does, without the browser.
 *
 *   AGENT_BASE=http://localhost:3001 PROBE_MODEL=claude-haiku-5.5 \
 *     bun run benchmark/user-study/import-archive.ts path/to/airbnb_bobflow_archive.json "P03"
 */
import { readFileSync } from "node:fs";
import { login } from "../../src/api";
import { studyLogin } from "./study";
import { createStudyAgent, studyWorkflowUrl } from "./bobflow";

const [archivePath, label = `import ${new Date().toISOString().slice(0, 16)}`] = process.argv.slice(2);
if (!archivePath) throw new Error("usage: import-archive.ts <archive.json> [label]");
const archive = JSON.parse(readFileSync(archivePath, "utf8")) as {
  steps: unknown[];
  results?: Record<string, Record<string, unknown>>;
  instructions?: string;
};
const MODEL = process.env.PROBE_MODEL ?? "claude-haiku-5.5";

const token = await studyLogin(login);
const { api, agent, wid } = await createStudyAgent(token, { name: `Scenario 2 – ${label}`, model: MODEL });
const started = Date.now();
const imported = await api.post(`/${agent.id}/import-react-steps`, { ...archive, execute: true });
if (!imported.importedCount) throw new Error(`import failed: ${JSON.stringify(imported).slice(0, 300)}`);
const results = (await api.get(`/${agent.id}/operator-results`)).results ?? {};
const workflow = await api.get(`/${agent.id}/workflow`);
const settings = await api.get(`/${agent.id}/settings`);
console.log(
  `agent ${agent.id} on workflow ${wid}: imported ${imported.importedCount} steps in ${((Date.now() - started) / 1000).toFixed(1)} s; ` +
    `${workflow.workflow?.operators?.length ?? 0} operators, ${Object.keys(results).length} with results, ` +
    `${Object.values(results).filter((r: any) => r.error).length} failed; instructions ${settings.instructions ? "set" : "NOT set"}; ` +
    `run after import: ${imported.executed?.state ?? "not run"}`
);
console.log(`\nOpen for the participant: ${studyWorkflowUrl(wid)}`);
