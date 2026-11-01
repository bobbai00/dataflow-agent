# Launching Texera + the Dataflow Agent with `bin/local-dev.sh`

One command brings up the full local stack: infra in Docker; the JVM
services, the agent-service and the frontend natively on the host. This page
covers what the agent needs, the checks, and troubleshooting. The launcher's
own reference (platforms, layout, its tests) is
[bin/local-dev/README.md](../bin/local-dev/README.md);
`bin/local-dev.sh --help` lists every subcommand and flag.

## Prerequisites

| Requirement | Check or set up |
|---|---|
| JDK 17, sbt | `java -version`, `sbt --version` (the launcher finds a JDK 17 itself) |
| Docker with Compose **v2.20+** | `docker compose version` (older plugins reject the `--progress` flag the launcher passes) |
| Bun (agent-service) | `bun --version` |
| Node 24 + yarn (frontend) | `node --version` |
| Python venv at `.venv/` | `uv sync --all-extras` (from the repo root) |
| Generated Python protos | `ls amber/src/main/python/proto/`; if missing: `source .venv/bin/activate && bash bin/python-proto-gen.sh` |
| Repo-root `.env` | `cp .env.example .env`, then the provider keys you use |
| `agent-service/.env` | `cp agent-service/.env.example agent-service/.env` |

`bin/python-proto-gen.sh` needs `protoc` and the betterproto plugin on PATH.
Inside the venv, `uv sync --all-extras` provides both, except `protoc` on
Apple Silicon macOS (`brew install protobuf`).

The engine's Python workers run under `UDF_PYTHON_PATH`. The launcher sets it
to `.venv/bin/python` when that exists, otherwise to the `python3` on PATH,
which usually lacks `loguru` / `pyarrow` and breaks every execution.

`agent-service/.env` points the agent at the natively running file service
(:9092) and computing-unit manager (:8888); without it both default to
texera-web (:8080).

Two setup mistakes surface far from their cause. Rule them out first:

- **Missing Python protos.** `amber/src/main/python/proto/` is generated and
  gitignored, so a fresh clone has none. Every Python worker then dies at
  import and executions never report back: agent turns hang until the
  4-minute execution timeout instead of showing an import error. Generate the
  protos as above, and again after any `.proto` change. (amber's sbt compile
  also runs `bin/python-proto-gen.sh` when `protoc` and
  `protoc-gen-python_betterproto` are on PATH, e.g. when the launcher runs from
  an activated venv; otherwise it logs a warning and skips it.)
- **`GUI_WORKFLOW_WORKSPACE_COPILOT_ENABLED` missing from the root `.env`.**
  `gui.conf` ships `copilot-enabled = false`. The native JVMs read the root
  `.env` (the launcher exports it); `bin/single-node/.env` reaches only the
  Docker containers. Without the line, access-control-service answers every
  `/api/chat/*` and `/api/models` request with
  `403 {"error": "Copilot feature is disabled"}`, and every agent turn fails
  at its first model call. `.env.example` sets it.

## Launch

From the repo root:

```bash
bin/local-dev.sh up
```

That command:

1. brings up the Docker infra under compose project `texera-local-dev`
   (`bin/single-node/docker-compose.yml` plus
   `bin/local-dev/docker-compose.override.yml`, which publishes the ports):
   postgres, minio, lakefs and litellm, plus lakekeeper when
   `STORAGE_ICEBERG_CATALOG_TYPE=rest`;
2. reconciles the postgres schema: a fresh database is bootstrapped from
   `sql/texera_ddl.sql`, and pending `sql/updates/*.sql` listed in
   `sql/changelog.xml` are applied through liquibase, so jOOQ codegen sees the
   schema the code expects;
3. runs `sbt dist`, `yarn install` and `bun install` when sources or lock
   files changed since the last build (`--build` forces the build, `--fresh`
   runs `sbt clean dist`, `--skip-build` skips it), then starts every JVM
   service;
4. starts the agent-service (`bun run dev`, which reloads on source changes)
   and the frontend (`yarn start`, which runs `ng serve`).

Workflow results use the postgres Iceberg catalog by default: catalog rows in
the `texera_iceberg_catalog` database, files under
`amber/user-resources/workflow-results`, so nothing depends on the host's LAN
IP. `STORAGE_ICEBERG_CATALOG_TYPE=rest` switches to Lakekeeper on MinIO, which
does (see Troubleshooting).

### Services and ports

