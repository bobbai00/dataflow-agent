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
 * Seeding: what every user gets on first contact, without importing anything
 * by hand. A seed definition is one JSON file, shared with the script agent's
 * service, which reads its own section:
 *
 *   {
 *     "name": "scenario-2",
 *     "bobflow": {
 *       "workflowName": "Scenario 2: San Francisco Airbnb",
 *       "archive": "~/Desktop/user-study/scenario-2/dataflow/airbnb_bobflow_archive.json",
 *       "model": "claude-haiku-5.5",
 *       "agentName": "Bob",
 *       "settings": { "operatorDoc": true },
 *       "computingUnit": { "name": "user-study", "uri": "http://localhost:8085" }
 *     },
 *     "smolagents": { "notebook": "...", "files": ["..."] }
 *   }
 *
 * `AGENT_SEED_FILE` names it. Paths may start with `~`, and relative paths are
 * read against the definition's folder, so one file serves a laptop and a
 * bare-metal deployment alike. The seeding itself (a workflow, an agent, the
 * archive imported and run once, all under the user's own account and traced
 * as theirs) lives in server.ts, next to the agent routes it reuses; this
 * module holds what it needs from the platform.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { createComputingUnit, listComputingUnits } from "../api/computing-unit-api";
import { createLogger } from "../logger";

const log = createLogger("Seed");

export interface BobflowSeed {
  /** The workflow each user gets; its description shows in the dashboard. */
  workflowName: string;
  description?: string;
  /** `GET /api/agents/:id/archive` of a prepared agent: steps, results and instructions. */
  archive: string;
  model: string;
  agentName?: string;
  settings?: Record<string, unknown>;
  /** The computing unit the agent runs on: an existing id, or one of the user's by name, created with this uri when missing. */
  computingUnit?: { cuid?: number; name?: string; uri?: string; unitType?: "local" | "kubernetes" };
}

export interface SeedDefinition {
  name: string;
  bobflow?: BobflowSeed;
  /** The script agent's section; not read here. */
  smolagents?: unknown;
}

/** `~` and relative paths resolved against `base`. */
export function resolveSeedPath(path: string, base: string): string {
  const expanded = path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

/** The definition `AGENT_SEED_FILE` names, with its archive path resolved; undefined when seeding is off. */
export function loadSeedDefinition(file: string | undefined): SeedDefinition | undefined {
  if (!file) return undefined;
  const path = resolveSeedPath(file, process.cwd());
  const parsed = JSON.parse(readFileSync(path, "utf8")) as SeedDefinition;
  if (!parsed.name) throw new Error(`${path}: a seed definition needs a name`);
  if (parsed.bobflow) {
    const bob = parsed.bobflow;
    for (const key of ["workflowName", "archive", "model"] as const)
      if (!bob[key]) throw new Error(`${path}: bobflow.${key} is required`);
    bob.archive = resolveSeedPath(bob.archive, dirname(path));
    if (!existsSync(bob.archive)) throw new Error(`${path}: the archive ${bob.archive} does not exist`);
  }
  log.info({ path, seed: parsed.name, bobflow: !!parsed.bobflow }, "seed definition loaded");
  return parsed;
}

/** The archive the seed imports, read fresh each time (a facilitator may regenerate it while the service runs). */
export function readSeedArchive(seed: BobflowSeed): Record<string, unknown> {
  return JSON.parse(readFileSync(seed.archive, "utf8")) as Record<string, unknown>;
}

/**
 * The computing unit a seeded agent runs on, as the user: the configured id,
 * else the user's unit of the configured name (created from the configured
 * uri when the user has none), else the first unit the user can see.
 */
export async function ensureComputingUnit(userToken: string, wanted: BobflowSeed["computingUnit"]): Promise<number> {
  if (wanted?.cuid) return wanted.cuid;
  const units = await listComputingUnits(userToken);
  const name = wanted?.name ?? "user-study";
  const named = units.find(unit => unit.computingUnit.name === name && !unit.computingUnit.terminateTime);
  if (named) return named.computingUnit.cuid;
  if (wanted?.uri || wanted?.unitType === "kubernetes") {
    const created = await createComputingUnit(userToken, name, {
      unitType: wanted.unitType ?? "local",
      uri: wanted.uri,
    });
    return created.computingUnit.cuid;
  }
  const any = units.find(unit => !unit.computingUnit.terminateTime);
  if (any) return any.computingUnit.cuid;
  throw new Error("No computing unit for the seeded agent: configure computingUnit.uri or .cuid in the seed");
}

/** An empty workflow, as the frontend creates one. */
export const EMPTY_WORKFLOW_CONTENT = {
  operators: [],
  operatorPositions: {},
  links: [],
  commentBoxes: [],
  settings: { dataTransferBatchSize: 400 },
};
