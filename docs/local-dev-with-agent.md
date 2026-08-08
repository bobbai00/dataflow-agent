# Launching Texera + the Dataflow Agent with `bin/local-dev.sh`

This is the one-command path to a full local Texera stack — infra in Docker,
JVM services + frontend + agent-service native — on the `stable` branch
(`feat/turn-resume` merged with `bobbai00/texera` `main`).

## Prerequisites

| Requirement | Check |
|---|---|
| JDK 17, sbt | `java -version`, `sbt --version` |
| Docker + compose v2 | `docker compose version` |
| Bun (agent-service) | `bun --version` |
| Node 24 + yarn (frontend) | `node --version` |
| Python venv at `.venv/` | `uv sync --all-extras` (from repo root) |

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

Note: `bun run e2e:errors` asserts the OLD engine-side error format
(`Operator code:` + `>`-marked line echoed by the worker). The current design
sends exception + line pointer from the engine and lets the agent-service
append the operator code from `operatorProperties`, so that suite's
expectations are stale on `feat/turn-resume` too — not a regression of this
merge.

### Context parameters (tuning knobs)

Passed as `settings` on agent creation (`POST /api/agents/`) or via
`PATCH /api/agents/:id/settings`:

| Knob | Values | What it does |
|---|---|---|
| `contextMode` | `latest` \| `delta` | LATEST = task + current snapshot only; DELTA = full event trajectory |
| `contextWindowTokens` | int (0 = unbounded) | DELTA budget; overflow triggers compaction |
| `compactionStrategy` | `compress` \| `sliding` | fold old events into a stats deck vs. evict oldest |
| `deckSampleRatio` | 0..1 (default 0.10) | fraction of folded operators' rows kept as a peek |
| `maxResultRows` | int | rows rendered per operator result |
| `columnStats` | bool | per-column stats block on each result (suppressed by design when the complete small table is already visible in the context) |
| `thoughtReplay` / `thoughtReplayK` | bool / int | LATEST `# Reasoning` block of last K events |
| `turnHistory` | `full` \| `index` | prior turns verbatim vs. compact catalogue |
| `indexDetailedOperators` | int | how many operators keep full index entries |
| `indexRichTables` | int | how many upstream operators render sample rows |
| `flowLevel` / `dataLevel` | int | flow/data annotation rungs |

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
