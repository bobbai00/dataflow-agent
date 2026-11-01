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

The stack the paper's runs used: one isolated stack whose services, agent, gateway config and runners all come from one
checkout, with its own ports, containers, volumes, logs, wire traces and run folders. Everything here reads the stack's
profile, so the same scripts serve any checkout. What to run on it is in [the benchmark README](../README.md).

## 1. Before the first stack

```bash
cp .env.example .env                 # then add the provider keys (OpenAI, Anthropic, OpenRouter, Gemini)
benchmark/bench setup all            # submodule, interpreters, protos, data (benchmark/README.md)
```

The sandbox mounts `benchmark/Kramabench/data`; `bench setup` stages PrepBench's and LongDS's inputs there. Building the
services needs sbt and a JDK; the containers need docker.

## 2. Bring it up

```bash
benchmark/bench stack up             # safe to repeat; rebuilds what changed and restarts the agent
benchmark/bench stack status
```

This writes the stack into `STACK_DIR` (default `/var/tmp/bobflow-bench`: `profile.sh`, `run-env.sh`, `compose.json`,
`infra.env`, and the `logs`, `wire`, `runs` folders), copies the provider keys from `.env` into `infra.env` (mode 600),
builds and starts Texera's services, drops the workflow search index (it did not exist in the paper's runs), and starts the
agent, the smolagents gateway and the memory guard.

The ports are the local-dev base ports plus an offset of 30000: Postgres 35432, MinIO 39000, LakeFS 38000, gateway 34000,
smolagents gateway 34001, web 38080, computing-unit master 38085, manager 38888; the agent is on 3100. For a second stack
on one host, write it with its own folder, offset and agent port first:

```bash
python3 benchmark/campaign/stack/render.py --stack-dir /var/tmp/second-stack --offset 20000 --agent-port 3101
STACK_DIR=/var/tmp/second-stack benchmark/bench stack up
```

Every script here reads `STACK_DIR`. A gateway reads its config only at start: run `bench stack up` only between runs.

## 3. Launch runs

| Script | Runs |
|---|---|
| `launch.sh <run> <model tag> <reps> <workers> [tasks]` | dataflow on KramaBench (default arms `evidence_full_flow0 evidence_data1_flow0` = without and with statistics) |
| `launch-smol.sh <run> <model tag> <reps> <workers> [tasks]` | smolagents on KramaBench |
| `launch-prep.sh <run> <model tag> <workers> [tasks]` | dataflow on PrepBench (default `evidence_full_flow0`) |
| `launch-prep-smol.sh <run> <model tag> <workers> [tasks]` | smolagents on PrepBench |

Model tags are `MODEL_TYPES` in `benchmark/src/bobbench/models.py` (`Sol61`, `Gemini4ArgonMedium`, `Haiku55LowThink`,
...). Haiku smolagents runs used the main gateway: `GATEWAY=34000`. `WAIT=1` keeps a launcher in the foreground until its
run ends. Each launcher calls `benchmark/bench run` with the
paper's settings. Examples of the 10-17 runs:

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

## 4. Score

KramaBench attempts are scored by the runner (`progress.json`). PrepBench attempts are scored by PrepBench's evaluator,
`benchmark/bench score prepbench`. `benchmark/bench report` gives the tables; see [the benchmark README](../README.md).

## 5. Bring it down

```bash
benchmark/bench stack down           # the data stays in the stack's docker volumes
```

Known traps from the campaigns: the first concurrent executions on a fresh stack can race on
`iceberg_namespace_properties_pkey` (one-time); `wildfire-hard-19` (1 GB input) times out for most models; two heavy
runs at once can push the host into swap and attempts into timeouts, which is what the guard is for.
