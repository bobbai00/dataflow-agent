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

# AGENTS.md — the BobFlow repository

## 1. What this repo is

BobFlow is an LLM agent that answers data-science questions by building, running and reading dataflows. It lives in a fork
of [Apache Texera](https://texera.apache.org/). On top of the upstream platform, the fork adds:

1. **`agent-service/`**: the agent (Bun/TypeScript). A ReAct loop with one tool, `dataflow(python, statements)`. The
   model edits a graph with `set id: type(inputs, settings)` and `delete id` statements, over built-in operators and
   registered Python table functions, then runs and reads it with `execute` and `show`. See
   [docs/native-registered-python-design.md](docs/native-registered-python-design.md).
2. **Engine and UI additions** in `amber/` and `frontend/`: the statistics and flow counters the agent reads, UDF errors
   that point at user code, operator port-result caching, the chat panel, the version tree and the operator panel.
3. **`benchmark/`**: the harness behind the paper's numbers (KramaBench, PrepBench, LongDS; BobFlow and Script ReAct) and
   the overhead experiments.

The repository is [Texera/bobflow](https://github.com/Texera/bobflow); work lands on **`main`**.

## 2. How to run things

Everything runs from the repo root. [README.md](README.md) is the walkthrough; the short version:

```bash
cp .env.example .env                # provider keys (§7)
benchmark/bench setup base          # .venv, Python protos, the benchmark venvs, the KramaBench submodule
bin/local-dev.sh up                 # docker infra + JVM services + agent + frontend
bin/local-dev.sh status             # 13 services running; frontend :4200
```

`bin/local-dev.sh` is the supported launcher: it bootstraps the Postgres schema (DDL, then pending `sql/updates`), runs
`sbt dist`, starts the LiteLLM proxy with your keys and manages every service (`up` / `down` / `status` / `logs <svc>` /
`auto`). Agents should use the non-interactive subcommands, never the `-i` TUI. Note that `auto` misses some edits; after
a change the engine must see, use `up --build`. Per-service operations and troubleshooting:
[docs/local-dev-with-agent.md](docs/local-dev-with-agent.md).

Ports: config 9094, access-control (LLM proxy) 9096, file 9092, compiling 9090, computing-unit manager 8888 (admin 8082),
texera-web 8080, computing-unit master 8085, agent-service 3001, frontend 4200, LiteLLM 4000, Postgres 5432, MinIO 9000,
LakeFS 8000.

Benchmarks run on a separate stack: `benchmark/bench stack up` (§5).

## 3. System architecture

```
Browser ──▶ frontend :4200, whose dev proxy (frontend/proxy.config.json) sends
              /api/agents ──▶ agent-service :3001          /api/compile ──▶ compiling :9090
              /api/chat/completion, /api/models ──▶ access-control :9096
              /api/dataset ──▶ file :9092                  /api/computing-unit ──▶ manager :8888
              /wsapi ──▶ computing-unit master :8085       /api ──▶ texera-web :8080

agent-service :3001 ──▶ texera-web :8080, file :9092, manager :8888, computing-unit master :8085 ──▶ Python workers (.venv)
              └───────▶ access-control :9096 ──▶ LiteLLM :4000 ──▶ providers
```

- **`amber/`** holds two things: the Texera web app (`org.apache.texera.web.*`, Dropwizard REST and websockets) and the
  Amber engine (`org.apache.texera.amber.engine.*`, Pekko actors; workers spawn Python processes that load
  `pytexera`/`pyamber`).
- **`agent-service/`** is a standalone Bun/Elysia process, not part of the sbt build. The `dataflow` tool is in
  `src/agent/tools/`; the native catalog, expression parser and Python runtime in `src/agent/native/`; context assembly in
  `src/agent/context/` and `src/agent/util/context-utils.ts`; the loop in `src/agent/texera-agent.ts`. **Never import
  frontend or amber code from agent-service**: it is a process boundary.
- **Traces**: `agent-service/src/trace/trace-store.ts` writes every agent's turns, steps (with timings), model requests
  (by size and token count, never content), dataflow versions, executions, operator results and control events to one
  SQLite database as they happen; `AGENT_TRACE_DB` names it (§7), `GET /api/traces` and `GET /api/traces/:id` read it, and
  `POST /api/agents/:id/restore` rebuilds an agent from it after a restart. `GET /api/agents/:id/archive` is the portable
  form: the steps, each step's operator results and the instructions as one file, which the chat's Import button (or
  `POST /api/agents/:id/import-react-steps`, with `execute: true`) loads into a fresh agent and runs once.
- **Seeding** (`agent-service/src/study/seed.ts`): with `AGENT_SEED_FILE` naming a seed definition
  (`agent-service/benchmark/user-study/seeds/`), every user gets the seed's workflow, agent and trace once, under their own
  account. `POST /api/agents/seed` does it (the frontend's `StudySeedService` asks on every login;
  `agent-service/benchmark/user-study/seed-accounts.ts` asks ahead of time). `GET /api/agents` lists only the caller's agents
  and, given `?workflowId=`, first restores the caller's traced agents on that workflow that a restart dropped. The study
  datasets must be public (`agent-service/benchmark/user-study/setup-datasets.ts`). The definition's `smolagents` section
  seeds the script agent (`smolagents-service/README.md`).
- **The canvas** (frontend): the chat panel is always open, and a new workflow starts a chat named Bob on Claude Haiku 5.5
  (`component/agent/agent-panel/`). A native operator's box shows its one-line doc; a scan shows the file it reads with a
  document glyph (`service/joint-ui/joint-ui.service.ts`, `service/agent/native-operator.ts`). Selecting an operator marks
  everything upstream of it (`workflow-editor.component.ts`, `applyUpstreamHighlight`). The operator panel
  (`component/agent/agent-interaction/`) has Run, Edit, Feedback and Explain; Explain sends a templated chat message and
  shows the reply in the panel as well as the chat. A registered function set with `is_visualization=True` returns a
  chart's HTML, which the panel renders in an iframe. Layout spacing lives in
  `agent-service/src/agent/util/auto-layout.ts` and must stay equal to `joint-graph-wrapper.ts` (`autoLayoutJoint`).
- **LLM path**: the agent never holds a provider key. It sends the user's JWT to the access-control-service, which injects
  the LiteLLM master key and forwards to the proxy. The models are in `bin/single-node/litellm-config.yaml`; the Script
  ReAct runs use `bin/single-node/litellm-config.smolagents.yaml`.
- **Data**: benchmark tasks address files as relative `data/...` paths. On the benchmark stack, the sandbox around the
  engine's Python (`benchmark/src/bobbench/sandbox/`) mounts `benchmark/Kramabench/data` there. On the default stack, data
  comes in through datasets: upload a file in the UI, or drop it on the chat.
- **Gotcha**: JVM services must run with `GUI_WORKFLOW_WORKSPACE_COPILOT_ENABLED=true`, otherwise the access-control-service
  answers `/api/chat/*` and `/api/models` with `403 {"error": "Copilot feature is disabled"}`. It ships in `.env.example`,
  so it reaches the JVMs through the root `.env`. `bin/single-node/.env` sets it too, but that file goes only to
  `docker compose`.

## 4. Connecting to the agent

REST on `:3001` under `/api/agents`; [README.md](README.md#call-the-agent-over-http) has a block that runs as written.

| Step | Call |
|---|---|
| auth | `POST :8080/api/auth/login` gives a JWT; the agent acts on the user's behalf |
| create | `POST /api/agents`: `modelType`, `workflowId`, `computingUnitId`, optional `settings`. A key that is not a setting is refused with a 400 |
| run a turn | `POST /api/agents/:id/message` `{content}`, synchronous; returns `{answer, state, steps, headId}`; 409 while a turn runs |
| inspect | `GET /:id/react-steps`, `/:id/workflow`, `/:id/operator-results`, `/:id/snapshots/:stepId` (workflow and results at a step) |
| tune live | `GET`, `PATCH /:id/settings` |
| control | `POST /:id/stop`, `/:id/clear`, `/:id/checkout`, `DELETE /:id` |
| versions | `GET /:id/snapshot-tree`, `POST /:id/checkout-version`, `GET /:id/versions/:snapshotId` |
| operators | `GET /:id/operators/:opId/form`, `POST .../edit`, `POST .../run`: a user's edit or run, recorded as a user step |
| stream | `WS /:id/react`: per-step frames, what the frontend uses |

Later messages to the same agent continue on the same dataflow. Programmatic clients: TypeScript in
`agent-service/src/api/agent-service-api.ts`, Python in `benchmark/src/bobbench/agent_client.py`.

`python` holds definitions; `statements` holds `set`, `delete`, `execute` and `show` lines. Definitions register before any
statement runs, and a call's `set` and `delete` lines apply together or not at all. The model answers by replying without
the tool once `show result` has displayed what the answer rests on; tool choice is never forced. The rendered system prompt,
tool definition and operator reference live in [native-mode/](native-mode/), generated by
`bun run render:native-reference` in `agent-service/` (a test fails when they drift).

### Default agent configuration

`DEFAULT_AGENT_SETTINGS` (`agent-service/src/types/agent.ts`) is what an agent created with no `settings` runs:
`retrievalViews: ["sample_stats", "full"]`, `nativeProfileCollection: true`, `flowEvidence: false`, `operatorDoc: false`,
`maxResultRows: 3`, `maxOperatorResultCharLimit: 2000`, `fullResultCharLimit: 5000`, `executionTimeoutMs: 240000`,
`maxSteps: 100`, `multiRequest: "off"`, `instructions: ""`. Agents made in the UI turn `operatorDoc` on. See
[docs/retrieval-views.md](docs/retrieval-views.md).

Benchmark arms set their own values (`benchmark/src/bobbench/arms.py`, and the runner's budgets), so read an arm's recorded
`settings.json`, not the service default, when interpreting a result. Retired settings produce an error, not a mapping.
Historical arms must run their recorded revisions.

## 5. Benchmarking

`benchmark/bench` is the one command line; [benchmark/README.md](benchmark/README.md) has every command, the paper's cells
and what a run folder holds.

```bash
benchmark/bench setup all                 # datasets, about 12 GB
benchmark/bench stack up                  # an isolated stack on its own ports, /var/tmp/bobflow-bench
ARMS=evidence_data1_flow0_opt_strict benchmark/campaign/launch.sh opt-kb-luna Luna 1 6
benchmark/bench report /var/tmp/bobflow-bench/runs/opt-kb-luna
benchmark/bench compare <run>[:<arm>] <run>[:<arm>]
benchmark/bench test                      # offline, about 20 s
```

`benchmark/tests/gate/` replays recorded smokes through the runners with a stub model, $0, and fails on any change in what
a model sees or how an attempt ends. Use it after any change to the harness, the agent or the engine that is not meant to
change what a model sees. `benchmark/tracker/` holds the overhead experiments.

## 6. Tests

[README.md](README.md#4-tests) lists every suite. With the stack up, `cd agent-service && bun run e2e` runs workflows through
the engine (it calls neither the agent nor the LLM proxy), and `frontend/e2e/*.e2e.mjs` drive the UI in a real browser.

## 7. Credentials

Provider keys live in the root **`.env`** (`cp .env.example .env`), read by `bin/local-dev.sh` and `benchmark/bench`;
shell-exported values win. `agent-service/.env` holds the agent's service endpoints and no keys: the launcher creates it from
its example.

| Variable | Used by |
|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY` | the LiteLLM gateways; only the providers you call |
| `LITELLM_BASE_URL`, `LITELLM_MASTER_KEY` | optional: swap the local proxy for an external OpenAI-compatible gateway |
| `OPENAI_API_KEY` | also KramaBench's judge (gpt-5-mini, called directly); a dummy key silently zeroes paraphrase metrics |
| `UDF_PYTHON_PATH` | optional: the engine workers' interpreter (default: the repo's `.venv`) |
| `AGENT_TRACE_DB` | optional: the trace database; default `logs/agent-service/traces.db`, `off` disables it |
| `AGENT_SEED_FILE` | optional: a seed definition (§3 Seeding); unset means no seeding |

**Never commit secrets**: `.env`, local configs, build output and logs are gitignored; keep it that way.

## 8. Conventions for working in this repo

- **Environment**: JDK 17, Scala 2.13, Python 3.12 (uv-managed `.venv`, pinned by `.python-version`), Node 24, Bun, Docker
  Compose v2.20 or newer. `protoc` 3.19.4 comes with the venv, except on Apple Silicon (`brew install protobuf`). `.jvmopts`
  carries the `--add-opens` flags JDK 17 needs; `project/JdkOptions.scala` passes them to forked JVMs.
- **A plain `sbt` command needs a database**: jOOQ generates its sources from Postgres at compile time, with the settings in
  `storage.conf`. `bin/local-dev.sh` and `bin/test-scala.sh` set them; the generated code is not in git.
- **`.venv`**: `benchmark/bench setup base` adds the paper's extra engine packages (`benchmark/envs/engine/requirements.txt`),
  and a later `uv sync` removes them. Run setup again after one.
- **Scope**: narrowly scoped changes; `git status --short` before editing; never revert unrelated dirty files.
- **Commits**: Conventional Commits, about 60 characters, module as scope (`feat(agent-service): ...`, `fix(amber): ...`). This
  fork's PR base is the fork's own branches, not upstream `main`.
- **Tests first**: failing test, implement, green. Bug fixes start with a regression test.
- **Python protos**: `amber/src/main/python/proto/` is generated and gitignored. Regenerate after any proto change:
  `source .venv/bin/activate && bash bin/python-proto-gen.sh`. Without them every Python worker dies at import, and turns
  hang until the execution timeout rather than showing an error.
- **Formatting, lint, license headers**: [CONTRIBUTING.md](CONTRIBUTING.md); every source file carries the ASF header
  (`.licenserc.yaml`).
- **Upstream sync**: this fork tracks `apache/texera`; merges land on `main`.

## 9. Where things live

| Topic | Source of truth |
|---|---|
| Install, launch, agent API, benchmarks in brief | [README.md](README.md) |
| Launcher deep dive and troubleshooting | [docs/local-dev-with-agent.md](docs/local-dev-with-agent.md) |
| Benchmarks: commands, the paper's cells, run folders | [benchmark/README.md](benchmark/README.md) |
| The benchmark stack | [benchmark/campaign/README.md](benchmark/campaign/README.md) |
| Overhead experiments | [benchmark/tracker/README.md](benchmark/tracker/README.md) |
| The `dataflow` tool's design | [docs/native-registered-python-design.md](docs/native-registered-python-design.md) |
| What the model reads | [docs/retrieval-views.md](docs/retrieval-views.md), [native-mode/](native-mode/) |
| The model list | [bin/single-node/litellm-config.yaml](bin/single-node/litellm-config.yaml) |
| Contribution, PR, lint, format | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Security reporting | [SECURITY.md](SECURITY.md) |
| Engine internals | [amber/README.md](amber/README.md) |
| Single-node and k8s deploy | [bin/single-node](bin/single-node/README.md), [bin/k8s](bin/k8s/README.md) |
