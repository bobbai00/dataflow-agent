# Texera — Local Development Setup

A succinct, end-to-end guide to running Texera locally: the **JVM backend services**
(+ the Amber execution engine), the **agent-service**, and the **Python UDF
environment**.

For IDE-based / deeper setup see
[`docs/contribution-guidelines/guide-for-developers.md`](docs/contribution-guidelines/guide-for-developers.md);
for the architecture map see [`AGENTS.md`](AGENTS.md). All commands run from the
**repo root** unless noted.

## Prerequisites

| Tool | Version | Used for |
|---|---|---|
| **JDK** | **17** | Scala/sbt services (Kryo/Arrow/Pekko require the JDK 17 `--add-opens` flags, already in `.jvmopts`) |
| **sbt** | 1.x (project pins **1.12.9**) | build + run the JVM services |
| **Bun** | ≥ 1.3 | agent-service + e2e suite |
| **uv** | ≥ 0.11 | Python UDF environment |
| **Python** | **3.12** (`.python-version`; `pyproject` requires `>=3.10`) | UDF runtime (managed by uv) |
| **Docker** | recent | PostgreSQL/PGroonga, LakeFS, MinIO |

> Node ≥ 20 is only needed for the Angular frontend — see [`frontend/README.md`](frontend/README.md).

## 1. Infrastructure

### a. PostgreSQL + PGroonga — `texera_db` on port **5432**