| Service | Port |
|---|---|
| config-service | 9094 |
| access-control-service (LLM gateway) | 9096 |
| file-service | 9092 |
| workflow-compiling-service | 9090 |
| computing-unit-managing-service | 8888 (API), 8082 (admin; what `status` probes) |
| texera-web | 8080 |
| computing-unit-master | 8085 |
| agent-service | 3001 (`TEXERA_AGENT_SERVICE_PORT`) |
| frontend | 4200 |
| Docker: postgres, minio, lakefs, litellm | 5432, 9000, 8000, 4000 |
| Docker: lakekeeper (REST catalog only) | 8181 |

Day to day:

```bash
bin/local-dev.sh status            # one-shot table (also what a bare bin/local-dev.sh prints)
bin/local-dev.sh status --json     # machine-readable; exit 0 iff every service is running
bin/local-dev.sh logs <service>    # tail one service's log
bin/local-dev.sh auto              # rebuild and bounce only the services whose source changed
bin/local-dev.sh up <service>      # start one service; rebuild and bounce it if its source changed
bin/local-dev.sh down [<service>]  # stop everything, or one service
```

To restart a running service as it is:
`bin/local-dev.sh down <service> && bin/local-dev.sh up <service> --skip-build`.
Logs, PIDs and build stamps live under `/tmp/texera-local-dev/`
(`TEXERA_LOCAL_DEV_DIR` moves them); `logs/` holds one `<service>.log` per
service plus `sbt-dist.log`, `yarn-install.log` and `bun-install.log`.

### LLM gateway

The browser and the agent never hold a provider key. The agent calls the
access-control-service gateway at `LLM_ENDPOINT` (default
`http://localhost:9096`) with the user's Texera JWT; the gateway forwards
`POST /api/chat/<route>` and `GET /api/models` to `LITELLM_BASE_URL` with
`LITELLM_MASTER_KEY` attached (`common/config/src/main/resources/llm.conf`).

- **Default: the local LiteLLM container** (`litellm`, :4000). It serves the
  models in `bin/single-node/litellm-config.yaml` with the provider keys from
  the root `.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
  `GEMINI_API_KEY`); only the providers you call need keys. The launcher
  defaults `LITELLM_BASE_URL=http://localhost:4000` and
  `LITELLM_MASTER_KEY=sk-texera-internal-do-not-share`, and the container gets
  the same key.
- **Optional: an external gateway**, such as the DKNet-hosted LiteLLM. Set both
  values in the root `.env` (or export them; exported values win):

  ```bash
  LITELLM_BASE_URL=https://texera.dknet-ai.org/litellm
  LITELLM_MASTER_KEY=<DKNet master key, from the deployment owner>
  ```

  then restart access-control-service. Nothing else changes; the local
  LiteLLM container still starts but goes unused.

The panel starts every new chat on `claude-haiku-5.5`, so the gateway should
offer it (on the local LiteLLM it needs `ANTHROPIC_API_KEY`).
`GET /api/models` on :9096 (with a Texera JWT) lists what a gateway offers.

### Other checkouts

- `bin/local-dev.sh up --worktree=PATH` (or `--branch=NAME`: the worktree that
  has NAME checked out) deploys a sibling worktree's code with this checkout's
  launcher. Later `status`, `logs`, `down`, `up <service>` and `auto` follow
  that deployment until a plain `up`. Changes the target makes to
  `bin/local-dev/` do not apply; the launcher warns when it sees them.
- A second agent-service next to the running stack: set
  `TEXERA_AGENT_SERVICE_PORT` (e.g. 3008) in that worktree's repo-root `.env`
  and give it its own launcher state directory:

  ```bash
  TEXERA_LOCAL_DEV_DIR=/tmp/texera-local-dev-3008 bin/local-dev.sh up agent-service
  ```

  The launcher passes the port to Bun and uses it for status, health checks
  and stopping; keep the same `TEXERA_LOCAL_DEV_DIR` for later commands. The
  agent process and its logs are separate; the JVM services and Docker infra
  stay shared. The frontend's proxy (`frontend/proxy.config.json`) still sends
  `/api/agents` to :3001.
- Fully isolated stacks (own ports, containers and volumes, through
  `TEXERA_LOCAL_DEV_PROFILE` and `TEXERA_LOCAL_DEV_PORT_OFFSET`) are set up as
  in [benchmark/campaign/README.md](../benchmark/campaign/README.md).

## The agent

