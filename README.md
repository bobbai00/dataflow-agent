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

# BobFlow

BobFlow is an LLM agent that answers data-science questions by building a dataflow. It adds operators to a workflow on
[Apache Texera](https://texera.apache.org/), runs them on Texera's engine, reads each result, and then decides what to do
next. A person sees the same dataflow on a canvas, and can edit or rerun any operator or go back to any earlier version.

This repository holds three things:

| Part | Where | What it is |
|---|---|---|
| Texera | `amber/`, `common/`, `*-service/`, `frontend/`, `sql/` | A fork of Apache Texera: the engine, its web services and the UI |
| The agent | `agent-service/` | The agent, in TypeScript on Bun. The model has one tool, `dataflow(python, statements)` |
| The benchmarks | `benchmark/` | The harness behind the paper's numbers: KramaBench, PrepBench and LongDS, on BobFlow and on a script agent |

```
browser ──▶ frontend :4200 ─────────┐
                                    ▼
benchmark runner ─────────▶ agent-service :3001 ──▶ access-control-service :9096 ──▶ LiteLLM :4000 ──▶ model providers
                                    │
                                    ▼
             texera-web :8080, file service :9092, computing units :8888, engine :8085 ──▶ Python workers
```

## 1. Install

You need these tools. This README was run from a fresh clone on Ubuntu 20.04 with the versions in the second column.

| Tool | Tested with | For |
|---|---|---|
| JDK 17 and [sbt](https://www.scala-sbt.org/) | OpenJDK 17.0.15, sbt 1.9.3 | Texera's services |
| Docker with Compose v2.20 or newer | Docker 23.0.4, Compose 5.4.0 | Postgres, MinIO, LakeFS, the LiteLLM gateway |
| [Bun](https://bun.sh/) | 1.3.5 | the agent |
| Node 24, with `corepack enable` for yarn | Node 24.19.0, yarn 4.14.1 | the UI |
| [uv](https://docs.astral.sh/uv/) and any `python3` | uv 0.9.21 | Python environments |
| `git`, `curl`, `lsof`, `ip`, [bubblewrap](https://github.com/containers/bubblewrap) | bubblewrap 0.4.0 | the launcher; `bwrap` sandboxes the code models write in benchmarks |

Then, from an empty folder:

```bash
git clone git@github.com:bobbai00/dataflow-agent.git
cd dataflow-agent
git checkout stable
cp .env.example .env            # then open .env and add your API keys
benchmark/bench setup base      # Python environments, generated code, the KramaBench submodule
```

You only need keys for the models you call:

| Key in `.env` | Models |
|---|---|
| `ANTHROPIC_API_KEY` | Claude. A new chat in the UI starts on Claude Haiku 5.5 |
| `OPENAI_API_KEY` | GPT-5.6 and GPT-6.1. KramaBench's scoring also needs it, for its gpt-5-mini judge |
| `OPENROUTER_API_KEY` | Gemini 4 Argon and DeepSeek. LongDS's judge also needs it |
| `GEMINI_API_KEY` | Gemini 3.8 Flash |

## 2. Launch

### Everything together

```bash
bin/local-dev.sh up             # the first run builds everything, which takes several minutes
bin/local-dev.sh status         # 13 services, all running
```

Open <http://localhost:4200> and sign in as `texera` with password `texera`. Create a workflow and it opens with the chat
panel on the right, already on a chat with the agent. Ask it something, and watch it build the dataflow on the canvas.
Select an operator to run it, edit it, or send the agent feedback about it. The version tree on the left goes back to any
earlier version.

```bash
bin/local-dev.sh down           # stop everything; your data stays in Docker volumes
```

### One part at a time

Each of these takes a service name from the table below.

```bash
bin/local-dev.sh up --skip=frontend         # everything except the UI
bin/local-dev.sh up agent-service           # start or restart one service, rebuilding it if its source changed
bin/local-dev.sh down agent-service         # stop one service
bin/local-dev.sh logs agent-service         # follow one service's log
bin/local-dev.sh auto                       # after editing code: rebuild and restart only what changed
```

| Service | Port | What it does |
|---|---|---|
| `postgres`, `minio`, `lakefs`, `litellm` | 5432, 9000, 8000, 4000 | Storage and the model gateway, in Docker |
| `config-service` | 9094 | Site settings |
| `access-control-service` | 9096 | Sign-in checks and the path to the model gateway |
| `file-service` | 9092 | Datasets |
| `workflow-compiling-service` | 9090 | Checks a workflow and works out its schemas |
| `computing-unit-managing-service` | 8888 | Computing units |
| `computing-unit-master` | 8085 | The engine, which starts the Python workers |
| `texera-web` | 8080 | Workflows, users, and the REST API behind the UI |
| `agent-service` | 3001 | The agent |
| `frontend` | 4200 | The UI |

More on the launcher, including its logs and what to do when a service will not start:
[docs/local-dev-with-agent.md](docs/local-dev-with-agent.md).

### Call the agent over HTTP

The UI is one client of the agent's REST API, and the benchmark runner is another. With the stack up, this block asks the
agent one question. It prints the agent's answer, which should say 385.

```bash
json() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }
HEADER='Content-Type: application/json'

# Sign in. The agent acts on your behalf with this token.
TOKEN=$(curl -s -X POST localhost:8080/api/auth/login -H "$HEADER" \
  -d '{"username":"texera","password":"texera"}' | json '["accessToken"]')
AUTH="Authorization: Bearer $TOKEN"

# A workflow for the agent to build in, and a computing unit to run it on.
WORKFLOW=$(curl -s -X POST localhost:8080/api/workflow/create -H "$AUTH" -H "$HEADER" \
  -d '{"name":"first dataflow","description":"","content":"{\"operators\":[],\"operatorPositions\":{},\"links\":[],\"commentBoxes\":[],\"settings\":{\"dataTransferBatchSize\":400}}"}' \
  | json '["workflow"]["wid"]')
UNIT=$(curl -s -X POST localhost:8888/api/computing-unit/create -H "$AUTH" -H "$HEADER" \
  -d '{"name":"first unit","unitType":"local","cpuLimit":"NaN","memoryLimit":"NaN","gpuLimit":"NaN","jvmMemorySize":"NaN","shmSize":"NaN","uri":"http://localhost:8085"}' \
  | json '["computingUnit"]["cuid"]')

# The agent. settings is optional; modelType is any model the gateway offers.
AGENT=$(curl -s -X POST localhost:3001/api/agents -H "$AUTH" -H "$HEADER" \
  -d "{\"modelType\":\"gpt-5.6-luna\",\"workflowId\":$WORKFLOW,\"computingUnitId\":$UNIT}" | json '["id"]')

# One turn. This call returns when the agent has finished.
curl -s -X POST localhost:3001/api/agents/$AGENT/message -H "$HEADER" \
  -d '{"content":"Make a table of the numbers 1 to 10 and their squares, then tell me the sum of the squares."}' \
  | json '["answer"]'

# What it did: how many steps it took, and the operators of the dataflow it built.
curl -s localhost:3001/api/agents/$AGENT/react-steps | json '["steps"].__len__()'
curl -s localhost:3001/api/agents/$AGENT/workflow | json '["workflow"]["operators"].__len__()'

# Later messages to the same agent continue on the same dataflow. When you are done:
curl -s -X DELETE localhost:3001/api/agents/$AGENT
```

The main routes, all under `/api/agents`:

| Route | What it does |
|---|---|
| `POST /` | Create an agent: `modelType`, `workflowId`, `computingUnitId`, and optional `settings` |
| `POST /:id/message` | Run one turn and wait for it; `409` if one is already running |
| `WS /:id/react` | The same turn with one frame per step, which is what the UI uses |
| `GET /:id/react-steps`, `/workflow`, `/operator-results` | The steps, the dataflow, and each operator's results |
| `GET`, `PATCH /:id/settings` | Read or change the agent's settings. An unknown key is refused with a `400` |
| `GET /:id/snapshot-tree`, `POST /:id/checkout-version` | The versions of the dataflow, and going back to one |
| `POST /:id/stop`, `DELETE /:id` | Stop a turn, delete the agent |

The prompt and tool the model sees are in [native-mode/](native-mode/), generated from the code. The default settings are
`DEFAULT_AGENT_SETTINGS` in [agent-service/src/types/agent.ts](agent-service/src/types/agent.ts), and
[docs/retrieval-views.md](docs/retrieval-views.md) explains the ones that decide what the model reads.

## 3. Benchmarks

The paper compares two systems on three benchmarks. BobFlow is the agent above. Script ReAct is
[smolagents](https://github.com/huggingface/smolagents)' `CodeAgent`, a model that writes and runs Python scripts.

| Benchmark | Size | How an answer is scored |
|---|---|---|
| KramaBench | 104 questions over 6 data lakes | KramaBench's evaluator, which calls a small model to compare answers |
| PrepBench | 306 data-preparation cases | PrepBench's evaluator, on the output tables |
| LongDS v1.1 Lite | 24 sessions, 777 requests in a row on one dataset | A judge model, against the expected answers |

### Set up once

```bash
benchmark/bench setup all       # adds the datasets, about 12 GB
bin/local-dev.sh down           # one stack per checkout at a time
benchmark/bench stack up        # builds and starts a Texera just for benchmarks
```

The benchmark stack has its own ports, containers and data, and keeps its state in `/var/tmp/bobflow-bench`. It shares this
checkout's build and results folder with the stack from section 2, so only one of them can run at a time; `bench stack up`
refuses while the other is up. `benchmark/bench stack down` stops it.

### Run a few tasks first

This runs BobFlow on 2 KramaBench questions with GPT-5.6 Luna, for about a cent, and prints the accuracy and cost.

```bash
WAIT=1 ARMS=evidence_full_flow0 benchmark/campaign/launch.sh demo-kb Luna 1 2 archeology-easy-6 legal-easy-25
benchmark/bench report /var/tmp/bobflow-bench/runs/demo-kb
```

Each attempt keeps its prompt, every model request and response, the dataflow, the answer and its cost under
`/var/tmp/bobflow-bench/runs/demo-kb/system_scratch/`. The same small run for every benchmark and system is in
[benchmark/README.md](benchmark/README.md#one-small-run-per-benchmark-and-system).

### Reproduce a number from the paper

Each number in the paper is one model on one system. These two commands reproduce one: BobFlow with the optimizations on
KramaBench, with GPT-5.6 Luna. The paper reports 72.1% at $0.30. Accuracy varies by about 2 points between runs, and cost
by about 5%.

```bash
ARMS=evidence_data1_flow0_opt_strict benchmark/campaign/launch.sh opt-kb-luna Luna 1 6
benchmark/bench report /var/tmp/bobflow-bench/runs/opt-kb-luna      # once the run has finished
```

The launcher returns at once and the run continues on its own. `python3 -I benchmark/campaign/alert.py opt-kb-luna` follows
it, with a line for each problem and when it ends.

These are the paper's numbers, as accuracy and the cost of one pass over the benchmark:

| Model | Tag | KramaBench, BobFlow | KramaBench, Script ReAct | PrepBench, BobFlow | PrepBench, Script ReAct |
|---|---|---|---|---|---|
| GPT-5.6 Luna | `Luna` | 72.1% $0.30 | 58.3% $0.40 | 83.3% $0.99 | 69.9% $1.21 |
| GPT-5.6 Terra | `Terra` | 68.3% $2.76 | 65.4% $6.99 | 86.3% $8.67 | 79.4% $24.56 |
| GPT-5.6 Sol | `Sol` | 73.1% $5.09 | 60.6% $10.22 | 88.6% $16.50 | 71.9% $45.97 |
| GPT-6.1 Sol | `Sol61` | 74.0% $1.67 | 75.0% $3.35 | 90.8% $6.33 | 90.5% $17.33 |
| Gemini 3.8 Flash | `Gemini38FlashVertex` | 78.8% $7.24 | 66.3% $11.27 | 89.5% $15.80 | 70.9% $40.87 |
| Gemini 4 Argon | `Gemini4ArgonMedium` | 72.1% $6.15 | 74.0% $11.68 | 91.5% $15.42 | 88.6% $33.41 |
| DeepSeek V4.1 Flash | `DeepSeek41Flash` | 69.2% $0.66 | 66.7% $0.62 | 88.9% $1.31 | 85.6% $1.40 |
| Claude Opus 5.5 | `Opus55` | 73.1% $4.35 | 74.7% $4.76 | 90.5% $16.89 | 90.2% $17.76 |

The BobFlow columns are the setting with the optimizations. The launchers run each of these cells, with `<tag>` from the
table:

```bash
ARMS=evidence_data1_flow0_opt_strict benchmark/campaign/launch.sh kb-<tag> <tag> 1 6       # KramaBench, BobFlow
ARMS=evidence_data1_flow0_opt benchmark/campaign/launch.sh kb-opus Opus55 1 6              # the same, for Opus
benchmark/campaign/launch-smol.sh smol-kb-<tag> <tag> 3 3                                  # KramaBench, Script ReAct
ARMS=evidence_data1_flow0_opt_strict benchmark/campaign/launch-prep.sh pb-<tag> <tag> 6    # PrepBench, BobFlow
ARMS=evidence_data1_flow0_opt benchmark/campaign/launch-prep.sh pb-opus Opus55 6           # the same, for Opus
benchmark/campaign/launch-prep-smol.sh smol-pb-<tag> <tag> 3                               # PrepBench, Script ReAct
```

The rest is in [benchmark/README.md](benchmark/README.md): the plain BobFlow and statistics settings, Flow Evidence, and
LongDS.

### Read results for free

These read files only. No model, judge or service runs.

```bash
S=/var/tmp/bobflow-bench/runs
benchmark/bench report $S/opt-kb-luna                       # accuracy and cost per model and setting
benchmark/bench compare $S/demo-kb $S/opt-kb-luna           # which tasks each one solves, and at what cost
benchmark/bench audit $S/opt-kb-luna                        # check that each attempt did what its setting says
```

### Measure the system's overhead

[benchmark/tracker/](benchmark/tracker/README.md) measures what keeping every version of the dataflow costs as a session
grows: the agent's memory, with the tracker and without it, and the time to jump to a version. It replays recorded runs, so
it calls no model.

Each attempt also records what it cost as it runs: tokens, money, steps and time per attempt (`stats.json`, per-step timers
in `react_steps.json`), and the machine's load and memory every 15 seconds (`host-resources.jsonl`). The paper's overhead
of collecting statistics was measured on the `study/stats-overhead` branch, whose instrumentation is not on this one.

## 4. Tests

None of these calls a model.

| Command | What it covers | Takes |
|---|---|---|
| `benchmark/bench test` | The benchmark harness | under a minute |
| `(cd agent-service && bun test && bun run typecheck)` | The agent | 2 minutes |
| `(cd amber && ../.venv/bin/python -m pytest -m "not integration" src/test/python)` | The engine's Python workers | 1 minute |
| `(cd frontend && yarn test)` | The UI | under a minute |
| `bin/test-scala.sh` | Texera's Scala code, with a throwaway Postgres | 5 minutes |

With the stack up, these exercise the real system:

| Command | What it covers |
|---|---|
| `(cd agent-service && bun run e2e)` | Workflows through the engine, without the agent or a model |
| `(cd frontend && npx playwright install chromium && node e2e/agent-panel.e2e.mjs)` | The UI in a real browser: a new workflow opens a chat, the agent answers, settings, versions, a new chat. It calls Claude Haiku 5.5, a few cents |
| `(cd frontend && node e2e/agent-operator-actions.e2e.mjs)` | Run, Edit and Feedback on an operator, its versions and docs. `agent-dataflow-ux` and `agent-drop-upload` work the same way; `agent-jump` replays recorded runs instead of calling a model and needs the tracker's agent (its header says how) |

## 5. If something goes wrong

| What you see | Why, and what to do |
|---|---|
| An agent turn fails with `401` | A provider key in `.env` is missing or invalid. Fix it, then recreate the gateway: `bin/local-dev.sh down litellm && bin/local-dev.sh up litellm`, or `benchmark/bench stack down && benchmark/bench stack up` for the benchmark stack |
| The first run of a fresh stack fails with `iceberg_namespace_properties_pkey` | Two first executions raced to create the results catalog. It happens once. Run it again, or run `bin/local-dev.sh up computing-unit-master` |
| A service will not start | `bin/local-dev.sh logs <service>` |
| A benchmark run fails on missing packages after you ran `uv sync` | `uv sync` removes the extra packages the paper's engine had. Run `benchmark/bench setup base` again |

## 6. Where things are

| Folder | What is there |
|---|---|
| `agent-service/` | The agent: its loop, its tool, what the model reads |
| `native-mode/` | The system prompt and tool definition as the model receives them, generated from the code |
| `amber/` | Texera's engine and web app (Scala), and its Python workers |
| `common/`, `*-service/` | Texera's shared libraries and services |
| `frontend/` | The UI (Angular), and its browser tests in `frontend/e2e/` |
| `benchmark/` | [The harness](benchmark/README.md): `benchmark/bench`, the launchers in `campaign/`, the overhead experiments in `tracker/` |
| `smolagents-service/` | The script agent with a UI, for the user study |
| `bin/` | `local-dev.sh` and the deployment scripts |
| `sql/` | The database schema |
| `docs/` | [The launcher](docs/local-dev-with-agent.md), [the tool's design](docs/native-registered-python-design.md), [result views](docs/retrieval-views.md), and Texera's upstream docs |

This fork tracks [apache/texera](https://github.com/apache/texera). For the platform itself, see
[Texera's site](https://texera.apache.org/).
