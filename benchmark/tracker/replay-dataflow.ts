/**
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Replay recorded dataflow-agent conversations through a running agent service, in one agent, and record its memory
 * and the time of jumps between snapshots as the snapshot tree grows.
 *
 * The agent runs exactly as in a benchmark run, except that its model is this script: the service's LLM_ENDPOINT
 * points at --model-port, which answers each model call with the next recorded response of the conversation being
 * replayed. Every call the agent makes, every edit and every execution on the engine, happens for real. Each
 * conversation starts from the agent's first snapshot (the empty dataflow), so the conversations become branches of
 * one snapshot tree, as in benchmark/tracker/README.md. The service's memory is read after each conversation, and
 * again once HEAD is back at the first snapshot ("rest" lines): the history alone, without the conversation's working
 * set.
 *
 *   bun benchmark/tracker/replay-dataflow.ts --conversations C.jsonl --out OUT.jsonl --agent http://localhost:3141 \
 *     --model-port 3199 [--texera http://localhost:64080] [--cu 10] [--history keep|forget] \
 *     [--jumps 0] [--jump-every 100] [--limit 0]
 *
 * --history forget drops, before each conversation, every snapshot its path does not need (the "without the context
 * tracker" arm). --jumps K checks out K random versions each time the tree passes another --jump-every snapshots.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    conversations: { type: "string" },
    out: { type: "string" },
    agent: { type: "string", default: "http://localhost:3141" },
    texera: { type: "string", default: "http://localhost:64080" },
    cu: { type: "string", default: "10" },
    "model-port": { type: "string", default: "3199" },
    history: { type: "string", default: "keep" },
    jumps: { type: "string", default: "0" },
    "jump-every": { type: "string", default: "100" },
    limit: { type: "string", default: "0" },
    seed: { type: "string", default: "7" },
    "turn-timeout": { type: "string", default: "1800" },
  },
});

interface Conversation {
  id: string;
  prompt: string;
  settings: Record<string, unknown>;
  calls: Array<{ response: any; requestChars: number }>;
  toolErrors: boolean[];
}

const conversations: Conversation[] = readFileSync(args.conversations!, "utf8")
  .split("\n")
  .filter(Boolean)
  .map(line => JSON.parse(line));
if (Number(args.limit)) conversations.splice(Number(args.limit));
const out = args.out!;
writeFileSync(out, "");
const emit = (line: Record<string, unknown>) => appendFileSync(out, JSON.stringify(line) + "\n");
const api = `${args.agent}/api/agents`;

// ── the model: recorded responses, in call order ───────────────────────────
let current: Conversation | undefined;
let served = 0;
const fidelity: Array<{ call: number; sentChars: number; recordedChars: number }> = [];
const modelServer = Bun.serve({
  port: Number(args["model-port"]),
  async fetch(request) {
    if (!new URL(request.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
    const body = await request.json();
    const call = current?.calls[served];
    fidelity.push({ call: served, sentChars: JSON.stringify(body.messages).length, recordedChars: call?.requestChars ?? 0 });
    served++;
    // More calls than the run made: answer, which ends the turn.
    const response = call?.response ?? {
      object: "chat.completion",
      created: 0,
      model: "replay",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "**Final Answer: replay ended**" },
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    return Response.json({ ...response, id: `replay-${served}-${Date.now()}` });
  },
});

// ── the agent service ──────────────────────────────────────────────────────
async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok)
    throw Object.assign(new Error(`${method} ${url}: ${response.status} ${text.slice(0, 500)}`), { body: text });
  return text ? JSON.parse(text) : undefined;
}

const token = (await call("POST", `${args.texera}/api/auth/login`, { username: "texera", password: "texera" }))
  .accessToken as string;
const auth = { Authorization: `Bearer ${token}` };
const created = await call(
  "POST",
  `${args.texera}/api/workflow/create`,
  {
    name: `tracker-replay-${Date.now()}`,
    content: JSON.stringify({ operators: [], operatorPositions: {}, links: [], commentBoxes: [], settings: {} }),
  },
  auth
);
const workflowId = created.workflow?.wid ?? created.wid;
const agentId = (
  await call(
    "POST",
    api,
    { modelType: "claude-opus-5.5", workflowId, computingUnitId: Number(args.cu), name: "tracker-replay" },
    auth
  )
).id as string;
const tree = async () => call("GET", `${api}/${agentId}/snapshot-tree`);
const initStepId = (await tree()).nodes.find((node: any) => node.action?.kind === "start")?.reactStepId as string;
if (!initStepId) throw new Error("the agent has no initialize step");

// Frames from the agent's socket; a waiter takes the first frame it matches.
const waiters: Array<{ match: (frame: any) => boolean; resolve: (frame: any) => void; bytes?: number }> = [];
// The agent steps the running turn streamed (a step is sent again when it changes).
const turnSteps = new Map<string, any>();
const socket = new WebSocket(`${args.agent.replace(/^http/, "ws")}/api/agents/${agentId}/react`);
socket.onmessage = event => {
  const text = String(event.data);
  const frame = JSON.parse(text);
  if (frame.type === "step" && frame.step?.role === "agent") turnSteps.set(frame.step.id, frame.step);
  const index = waiters.findIndex(waiter => waiter.match(frame));
  if (index >= 0) waiters.splice(index, 1)[0].resolve({ frame, bytes: text.length, at: performance.now() });
};
await new Promise(resolve => (socket.onopen = resolve));
const next = (match: (frame: any) => boolean, seconds: number) =>
  new Promise<any>((resolve, reject) => {
    const waiter = { match, resolve };
    waiters.push(waiter);
    setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) {
        waiters.splice(index, 1);
        reject(new Error(`no frame within ${seconds} s`));
      }
    }, seconds * 1000);
  });

const memory = async () => call("GET", `${args.agent}/api/debug/memory`);
const size = async () => call("GET", `${api}/${agentId}/debug/tracker`);

// ── jumps ──────────────────────────────────────────────────────────────────
let seed = Number(args.seed);
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

async function jump(snapshots: number) {
  const versions = (await tree()).nodes.filter((node: any) => node.version !== undefined);
  const target = versions[Math.floor(random() * versions.length)];
  const headChange = next(frame => frame.type === "headChange", 120);
  const started = performance.now();
  const response = await call("POST", `${api}/${agentId}/checkout-version`, { snapshotId: target.id });
  const answered = performance.now();
  const frame = await headChange;
  emit({
    kind: "jump",
    snapshots,
    target: target.id,
    version: target.version,
    action: target.action?.kind,
    httpMs: answered - started,
    headChangeMs: frame.at - started,
    headChangeBytes: frame.bytes,
    ...response.timing,
  });
}

// The recorded settings are what GET /settings returned; PATCH takes most of them. A setting it rejects (fixed at
// creation, or read-only) is left as the agent has it, and the start line lists them.
const unpatchable = new Set<string>(["enableCodeInSnapshot"]);
async function patchSettings(patch: Record<string, unknown>) {
  for (;;) {
    try {
      return await call("PATCH", `${api}/${agentId}/settings`, patch);
    } catch (error: any) {
      // Elysia reports the rejected property as JSON inside the error string.
      let name: string | undefined;
      try {
        name = JSON.parse(JSON.parse(error.body).error).property?.replace(/^\//, "");
      } catch {}
      if (!name || !(name in patch)) throw error;
      unpatchable.add(name);
      delete patch[name];
    }
  }
}

// ── replay ─────────────────────────────────────────────────────────────────
const base = await memory();
emit({ kind: "start", agentId, workflowId, history: args.history, memory: base, ...(await size()) });
let settings = "";
let agentSteps = 0;
let nextJumpAt = Number(args["jump-every"]);
const started = performance.now();
for (const [index, conversation] of conversations.entries()) {
  const patch = Object.fromEntries(Object.entries(conversation.settings).filter(([key]) => !unpatchable.has(key)));
  if (JSON.stringify(patch) !== settings) {
    await patchSettings(patch);
    settings = JSON.stringify(patch);
  }
  current = conversation;
  served = 0;
  fidelity.length = 0;
  turnSteps.clear();
  const turnStarted = performance.now();
  const done = next(frame => frame.type === "complete" || frame.type === "error", Number(args["turn-timeout"]));
  socket.send(JSON.stringify({ type: "message", content: conversation.prompt, messageSource: "chat" }));
  const { frame } = await done;
  const turnMs = performance.now() - turnStarted;
  // Whether the replayed tool results failed where the recorded run's did.
  const toolErrors = [...turnSteps.values()].flatMap((step: any) =>
    (step.toolResults ?? []).map((result: any) => !!result.isError)
  );
  agentSteps += conversation.calls.length;
  const tracker = await size();
  emit({
    kind: "conversation",
    index,
    id: conversation.id,
    outcome: frame.type,
    turnMs,
    callsRecorded: conversation.calls.length,
    callsServed: served,
    agentSteps,
    sentChars: fidelity.reduce((sum, item) => sum + item.sentChars, 0),
    recordedChars: fidelity.reduce((sum, item) => sum + item.recordedChars, 0),
    toolErrorsMatch: JSON.stringify(toolErrors) === JSON.stringify(conversation.toolErrors),
    ...tracker,
    memory: await memory(),
  });
  console.log(
    `${index + 1}/${conversations.length} ${conversation.id}: ${frame.type}, ${served}/${conversation.calls.length} calls, ` +
      `${tracker.snapshots} snapshots, ${((performance.now() - started) / 1000).toFixed(0)} s`
  );
  if (Number(args.jumps)) {
    while (tracker.snapshots >= nextJumpAt) {
      for (let k = 0; k < Number(args.jumps); k++) await jump(tracker.snapshots);
      nextJumpAt += Number(args["jump-every"]);
    }
  }
  // Back to the first snapshot, where the next conversation starts: what the agent holds now is the history alone,
  // without the finished conversation's working set.
  await call("POST", `${api}/${agentId}/checkout`, { stepId: initStepId });
  if (args.history === "forget") await call("POST", `${api}/${agentId}/debug/forget-history`);
  emit({ kind: "rest", index, id: conversation.id, agentSteps, ...(await size()), memory: await memory() });
}
emit({ kind: "end", seconds: (performance.now() - started) / 1000, unpatchable: [...unpatchable] });
// What the history holds, by part: after the last measurement, since reading the sizes allocates.
emit({
  kind: "breakdown",
  tracker: await call("GET", `${api}/${agentId}/debug/tracker?bytes=1`),
  memory: await memory(),
});
socket.close();
modelServer.stop(true);
process.exit(0); // the waiters' timeouts would keep the process alive
