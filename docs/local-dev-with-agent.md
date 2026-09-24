# Launching Texera + the Dataflow Agent with `bin/local-dev.sh`

This is the one-command path to a full local Texera stack — infra in Docker,
JVM services + frontend + agent-service native — on the `stable` branch
(`feat/turn-resume` merged with `bobbai00/texera` `main`).

## Prerequisites

| Requirement | Check |
|---|---|
| JDK 17, sbt | `java -version`, `sbt --version` |
| Docker + compose **v2.20+** | `docker compose version` |
| Bun (agent-service) | `bun --version` |
| Node 24 + yarn (frontend) | `node --version` |
| Python venv at `.venv/` | `uv sync --all-extras` (from repo root) |
| `protoc` (any 3.2x) | `protoc --version` |
| Generated Python protos | `ls amber/src/main/python/proto/` |
| Repo-root `.env` | `cp .env.example .env` |

Three of these fail *silently* rather than loudly, so check them before
debugging anything else:

- **Compose older than 2.20** rejects the `--progress` flag this script passes.
  Infra reports "5 containers up" while nothing actually started, and the run
  dies later in `sbt dist` with `not found: value SITE_SETTINGS` — jOOQ codegen
  against a database that isn't there.
- **Missing Python protos.** `amber/src/main/python/proto/` is generated and
  gitignored, so a fresh clone has none, every UDF worker dies at import, and
  executions never signal. You see agent turns that hang until the engine's
  240 s timeout, not an import error. Fix:
  `source .venv/bin/activate && bash bin/python-proto-gen.sh`.
- **`GUI_WORKFLOW_WORKSPACE_COPILOT_ENABLED` unset.** It ships in
  `.env.example`; the natively-launched JVMs read the repo-root `.env`, and
  `bin/single-node/.env` reaches only the docker containers. Without it every
  `/api/chat/*` is `403 {"error": "Copilot feature is disabled"}`.

The Python venv matters: the engine's Python workers run under
`UDF_PYTHON_PATH`, and `bin/local-dev.sh` prefers `$REPO_ROOT/.venv/bin/python`
when it exists (falls back to system `python3`, which usually lacks `loguru` /
`pyarrow` and breaks every execution).

After pulling proto changes (e.g. the Controller→Coordinator rename),
regenerate the Python gRPC stubs once, inside the venv:

```bash
source .venv/bin/activate && bash bin/python-proto-gen.sh
```

## Launch

From the repo root:

```bash
# LLM gateway (LiteLLM at DKNet) — the access-control-service proxies
# /api/chat/* and /api/models to this gateway with the master key attached.
export LITELLM_BASE_URL="https://texera.dknet-ai.org/litellm"
export LITELLM_MASTER_KEY="<dknet master key>"

bin/local-dev.sh up
```

That single command:

1. brings up Docker infra (postgres, minio, lakefs, lakekeeper, litellm)
   under compose project `texera-local-dev`;
2. reconciles the postgres schema — fresh DB bootstrapped from
   `sql/texera_ddl.sql`, pending `sql/updates/*.sql` applied via liquibase —
   so jOOQ codegen sees the schema the code expects;
3. runs `sbt dist` and starts every JVM service;
4. starts the agent-service (`bun run --watch`, :3001) and the frontend
   (`ng serve`, :4200).

### Services and ports

| Service | Port |
|---|---|
| config-service | 9094 |
| access-control-service (LLM proxy) | 9096 |
| file-service | 9092 |
| workflow-compiling-service | 9090 |
| computing-unit-managing-service | 8082 |
| texera-web | 8080 |
| computing-unit-master | 8085 |
| agent-service | 3001 |
| frontend | 4200 |

Check state any time:

```bash
bin/local-dev.sh status          # one-shot dashboard
bin/local-dev.sh status --json   # machine-readable; exit 0 iff all running
bin/local-dev.sh logs <service>  # tail one service's log
bin/local-dev.sh down            # stop everything
```

Logs live under `/tmp/texera-local-dev/logs/<service>.log`.

### Separate agent worktrees

Agent-service worktrees can share the running Texera backend while using
different HTTP ports. Set `TEXERA_AGENT_SERVICE_PORT` in each worktree's
repo-root `.env`, and use a separate launcher state directory:

```bash
TEXERA_LOCAL_DEV_DIR=/tmp/texera-native-batch bin/local-dev.sh up agent-service --skip-build
```

