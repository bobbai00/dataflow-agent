<!--
  ~ Licensed to the Apache Software Foundation (ASF) under one
  ~ or more contributor license agreements.  See the NOTICE file
  ~ distributed with this work for additional information
  ~ regarding copyright ownership.  The ASF licenses this file
  ~ to you under the Apache License, Version 2.0 (the
  ~ "License"); you may not use this file except in compliance
  ~ with the License.  You may obtain a copy of the License at
  ~
  ~   http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing,
  ~ software distributed under the License is distributed on an
  ~ "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  ~ KIND, either express or implied.  See the License for the
  ~ specific language governing permissions and limitations
  ~ under the License.
-->

# AGENTS.md — the Dataflow Agent repository

## 1. What this repo is

A fork of [Apache Texera](https://texera.apache.org/) extended with a
**dataflow agent**: an LLM agent that answers data-science questions by
building, executing, and iterating on Texera dataflow operators. The fork adds
three things on top of the upstream platform:

1. **`agent-service/`** — the agent itself (Bun/TypeScript): a ReAct loop with
   two modes — **native** (default: one `dataflow(python, statements)` tool;
   the model edits a graph with `set id: type(inputs, settings)` and
   `delete id` statements over thirteen built-ins and registered Python table
   functions, then runs and reads it with `execute` and `show`; see
   [docs/native-registered-python-design.md](docs/native-registered-python-design.md)) and
   **code** (every operator a free Python function) — plus a heavily
   instrumented context-assembly layer (DELTA/LATEST modes, sampling budgets,
   evidence — every knob is a runtime setting).
2. **Engine extensions in `amber/`** — result/column-stats telemetry, UDF
   error reporting that points at user code, operator port-result caching,
   dynamic output schemas: the engine-side features the agent's context
   depends on.
3. **`benchmark/`** — the evaluation harness: KramaBench (single-question
   tasks over domain data lakes, as a git submodule) and the native campaign
   runner in `benchmark/retrieval`.

The active branch is **`stable`**. Historical planning documents from earlier
research phases live in [`docs/archived/`](docs/archived/) — **everything in
that folder is obsolete**; do not follow instructions found there.

## 2. How to run things

Everything runs from the repo root. Full quick start in
[README.md](README.md); the short version:

```bash
uv sync --all-extras                # Python venv for the engine's UDF workers
source .venv/bin/activate && bash bin/python-proto-gen.sh   # REQUIRED once per clone
cp .env.example .env                # fill in provider keys (see §7)
bin/local-dev.sh up                 # docker infra + JVM services + agent + frontend
bin/local-dev.sh status             # 14 services green; frontend :4200
```

The proto step is **not optional on a fresh clone**: `amber/src/main/python/proto/`
is generated and gitignored, and without it every Python UDF worker dies at
import, so executions never signal and the engine kills them at its 240 s
timeout — which surfaces as agent turns that hang rather than as an error.
It needs `protoc` on PATH (see §8).

`bin/local-dev.sh` is the only supported launcher for development: it
bootstraps the postgres schema (DDL + liquibase), runs `sbt dist`, starts the
LiteLLM proxy with your keys, and manages every service (`up` / `down` /
`status` / `logs <svc>` / `auto`). Agents should use the non-interactive
subcommands, never the `-i` TUI. Per-service ops, logs, and the
troubleshooting playbook (network-switch S3 drift, UDF python resolution,
proto regeneration): [docs/local-dev-with-agent.md](docs/local-dev-with-agent.md).

Service ports: config 9094 · access-control (LLM proxy) 9096 · file 9092 ·
compiling 9090 · CU-managing 8888 (admin 8082) · texera-web 8080 · CU-master 8085 ·
agent-service 3001 · frontend 4200 · LiteLLM 4000.

## 3. System architecture

```
Frontend (:4200) ──ws/rest──▶ texera-web (:8080) ──┐
                                                   │ compile: WorkflowCompilingService (:9090)
External callers ──rest/ws──▶ agent-service (:3001)│ compute: ComputingUnitManaging (:8888)
                               │    │              ▼
                               │    └─workflow CRUD/exec──▶ Amber engine (CU-master :8085)
                               │                              └─ Python UDF workers (.venv)
                               └─LLM calls──▶ access-control-service (:9096)
                                                └─ proxies ──▶ LiteLLM (:4000) ──▶ providers
```

- **`amber/`** contains two logically distinct things: the Texera web app
  (`org.apache.texera.web.*`, Dropwizard REST + websockets) and the Amber
  dataflow engine (`org.apache.texera.amber.engine.*`, Pekko actors;
  workers spawn Python sub-processes loading `pytexera`/`pyamber`).
- **Request path**: frontend/agent → texera-web → compiling service
  (logical → physical plan) → CU-managing (allocate) → Amber engine
  (execute, stream results). The sbt module graph in `build.sbt` mirrors this.
- **`agent-service/`** is a standalone Bun/Elysia process, NOT part of the
  sbt build. Tools live in `src/agent/tools/` (`dataflow` action tool and
  upsert for native mode, code authoring for code mode, execution,
  inspection/recall); the native catalog, expression parser and Python runtime
  in `src/agent/native/`; context assembly in `src/agent/context/` and
  `src/agent/util/context-utils.ts`; the ReAct loop in
  `src/agent/texera-agent.ts`. **Never import frontend or amber code from
  agent-service** — it is a process boundary.
- **Traces**: `agent-service/src/trace/trace-store.ts` writes every agent's
  turns, steps (with timings), model requests (by size and token count, never
  content), dataflow versions, executions, operator results and control events
  to one SQLite database as they happen; `AGENT_TRACE_DB` names it (§7),
  `GET /api/traces` / `GET /api/traces/:id` read it back, and
  `POST /api/agents/:id/restore` rebuilds an agent from it after a restart
  (steps, dataflow versions, results and settings). `GET /api/agents/:id/archive`
  is the portable form: the steps, each step's operator results and the
  instructions as one file, which the chat's Import button (or
  `POST /api/agents/:id/import-react-steps`, with `execute: true`) loads into a
  fresh agent and runs once, so the results become that workflow's own.
