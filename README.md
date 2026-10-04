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

Prerequisites: JDK 17, sbt, Docker with **Compose v2.20+**, Bun,
Node 24 + yarn, Python 3.12 with [uv](https://docs.astral.sh/uv/), and
`protoc` (any 3.2x) on PATH.

Two prerequisites bite specifically on a *fresh clone*, because both failures
are silent rather than loud: an older Compose plugin rejects the `--progress`
flag the launcher passes, so infra prints "containers up" while nothing
started and the build then fails jOOQ codegen with `not found: value
SITE_SETTINGS`; and the generated Python protos are gitignored, so without
step 1 below every UDF worker dies at import and agent turns hang until the
engine's 240 s execution timeout.

```bash
# 0. Python venv for the engine's UDF workers
uv sync --all-extras

# 1. Generated Python protos — REQUIRED once per clone (gitignored, needs protoc)
source .venv/bin/activate && bash bin/python-proto-gen.sh

# 2. API keys — read by BOTH the stack launcher and the benchmark driver
cp .env.example .env          # fill in OPENAI_API_KEY / ANTHROPIC_API_KEY

# 3. the whole stack: docker infra (postgres/minio/lakefs/lakekeeper/LiteLLM),
#    JVM services, agent-service, frontend
bin/local-dev.sh up

# 4. check
bin/local-dev.sh status       # 14 services; frontend at http://localhost:4200
```

`bin/local-dev.sh` owns everything: it bootstraps the postgres schema, runs
`sbt dist`, starts every service, and brings up the **LiteLLM proxy**
(`localhost:4000`) with your provider keys from `.env`. Models served by
default (see `bin/single-node/litellm-config.yaml`): `claude-haiku-4.5`,
`claude-sonnet-5`, `claude-sonnet-5.5`, `claude-opus-5`, `gpt-5.2`, `gpt-5-mini`, `gpt-5.6`, and the
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
#    (no `settings` = the defaults below: native mode, DELTA context, evidence off;
#     pass e.g. {"agentMode":"code"} or {"dataEvidence":true,"flowEvidence":true} to change them)
AGENT=$(curl -s -X POST $BASE/agents/ \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"modelType":"gpt-5.2","workflowId":1,"computingUnitId":1}' | jq -r .id)

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

### Modes and tools

`agentMode` selects how the model builds the dataflow. Native mode uses an
ordered action list with explicit execution and retrieval. Code mode executes
automatically after operator edits.

| Mode | Tools the model sees | What one call does |
|---|---|---|
| `native` (default) | `dataflow` | `dataflow({reasoning, actions})`: an ordered list of `inspect`, `edit`, `execute`, `retrieve`, or `answer`. Edits use explicit `create/update/delete operator` and `create/delete edge` commands over the 15-operator catalog. Operator expressions contain parameters; named ports define connections. Each Edit is atomic, and deleting an operator also deletes its incident edges. `filter`, `map`, and `process` carry Python functions and a required `doc`. Edits do not execute; retrieval reads stored results; Answer ends the loop. |
| `code` | `createOrModifyOperator`, `deleteOperator` | one operator per call as a Python `def load()` / `def process(...)` function (`DataLoading` / `DataProcessing`). |

Optional pull tools in either mode, all off by default: `recallState`
(`enableRecallTool`), `resumeFrom` (`enableResumeTool`), `compactContext`
(`enableCompactTool`). Native mode forces provider parallel tool calls off;
the action list is the batch. Actions stop at the first failure; completed
edits remain. Decisions based on returned results belong in the next call. See
[docs/native-expression-mode.md](docs/native-expression-mode.md) for the
expression syntax, the operator reference and the error taxonomy, and
[native-mode/](native-mode/) for the complete system prompt, the exact tool
definitions and the operator reference as the model receives them (generated
from the code; `bun run render:native-reference` in `agent-service/`).

### Default configuration

An agent created with no `settings` uses
(`DEFAULT_AGENT_SETTINGS` in `agent-service/src/types/agent.ts`):

| Setting | Default | What it gives the model |
|---|---|---|
| `agentMode` | `native` | the operator expressions above; `code` is the other mode |
| `contextMode` | `delta` | the trajectory replayed per event (Thought / Action / Observation), not just a snapshot |
| `dataEvidence` | `false` | other modes use it to expose data measurements; native actions select data statistics through `sample_stats` |
| `retrievalViews` | `["sample_stats", "full"]` | inspect samples and statistics first; `sample` can be enabled explicitly |
| `flowEvidence` | `false` | automatically adds selected flow measurements and operator contracts, including producing ancestors, to retrieved results |
| `dataflowReasoning` | `true` | retained for archived settings; native action calls always require a brief rationale and normalize this setting to true |
| `nativeProfileCollection` | `true` | the engine collects the counters behind both evidence kinds, so they can be switched on later without rebuilding the workflow; it cannot change on an existing workflow |
| `maxOperatorResultCharLimit` | `2000` | per-result budget for schema and sample rows; each enabled evidence kind appends within its own budget, so evidence never displaces rows; a complete small table takes priority |
| `maxResultRows` | `0` | additional sample row limit; zero leaves the sample bounded by characters |
| `fullResultCharLimit` | `5000` | full-record display cap; native transport independently retains up to 100,000 characters; incomplete views remain labeled |
| `dataEvidenceCharLimit` / `flowEvidenceCharLimit` | `2000` each | separate budgets for native data statistics and automatic flow evidence |
| `maxOperatorResultCellCharLimit` | `2000` | sample cells are clipped and marked; native full retrieval preserves retained cell contents |
| `maxSteps` | `100` | per-turn step budget |
| `stateHistory` | `false` | native actions can inspect named operators at completed tasks, read saved views in the same inspection, and fork historical operator branches; see [historical state](docs/native-expression-mode.md#optional-historical-state) |
| `taskContext` | `"trajectory"` | opt-in `"dependencies"` keeps current-task ReAct and replaces earlier trajectories with questions, answers and parent task IDs; inspect a task to retrieve its saved answer sub-DAG; requires native DELTA context and `stateHistory`; see [task context](docs/observation-format/task-dependency-context.md) |
| `toolTimeoutSeconds` / `executionTimeoutMinutes` | `240` s / `4` min | per tool call / per workflow execution |
| `parallelToolCalls` | `true` | provider-side parallel calls (forced off in native mode) |
| `thoughtReplay` | `true` (K=10) | recent reasoning re-injected |
| layout | flat | `sessionTurns` / `versionedMode` / `turnHistory: "index"` all off |

Display settings can also be changed live with `PATCH /api/agents/:id/settings`.
Increasing a retrieval budget does not recover records absent from an earlier
execution. See [Retrieval views](docs/retrieval-views.md) for the tool contract,
prompt behavior, result caching and experiment driver.
Retired settings (`nativeToolMode`, `nativeCatalogVersion`,
`allowedOperatorTypes`, `agentMode: "general"`, and the old level/statistics
overlays) are rejected with an error, not translated. `inspectResult` is not a
tool. For the evidence formulas, budgets and rendered examples of all four
evidence configurations, see [Data and flow evidence](docs/data-flow-evidence.md).

Key endpoints (all under `/api/agents`):

| Method | Path | What |
|---|---|---|
| POST | `/` | create agent — `modelType` (any LiteLLM model above), `workflowId`, `computingUnitId`, optional `settings` (mode, evidence flags, budgets, every knob in the table above) |
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
