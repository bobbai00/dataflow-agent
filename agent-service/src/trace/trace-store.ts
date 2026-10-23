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

/**
 * The trace store: what every agent does, written to one SQLite database as
 * it happens.
 *
 * Everything a conversation produces has a row here the moment it exists: the
 * agent and its settings; each turn (a chat message, a canvas action, a debug
 * input) with when it started and ended; each ReAct step with its timings and
 * token counts; each model request; each dataflow version with its snapshot;
 * each engine execution and each operator result; and the control events
 * around them (settings changes, stops, checkouts, imports). Writes are
 * synchronous — SQLite in WAL mode takes well under a millisecond — and never
 * reach the caller as errors: a row that cannot be written is logged, and the
 * turn goes on.
 *
 * Model inputs are recorded by size and token count only, never by content.
 * Operator results keep a bounded sample; the tables themselves stay in the
 * engine, referenced by execution id. A snapshot stores each operator once, by
 * content hash (a native operator carries its runtime, about 190 KB), so a
 * dataflow of many versions costs little more than one.
 *
 * `stepsOf`, `snapshotsOf`, `snapshotResultsOf` and `lastCheckout` give an
 * agent back after a restart, its version tree as it was, in the shape
 * `TexeraAgent.importReActSteps` takes.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createLogger } from "../logger";
import type { ReActStep, TokenUsage } from "../types/agent";
import type { ExecutionRunMetrics, OperatorInfo } from "../types/execution";
import type { OperatorPredicate, WorkflowContent } from "../types/workflow";
import type { RestoredResult, RestoredSnapshot, SnapshotData } from "../agent/workflow-snapshot-storage";

const log = createLogger("TraceStore");

/** Where the database lives unless `AGENT_TRACE_DB` says otherwise: the repo's logs folder. */
export function defaultTracePath(): string {
  return resolve(import.meta.dir, "../../../logs/agent-service/traces.db");
}

/**
 * The store named by the `AGENT_TRACE_DB` setting: a path, `:memory:`, or
 * `off` for none. Unset, the default path — or, under `bun test`, a database
 * in memory, so tests never touch the real one.
 */
export function openTraceStore(setting: string | undefined): TraceStore | undefined {
  if (setting === "off") return undefined;
  const path = setting ?? (process.env.NODE_ENV === "test" ? ":memory:" : defaultTracePath());
  return new TraceStore(path === ":memory:" ? path : resolve(path));
}

/**
 * Whether a trace kept an agent's whole version tree: a snapshot for every
 * step that made one, every version its calls recorded, and every snapshot's
 * parent, unless it is the first snapshot on its path of steps (it hangs
 * under a root: the agent's first, or the one an import started anew). Rows
 * an earlier schema let another agent overwrite leave it incomplete.
 */
export function storedTreeComplete(steps: ReActStep[], snapshots: RestoredSnapshot[]): boolean {
  if (!snapshots.length) return false;
  const ids = new Set(snapshots.map(snapshot => snapshot.id));
  const owners = new Set(snapshots.map(snapshot => snapshot.stepId));
  const parentOf = new Map(steps.map(step => [step.id, step.parentId]));
  const madeOne = (step: ReActStep) =>
    step.userAction?.kind === "restore" ||
    (!!step.toolCalls?.length && !step.toolCalls.every(call => call.toolName === "inspectError"));
  if (!steps.every(step => !madeOne(step) || owners.has(step.id))) return false;
  // Every version a step's calls recorded is there.
  const stored = new Set(snapshots.flatMap(snapshot => (snapshot.version === undefined ? [] : [snapshot.version])));
  if (!steps.every(step => recordedVersions(step).every(version => stored.has(version)))) return false;
  return snapshots.every(snapshot => {
    if (snapshot.parentId !== undefined && ids.has(snapshot.parentId)) return true;
    const earlier = (other: RestoredSnapshot) =>
      other.createdAt < snapshot.createdAt || (other.version ?? -1) < (snapshot.version ?? -1);
    if (snapshots.some(other => other !== snapshot && other.stepId === snapshot.stepId && earlier(other))) return false;
    for (let step = parentOf.get(snapshot.stepId); step !== undefined; step = parentOf.get(step))
      if (owners.has(step)) return false;
    return true;
  });
}

