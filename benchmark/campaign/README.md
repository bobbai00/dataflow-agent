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

# Benchmark campaigns: KramaBench and PrepBench

How the 2026-10-16/17 runs (GPT-6.1 Sol, Gemini 4 Argon, Haiku 5.5 low thinking; dataflow agent and smolagents) were
run: one isolated stack whose services, agent, gateway config and runners all come from one checkout, with its own
ports, containers, volumes, logs, wire traces and run folders. Everything here reads the stack's profile, so the same
scripts serve any checkout. PrepBench's harness is in `benchmark/prepbench/`.

## 1. Checkout prerequisites

```bash
uv sync --all-extras                                   # .venv: engine workers and the model-code sandbox
bin/python-proto-gen.sh                                # Python protos for the engine and the result exporter
(cd agent-service && bun install --frozen-lockfile)
git submodule update --init benchmark/Kramabench       # plus its .venv (the KramaBench venv the runners use)
benchmark/retrieval/script-agent/setup.sh              # smolagents' locked interpreter
cp .env.example .env                                   # then add the provider keys (OpenAI, Anthropic, OpenRouter, Gemini)
```

The sandbox mounts `benchmark/Kramabench/data`; PrepBench's inputs come from `benchmark/prepbench/build_workload.py`.

## 2. Write the stack

```bash
python3 benchmark/campaign/stack/render.py --stack-dir /var/tmp/texera-stable   # profile.sh, run-env.sh, compose.json, ...
```

Fill the provider keys in `<stack>/infra.env` (written with mode 600; every other value is the repository's local-dev
default). The ports are the texera-stable set: Postgres 61432, MinIO 65000, LakeFS 64000, gateway 60000, web 64080,
computing-unit master 64085, manager 64888, agent 3130; the smolagents gateway uses 60001. All scripts take
`STACK_DIR` (default `/var/tmp/texera-stable`).

## 3. Bring it up

```bash
S=/var/tmp/texera-stable
TEXERA_LOCAL_DEV_PROFILE=$S/profile.sh bash $S/run-env.sh bin/local-dev.sh up --build --skip=frontend,agent-service
docker exec texera-stable-postgres psql -U texera -d texera_db -c "DROP INDEX IF EXISTS texera_db.idx_workflow_pgroonga;"
benchmark/campaign/start-agent.sh                      # dataflow agent on :3130, non-watch
benchmark/campaign/start-smol-gateway.sh               # smolagents gateway on :60001
echo $S/runs/<run> >> $S/runs.txt; setsid -f python3 -I benchmark/campaign/guard.py   # memory guard (pause-only)
```

The pgroonga index rejects workflows over ~1.8 MB (MeCab), so it is dropped. A gateway reads its config only at
start: restart one only between runs.

## 4. Launch runs

| Script | Runs |
|---|---|
| `launch.sh <run> <model tag> <reps> <workers> [tasks]` | dataflow on KramaBench (default arms `evidence_full_flow0 evidence_data1_flow0` = without and with statistics) |
| `launch-smol.sh <run> <model tag> <reps> <workers> [tasks]` | smolagents on KramaBench |
| `launch-prep.sh <run> <model tag> <workers> [tasks]` | dataflow on PrepBench (default `evidence_full_flow0`) |
| `launch-prep-smol.sh <run> <model tag> <workers> [tasks]` | smolagents on PrepBench |

Model tags are `benchmark/retrieval/run.py`'s `MODEL_TYPES` (`Sol61`, `Gemini4ArgonMedium`, `Haiku55LowThink`, ...).
Haiku smolagents runs used the main gateway: `GATEWAY=60000`. Examples of the 10-17 runs:

```bash
benchmark/campaign/launch.sh st-sol61-r1 Sol61 1 3
benchmark/campaign/launch-smol.sh st-smol-sol61-r1 Sol61 1 2
benchmark/campaign/launch-prep.sh sp-sol61-r1 Sol61 2
benchmark/campaign/launch-prep-smol.sh sp-smol-sol61-r1 Sol61 3
```

Watch with `python3 -I benchmark/campaign/alert.py <run>...` (one line per problem attempt, progress every 20, each
run's end). After a run, `python3 -I benchmark/campaign/integrity_scan.py $S/runs/<run>` lists model code that reached
outside the task data, and `provider_failures.py $S/runs/<run>` lists timeouts caused by slow providers (calls of
>= 120 s adding up to >= 300 s), which the campaigns rerun.

## 5. Score

KramaBench attempts are scored by the runner (`progress.json`). PrepBench attempts are scored by PrepBench's evaluator:
`benchmark/prepbench/score.py` (see `benchmark/prepbench/README.md`). `analysis/final_tables_20261017.py` and
`analysis/haiku_tests_20261017.py` are the code behind the 10-17 tables (run names are that campaign's);
`analysis/tables_from_index.py` and `analysis/run_inventory.py` rebuild the tables from a results package's
`scores/index.csv`.

## 6. Bring it down

```bash
TEXERA_LOCAL_DEV_PROFILE=$S/profile.sh bash $S/run-env.sh bin/local-dev.sh down
kill "$(lsof -tiTCP:3130 -sTCP:LISTEN)"; docker rm -f texera-stable-litellm-smol
```

Known traps from the campaigns: the first concurrent executions on a fresh stack can race on
`iceberg_namespace_properties_pkey` (one-time); `wildfire-hard-19` (1 GB input) times out for most models; two heavy
runs at once can push the host into swap and attempts into timeouts, which is what the guard is for.
