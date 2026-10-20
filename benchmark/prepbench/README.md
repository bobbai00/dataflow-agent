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

# PrepBench

[PrepBench](https://github.com/TsinghuaDatabaseGroup/prepbench) (clarified mode) run as a KramaBench domain,
`prepbench`: 306 cases, tasks `prepbench-hard-<n>`. An agent builds each requested output table; PrepBench's own
evaluator scores the tables (row count, one-to-one key match, values within the column's matcher). This is the harness
of the 2026-10-14 runs and the 2026-10-17 GPT-6.1 Sol / Gemini 4 Argon / Haiku 5.5 runs.

| File | Role |
|---|---|
| `build_workload.py` | Stages the cases into KramaBench: `data/prepbench/input/case_NNN/`, `workload/prepbench.json`, `format_hint/prepbench.json` (dataflow handover), and here `format_hint_script.json` (smolagents handover) and `task-index.json` (case per task, inputs, outputs) |
| `prep_run.py` | Dataflow runner: `benchmark/retrieval/run.py` with PrepBench added to the inventory; each attempt runs `evaluate_task.py` |
| `evaluate_task.py` | One dataflow attempt: the runner's per-attempt script, then each output file the agent names is exported from the operator's stored result (`export_result.py`) to `<attempt>/outputs/` |
| `export_result.py` | Reads an operator's full stored result (Iceberg, through the engine's Python storage code) and writes it as CSV |
| `smol_run.py`, `smol/evaluate_script_task.py` | smolagents runner and attempt: the agent writes `result/output_NN.csv` with pandas; the files are collected to `<attempt>/outputs/` |
| `score.py` | PrepBench's evaluator over every attempt's `outputs/`, billed cost per attempt, and a summary table |
| `run.py`, `smol/run_baselines.py` | Placeholders the runners point `__file__` at, so attempts start the scripts next to them |

## Build the workload

The KramaBench pin carries `workload/prepbench.json` and both format hints; the input tables are generated (166 MB):

```bash
git clone https://github.com/TsinghuaDatabaseGroup/prepbench /var/tmp/texera-registered-python/prepbench/repo
git -C /var/tmp/texera-registered-python/prepbench/repo checkout 993a313
python3 benchmark/prepbench/build_workload.py /var/tmp/texera-registered-python/prepbench/repo
```

The build is deterministic: from 993a313 it reproduces the committed JSON files byte for byte.

## Run and score

Runs go through a benchmark stack (see `benchmark/campaign/README.md`): `launch-prep.sh` for the dataflow agent
(default arm `evidence_full_flow0`, the basic setting) and `launch-prep-smol.sh` for smolagents. Then:

```bash
PREPBENCH_REPO=/var/tmp/texera-registered-python/prepbench/repo \
  benchmark/Kramabench/.venv/bin/python benchmark/prepbench/score.py scores.json /var/tmp/texera-stable/runs/<run> ...
```

The runner's own score for PrepBench tasks is always 0 (the workload's answer is a placeholder); use `score.py`.