The agent-service (:3001) writes every agent's turns, steps, versions,
executions and results to one SQLite database as they happen:
`logs/agent-service/traces.db` at the repo root (`AGENT_TRACE_DB` names
another path; `off` disables it). After a restart, opening a workflow in the
frontend restores the user's agents on it, version trees included.
[README.md](../README.md) §2 shows the REST loop.

### The panel

The agent panel is always open. Opening a workflow that has an agent shows its
chat. For one without, the panel starts a chat with `claude-haiku-5.5`, agent
name "Bob", as soon as a computing unit runs; when `/api/models` does not list
that model or the start fails, it asks for a model instead (an unsaved
workflow also asks). Agents made in the UI have `operatorDoc: true`. "Start a
new chat" deletes the workflow's agent with its messages and versions, keeps
the dataflow on the canvas, and starts a new chat. Code:
`frontend/src/app/workspace/component/agent/agent-panel/`.

Files dropped on the panel are uploaded to the user's `agent-uploads` dataset
and attached to the message as chips showing their dataset paths
(`/ownerEmail/datasetName/vN/file`); the sent message carries the paths.
Native `scan` and registered-function settings read such paths. A computing
unit holds no user credential, so before each execution the agent-service has
the file service resolve the dataset paths an operator names (with the user's
token, which also checks access) to short-lived download links that travel
with that request only; the worker copies each file into a local cache once.
See `agent-service/src/agent/tools/dataset-files.ts`.

### Running and editing operators from the canvas

Selecting an operator the agent built opens its panel on the canvas, with Run,
Edit, Feedback and Explain; the property editor stays closed for it. Run and
Edit go through the agent, which applies each as one of its own `dataflow`
calls and records it as a user step (`messageSource: "action"`); the chat
shows it as, e.g., "You edited `kept` and ran it · 1 row". A run is answered
by the agent in a turn of its own; a plain edit is read at its next turn.
Feedback is a message to the agent and starts a turn. Explain asks the agent
to explain the operator from its result; the answer shows in the panel and in
the chat. See `agent-service/src/agent/user-actions.ts`,
`TexeraAgent.applyUserAction` and
`frontend/src/app/workspace/component/agent/agent-interaction/`.

### Versions

