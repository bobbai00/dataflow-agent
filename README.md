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

# Dataflow Agent — Texera + an LLM agent that builds dataflows

A fork of [Apache Texera](https://texera.apache.org/) (human-AI collaborative
data science using visual workflows) extended with a **dataflow agent**: an LLM
agent that answers data-science questions by building, executing, and iterating
on Texera dataflow operators — plus the benchmarking harnesses
(KramaBench, LongDS-Bench) used to evaluate it.

```
┌──────────┐   REST/WS    ┌───────────────┐   proxied LLM calls   ┌─────────┐
│ benchmark  ───────────▶ │ agent-service │ ────────────────────▶ │ LiteLLM │
└──────────┘              │    (:3001)    │      (:9096→:4000)    └─────────┘
                          └──────┬────────┘
                                 │ workflow CRUD + execution
                          ┌──────▼────────────────────────────────┐
                          │ Texera JVM services + Python workers  │
                          └───────────────────────────────────────┘
```

## 1. Quick start

Prerequisites: JDK 17, sbt, Docker (compose v2), Bun, Node 24 + yarn,
Python 3.12 with [uv](https://docs.astral.sh/uv/).

```bash
# 0. Python venv for the engine's UDF workers
uv sync --all-extras

# 1. API keys — read by BOTH the stack launcher and the benchmark driver
cp .env.example .env          # fill in OPENAI_API_KEY / ANTHROPIC_API_KEY

# 2. the whole stack: docker infra (postgres/minio/lakefs/lakekeeper/LiteLLM),
#    JVM services, agent-service, frontend
bin/local-dev.sh up

# 3. check
bin/local-dev.sh status       # 14 services; frontend at http://localhost:4200
```

`bin/local-dev.sh` owns everything: it bootstraps the postgres schema, runs
`sbt dist`, starts every service, and brings up the **LiteLLM proxy**
(`localhost:4000`) with your provider keys from `.env`. Models served by
default (see `bin/single-node/litellm-config.yaml`): `claude-haiku-4.5`,
`claude-sonnet-5`, `claude-opus-5`, `gpt-5.2`, `gpt-5-mini`, `gpt-5.6`, and the
reasoning variants `gpt-5.6-luna` / `gpt-5.6-tara` (pinned to medium reasoning
effort). You only need keys for the providers you actually call.

To use an external OpenAI-compatible gateway instead of the local LiteLLM, set
`LITELLM_BASE_URL` / `LITELLM_MASTER_KEY` in `.env` — nothing else changes.

Deep dive on the launcher (per-service ops, logs, troubleshooting — including
what breaks when your laptop switches networks):
[docs/local-dev-with-agent.md](docs/local-dev-with-agent.md).

## 2. Calling the agent

The agent-service (`:3001`) exposes a small REST surface. One full loop:

```bash
BASE=http://localhost:3001/api

# JWT from the Texera backend (the agent acts on your behalf)
TOKEN=$(curl -s -X POST http://localhost:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"texera","password":"texera"}' | jq -r .accessToken)

# 1. create an agent bound to a workflow + computing unit
AGENT=$(curl -s -X POST $BASE/agents/ \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"modelType":"gpt-5.2","workflowId":1,"computingUnitId":1,
       "settings":{"agentMode":"code","contextMode":"latest"}}' | jq -r .id)

# 2. run one turn (synchronous — returns when the agent finishes)
curl -s -X POST $BASE/agents/$AGENT/message \
  -H 'Content-Type: application/json' \
  -d '{"content":"Load data/wildfire/input/noaa_wildfires_monthly_stats.csv and report the row count."}'
# -> {"status":"complete","state":"AVAILABLE","answer":"...","steps":N,"headId":"..."}

# 3. inspect what it did
curl -s $BASE/agents/$AGENT/react-steps      # full ReAct trace
curl -s $BASE/agents/$AGENT/workflow         # current workflow DAG
curl -s $BASE/agents/$AGENT/operator-results # per-operator executed results
curl -s $BASE/agents/$AGENT/snapshots/head   # steps + workflow at HEAD

# 4. clean up
curl -s -X DELETE $BASE/agents/$AGENT
```

### Default configuration

An agent created with no `settings` runs the campaign-measured configuration
(`DEFAULT_AGENT_SETTINGS` in `agent-service/src/types/agent.ts`):

| Setting | Default | What it gives the model |
|---|---|---|
| `contextMode` | `delta` | the trajectory replayed per event (Thought / Action / Observation), not just a snapshot |
| `flowLevel` | `1` | loader-remediation hints + the consolidated `Operators needing attention` section |
| `dataLevel` | `2` | typed `Schema (N cols)` line + `Output Table profile:` (duplicate rows, all-null regions, unresolved headers) |
| `columnStats` | `true` | `Column Schema and stats:` — nulls, min/max/mean, distinct, top-N per column |
| `agentMode` | `code` | one `createOrModifyOperator` tool writing Python `def load()` / `def process()` |
| `maxSteps` | `100` | per-turn step budget |
| `maxOperatorResultCharLimit` | `2000` | sample-row budget per result (`codeMaxChars: 0` = code uncapped) |
| `thoughtReplay` | `true` (K=10) | recent reasoning re-injected |
| layout | flat | `sessionTurns` / `versionedMode` / `turnHistory: "index"` all off |

Everything else (recall / inspect / resume / compaction / telemetry knobs) is
off by default. Two renders are **conditional by design**, so their absence in
a small run is not a bug: column stats are suppressed when the complete table
is already visible in the context, and the structural profile only appears when
the worker finds an actual signal (duplicate rows, all-null rows/columns, an
unresolved header).

Key endpoints (all under `/api/agents`):

| Method | Path | What |
|---|---|---|
| POST | `/` | create agent — `modelType` (any LiteLLM model above), `workflowId`, `computingUnitId`, optional `settings` (context mode, budgets, all knobs) |
| GET | `/` | list agents |
| POST | `/:id/message` | **run one turn synchronously**; body `{content}`; 409 while a turn is running |
| GET | `/:id/react-steps` | full ReAct trace (thoughts, tool calls, observations) |
| GET | `/:id/workflow` | current workflow content |
| GET | `/:id/operator-results` | executed result summaries per operator |
| GET | `/:id/snapshots/:stepId` | steps + workflow at any step (`head` for latest) |
| GET/PATCH | `/:id/settings` | read / tune context parameters live |
| POST | `/:id/stop`, `/:id/clear`, `/:id/checkout` | stop turn / reset history / move HEAD |
| DELETE | `/:id` | delete agent |
| WS | `/:id/react` | streaming protocol (per-step frames) — what the frontend uses |

Multi-turn sessions: keep POSTing `/message` to the same agent — operators,
results, and history carry over (this is exactly how LongDS-Bench drives it).
Programmatic clients: TypeScript helpers in
`agent-service/src/api/agent-service-api.ts`, Python in
`benchmark/Kramabench/dataflow_agent.py`.

## 3. Benchmarks

Both benchmarks run through one driver, from the repo root:

```bash
bin/bench.sh setup            # one-time: submodule, venv, data, symlinks
                              #   (--copy-from <old-checkout> skips the Kaggle download)

# KramaBench (104 tasks, 6 domain data lakes; benchmark/Kramabench submodule)
bin/bench.sh kb tasks --sut DataflowSystemGPT52LatestSchemaConverge \
    --ids "legal-easy-3 wildfire-easy-1" --parallel
bin/bench.sh kb scores --sut DataflowSystemGPT52LatestSchemaConverge
bin/bench.sh kb systems       # every runnable SUT configuration

# LongDS-Bench (long-horizon multi-turn; benchmark/longds)
bin/bench.sh longds run --task sports__nfl_big_data_bowl_2023__task1 --arm haiku-delta-1k
bin/bench.sh longds judge --sut LongDS_LongDSHaikuDelta1k --judge-model gpt-5.2
```

Run artifacts (per-task prompt, response, ReAct trace, workflow JSON, token
and cost stats) land in `benchmark/Kramabench/system_scratch/<SUT>/<task>/`
and `benchmark/longds/system_scratch/<SUT>/<task>/t<NN>/`.

Full benchmark docs: [benchmark/README.md](benchmark/README.md).

## 4. Repo layout

| Path | What |
|---|---|
| `agent-service/` | the dataflow agent (Bun/TypeScript): ReAct loop, context assembly, tools |
| `amber/` | Texera's execution engine (Scala + Python workers) |
| `common/`, `*-service/` | Texera microservices (config, auth+LLM proxy, files, compiling, computing units) |
| `frontend/` | Angular UI (`localhost:4200`) |
| `bin/local-dev.sh` | full-stack launcher |
| `bin/bench.sh` | benchmark driver |
| `bin/single-node/litellm-config.yaml` | LiteLLM model list |
| `benchmark/` | KramaBench submodule + LongDS harness |
| `docs/local-dev-with-agent.md` | launcher deep dive + troubleshooting |

## 5. Upstream

This fork tracks [apache/texera](https://github.com/apache/texera). For the
upstream platform documentation, see the
[Texera official site](https://texera.apache.org/) and
[docs.texera.io](https://docs.texera.io).
