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
 * Participant accounts on both systems, seeded and checked: for each name,
 * register the account on Texera and on the script agent (or sign in when it
 * exists), ask each service to seed it, wait, and print what each side's trace
 * holds. Both services must run with the same seed definition
 * (`AGENT_SEED_FILE` and `--seed`); a user who registers through either UI is
 * seeded the same way on first login, this script just does it ahead of time.
 *
 *   STUDY_PASSWORD=... bun run benchmark/user-study/seed-accounts.ts p01 p02 p03
 *
 * Environment: AGENT_BASE (http://localhost:3001), WEB_BASE (http://localhost:8080),
 * SMOL_BASE (http://localhost:7860; "off" skips the script agent), STUDY_PASSWORD
 * (default study-2026), STUDY_EMAIL_DOMAIN (study.local).
 */
import { STUDY } from "./study";

const WEB = process.env.WEB_BASE ?? "http://localhost:8080";
const SMOL = process.env.SMOL_BASE ?? "http://localhost:7860";
const PASSWORD = process.env.STUDY_PASSWORD ?? "study-2026";
const DOMAIN = process.env.STUDY_EMAIL_DOMAIN ?? "study.local";
const WAIT_SECONDS = Number(process.env.SEED_WAIT_SECONDS ?? 240);

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error("usage: bun run benchmark/user-study/seed-accounts.ts <username> [username...]");
  process.exit(2);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const JSON_HEADERS = { "Content-Type": "application/json" };

async function texeraLogin(username: string, password: string): Promise<string | undefined> {
  const login = await fetch(`${WEB}/api/auth/login`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ username, password }),
  });
  return login.ok ? ((await login.json()) as { accessToken: string }).accessToken : undefined;
}

const roleOf = (token: string): string =>
  (JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as { role?: string }).role ?? "";

/**
 * A self-registered Texera account is INACTIVE until an admin activates it, and
 * an inactive account can neither list computing units nor run anything. The
 * study account is that admin: it sets the role to REGULAR.
 */
async function activate(username: string): Promise<void> {
  const admin = await texeraLogin(STUDY.username, STUDY.password);
  if (!admin) throw new Error(`Texera: cannot sign in as the study admin ${STUDY.username}`);
  const headers = { ...JSON_HEADERS, Authorization: `Bearer ${admin}` };
  const users = (await fetch(`${WEB}/api/admin/user/list`, { headers }).then(r => r.json())) as Array<
    Record<string, unknown>
  >;
  const user = users.find(u => u.name === username);
  if (!user) throw new Error(`Texera: ${username} is not in the admin's user list`);
  const update = await fetch(`${WEB}/api/admin/user/update`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      uid: user.uid,
      name: user.name,
      email: user.email,
      role: "REGULAR",
      comment: user.comment ?? null,
    }),
  });
  if (!update.ok) throw new Error(`Texera: cannot activate ${username}: ${update.status} ${await update.text()}`);
}

/** A Texera token for an active account, registering and activating it as needed. */
async function texeraToken(username: string): Promise<{ token: string; created: boolean }> {
  let created = false;
  let token = await texeraLogin(username, PASSWORD);
  if (!token) {
    const register = await fetch(`${WEB}/api/auth/register`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ username, email: `${username}@${DOMAIN}`, password: PASSWORD }),
    });
    if (!register.ok)
      throw new Error(`Texera: cannot register ${username}: ${register.status} ${await register.text()}`);
    token = ((await register.json()) as { accessToken: string }).accessToken;
    created = true;
  }
  if (!["REGULAR", "ADMIN"].includes(roleOf(token))) {
    await activate(username);
    token = await texeraLogin(username, PASSWORD);
    if (!token) throw new Error(`Texera: ${username} cannot sign in after activation`);
  }
  return { token, created };
}