Every action on the dataflow is a version, numbered from v0 (the dataflow the
agent started from): each `set` or `delete` in a `dataflow` call, each
execution and each read of results, from the agent's calls and from canvas
actions alike. A call that adds two operators and shows the second makes four
versions: add, add, run, show (`VersionAction` in
`agent-service/src/agent/workflow-snapshot-storage.ts`; `editVersions` in
`agent-service/src/agent/tools/graph-edits.ts` splits a call's edits). The
version tree lists each version under its verb. Clicking a version checks it
out: a step's newest version moves HEAD to that step; an earlier version
inside a call is restored as a user step the agent reads
(`TexeraAgent.checkoutVersion`, `POST /api/agents/:id/checkout-version`).
Playback previews versions without moving HEAD.

### Agent settings

Settings go in `settings` on `POST /api/agents/` or in
`PATCH /api/agents/:id/settings`. The accepted keys are `AGENT_SETTINGS_SCHEMA`
in `agent-service/src/server.ts`; the defaults are `DEFAULT_AGENT_SETTINGS` in
`agent-service/src/types/agent.ts`. The panel's settings modal sets data and
flow evidence, operator doc, instructions, the result character limit, the
execution timeout and the step budget.

| Setting | Default | What it sets |
|---|---|---|
| `maxSteps` | `100` | steps per turn |
| `executionTimeoutMinutes` | `4` | per workflow execution |
| `retrievalViews` | `["sample_stats", "full"]` | the views `show result` may use; `["full"]` alone turns data statistics off |
| `maxOperatorResultCharLimit` | `2000` | characters of schema and sample rows in a `sample_stats` view; data statistics and flow facts each have their own 2,000-character budget |
| `maxResultRows` | `3` | sample rows in a `sample_stats` view; `0` leaves only the character limit |
| `fullResultCharLimit` | `5000` | characters a `full` view shows (128 to 100,000) |
| `flowEvidence` | `false` | version-matched input/output facts (rows kept, keys matched) on observed results |
| `dataEvidence` | `true` | historical switch: `retrievalViews` and the requested view decide whether results carry data statistics |
| `nativeProfileCollection` | `true` | the engine collects the counters behind statistics and flow facts; compiled into each operator, so it changes only on a fresh agent and workflow |
| `operatorDoc` | `false` (`true` for agents made in the UI) | a one-line `doc` on every operator; the canvas and the operator panel show it |
| `instructions` | `""` | appended to the system prompt (up to 20,000 characters) |
| `multiRequest` | `"off"` | `"transcript"`: a later request follows the whole earlier transcript; set before the first request |
| `contextMode` | `"delta"` | the only value |
| observation format | see `DEFAULT_OBSERVATION_FORMAT` | `tableFormat` (`markdown`), `keyValueColumns` (`12`), `fullPreviewRows` (`0`), and `optionalPython`, `dataHygiene`, `pandasRound`, `compactRecords`, `answerOnlyReply` (all `false`); `agent-service/src/agent/native/observation-format.ts` |

A key that is not a setting is refused with HTTP 400 and
`{"error": "<key> is not a setting"}`, on create and on PATCH, and nothing
changes. Retired keys get the same answer: `agentMode`, `thoughtReplay`,
`messageLayout`, `toolDialect`, `staticCompaction`, `compactionStrategy`,
`nativeTransport`, `columnStats` and the others
`agent-service/src/server.test.ts` lists. Invalid values and combinations are
a 400 as well, among them `optionalPython` with a non-Claude model, a
`nativeProfileCollection` change once the workflow has operators, and a
`multiRequest` change after the first request.
[docs/retrieval-views.md](retrieval-views.md) describes the views.

## Checks

### Engine round trips (from `agent-service/`)

```bash
bun run e2e          # 6 workflows straight through the engine
bun run e2e:errors   # 4 workflows that fail by design: the worker's error format
```

Neither makes a model call or needs the agent-service running. Both log in as
`texera` / `texera` by default (`TEXERA_USERNAME`, `TEXERA_PASSWORD`), create a
local computing unit, execute through the JVM services, and delete what they
made.

- `bun run e2e` (`benchmark/e2e/run.ts`) uploads the files the example
  workflows read (`benchmark/e2e/data/`) into fresh datasets, then runs the 2
  example workflows in `benchmark/e2e/workflows/` and the 4 `[PythonOps]`
  workflows in `benchmark/e2e/python-operator-workflows.ts`, whose strict
  validators check DataLoading / DataProcessing port-to-parameter mapping.
- `bun run e2e:errors` (`benchmark/e2e/error-run.ts`) checks that each failing
  operator's error carries the exception type and a ``(line N) `source` -``
  pointer whose source is the offending statement.

### Probes against a running agent-service (from `agent-service/`)

These need the stack and an agent-service running this checkout
(`TEXERA_AGENT_SERVICE_ENDPOINT`, default `http://localhost:3001`). Each writes
its artifacts to a new temp directory.

| Command | Model calls | What it checks |
|---|---|---|
| `bun benchmark/e2e/registered-python-run.ts` | none | registered-Python probes through the engine, each one `dataflow(python, statements)` call sent as debug input |
| `bun benchmark/e2e/process-input-run.ts` | none | registered Python inputs through the engine transport: nullable and extreme integers, reshaped and empty tables |
| `bun benchmark/e2e/file-io-probe.ts` | none | a registered loader may read a file with `open()` |
| `bun benchmark/e2e/sandbox-escape-probe.ts <repo root>` | none | model-written Python cannot read the repository; run against an engine whose `UDF_PYTHON_PATH` is `benchmark/retrieval/native_isolated_python.py` |
| `bun benchmark/e2e/dataflow-actions-run.ts` | one live task (`TEXERA_AGENT_MODEL`, default `gpt-5.6-luna`); `--probes-only` skips it | `dataflow` call and cache checks |
| `bun benchmark/e2e/demo/demo-driver.ts benchmark/e2e/demo/<scenario>.json` | every turn | a multi-turn demo through the REST API that keeps the agent and workflow for the frontend; set `AGENT_BASE`, `DEMO_USER`, `DEMO_PASSWORD`, `DEMO_CUID` and `PROBE_MODEL` for your stack |

### Real-browser checks (from `frontend/`, Playwright)

With the stack up:

| Command | What it checks |
|---|---|
| `node e2e/agent-panel.e2e.mjs` | the panel open on arrival and its chat starting by itself (Bob, Claude Haiku 5.5); streamed steps, canvas highlight, the settings modal; checkout and branching in the version tree; "Start a new chat" |
| `node e2e/agent-operator-actions.e2e.mjs` | Run, Edit and Feedback from an operator's panel; a refused edit; a version per action; operator docs on the canvas |
| `node e2e/agent-dataflow-ux.e2e.mjs` | the dataflow appearing one action at a time; the operator panel's data section; runs from the panel with cached results; feedback from the panel and the chat |
| `node e2e/agent-drop-upload.e2e.mjs` | drag and drop into the `agent-uploads` dataset, file chips, and a turn that loads the file (`SKIP_AGENT_TURN=1` skips the turn) |
| `node e2e/agent-jump.e2e.mjs` | jumping between versions without a model, on conversations replayed by `benchmark/tracker/replay-dataflow.ts` through an agent-service started by `benchmark/tracker/start-agent.sh`; its header lists the variables it needs |

The first four create their own computing unit and workflow and run on
`claude-haiku-5.5`; `PROBE_MODEL` picks another model, except in
`agent-panel.e2e.mjs`, whose chat the panel starts. `study-open-agent.mjs`,
`study-operator-panel.mjs` and `study-import-archive.mjs` check prepared
user-study workflows and save screenshots; each takes a workflow id (see its
header).

## Troubleshooting

- **Every execution fails with `AskTimeoutException` on `/user/cluster-info`**:
  the Python workers crash at startup. Look for `ModuleNotFoundError` in
  `/tmp/texera-local-dev/logs/computing-unit-master.log`; if it is there,
  `UDF_PYTHON_PATH` points at a Python without the engine's packages. Run
  `uv sync --all-extras`, then restart `computing-unit-master` and
  `texera-web` (`bin/local-dev.sh down <service> && bin/local-dev.sh up <service> --skip-build`).
- **Agent turns fail at their first model call with 403**:
  `GUI_WORKFLOW_WORKSPACE_COPILOT_ENABLED` is missing (see Prerequisites).
- **Agent LLM calls 404**: `LLM_ENDPOINT` must be `http://localhost:9096`
  (access-control-service), not texera-web.
- **Model calls fail with an authentication error**: the master key
  access-control-service sends does not match the gateway's, or the gateway
  has no provider key for the model (the key that model's entry in
  `bin/single-node/litellm-config.yaml` names). The LiteLLM container reads
  its keys when it is created: after editing `.env`, run
  `bin/local-dev.sh down litellm && bin/local-dev.sh up litellm`.
  access-control-service reads `LITELLM_BASE_URL` / `LITELLM_MASTER_KEY` when
  it starts: restart it after changing them.
- **The panel shows no chat, or asks for a model**: it starts a chat only once
  the selected computing unit runs ("Waiting for a computing unit to start
  the chat…"), and asks for a model when the gateway does not list
  `claude-haiku-5.5` or the start fails.
- **`sbt dist` fails on missing jOOQ classes** (`not found: value SITE_SETTINGS`,
  `FEEDBACK`, …): jOOQ codegen reads the postgres schema at compile time, and
  the generated sources are not tracked. Build through `bin/local-dev.sh up`,
  which brings postgres up and reconciles its schema first, and check that the
  infra step succeeded (`docker compose -p texera-local-dev ps`).
- **Executions fail after a network change (REST catalog only)**: with
  `STORAGE_ICEBERG_CATALOG_TYPE=rest`, MinIO's endpoint is the host's LAN IP,
  baked into Lakekeeper's warehouse profile and into every running JVM's
  `STORAGE_S3_ENDPOINT`. When the IP changes, executions fail while every
  service still reports running; `bin/local-dev.sh status` warns that the S3
  endpoint is stale. Fix, keeping the Docker volumes:
  `bin/local-dev.sh down && bin/local-dev.sh up --skip-build`. Permanent fix:
  `echo '127.0.0.1 texera-minio' | sudo tee -a /etc/hosts`; the launcher then
  uses `http://texera-minio:9000`, which does not depend on the IP. Keep
  `STORAGE_ICEBERG_CATALOG_TYPE=rest` in the root `.env` rather than on one
  command line: `status` checks the endpoint only in that mode, and an `up`
  without it returns to the postgres catalog, which involves no LAN IP.

  Executions the dead endpoint left in RUNNING (status 1) can be marked KILLED
  (status 5):

  ```bash
  docker exec texera-postgres psql -U texera -d texera_db -c \
    "UPDATE texera_db.workflow_executions SET status = 5 WHERE status = 1 AND starting_time < now() - interval '30 minutes';"
  ```