The launcher passes that port to Bun and uses it for status, health checks,
and stopping the service. Keep the same state directory for later commands.
For example, use port 3008 in one worktree and 3009 in another. This isolates
agent processes and logs; JVM services and Docker infrastructure remain shared.

## The agent

The agent-service reads its backend endpoints from `agent-service/.env`
(copy `.env.example`) and reaches the LLM through the access-control-service
proxy (`LLM_ENDPOINT=http://localhost:9096`) — the browser and the agent never
hold a provider key; the proxy injects `LITELLM_MASTER_KEY` server-side.

Models available through the DKNet gateway: `claude-haiku-4.5` (cheap,
default for e2e), `claude-sonnet-4-6`, `gpt-5.4`, `local-llm`.

### Verifying end-to-end

```bash
cd agent-service
bun run e2e          # static workflows through the execution path
bun run e2e:agent    # REAL agent driving the LLM gateway (haiku by default)

# context-parameter smoke matrix (LATEST/DELTA, compaction, index caps):
bun run benchmark/e2e/context-tuning-run.ts
# multi-turn context FORMAT check (LATEST + DELTA assembled-context markers):
bun run benchmark/e2e/context-format-check.ts
```

Verified on this branch (2026-08-08, model `claude-haiku-4.5` via the DKNet
gateway):

| Suite | Result |
|---|---|
| `bun run e2e` (8 static workflows + strict validators) | 8/8 pass |
| `bun run e2e:agent` (16 real-agent specs) | 15/16 pass — T4 expects both operators in ONE parallel tool-call step; haiku emitted them sequentially (model behavior, DAG still correct) |
| context-tuning matrix (6 configs) | 6/6 pass, all reached the correct answer |
| context-format check (LATEST + DELTA, 2 turns) | all markers present |

Context-tuning matrix configs, all green: `latest` default;
`latest + columnStats + thoughtReplayK=3`; `delta` unbounded;
`delta + contextWindowTokens=8000 + compress + deckSampleRatio=0.25`;
`delta + contextWindowTokens=6000 + sliding`;
`delta + turnHistory=index + indexDetailedOperators=6 + indexRichTables=2`.

`bun run e2e:errors` checks the worker's error contract: the exception type
and a `(line N) \`source\` - ` pointer at the offending statement; the
agent-service appends the operator code from `operatorProperties` itself.
Native-mode smokes: `bun run benchmark/e2e/native-program-run.ts` (a program
through the real engine) and `bun run benchmark/e2e/native-errors-run.ts`
(every error layer rendered as the model sees it). Both need
`TEXERA_AGENT_SERVICE_ENDPOINT` pointing at the running agent-service.

### Agent settings (tuning knobs)

Passed as `settings` on agent creation (`POST /api/agents/`) or via
`PATCH /api/agents/:id/settings`. Defaults are `DEFAULT_AGENT_SETTINGS` in
`agent-service/src/types/agent.ts`; the README lists them.