/** The version numbers a step's `dataflow` calls recorded: each edit's, run's and show's. */
function recordedVersions(step: ReActStep): number[] {
  return (step.toolResults ?? []).flatMap(result => {
    const output = result.output as
      | {
          kind?: string;
          actions?: Array<{ output?: { versions?: Array<{ version?: unknown }>; version?: { version?: unknown } } }>;
        }
      | undefined;
    if (output?.kind !== "dataflow-actions") return [];
    return (output.actions ?? []).flatMap(item =>
      [...(item.output?.versions ?? []), ...(item.output?.version ? [item.output.version] : [])].flatMap(version =>
        typeof version?.version === "number" ? [version.version] : []
      )
    );
  });
}

export interface TraceAgent {
  id: string;
  name: string;
  model: string;
  driver?: string;
  workflowId?: number;
  computingUnitId?: number;
  user?: { uid: number; name: string };
  settings?: unknown;
  createdAt: number;
}

export type TurnChannel = "message" | "action" | "debug";

export interface TraceTurnStart {
  agentId: string;
  messageId: string;
  /** How the turn came in: a message (REST or WebSocket), a canvas action, or a debug input. */
  channel: TurnChannel;
  /** The message's source, as the step records it (chat, feedback, action). */
  source?: string;
  text: string;
  startedAt: number;
}

export interface TraceTurnEnd {
  agentId: string;
  messageId: string;
  endedAt: number;
  status: "ok" | "error" | "stopped";
  reply?: string;
  error?: string;
}

export interface TraceLlmCall {
  agentId: string;
  messageId: string;
  /** The ReAct step the request produced. */
  stepId?: string;
  model: string;
  startedAt: number;
  endedAt: number;
  /** The input by size only: how many messages went on the wire, and their characters. */
  inputMessages?: number;
  inputChars?: number;
  outputChars?: number;
  usage?: TokenUsage;
  error?: string;
}

export interface TraceExecution {
  agentId: string;
  messageId?: string;
  /** The step whose actions the execution served. */
  stepId?: string;
  run: ExecutionRunMetrics;
}

export interface TraceOperatorResult {
  agentId: string;
  snapshotId: string;
  stepId?: string;
  operatorId: string;
  info: OperatorInfo;
  at: number;
}

export interface TraceEvent {
  agentId?: string;
  kind: string;
  at?: number;
  detail?: unknown;
}