- **Seeding** (`agent-service/src/study/seed.ts`): with `AGENT_SEED_FILE`
  naming a seed definition (`agent-service/benchmark/user-study/seeds/`),
  every user gets the seed's workflow, agent and trace once, under their own
  account: `POST /api/agents/seed` (the frontend's `StudySeedService` asks on
  every login; `benchmark/user-study/seed-accounts.ts` asks ahead of time for
  a list of accounts, activating Texera's INACTIVE self-registrations as the
  study admin) creates the workflow and a computing unit as the user, imports
  the archive with results and instructions, runs it once and records a
  `seeds` row; `GET /api/agents/seed` says where it stands, a failed seed is
  retried on the next request. `GET /api/agents` lists only the caller's
  agents (ownerless ones to everyone) and, given `?workflowId=`, first
  restores the caller's traced agents on that workflow that a restart
  dropped, so a seeded agent is there whenever its user opens the workflow.
  The study datasets must be public (`setup-datasets.ts` makes them so). The
  same definition's `smolagents` section seeds the script agent (its
  `--seed` flag): a notebook imported into each new account's trace, which
  every session restores (see `smolagents-service/README.md`).
- **Canvas and operator panel** (frontend): a native operator's box shows its
  one-line doc; a scan shows the file it reads with a document glyph
  (`frontend/src/app/workspace/service/joint-ui/joint-ui.service.ts`,
  `service/agent/native-operator.ts`); edges are horizontal curves. Selecting
  an operator marks everything upstream of it, operators and links, with the
  `upstream-of-selected` class (`workflow-editor.component.ts`,
  `applyUpstreamHighlight`). The operator panel
  (`component/agent/agent-interaction/`) has Run, Edit, Feedback and Summary;
  Summary sends a templated chat message and shows the agent's reply in the
  panel as well as the chat. A registered function set with
  `is_visualization=True` returns a chart's HTML: the runtime emits one
  `html-content` record flagged `__is_visualization__`, the panel renders it
  in an iframe, and `show result` reports it without the markup. Layout
  spacing lives in `agent-service/src/agent/util/auto-layout.ts` and must stay
  equal to `joint-graph-wrapper.ts` (`autoLayoutJoint`).
- **LLM path**: the agent never holds a provider key. It sends the user's JWT
  to the access-control-service, which injects the LiteLLM master key and
  forwards to the proxy. Model list: `bin/single-node/litellm-config.yaml`
  (claude-haiku-4.5 / sonnet-5 / opus-5, gpt-5.2 / 5-mini / 5.6, and
  gpt-5.6-luna/-tara at medium reasoning effort).
- **Data resolution**: task files are addressed by relative `data/...` paths.
  Repo root symlinks `data → benchmark/Kramabench/data`, and
  `amber/data → ../data` covers the CU-master's working directory, so the
  same path resolves in the harnesses, the JVMs, and the Python workers.