| Knob | Values | What it does |
|---|---|---|
| `agentMode` | `native` (default) \| `code` | native: the model writes the dataflow as a `name = operator(...)` program (`dataflow` tool); code: one Python `load()`/`process()` operator per `createOrModifyOperator` call |
| `dataEvidence` | bool (default `false`) | `Data measurement` lines (null/distinct counts, ranges, top values) in observed results |
| `flowEvidence` | bool (default `false`) | `Flow measurement` / `Flow guarantee` lines (rows kept, keys matched, contracts) in observed results |
| `dataflowReasoning` | bool (default `false`) | native `dataflow` tool gains a required `reasoning` argument (why this call, what the observed tables should show), replayed with the call |
| `nativeProfileCollection` | bool (default `true`) | collect the counters behind both evidence kinds; fixed for the life of a workflow |
| `maxOperatorResultCharLimit` | int (default 2000) | per-result budget shared by schema, sample rows and enabled evidence |
| `maxOperatorResultCellCharLimit` | int (default 2000) | clip long cells |
| `contextMode` | `delta` (default) \| `latest` | DELTA = full event trajectory, append-only for the provider cache; LATEST = task + current snapshot |
| `messageLayout` | `native` (default) \| `block` \| `blockSplit` \| `turnSplit` \| `opSplit` \| `opBlock` | how the transcript is split into messages; `opSplit`/`opBlock` are LATEST layouts with one message per operator |
| `contextWindowTokens` | int (0 = unbounded) | DELTA budget; overflow triggers compaction |
| `compactionStrategy` | `compress` \| `sliding` | fold old events into a stats deck vs. evict oldest |
| `deckSampleRatio` | 0..1 (default 0.10) | fraction of folded operators' rows kept as a peek |
| `maxResultRows` | int (0 = no cap) | rows rendered per operator result |
| `maxSteps` | int (default 100) | per-turn step budget |
| `toolTimeoutSeconds` / `executionTimeoutMinutes` | int | per tool call / per workflow execution |
| `parallelToolCalls` | bool (default `true`) | provider-side parallel tool calls; forced off in native mode |
| `thoughtReplay` / `thoughtReplayK` | bool / int | recent reasoning re-injected (default on, K=10) |
| `turnHistory` | `full` \| `index` | prior turns verbatim vs. compact catalogue |
| `indexDetailedOperators` / `indexRichTables` | int | index caps for `turnHistory: index` |
| `seedSources` | bool (default `false`) | scan and observe the files passed as `sources` with the message before the first model call |
| `enableRecallTool` / `enableResumeTool` / `enableCompactTool` | bool (default `false`) | expose `recallState` / `resumeFrom` / `compactContext` |
| `disabledTools` | string[] | hide tools by name |

Retired knobs (`nativeToolMode`, `nativeCatalogVersion`, `allowedOperatorTypes`,
`columnStats`, `flowLevel`/`dataLevel`, `agentMode: "general"`) are rejected
with an error rather than mapped.

## Troubleshooting

- **Every execution fails with `AskTimeoutException` on `/user/cluster-info`**:
  the Python workers are crashing at startup. Check
  `/tmp/texera-local-dev/logs/computing-unit-master.log` for
  `ModuleNotFoundError` — if present, `UDF_PYTHON_PATH` points at a bare
  python. `uv sync --all-extras` and relaunch.
- **Agent LLM calls 404**: `LLM_ENDPOINT` must be `http://localhost:9096`
  (access-control-service), not texera-web.
- **`/api/chat/completions` 401 from the gateway**: `LITELLM_MASTER_KEY`
  missing/wrong, or you're on the docker-compose litellm (`localhost:4000`)
  which has no provider keys — export the DKNet values above and bounce
  `access-control-service`.
- **Runs hang in "running" / fail with no result after switching networks**
  (laptop moved Wi-Fi, VPN toggled): the MinIO endpoint is the HOST LAN IP,
  and it is baked into (a) the lakekeeper warehouse storage profile and
  (b) every running JVM's `STORAGE_S3_ENDPOINT`. lakekeeper logs show
  `tcp connect error: Connection refused` on `s3://texera-iceberg/...`.
  Fix: update the warehouse profile to the new IP, then bounce the JVMs —

  ```bash
  NEW_IP=$(ipconfig getifaddr en0)   # or your active interface
  WID=$(curl -s http://localhost:8181/management/v1/warehouse | python3 -c \
    "import json,sys; print(json.load(sys.stdin)['warehouses'][0]['id'])")
  curl -s -X POST "http://localhost:8181/management/v1/warehouse/$WID/storage" \
    -H 'Content-Type: application/json' -d "{
      \"storage-profile\": {\"type\":\"s3\",\"bucket\":\"texera-iceberg\",
        \"endpoint\":\"http://$NEW_IP:9000/\",\"region\":\"us-west-2\",
        \"path-style-access\":true,\"sts-enabled\":false,\"flavor\":\"s3-compat\",
        \"push-s3-delete-disabled\":true,\"remote-signing-enabled\":true,
        \"remote-signing-url-style\":\"auto\"},
      \"storage-credential\": {\"type\":\"s3\",\"credential-type\":\"access-key\",
        \"aws-access-key-id\":\"texera_minio\",\"aws-secret-access-key\":\"password\"}}"
  # then bounce each JVM: bin/local-dev.sh down <svc> && bin/local-dev.sh up <svc> --skip-build
  ```

  Executions left in a phantom RUNNING state by the dead S3 endpoint can be
  cleared with:

  ```sql
  UPDATE texera_db.workflow_executions SET status = 5  -- KILLED
  WHERE status = 1 AND starting_time < now() - interval '30 minutes';
  ```