async function seedBobflow(username: string): Promise<string> {
  const { token, created } = await texeraToken(username);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const base = `${STUDY.agentBase}/api/agents`;
  let status = (await fetch(`${base}/seed`, { method: "POST", headers, body: "{}" }).then(r => r.json())) as Record<
    string,
    unknown
  >;
  if (status.status === "disabled") return `${created ? "created" : "exists"}; seeding is off (AGENT_SEED_FILE unset)`;
  const deadline = Date.now() + WAIT_SECONDS * 1000;
  while (status.status === "running" && Date.now() < deadline) {
    await sleep(2000);
    status = (await fetch(`${base}/seed`, { headers }).then(r => r.json())) as Record<string, unknown>;
  }
  if (status.status !== "done")
    return `${created ? "created" : "exists"}; seed ${status.status}: ${status.error ?? "timed out"}`;
  // What the trace holds for this account, as a facilitator would check it.
  const traces = (await fetch(`${STUDY.agentBase}/api/traces?user=${encodeURIComponent(username)}`).then(r =>
    r.json()
  )) as { agents?: Array<{ id: string; steps: number; turns: number }> } | Array<{ id: string; steps: number }>;
  const agents = Array.isArray(traces) ? traces : (traces.agents ?? []);
  const mine = agents.find(a => a.id === status.agentId);
  return `${created ? "created" : "exists"}; workflow ${status.workflowId}, agent ${status.agentId} (${mine?.steps ?? "?"} traced steps)`;
}

async function seedSmolagents(username: string): Promise<string> {
  if (SMOL === "off") return "skipped";
  const form = new URLSearchParams({ username, password: PASSWORD });
  const cookieOf = (response: Response) => response.headers.get("set-cookie")?.split(";")[0];
  let response = await fetch(`${SMOL}/login`, { method: "POST", body: form, redirect: "manual" });
  let created = false;
  let cookie = response.status === 303 ? cookieOf(response) : undefined;
  if (!cookie) {
    response = await fetch(`${SMOL}/register`, { method: "POST", body: form, redirect: "manual" });
    cookie = response.status === 303 ? cookieOf(response) : undefined;
    created = true;
    if (!cookie) throw new Error(`script agent: cannot register ${username}: ${response.status}`);
  }
  const headers = { Cookie: cookie };
  let status = (await fetch(`${SMOL}/api/seed`, { method: "POST", headers }).then(r => r.json())) as Record<
    string,
    unknown
  >;
  if (status.status === "disabled") return `${created ? "created" : "exists"}; seeding is off (--seed unset)`;
  const deadline = Date.now() + WAIT_SECONDS * 1000;
  while (status.status === "running" && Date.now() < deadline) {
    await sleep(2000);
    status = (await fetch(`${SMOL}/api/seed`, { headers }).then(r => r.json())) as Record<string, unknown>;
  }
  if (status.status !== "done")
    return `${created ? "created" : "exists"}; seed ${status.status}: ${status.error ?? "timed out"}`;
  const runs = (await fetch(`${SMOL}/api/runs`, { headers }).then(r => r.json())) as Array<{
    kind: string;
    status: string;
    steps: number;
  }>;
  const notebook = runs.find(r => r.kind === "notebook");
  return `${created ? "created" : "exists"}; notebook run ${notebook?.status ?? "missing"} (${notebook?.steps ?? 0} cells), ${runs.length} runs traced`;
}

let failed = false;
for (const name of names) {
  const [bobflow, smol] = await Promise.all([
    seedBobflow(name).catch(error => {
      failed = true;
      return `FAILED: ${error instanceof Error ? error.message : String(error)}`;
    }),
    seedSmolagents(name).catch(error => {
      failed = true;
      return `FAILED: ${error instanceof Error ? error.message : String(error)}`;
    }),
  ]);
  if (/seed (failed|running)/.test(bobflow + smol)) failed = true;
  console.log(`${name}\n  BobFlow:      ${bobflow}\n  script agent: ${smol}`);
}
process.exit(failed ? 1 : 0);
