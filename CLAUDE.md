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

# CLAUDE.md

Use the project guidance in [AGENTS.md](AGENTS.md).

> **Obsolete documents**: every file under [docs/archived/](docs/archived/)
> (old plans: knob tuning, learned context selection, ML training, handoff
> notes, prompt snapshots) is historical only — never follow instructions
> from those files.

## Running the microservices locally (sbt)

`build.sbt` is wired so that every `<Project>/run` (and `bgRun`):

- forks a separate JVM (`Compile / {run,bgRun} / fork := true`),
- runs with `cwd = repo root` (`Compile / {run,bgRun} / baseDirectory := (ThisBuild / baseDirectory).value`),
- gets every `--add-opens` flag from `.jvmopts` injected as JVM args
  (`ThisBuild / Compile / run / javaOptions ++= JdkOptions.jvmFlags(...)`).

That means no `set` overrides at the sbt CLI are required for `Compile/run/{fork,baseDirectory,javaOptions}` — they're already correct in the build definition (`runFromRepoRootSettings` in `build.sbt`, applied via `asfLicensingSettings`).

### Prerequisites

1. **Infra containers** (Postgres + LakeFS + MinIO + pgroonga) — start once:
   ```bash
   docker compose -f file-service/src/main/resources/docker-compose.yml up -d
   ```
2. **Python venv** at `.venv/` (referenced by `common/config/src/main/resources/udf.conf`):
   ```bash
   uv sync --all-extras
   ```
3. **Agent-service env file** (only if you'll run `agent-service` or its e2e suite):
   ```bash
   cp agent-service/.env.example agent-service/.env
   ```
   Defaults in `.env.example` already point at the correct per-service ports.

### Per-service launch (one terminal each)

Run from the **repo root**. sbt's project lock means only one of these can be running at a time from the same checkout — use the all-in-one launcher below if you need them concurrently.

| Service | Port | Command |
|---|---|---|
| ConfigService | 9094 | `sbt ConfigService/run` |
| AccessControlService | 9096 | `sbt AccessControlService/run` |
| FileService | 9092 | `sbt FileService/run` |
| ComputingUnitManagingService | 8888 | `sbt ComputingUnitManagingService/run` |
| WorkflowCompilingService | 9090 | `sbt WorkflowCompilingService/run` |
| ComputingUnitMaster | 8085 | `sbt 'WorkflowExecutionService/runMain org.apache.texera.web.ComputingUnitMaster'` |
| ComputingUnitWorker | (pekko) | `sbt 'WorkflowExecutionService/runMain org.apache.texera.web.ComputingUnitWorker'` |
| TexeraWebApplication | 8080 | `sbt 'WorkflowExecutionService/runMain org.apache.texera.web.TexeraWebApplication'` |

### All 8 in one sbt session (concurrent via `bgRun`)

```bash
# GUI_WORKFLOW_WORKSPACE_COPILOT_ENABLED=true is REQUIRED: gui.conf ships
# `copilot-enabled = false`, and without the override every agent endpoint
# returns 403 Forbidden (llm.conf documents this). Omitting it produces runs that
# fail in ~0.5s with `Error: Forbidden`.
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

The trailing `bgWaitFor` lines block on each background job so the sbt process stays alive (kill that sbt process to stop everything; forked services die with it).

### Agent service

Separate from sbt — runs under Bun:

```bash
cd agent-service && bun run dev    # listens on :3001
```

### Verifying a launch

After bringing services up, the agent-service end-to-end suite is a fast smoke test that exercises auth + workflow CRUD + dataset upload + workflow execution against all the backends:

```bash
cd agent-service && bun run e2e         # happy-path workflows
cd agent-service && bun run e2e:errors  # runtime-error reporting format
```

Both scripts use the agent-service TypeScript helpers but do not require `bun run dev` to be running — they talk to the JVM backends directly.

### Stopping services

Three layers, stop the ones you started:

```bash
# 1. Agent service (Bun, port 3001) — if you ran `bun run dev`
kill "$(lsof -tiTCP:3001 -sTCP:LISTEN)" 2>/dev/null

# 2. JVM microservices + sbt
pkill -f 'java @.*sbt-args'   # forked service JVMs
pkill -f sbt-launch.jar       # the sbt process itself
# escalate if a JVM doesn't exit within a couple seconds
pkill -9 -f 'java @.*sbt-args'
pkill -9 -f sbt-launch.jar

# 3. Infra containers (Postgres / LakeFS / MinIO / pgroonga) — stateful
#    Stop only when you want a clean slate; otherwise leave them running
#    between sessions to skip the warm-up cost.
docker compose -f file-service/src/main/resources/docker-compose.yml down
```

Verify everything is gone:

```bash
lsof -iTCP -sTCP:LISTEN -P -n | awk '$1=="java" || $1=="bun"'
docker ps --filter "name=texera-lakefs" --filter "name=pgroonga"
```

Logs persist at `logs/sbt-services.log` (combined sbt stream) and `logs/agent-service.log` (Bun dev server) for postmortem.