const SAMPLE_ROWS = 5;
const SAMPLE_CELL_CHARS = 200;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT,
  model TEXT,
  driver TEXT,
  workflow_id INTEGER,
  computing_unit_id INTEGER,
  user_uid INTEGER,
  user_name TEXT,
  settings TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT
);
CREATE TABLE IF NOT EXISTS turns (
  message_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  source TEXT,
  text TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT,
  reply TEXT,
  error TEXT,
  PRIMARY KEY (agent_id, message_id)
);
CREATE TABLE IF NOT EXISTS steps (
  id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  parent_id TEXT,
  step_number INTEGER NOT NULL,
  role TEXT NOT NULL,
  source TEXT,
  correction TEXT,
  at INTEGER NOT NULL,
  is_begin INTEGER NOT NULL,
  is_end INTEGER NOT NULL,
  end_reason TEXT,
  content TEXT,
  reasoning TEXT,
  tool_calls INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  cached_input_tokens INTEGER,
  reasoning_tokens INTEGER,
  input_messages INTEGER,
  input_chars INTEGER,
  compile_ms INTEGER,
  context_ms INTEGER,
  model_ms INTEGER,
  post_step_ms INTEGER,
  step TEXT NOT NULL,
  cleared INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, id)
);
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  step_id TEXT,
  model TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  input_messages INTEGER,
  input_chars INTEGER,
  output_chars INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  cached_input_tokens INTEGER,
  cache_creation_input_tokens INTEGER,
  reasoning_tokens INTEGER,
  error TEXT
);
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  parent_id TEXT,
  step_id TEXT,
  version INTEGER,
  kind TEXT,
  author TEXT,
  operator_id TEXT,
  action TEXT,
  created_at INTEGER NOT NULL,
  operators INTEGER NOT NULL,
  links TEXT NOT NULL,
  positions TEXT NOT NULL,
  settings TEXT,
  namespace TEXT,
  cleared INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, id)
);
CREATE TABLE IF NOT EXISTS snapshot_operators (
  agent_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  operator_id TEXT NOT NULL,
  blob TEXT NOT NULL,
  PRIMARY KEY (agent_id, snapshot_id, position)
);
CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS executions (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  message_id TEXT,
  step_id TEXT,
  execution_id TEXT,
  targets TEXT NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  success INTEGER NOT NULL,
  state TEXT,
  compilation TEXT,
  compilation_ms REAL,
  request_ms REAL,
  decode_ms REAL,
  prepare_ms REAL,
  store_ms REAL
);
CREATE TABLE IF NOT EXISTS operator_results (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  step_id TEXT,
  operator_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  state TEXT,
  rows INTEGER,
  cached INTEGER NOT NULL,
  error TEXT,
  execution_id TEXT,
  result_version TEXT,
  schema TEXT,
  sample TEXT,
  info TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  agent_id TEXT,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  detail TEXT
);
-- A seed (study/seed.ts) given to a user: the workflow and agent it made, once per user and seed.
CREATE TABLE IF NOT EXISTS seeds (
  user_uid INTEGER NOT NULL,
  seed TEXT NOT NULL,
  user_name TEXT,
  status TEXT NOT NULL,
  workflow_id INTEGER,
  agent_id TEXT,
  computing_unit_id INTEGER,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT,
  PRIMARY KEY (user_uid, seed)
);
CREATE INDEX IF NOT EXISTS turns_by_agent ON turns (agent_id, started_at);
CREATE INDEX IF NOT EXISTS steps_by_agent ON steps (agent_id, at);
CREATE INDEX IF NOT EXISTS steps_by_message ON steps (message_id);
CREATE INDEX IF NOT EXISTS llm_calls_by_agent ON llm_calls (agent_id, started_at);
CREATE INDEX IF NOT EXISTS snapshots_by_agent ON snapshots (agent_id, created_at);
CREATE INDEX IF NOT EXISTS executions_by_agent ON executions (agent_id, started_at);
CREATE INDEX IF NOT EXISTS operator_results_by_agent ON operator_results (agent_id, at);
CREATE INDEX IF NOT EXISTS events_by_agent ON events (agent_id, at);
`;

/** A seed's state for one user, as `GET /api/agents/seed` reports it. */
export interface SeedRow {
  seed: string;
  userUid: number;
  userName?: string;
  status: "running" | "done" | "failed";
  workflowId?: number;
  agentId?: string;
  computingUnitId?: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

function seedRow(row: Record<string, unknown>): SeedRow {
  const number = (value: unknown) => (typeof value === "number" ? value : undefined);
  return {
    seed: String(row.seed),
    userUid: Number(row.user_uid),
    userName: typeof row.user_name === "string" ? row.user_name : undefined,
    status: row.status as SeedRow["status"],
    workflowId: number(row.workflow_id),
    agentId: typeof row.agent_id === "string" ? row.agent_id : undefined,
    computingUnitId: number(row.computing_unit_id),
    startedAt: Number(row.started_at),
    finishedAt: number(row.finished_at),
    error: typeof row.error === "string" ? row.error : undefined,
  };
}

/** Columns added after the first release, for databases created before them. */
const MIGRATIONS: Array<[table: string, column: string, type: string]> = [
  ["operator_results", "info", "TEXT"],
  ["steps", "cleared", "INTEGER NOT NULL DEFAULT 0"],
  ["snapshots", "cleared", "INTEGER NOT NULL DEFAULT 0"],
];

/** Tables first keyed by an id alone, which another agent's rows overwrote: each agent numbers its
 * snapshots from S0, and seeded agents share the archive's step and message ids. A database made
 * before they were keyed by agent is rebuilt once, keeping what it still holds. */
const AGENT_KEYED = ["turns", "steps", "snapshots", "snapshot_operators"];

const json = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value));
const flag = (value: unknown): number => (value ? 1 : 0);
const count = (value: number | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** A bounded sample of a result: its first rows, long cells cut short. */
function sampleOf(rows: unknown[] | undefined): string | null {
  if (!rows?.length) return null;
  return JSON.stringify(rows.slice(0, SAMPLE_ROWS), (_key, value) =>
    typeof value === "string" && value.length > SAMPLE_CELL_CHARS ? `${value.slice(0, SAMPLE_CELL_CHARS)}…` : value
  );
}

export class TraceStore {
  private readonly db: Database;
  /** Each operator's content hash, by object identity: snapshots share frozen operators. */
  private readonly hashes = new WeakMap<object, string>();

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.keyByAgent();
    this.db.exec(SCHEMA);
    for (const [table, column, type] of MIGRATIONS) {
      const columns = (this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);
      if (!columns.includes(column)) this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  close(): void {
    this.db.close();
  }

  /** Rebuild the tables an earlier schema keyed by id alone (AGENT_KEYED), keeping their rows. */
  private keyByAgent(): void {
    const keyOf = (table: string) =>
      (this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>).filter(c => c.pk);
    const stale = AGENT_KEYED.filter(table => {
      const key = keyOf(table);
      return key.length > 0 && !key.some(column => column.name === "agent_id");
    });
    if (!stale.length) return;
    this.db.transaction(() => {
      for (const table of stale) this.db.run(`ALTER TABLE ${table} RENAME TO ${table}_unkeyed`);
      this.db.exec(SCHEMA);
      for (const table of stale) {
        const columns = (this.db.query(`PRAGMA table_info(${table}_unkeyed)`).all() as Array<{ name: string }>)
          .map(column => column.name)
          .join(", ");
        // An operator row belongs to the agent whose snapshot held it last.
        if (table === "snapshot_operators")
          this.db.run(
            `INSERT OR IGNORE INTO snapshot_operators (agent_id, ${columns})
             SELECT s.agent_id, ${columns.replace(/(\w+)/g, "o.$1")} FROM snapshot_operators_unkeyed o
             JOIN ${stale.includes("snapshots") ? "snapshots_unkeyed" : "snapshots"} s ON s.id = o.snapshot_id`
          );
        else this.db.run(`INSERT OR IGNORE INTO ${table} (${columns}) SELECT ${columns} FROM ${table}_unkeyed`);
      }
      for (const table of stale) this.db.run(`DROP TABLE ${table}_unkeyed`);
    })();
    log.info({ tables: stale }, "trace tables keyed by agent");
  }

  /** Run one write; a failure is logged, never thrown — a trace must not fail a turn. */
  private write(what: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      log.warn({ err: error, what }, "trace write failed");
    }
  }

  // ── writes ────────────────────────────────────────────────────────────

  agentCreated(agent: TraceAgent): void {
    this.write("agent", () =>
      this.db
        .query(
          `INSERT OR REPLACE INTO agents (id, name, model, driver, workflow_id, computing_unit_id, user_uid, user_name, settings, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          agent.id,
          agent.name,
          agent.model,
          agent.driver ?? null,
          agent.workflowId ?? null,
          agent.computingUnitId ?? null,
          agent.user?.uid ?? null,
          agent.user?.name ?? null,
          json(agent.settings),
          agent.createdAt
        )
    );
  }

  /** The agent's settings as they now stand, and an event for the change. */
  agentSettings(agentId: string, settings: unknown, patch?: unknown): void {
    this.write("settings", () => {
      this.db.query("UPDATE agents SET settings = ? WHERE id = ?").run(json(settings), agentId);
    });
    this.event({ agentId, kind: "settings", detail: patch });
  }

  agentEnded(agentId: string, reason: string, at = Date.now()): void {
    this.write("agent end", () =>
      this.db.query("UPDATE agents SET ended_at = ?, end_reason = ? WHERE id = ?").run(at, reason, agentId)
    );
  }

  /** A turn begins; a second start for the same message (a turn answering a recorded action) keeps the first. */
  turnStarted(turn: TraceTurnStart): void {
    this.write("turn start", () =>
      this.db
        .query(
          `INSERT OR IGNORE INTO turns (message_id, agent_id, channel, source, text, started_at) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(turn.messageId, turn.agentId, turn.channel, turn.source ?? null, turn.text, turn.startedAt)
    );
  }

  turnEnded(turn: TraceTurnEnd): void {
    this.write("turn end", () =>
      this.db
        .query("UPDATE turns SET ended_at = ?, status = ?, reply = ?, error = ? WHERE agent_id = ? AND message_id = ?")
        .run(turn.endedAt, turn.status, turn.reply ?? null, turn.error ?? null, turn.agentId, turn.messageId)
    );
  }

  /** The agent's history was cleared (or an import replaced it): its rows so far stay, marked, and a restore leaves them out. */
  historyCleared(agentId: string): void {
    this.write("history cleared", () =>
      this.db.transaction(() => {
        this.db.query("UPDATE steps SET cleared = 1 WHERE agent_id = ?").run(agentId);
        this.db.query("UPDATE snapshots SET cleared = 1 WHERE agent_id = ?").run(agentId);
      })()
    );
  }

  /** A step as it stands; recorded again when it changes (its end, its timings, its content). */
  step(agentId: string, step: ReActStep): void {
    this.write("step", () => {
      // The model's input is kept by size, not content.
      const { inputMessages, ...stored } = step;
      const inputChars = inputMessages
        ?.map(message => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
        .reduce((total, text) => total + text.length, 0);
      const usage = step.usage;
      this.db
        .query(
          `INSERT OR REPLACE INTO steps (id, agent_id, message_id, parent_id, step_number, role, source, correction, at,
             is_begin, is_end, end_reason, content, reasoning, tool_calls, input_tokens, output_tokens, total_tokens,
             cached_input_tokens, reasoning_tokens, input_messages, input_chars, compile_ms, context_ms, model_ms,
             post_step_ms, step)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          step.id,
          agentId,
          step.messageId,
          step.parentId ?? null,
          step.stepId,
          step.role,
          step.messageSource ?? null,
          step.correction ?? null,
          step.timestamp,
          flag(step.isBegin),
          flag(step.isEnd),
          step.endReason ?? null,
          step.content,
          step.reasoningText ?? null,
          step.toolCalls?.length ?? 0,
          count(usage?.inputTokens),
          count(usage?.outputTokens),
          count(usage?.totalTokens),
          count(usage?.cachedInputTokens),
          count(usage?.reasoningTokens),
          inputMessages?.length ?? null,
          inputChars ?? null,
          count(step.timing?.compileMs),
          count(step.timing?.contextMs),
          count(step.timing?.modelMs),
          count(step.timing?.postStepMs),
          JSON.stringify(stored)
        );
    });
  }

  llmCall(call: TraceLlmCall): void {
    this.write("llm call", () =>
      this.db
        .query(
          `INSERT INTO llm_calls (agent_id, message_id, step_id, model, started_at, ended_at, input_messages, input_chars,
             output_chars, input_tokens, output_tokens, total_tokens, cached_input_tokens, cache_creation_input_tokens,
             reasoning_tokens, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          call.agentId,
          call.messageId,
          call.stepId ?? null,
          call.model,
          call.startedAt,
          call.endedAt,
          call.inputMessages ?? null,
          call.inputChars ?? null,
          call.outputChars ?? null,
          count(call.usage?.inputTokens),
          count(call.usage?.outputTokens),
          count(call.usage?.totalTokens),
          count(call.usage?.cachedInputTokens),
          count(call.usage?.cacheCreationInputTokens),
          count(call.usage?.reasoningTokens),
          call.error ?? null
        )
    );
  }

  /** A snapshot (a dataflow version) as it stands; recorded again when its workflow changes. */
  snapshot(agentId: string, snapshot: SnapshotData): void {
    this.write("snapshot", () => {
      const workflow = snapshot.workflow;
      const action = snapshot.action;
      this.db.transaction(() => {
        this.db
          .query(
            `INSERT OR REPLACE INTO snapshots (id, agent_id, parent_id, step_id, version, kind, author, operator_id, action,
               created_at, operators, links, positions, settings, namespace)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            snapshot.id,
            agentId,
            snapshot.parentId ?? null,
            snapshot.reactStepId ?? null,
            snapshot.version ?? null,
            action?.kind ?? null,
            action?.author ?? null,
            action?.operatorId ?? null,
            json(action),
            snapshot.createdAt,
            workflow.operators.length,
            JSON.stringify(workflow.links),
            JSON.stringify(workflow.operatorPositions),
            json(workflow.settings),
            json(workflow.nativeNamespace)
          );
        this.db
          .query("DELETE FROM snapshot_operators WHERE agent_id = ? AND snapshot_id = ?")
          .run(agentId, snapshot.id);
        const blob = this.db.query("INSERT OR IGNORE INTO blobs (hash, json) VALUES (?, ?)");
        const member = this.db.query(
          "INSERT INTO snapshot_operators (agent_id, snapshot_id, position, operator_id, blob) VALUES (?, ?, ?, ?, ?)"
        );
        workflow.operators.forEach((operator, position) => {
          const [hash, text] = this.hashOf(operator);
          blob.run(hash, text);
          member.run(agentId, snapshot.id, position, operator.operatorID, hash);
        });
      })();
    });
  }

  private hashOf(operator: OperatorPredicate): [string, string] {
    const text = JSON.stringify(operator);
    const cached = this.hashes.get(operator);
    if (cached) return [cached, text];
    const hash = new Bun.CryptoHasher("sha256").update(text).digest("hex");
    this.hashes.set(operator, hash);
    return [hash, text];
  }

  operatorResult(result: TraceOperatorResult): void {
    this.write("operator result", () => {
      const info = result.info;
      this.db
        .query(
          `INSERT INTO operator_results (agent_id, snapshot_id, step_id, operator_id, at, state, rows, cached, error,
             execution_id, result_version, schema, sample, info)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          result.agentId,
          result.snapshotId,
          result.stepId ?? null,
          result.operatorId,
          result.at,
          info.state ?? null,
          count(info.totalRowCount ?? info.outputTuples),
          flag(info.state === "CompletedFromCache" || info.materialization?.cached),
          info.error ?? null,
          info.executionContext?.executionId ?? info.materialization?.executionId ?? null,
          json(info.resultVersion),
          json(info.resultSchema),
          sampleOf(info.result),
          JSON.stringify(info)
        );
    });
  }

  execution(execution: TraceExecution): void {
    this.write("execution", () => {
      const run = execution.run;
      const timing = run.clientTiming;
      this.db
        .query(
          `INSERT INTO executions (agent_id, message_id, step_id, execution_id, targets, started_at, ended_at, success,
             state, compilation, compilation_ms, request_ms, decode_ms, prepare_ms, store_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          execution.agentId,
          execution.messageId ?? null,
          execution.stepId ?? null,
          run.executionId,
          JSON.stringify(run.targets),
          run.startedAt ?? null,
          run.endedAt ?? null,
          flag(run.success),
          run.state,
          run.phaseMetrics?.compilation ?? null,
          run.phaseMetrics?.compilationDurationMs ?? null,
          timing?.requestToHeadersMs ?? null,
          timing?.responseBodyDecodeMs ?? null,
          timing?.resultPreparationMs ?? null,
          timing?.snapshotStoreMs ?? null
        );
    });
  }

  event(event: TraceEvent): void {
    this.write("event", () =>
      this.db
        .query("INSERT INTO events (agent_id, kind, at, detail) VALUES (?, ?, ?, ?)")
        .run(event.agentId ?? null, event.kind, event.at ?? Date.now(), json(event.detail))
    );
  }

  // ── reads ─────────────────────────────────────────────────────────────

  /** Every agent recorded (one user's, when `user` names one), newest first, with how many turns and steps it has. */
  listAgents(user?: string): Array<Record<string, unknown>> {
    return this.db
      .query(
        `SELECT a.*,
           (SELECT COUNT(*) FROM turns t WHERE t.agent_id = a.id) AS turns,
           (SELECT COUNT(*) FROM steps s WHERE s.agent_id = a.id) AS steps,
           (SELECT MAX(at) FROM steps s WHERE s.agent_id = a.id) AS last_step_at
         FROM agents a WHERE ?1 IS NULL OR a.user_name = ?1 OR CAST(a.user_uid AS TEXT) = ?1
         ORDER BY a.created_at DESC`
      )
      .all(user ?? null)
      .map(row => this.agentRow(row as Record<string, unknown>));
  }

  /** One user's agents on one workflow that were never deleted: the ones a restart should bring back. */
  agentsOf(userUid: number, workflowId: number): Array<Record<string, unknown>> {
    return (
      this.db
        .query("SELECT * FROM agents WHERE user_uid = ? AND workflow_id = ? AND ended_at IS NULL ORDER BY created_at")
        .all(userUid, workflowId) as Array<Record<string, unknown>>
    ).map(row => this.agentRow(row));
  }

  // ── seeds ─────────────────────────────────────────────────────────────

  seedOf(userUid: number, seed: string): SeedRow | undefined {
    const row = this.db.query("SELECT * FROM seeds WHERE user_uid = ? AND seed = ?").get(userUid, seed) as Record<
      string,
      unknown
    > | null;
    return row ? seedRow(row) : undefined;
  }

  seedStarted(seed: { userUid: number; userName?: string; seed: string }): void {
    this.db.run(
      `INSERT INTO seeds (user_uid, seed, user_name, status, started_at)
       VALUES (?, ?, ?, 'running', ?)
       ON CONFLICT (user_uid, seed) DO UPDATE SET
         status = 'running', user_name = excluded.user_name, started_at = excluded.started_at,
         finished_at = NULL, error = NULL, workflow_id = NULL, agent_id = NULL, computing_unit_id = NULL`,
      [seed.userUid, seed.seed, seed.userName ?? null, Date.now()]
    );
  }

  seedFinished(
    userUid: number,
    seed: string,
    outcome: {
      status: "done" | "failed";
      workflowId?: number;
      agentId?: string;
      computingUnitId?: number;
      error?: string;
    }
  ): void {
    this.db.run(
      `UPDATE seeds SET status = ?, workflow_id = ?, agent_id = ?, computing_unit_id = ?, finished_at = ?, error = ?
       WHERE user_uid = ? AND seed = ?`,
      [
        outcome.status,
        outcome.workflowId ?? null,
        outcome.agentId ?? null,
        outcome.computingUnitId ?? null,
        Date.now(),
        outcome.error ?? null,
        userUid,
        seed,
      ]
    );
  }

  agent(agentId: string): Record<string, unknown> | undefined {
    const row = this.db.query("SELECT * FROM agents WHERE id = ?").get(agentId) as Record<string, unknown> | null;
    return row ? this.agentRow(row) : undefined;
  }

  private agentRow(row: Record<string, unknown>): Record<string, unknown> {
    return { ...row, settings: typeof row.settings === "string" ? JSON.parse(row.settings) : row.settings };
  }

  /** One agent's whole trace: every table's rows for it, in time order, as JSON-ready objects. */
  exportAgent(agentId: string): Record<string, unknown> | undefined {
    const agent = this.agent(agentId);
    if (!agent) return undefined;
    const rows = (sql: string) => this.db.query(sql).all(agentId) as Array<Record<string, unknown>>;
    const parsed = (row: Record<string, unknown>, keys: string[]) => {
      const out = { ...row };
      for (const key of keys) if (typeof out[key] === "string") out[key] = JSON.parse(out[key] as string);
      return out;
    };
    return {
      agent,
      turns: rows("SELECT * FROM turns WHERE agent_id = ? ORDER BY started_at, rowid"),
      steps: rows("SELECT * FROM steps WHERE agent_id = ? ORDER BY rowid").map(row => parsed(row, ["step"])),
      llm_calls: rows("SELECT * FROM llm_calls WHERE agent_id = ? ORDER BY started_at, id"),
      snapshots: rows("SELECT * FROM snapshots WHERE agent_id = ? ORDER BY created_at, rowid").map(row =>
        parsed(row, ["action", "links", "positions", "settings", "namespace"])
      ),
      executions: rows("SELECT * FROM executions WHERE agent_id = ? ORDER BY id").map(row => parsed(row, ["targets"])),
      operator_results: rows("SELECT * FROM operator_results WHERE agent_id = ? ORDER BY id").map(row =>
        parsed(row, ["result_version", "schema", "sample", "info"])
      ),
      events: rows("SELECT * FROM events WHERE agent_id = ? ORDER BY id").map(row => parsed(row, ["detail"])),
    };
  }

  /** An agent's steps as recorded, oldest first, less those a clear left behind — the archive `importReActSteps` replays. */
  stepsOf(agentId: string): ReActStep[] {
    return (
      this.db.query("SELECT step FROM steps WHERE agent_id = ? AND cleared = 0 ORDER BY rowid").all(agentId) as Array<{
        step: string;
      }>
    ).map(row => JSON.parse(row.step) as ReActStep);
  }

  /** Every snapshot of an agent's steps as last recorded, oldest first: the version tree a restore puts back. */
  snapshotsOf(agentId: string): RestoredSnapshot[] {
    const rows = this.db
      .query(
        `SELECT id, parent_id, step_id, version, action, created_at, links, positions, settings, namespace
         FROM snapshots WHERE agent_id = ? AND step_id IS NOT NULL AND cleared = 0 ORDER BY created_at, version, rowid`
      )
      .all(agentId) as Array<{
      id: string;
      parent_id: string | null;
      step_id: string;
      version: number | null;
      action: string | null;
      created_at: number;
      links: string;
      positions: string;
      settings: string | null;
      namespace: string | null;
    }>;
    const operatorsOf = this.db.query(
      `SELECT b.json FROM snapshot_operators o JOIN blobs b ON b.hash = o.blob
       WHERE o.agent_id = ? AND o.snapshot_id = ? ORDER BY o.position`
    );
    return rows.map(row => ({
      id: row.id,
      ...(row.parent_id ? { parentId: row.parent_id } : {}),
      stepId: row.step_id,
      ...(row.version !== null && row.action ? { version: row.version, action: JSON.parse(row.action) } : {}),
      createdAt: row.created_at,
      workflow: {
        operators: (operatorsOf.all(agentId, row.id) as Array<{ json: string }>).map(
          member => JSON.parse(member.json) as OperatorPredicate
        ),
        links: JSON.parse(row.links),
        operatorPositions: JSON.parse(row.positions),
        commentBoxes: [],
        settings: row.settings ? JSON.parse(row.settings) : { dataTransferBatchSize: 400 },
        ...(row.namespace ? { nativeNamespace: JSON.parse(row.namespace) } : {}),
      },
    }));
  }

  /** Every result written to an agent's snapshots, in the order written: a restore puts each back where it was. */
  snapshotResultsOf(agentId: string): RestoredResult[] {
    return (
      this.db
        .query(
          `SELECT snapshot_id, step_id, operator_id, info FROM operator_results
           WHERE agent_id = ? AND info IS NOT NULL ORDER BY id`
        )
        .all(agentId) as Array<{ snapshot_id: string; step_id: string | null; operator_id: string; info: string }>
    ).map(row => ({
      snapshotId: row.snapshot_id,
      ...(row.step_id ? { stepId: row.step_id } : {}),
      operatorId: row.operator_id,
      info: JSON.parse(row.info) as OperatorInfo,
    }));
  }

  /**
   * The step HEAD was last put on by a checkout (or by a restore or an import
   * choosing it), when that came after the newest step; undefined when the
   * newest step is where HEAD went last, as each step takes HEAD when made.
   */
  lastCheckout(agentId: string): string | undefined {
    const newest = this.db.query("SELECT MAX(at) AS at FROM steps WHERE agent_id = ?").get(agentId) as {
      at: number | null;
    } | null;
    const moved = this.db
      .query(
        `SELECT at, detail FROM events WHERE agent_id = ?
           AND kind IN ('checkout', 'checkout-version', 'restore', 'import') ORDER BY id DESC LIMIT 1`
      )
      .get(agentId) as { at: number; detail: string | null } | null;
    if (!moved?.detail || (newest?.at != null && newest.at > moved.at)) return undefined;
    const detail = JSON.parse(moved.detail) as { headId?: unknown; stepId?: unknown; success?: unknown };
    const head = detail.headId ?? (detail.success === true ? detail.stepId : undefined);
    return typeof head === "string" ? head : undefined;
  }
}
