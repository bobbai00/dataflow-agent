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
   two modes — **native** (default: the model edits a graph with
   `set id: type(inputs, settings)` and `delete id` declarations over thirteen
   built-ins and registered Python table functions; see
   [docs/native-registered-python-design.md](docs/native-registered-python-design.md)) and
   **code** (every operator a free Python function) — plus a heavily
   instrumented context-assembly layer (DELTA/LATEST modes, sampling budgets,
   evidence, turn indexing — every knob is a runtime setting).
2. **Engine extensions in `amber/`** — result/column-stats telemetry, UDF
   error reporting that points at user code, operator port-result caching,
   dynamic output schemas: the engine-side features the agent's context
   depends on.
3. **`benchmark/`** — the evaluation harnesses: KramaBench (single-question
   tasks over domain data lakes, as a git submodule) and LongDS-Bench
   (long-horizon multi-turn analysis, in-repo).

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

Multi-turn sessions: keep POSTing `/message` to the same agent — operators,
results, and history carry (LongDS-Bench drives it exactly this way).
Programmatic clients: TS helpers in `agent-service/src/api/agent-service-api.ts`,
Python in `benchmark/Kramabench/dataflow_agent.py`.

Tools per mode: native exposes one tool, `dataflow(reasoning, actions)`;
code exposes `createOrModifyOperator` and `deleteOperator`. `recallState`,
`resumeFrom` and `compactContext` are opt-in in either mode.
The rendered native system prompt, tool definitions and operator reference
live in [native-mode/](native-mode/), generated from the code by
`bun run render:native-reference` (a test fails when they drift).

### Default agent configuration

`DEFAULT_AGENT_SETTINGS` (`agent-service/src/types/agent.ts`) is what an agent
created with no `settings` runs: **`agentMode: native`** (explicit graph
commands; `code` is the other mode), **`contextMode: delta`**,
**`nativeProfileCollection: true`**, **`dataEvidence: false`** and
**`flowEvidence: false`**. Native retrieval choices control data-statistics
exposure; `flowEvidence` independently adds flow metadata. Collection is
compiled into each operator and cannot change on an existing workflow. Also on: `maxSteps: 100`,
`maxOperatorResultCharLimit: 2000`, `enableCodeInSnapshot`, `thoughtReplay`
(K=10). Native mode forces provider parallel tool calls off (the action list is
the batch). Layout is flat (`sessionTurns` / `versionedMode` / `turnHistory:
"index"` all off). Optional recall, resume, and compaction tools are off;
graph inspection is built into `dataflow`. See [README.md §2](README.md) for
the full table.

Flat native DELTA defaults to `messageLayout: "markdown"`: one environment
report per iteration pairs frozen submitted code/declarations with recorded
outcomes. Actual user requests and final answers retain their roles. The model
still calls the real `dataflow` tool; raw calls/results remain in saved traces.
Explicit `messageLayout: "native"` preserves the previous transcript for A/B
comparisons. Standard context budgets support both sliding and checkpoint
compaction. Advanced legacy context policies keep their existing renderer;
explicitly combining them with Markdown is rejected. See
[the context contract](docs/native-registered-python-design.md#iteration-history).

Measured `filter(t, predicate="name", settings={})` calls a registered predicate
with a read-only row mapping and keyword settings. Boolean/null verdicts keep or
drop rows; null verdicts are included in rejected counts. It preserves schema and
order and collects bounded rejected-value frequencies. General table functions
do not acquire filter/join/cast semantics automatically. Python edits invalidate
both custom table operators and measured filters plus their descendants.

`inspect target="schema"` reads exact column names/types from current completed
results; `target="source"` reads retained scan/workbook discovery metadata.
Both accept `operator_id` and optional `offset`/`limit` pages (limit 1–200), return
`next_offset`, and never execute or open files. Use scan preview=1, execute, then
source inspection for workbook layout; parsed schema requires a normal scan.

Native Retrieve requires `operator_ids` and a `view`: `full`, `sample`, or `sample_stats`. Session
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
`allowedOperatorTypes`, and the old level/statistics overlays) produce an
error, not a compatibility mapping. Schema and samples fill one result budget;
each enabled evidence kind appends within its own budget, so evidence never
displaces rows; a complete small table suppresses redundant data facts.
`dataflowReasoning` is retained for archived settings and normalized to true
in native mode. Every call requires a brief rationale and an ordered list of
`inspect`, `edit`, `execute`, `retrieve`, or `answer` actions. Edits do not
execute; retrieval never executes; Answer must be the sole action and ends
the loop. Each Edit atomically stages Python definitions and graph declarations;
it never executes. Functions share authored definitions, while every operator
invocation has fresh execution variables. A failed edit skips later actions while earlier completed edits remain. After
an execution failure, subsequent requested executions and inspect/retrieve may continue. Edits are skipped;
a skipped edit also blocks later executions from silently using the old graph.
`inspectResult` is never exposed. See
[docs/native-registered-python-design.md](docs/native-registered-python-design.md) and
[docs/data-flow-evidence.md](docs/data-flow-evidence.md). Historical benchmark
arms must run their recorded revisions; do not reinterpret old labels.

Benchmark arms override these per experiment (`Kramabench/systems/dataflow_system.py`,
`benchmark/longds/arms.py`), so an arm's configuration and the service default
are independent — read the arm, not the default, when interpreting a result.

## 5. Benchmarking

One driver for both benchmarks, run from the repo root
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

**LongDS-Bench** (agent benchmark — 68 tasks / 2,225 turns of multi-turn
analysis where turn N+1 depends on state built in 1..N; `benchmark/longds`,
part of this repo):

```bash
bin/bench.sh longds download --task sports/nfl_big_data_bowl_2023/task1
bin/bench.sh longds prepare  --task sports/nfl_big_data_bowl_2023/task1
bin/bench.sh longds run      --task sports__nfl_big_data_bowl_2023__task1 --arm haiku-delta-1k
bin/bench.sh longds judge    --sut LongDS_LongDSHaikuDelta1k --judge-model gpt-5.2
```

Arms live in `benchmark/longds/arms.py`. Run artifacts (per-turn prompt,
response, ReAct trace, workflow JSON, cost) land under each harness's
`system_scratch/<SUT>/<task>/`.

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
| `JUDGE_BASE_URL`, `JUDGE_API_KEY` | optional: LongDS judge endpoint (defaults to the local proxy) |
| `OPENAI_API_KEY` (again) | KramaBench scoring calls gpt-5-mini directly — a dummy key silently zeroes paraphrase metrics |
| `UDF_PYTHON_PATH` | optional: engine worker interpreter (defaults to repo `.venv`) |

**Never commit secrets**: `.env`, `Kramabench/.env`, local configs, build
output, logs are all gitignored — keep it that way.

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
| Benchmarks (setup, running, scoring) | [benchmark/README.md](benchmark/README.md), [benchmark/longds/README.md](benchmark/longds/README.md) |
| KramaBench result reports | `benchmark/Kramabench/judgment_runs/` |
| LiteLLM model list | [bin/litellm-config.yaml](bin/litellm-config.yaml), [bin/single-node/litellm-config.yaml](bin/single-node/litellm-config.yaml) |
| Contribution / PR / lint / format | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Security reporting | [SECURITY.md](SECURITY.md) |
| Engine internals | [amber/README.md](amber/README.md) |
| Single-node / k8s deploy | [bin/single-node](bin/single-node/README.md), [bin/k8s](bin/k8s/README.md) |
| **Obsolete** research/planning notes | [docs/archived/](docs/archived/) — do not follow |