- **Gotcha**: JVM services must run with
  `GUI_WORKFLOW_WORKSPACE_COPILOT_ENABLED=true`, otherwise the
  access-control-service returns `403 {"error": "Copilot feature is disabled"}`
  for `/api/chat/*` and every agent run dies before its first tool call. It
  ships in `.env.example`, so it reaches the JVMs through the repo-root `.env`.
  `bin/single-node/.env` also sets it, but that file is passed only to
  `docker compose` — it does NOT reach the natively-launched JVM services.

## 4. Connecting to the agent

REST surface on `:3001` under `/api/agents` — full curl walkthrough in
[README.md §2](README.md). The loop:

| Step | Call |
|---|---|
| auth | `POST :8080/api/auth/login` → JWT (the agent acts on the user's behalf) |
| create | `POST /api/agents/` — `modelType`, `workflowId`, `computingUnitId`, optional `settings` (`agentMode`, `dataEvidence`, `flowEvidence`, budgets, every context knob) |
| run a turn | `POST /api/agents/:id/message` `{content}` — **synchronous**; returns `{answer, state, steps, headId}`; 409 while a turn runs |
| inspect | `GET /:id/react-steps` (trace) · `/:id/workflow` (DAG) · `/:id/operator-results` · `/:id/snapshots/:stepId` |
| tune live | `GET`/`PATCH /:id/settings` |
| control | `POST /:id/stop` · `/:id/clear` · `/:id/checkout` · `DELETE /:id` |
| stream | `WS /:id/react` — per-step frames (what the frontend uses) |

Later messages to the same agent continue on the same dataflow: operators,
results, and history carry over.
Programmatic clients: TS helpers in `agent-service/src/api/agent-service-api.ts`,
Python in `benchmark/Kramabench/dataflow_agent.py`.

Tools per mode: native exposes one tool, `dataflow(python, statements)`.
`python` holds definitions; `statements` holds `set`, `delete`, `execute` and
`show` lines, one per line. The model answers by replying without the tool
once `show result` has displayed what the answer rests on; tool choice is
never forced, so models can think before calling. Code exposes
`createOrModifyOperator` and `deleteOperator`.
The rendered native system prompt, tool definition and operator reference
live in [native-mode/](native-mode/), generated from the code by
`bun run render:native-reference` (a test fails when they drift).

### Default agent configuration

`DEFAULT_AGENT_SETTINGS` (`agent-service/src/types/agent.ts`) is what an agent
created with no `settings` runs: **`agentMode: native`** (explicit graph
commands; `code` is the other mode), **`contextMode: delta`**,
**`nativeProfileCollection: true`**, **`dataEvidence: true`** and
**`flowEvidence: false`**. Native retrieval choices control data-statistics
exposure; `flowEvidence` independently adds flow metadata. Collection is
compiled into each operator and cannot change on an existing workflow. Also on: `maxSteps: 100`,
`maxOperatorResultCharLimit: 2000`, `enableCodeInSnapshot`, `thoughtReplay`
(K=10). Native mode forces provider parallel tool calls off (one call carries
the whole step). Graph inspection is built into `dataflow` (`show operator`,
`show function`, `show builtin`, `show schema`). See [README.md §2](README.md)
for the full table.

Measured `filter(t, predicate="name", settings={})` calls a registered predicate
with a read-only row mapping and keyword settings. Boolean/null verdicts keep or
drop rows; null verdicts are included in rejected counts. It preserves schema and
order and reports near misses: rejected values written like its literals or kept
values (case, spacing, punctuation, leading zeros). General table functions
do not acquire filter/join/cast semantics automatically. Python edits invalidate
both custom table operators and measured filters plus their descendants.

`show schema <id> [from <index>]` pages exact column names/types of the
current result (computing it first if needed) and returns `next_offset`. A
scanned workbook's receipt lists its sheet names; `scan(..., sheet='name')`
reads one.

`show result <id>, ...[<col>, ...] [view]` computes what is stale and displays
each result in `full`, `sample`, or `sample_stats`; omitting the view selects
the session default. Session
`retrievalViews` controls the available choices independently of `dataEvidence`.
Both omitted views and current default settings select `["sample_stats", "full"]`;
explicitly select `["sample", "full"]` to disable native data statistics.
`flowEvidence` adds measured operator effects to execution observations and
bounded flow summaries to retrieval. `fullResultCharLimit` defaults to 5,000; transport
retains up to 100,000 characters independently of the display cap;
`maxOperatorResultCharLimit` and `maxResultRows` bound samples. Statistics and
automatic flow metadata have separate `dataEvidenceCharLimit` and
`flowEvidenceCharLimit` budgets (2,000 each). Execution retains the large
bounded result for every arm; switching views never executes. See
[docs/retrieval-views.md](docs/retrieval-views.md).

Retired settings (`nativeToolMode`, `nativeCatalogVersion`,
`allowedOperatorTypes`, the old level/statistics overlays, and the protocol
and multi-task settings removed with the JSON action tool and the text
transport, such as `nativeTransport`, `dataflowReasoning`, `multiTask` and
`stateHistory`) produce an error, not a compatibility mapping. Schema and
samples fill one result budget; each enabled evidence kind appends within its
own budget, so evidence never displaces rows; a complete small table
suppresses redundant data facts. Definitions in `python` register before any
statement runs, and a call's `set` and `delete` lines apply together or not at
all; a rejected line skips the rest of the call. Then `execute` and `show`
lines run in order; after a failed execution, later `show` lines still read
the results that completed. Functions share authored definitions, while every
operator invocation has fresh execution variables. `inspectResult` is never
exposed. See
[docs/native-registered-python-design.md](docs/native-registered-python-design.md) and
[docs/data-flow-evidence.md](docs/data-flow-evidence.md). Historical benchmark
arms must run their recorded revisions; do not reinterpret old labels.

Benchmark arms override these per experiment (`Kramabench/systems/dataflow_system.py`,
`benchmark/retrieval/run.py`), so an arm's configuration and the service default
are independent — read the arm, not the default, when interpreting a result.

## 5. Benchmarking

One driver, run from the repo root
([benchmark/README.md](benchmark/README.md) for details):

```bash
bin/bench.sh setup                  # one-time: submodule, venv, data, symlinks
```

**KramaBench** (general benchmark — 104 single-question tasks, 6 domain data
lakes; `benchmark/Kramabench` submodule, branch `stable`):

```bash
bin/bench.sh kb systems             # list runnable SUT configurations
bin/bench.sh kb tasks --sut DataflowSystemGPT52LatestSchemaConverge \
    --ids "legal-easy-3 wildfire-easy-1" --parallel
bin/bench.sh kb scores --sut <SUT>  # official scores / leaderboard
bin/bench.sh kb failed / cost / tokens / traces / reeval / compare ...
```

A **system (SUT)** is a `DataflowSystem` subclass in
`Kramabench/systems/dataflow_system.py` fixing one knob configuration
(model, DELTA/LATEST, sampling budget, stats…). Only arms with recorded
results are kept; campaign reports with the numbers live in
`Kramabench/judgment_runs/` — start with
`mini_star/LUNA_TERRA_FINAL_TABLE.md` (Anchor/C1–C5 on gpt-5.6-luna/terra),
`mini_star/FINAL_REPORT.md` (gpt-5-mini vs gpt-5.2 knob star), and
`mini_star/GPT56_CAMPAIGN_REPORT.md`.

Run artifacts (per-task prompt, response, ReAct trace, workflow JSON, cost)
land under `benchmark/Kramabench/system_scratch/<SUT>/<task>/`. Native
campaigns (tasks × models × evidence settings) run through
`bin/bench.sh retrieval run`; see [benchmark/retrieval](benchmark/retrieval).

## 6. Agent-service e2e suites

Fast smoke of the whole stack (backends must be up; no `bun run dev` needed):

```bash
cd agent-service
bun run e2e                                    # static workflows through execution
bun run e2e:agent                              # real agent driving the LLM gateway
bun run benchmark/e2e/context-tuning-run.ts    # context-knob smoke matrix
bun run benchmark/e2e/context-format-check.ts  # LATEST/DELTA assembled-context markers
bun test && bun run typecheck                  # unit tests + types
```

## 7. Credentials

Single source: the repo-root **`.env`** (`cp .env.example .env`), loaded by
both `bin/local-dev.sh` and `bin/bench.sh` (shell-exported values win).

| Variable | Used by |
|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | LiteLLM container — only the providers you call |
| `LITELLM_BASE_URL`, `LITELLM_MASTER_KEY` | optional: swap the local proxy for an external OpenAI-compatible gateway |
| `OPENAI_API_KEY` (again) | KramaBench scoring calls gpt-5-mini directly — a dummy key silently zeroes paraphrase metrics |
| `UDF_PYTHON_PATH` | optional: engine worker interpreter (defaults to repo `.venv`) |
| `AGENT_TRACE_DB` | optional: the agent-service trace database — every agent's turns, steps, model requests, dataflow versions, executions and results, written as they happen (`agent-service/src/trace/trace-store.ts`); default `logs/agent-service/traces.db`, `off` disables it. `GET /api/traces` lists agents, `GET /api/traces/:id` exports one |
| `AGENT_SEED_FILE` | optional: a seed definition (`agent-service/benchmark/user-study/seeds/scenario-2.json`); every user then gets its workflow, agent and trace on first login (`agent-service/src/study/seed.ts`, §3 Seeding). Unset: no seeding |

**Never commit secrets**: `.env`, `Kramabench/.env`, local configs, build
output, logs are all gitignored — keep it that way.

**Native dataflows and the workflow search index**: every native operator
carries its ~200 KB runtime, so a dataflow of a dozen operators is several MB
of workflow content, and `sql/texera_ddl.sql`'s `idx_workflow_pgroonga`
(MeCab tokenizer) then refuses the save (`mecab_parse_lattice() failed …
too long sentence`, a 500 from `/api/workflow/persist`). On a local database,
recreate the index with the bigram tokenizer, which has no length limit and
keeps the dashboard's full-text search working:
`docker exec <postgres> psql -U texera -d texera_db -c "DROP INDEX texera_db.idx_workflow_pgroonga;" -c "CREATE INDEX idx_workflow_pgroonga ON texera_db.workflow USING pgroonga ((COALESCE(name, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(content, ''))) WITH (tokenizer = 'TokenBigram', plugins = 'token_filters/stem', token_filters = 'TokenFilterStem');"`
(`benchmark/campaign/README.md` drops the index instead).

## 8. Conventions for working in this repo

- **Environment**: JDK 17, Scala 2.13, Python 3.12 (uv-managed `.venv`, pinned
  by `.python-version` — without it `uv` may pick an older system/conda python),
  Node 24, Bun, `protoc` (any 3.2x; the generated stubs are gitignored), and
  Docker Compose **v2.20+** (older plugins reject the `--progress` flag
  `bin/local-dev/main.sh` passes, and the failure is silent: infra reports
  containers up while nothing started, then `sbt dist` fails jOOQ codegen with
  `not found: value SITE_SETTINGS`). `.jvmopts` carries the `--add-opens` flags
  JDK 17 needs; `project/JdkOptions.scala` propagates them to forked JVMs.
- **Scope**: narrowly scoped changes; `git status --short` before editing;
  never revert unrelated dirty files (local config edits are often
  deliberate).
- **Branches/commits**: Conventional Commits, ≤ ~60 chars, module as scope
  (`feat(agent-service): ...`, `fix(amber): ...`). This fork's PR base is the
  fork's own branches, not upstream `main`.
- **Tests first**: failing test → implement → green. Bug fixes start with a
  regression test. `agent-service`: `bun test`; Scala: `sbt <Project>/test`;
  Python engine: `pytest` from `amber/src/main/python`.
- **Python protos**: `bash bin/python-proto-gen.sh` (inside the venv, `protoc`
  on PATH) once per fresh clone AND after any proto change. `amber/src/main/python/proto/`
  is gitignored, so a clone never has it; the symptom of forgetting is hanging
  executions, not an import error you can see.
- **Formatting/lint/license headers**: [CONTRIBUTING.md](CONTRIBUTING.md);
  every source file carries the ASF header (`.licenserc.yaml`).
- **Upstream sync**: this fork tracks `apache/texera`; merges from upstream
  land on the fork's main line and are then merged into `stable`.

## 9. Where things live

| Topic | Source of truth |
|---|---|
| Quick start, agent REST API | [README.md](README.md) |
| Stack launcher deep dive + troubleshooting | [docs/local-dev-with-agent.md](docs/local-dev-with-agent.md) |
| Benchmarks (setup, running, scoring) | [benchmark/README.md](benchmark/README.md) |
| KramaBench result reports | `benchmark/Kramabench/judgment_runs/` |
| LiteLLM model list | [bin/litellm-config.yaml](bin/litellm-config.yaml), [bin/single-node/litellm-config.yaml](bin/single-node/litellm-config.yaml) |
| Contribution / PR / lint / format | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Security reporting | [SECURITY.md](SECURITY.md) |
| Engine internals | [amber/README.md](amber/README.md) |
| Single-node / k8s deploy | [bin/single-node](bin/single-node/README.md), [bin/k8s](bin/k8s/README.md) |
| **Obsolete** research/planning notes | [docs/archived/](docs/archived/) — do not follow |