Texera stores user data and system metadata in PostgreSQL with the
[PGroonga](https://pgroonga.github.io/) full-text extension, on `localhost:5432`,
database `texera_db`. Defaults are `postgres` / `postgres`, configured in
`common/config/src/main/resources/storage.conf` (`storage.jdbc`).

```bash
# macOS
brew install postgresql pgroonga      # or run a groonga/pgroonga Docker image exposing :5432
```

Load the schema:

```bash
psql -U postgres -f sql/texera_ddl.sql               # creates texera_db + tables
psql -U postgres -f sql/iceberg_postgres_catalog.sql # Iceberg result-storage catalog
```

> ⚠️ **jOOQ code generation runs at compile time and introspects `texera_db`.**
> The database must be **up and schema-loaded before `sbt compile`**, or the build
> fails with `value <TABLE> is not a member of ...jooq.generated.Tables`. When you
> add a table to `sql/texera_ddl.sql`, apply it to the live DB and recompile so the
> jOOQ classes regenerate. (On codegen failure the build silently reuses stale
> generated sources, so a clean rebuild may need
> `rm -rf common/dao/src/main/scala/org/apache/texera/dao/jooq/generated`.)

### b. LakeFS + MinIO — dataset / object storage

```bash
docker compose -f file-service/src/main/resources/docker-compose.yml up -d
```

Starts MinIO (`:9000` API / `:9001` console), LakeFS (`:8000`), and LakeFS's own
backing Postgres. These are **stateful** — leave them running between sessions to
skip the warm-up.

## 2. Python UDF environment

```bash
uv sync --all-extras      # creates .venv/ with the pinned Python + all UDF deps
```

`common/config/src/main/resources/udf.conf` points Texera at this `.venv/`. If your
interpreter lives elsewhere, set `python.path` there (`which python`).

## 3. Build

```bash
sbt compile
```

Compilation auto-runs the **protobuf** and **jOOQ** source generators (jOOQ needs
the DB from step 1a). The first build downloads dependencies and takes a while.

## 4. Run the backend services

sbt's per-checkout project lock means only **one** sbt build runs at a time from a
checkout. To run all 8 services concurrently, use the single background launcher:

```bash
GUI_WORKFLOW_WORKSPACE_COPILOT_ENABLED=true \
sbt --no-colors -Dsbt.supershell=false --batch \
  'compile' \
  'ConfigService/bgRun' \
  'AccessControlService/bgRun' \
  'FileService/bgRun' \
  'ComputingUnitManagingService/bgRun' \
  'WorkflowCompilingService/bgRun' \
  'WorkflowExecutionService/bgRunMain org.apache.texera.web.ComputingUnitMaster' \
  'WorkflowExecutionService/bgRunMain org.apache.texera.web.ComputingUnitWorker' \
  'WorkflowExecutionService/bgRunMain org.apache.texera.web.TexeraWebApplication' \
  'bgList' \
  'bgWaitFor 1' 'bgWaitFor 2' 'bgWaitFor 3' 'bgWaitFor 4' \
  'bgWaitFor 5' 'bgWaitFor 6' 'bgWaitFor 7' 'bgWaitFor 8' \
  > logs/sbt-services.log 2>&1
```

The trailing `bgWaitFor` lines keep the sbt process alive; kill it to stop every
forked service. Tail `logs/sbt-services.log`; the stack is ready when ports
`9094 9096 9092 8888 9090 8085 8080` are all listening.

`GUI_WORKFLOW_WORKSPACE_COPILOT_ENABLED=true` is required for agent-service and
KramaBench runs that call the LLM through AccessControlService. Without it,
`POST /api/chat/completions` returns `403 {"error": "Copilot feature is disabled"}`
and the benchmark trace usually ends immediately with `Error: Forbidden`.

Or run one service per terminal:

| Service | Port | Command |
|---|---|---|
| ConfigService | 9094 | `sbt ConfigService/run` |
| AccessControlService | 9096 | `sbt AccessControlService/run` |
| FileService | 9092 | `sbt FileService/run` |
| ComputingUnitManagingService | 8888 | `sbt ComputingUnitManagingService/run` |
| WorkflowCompilingService | 9090 | `sbt WorkflowCompilingService/run` |
| ComputingUnitMaster | 8085 | `sbt 'WorkflowExecutionService/runMain org.apache.texera.web.ComputingUnitMaster'` |
| ComputingUnitWorker | _(pekko, no HTTP port)_ | `sbt 'WorkflowExecutionService/runMain org.apache.texera.web.ComputingUnitWorker'` |
| TexeraWebApplication | 8080 | `sbt 'WorkflowExecutionService/runMain org.apache.texera.web.TexeraWebApplication'` |

> `ComputingUnitMaster` must be up before `ComputingUnitWorker`.

## 5. Agent service (Bun, port 3001)

```bash
cp agent-service/.env.example agent-service/.env   # defaults already match the service ports
cd agent-service
bun install
bun run dev                                         # http://localhost:3001
```

Key `.env` values:

- `LLM_ENDPOINT` — the LLM gateway/proxy (default `http://localhost:9096`).
- `LLM_API_KEY` — authenticates **to the gateway**, not the upstream provider; `dummy` works when the gateway enforces no key.
- `*_SERVICE_ENDPOINT` — URLs of the JVM services above.

To enable the in-GUI AI copilot, set `copilot-enabled = true` in
`common/config/src/main/resources/gui.conf`.

### AI copilot → LiteLLM gateway (DKNet-2)

The GUI AI copilot calls AccessControlService (`:9096`), which proxies its
chat/model requests to a LiteLLM gateway configured in
`common/config/src/main/resources/llm.conf` (`base-url` + `master-key`, each
overridable via the `LITELLM_BASE_URL` / `LITELLM_MASTER_KEY` env vars).

**To use the DKNet-2 server's LiteLLM**, export these before launching the JVM
services (the forked service JVMs inherit the environment) — this keeps the
secret key out of git rather than hard-coding it in `llm.conf`:

```bash
export LITELLM_BASE_URL="https://texera.dknet-ai.org/litellm"
export LITELLM_MASTER_KEY="<dknet-2 master key — obtain from the deployment owner>"
```

The proxy routes (`/api/chat`, `/api/models`) require an authenticated
REGULAR/ADMIN user and `copilot-enabled = true` (above); otherwise they return
`403`.

## 6. Verify end-to-end

The agent-service e2e suite drives auth + workflow CRUD + dataset upload + execution
against the live JVM backends (it talks to them directly — `bun run dev` need not be
running):

```bash
cd agent-service
bun run e2e          # happy-path: general + Python-UDF code + code-mode workflows
bun run e2e:errors   # runtime-error reporting format
```

A green run ends with `E2E pipeline finished successfully.`

### KramaBench one-task validation

Use this when validating the full native stack that KramaBench drives:

```bash
# 1. Confirm JVM services, agent-service, and LiteLLM are listening.
ss -ltnp | rg ':8080|:8085|:8888|:9090|:9092|:9094|:9096|:3001|:4000'

# 2. Health checks.
for u in \
  http://localhost:9094/api/healthcheck \
  http://localhost:9096/api/healthcheck \
  http://localhost:9092/api/healthcheck \
  http://localhost:8888/api/healthcheck \
  http://localhost:9090/api/healthcheck \
  http://localhost:8085/api/execution/health \
  http://localhost:8080/api/healthcheck \
  http://localhost:3001/api/healthcheck; do
  printf '%s ' "$u"; curl -fsS "$u"; printf '\n'
done

# 3. Smoke-test the LLM proxy through AccessControlService using the same
# login path as KramaBench.
TOKEN=$(
  curl -fsS -X POST http://localhost:8080/api/auth/login \
    -H 'Content-Type: application/json' \
    -d '{"username":"texera","password":"texera"}' |
    python3 -c 'import sys,json; print(json.load(sys.stdin)["accessToken"])'
)
curl -fsS -X POST http://localhost:9096/api/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.2","messages":[{"role":"user","content":"Say pong."}],"max_tokens":16}'

# 4. Run one benchmark task.
cd ../Kramabench
python3 kb.py tasks \
  --sut DataflowSystemGPT52DeltaStats5k \
  --ids "archeology-easy-10" \
  --isolate \
  --watchdog-min 5
```

Expected single-task sanity result:

| Artifact | Expected |
|---|---|
| Task answer | `Singapore` |
| Per-task score | `100.0` |
| Trace path | `../Kramabench/system_scratch/DataflowSystemGPT52DeltaStats5k/archeology-easy-10/react_steps.json` |
| Task log | `../Kramabench/logs/kb-tasks-*/archeology-easy-10.log` |

The partial-run re-evaluation rebuilds the whole workload cache from every
per-task scratch answer, so its aggregate workload score can reflect older
scratch files. For a stack sanity check, trust the fresh task log plus
`system_scratch/.../answer.json`, `stats.json`, and `evaluation.json`.

A healthy trace for `archeology-easy-10` has four steps:

1. User task prompt.
2. `createOrModifyOperator` for `worldcities`, loading
   `data/archeology/input/worldcities.csv`.
3. `createOrModifyOperator` for `country_avg_pop`, linked from `worldcities`.
4. `Final Answer: Singapore`.

## 7. Stop

```bash
# agent-service (port 3001)
kill "$(lsof -tiTCP:3001 -sTCP:LISTEN)" 2>/dev/null

# JVM services + sbt
pkill -f 'java @.*sbt-args'   # forked service JVMs
pkill -f sbt-launch.jar       # the sbt process

# infra (stateful — only for a clean slate)
docker compose -f file-service/src/main/resources/docker-compose.yml down
```

## Port reference

| Port | Service |
|---|---|
| 5432 | PostgreSQL / PGroonga (`texera_db`) |
| 8000 | LakeFS |
| 8080 | TexeraWebApplication |
| 8085 | ComputingUnitMaster |
| 8888 | ComputingUnitManagingService |
| 9000 / 9001 | MinIO API / console |
| 9090 | WorkflowCompilingService |
| 9092 | FileService |
| 9094 | ConfigService |
| 9096 | AccessControlService (also the agent-service `LLM_ENDPOINT` default) |
| 3001 | agent-service |

## Logs

- `logs/sbt-services.log` — combined output of the JVM services.
- `logs/agent-service.log` — agent-service (when redirected there).
