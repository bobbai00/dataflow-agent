<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Benchmarks

The harness behind the paper's numbers: KramaBench (104 tasks), PrepBench (306 cases) and LongDS v1.1 Lite (24 sessions,
777 requests), on BobFlow (the dataflow agent) and Script ReAct (smolagents' `CodeAgent`). `benchmark/bench` is the one
command line. Every subcommand takes `--help`.

## Layout

```
benchmark/
  bench            the command line
  envs/            exact package lists: kramabench (runner, evaluator), scriptreact (Script ReAct), engine (.venv)
  src/bobbench/    the harness
    runner.py        one run: jobs, workers, watchdog, progress.json
    kramabench/      one attempt, BobFlow or Script ReAct; `bench run`
    scriptreact/     smolagents' CodeAgent as the paper set it up, its sandbox and interpreter check
    prepbench/       PrepBench as a KramaBench domain: workload build, result export, PrepBench's evaluator
    longds/          LongDS sessions: prepare, run, judge, report (README there)
    sandbox/         the bubblewrap sandbox around the engine's Python
    profiling/       what an attempt cost (usage.py), what the host did (host.py)
    arms.py          the paper's settings; models.py: model tags and prices
    report.py, compare.py, audit.py, setup.py
  tests/           the offline tests and the $0 gate (tests/gate/)
  campaign/        the stack (templates, launchers, watchers; README there)
  tracker/         the context-tracker overhead experiments (README there)
  Kramabench/      submodule: KramaBench's evaluator, workloads, data and judge cache
  longds/          not tracked: the DataMind checkout and the prepared sessions
```

## Setup

Needs `git`, `uv` and any `python3`.

```bash
benchmark/bench setup all --dry-run    # what is there, what would be fetched
benchmark/bench setup all              # or kramabench, prepbench, longds; safe to run again
```

Every target first makes what all benchmarks need: the submodule at the pinned commit, `envs/kramabench/.venv` (Python
3.10.9), `envs/scriptreact/.venv` (3.12.12), the checkout's `.venv` (3.12.12; `uv sync --all-extras`, then the packages
of `envs/engine/requirements.txt` that the lock lacks) and the engine's Python protos. The engine runs the model's code
on `.venv`, so **a later `uv sync` removes packages the paper's runs had**: run `bench setup` again after one.

| Target | Adds | Size | Options |
|---|---|---|---|
| `kramabench` | wildfire's WeatherEvents csv from Kaggle (no login needed so far; else a token in `~/.kaggle/access_token`) | 1 GB | `--copy-from <KramaBench checkout>` links or copies it |
| `prepbench` | PrepBench at 993a313 in `~/datasets/prepbench`, staged into `Kramabench/data/prepbench` | 0.5 GB | `--datasets <dir>` clones it to `<dir>/prepbench`; then set `PREPBENCH_REPO=<dir>/prepbench` |
| `longds` | DataMind at 4b49ef0 (judge prompt only), the Lite sessions' tasks and data from Hugging Face `zjunlp/LongDS` at bf41bb2, a copy of the data in the tree the engine mounts, the prepared sessions | 9.5 GB | `--sessions <domain/dataset/task> ...`, `--prepared <dir>` |

`Kramabench/data/wildfire/input/ZHVI.csv` is 0 bytes in every paper run: leave it so. Setup reports 5 `legal` sources
"not found by their exact name": upstream's folder names differ in case, and the prompts' fuzzy search finds them.

## The stack

`bench run` and `bench longds run` need an isolated Texera stack: engine, agent, model gateway.
[campaign/README.md](campaign/README.md) renders it and brings it up and down. Below, `S` is the stack's folder, all
commands run from the repository root, and the provider keys are in the stack's `infra.env` and the checkout's `.env`.

## One small run per benchmark and system

With Claude Haiku 5.5, a few cents in all. The launchers run detached, with the paper's settings: results in
`$S/runs/<run>`, log in `$S/logs/<run>.log`. Without task ids they run every task.

```bash
export STACK_DIR=/var/tmp/texera-stable S=/var/tmp/texera-stable    # the launchers read STACK_DIR

# KramaBench, BobFlow
ARMS=evidence_full_flow0 benchmark/campaign/launch.sh demo-kb Haiku55 1 2 archeology-easy-6 legal-easy-25
# KramaBench, Script ReAct (Haiku is on the stack's main gateway, offset + 4000)
GATEWAY=60000 benchmark/campaign/launch-smol.sh demo-kb-script Haiku55 1 2 archeology-easy-6 legal-easy-25
# PrepBench, BobFlow
benchmark/campaign/launch-prep.sh demo-pb Haiku55 2 prepbench-hard-1 prepbench-hard-50
# PrepBench, Script ReAct
GATEWAY=60000 benchmark/campaign/launch-prep-smol.sh demo-pb-script Haiku55 2 prepbench-hard-1 prepbench-hard-50

# LongDS, BobFlow (the first 2 requests of a session; run these in the foreground)
P=benchmark/longds/prepared/business__netflix_movies_and_tv_shows__task2
bash $S/run-env.sh benchmark/bench longds run --prepared $P --out $S/runs/demo-longds/catalog-gold \
  --arm catalog-gold --model claude-haiku-5.5 --turns 2
bash $S/run-env.sh benchmark/bench longds run --prepared $P --out $S/runs/demo-longds/transcript-depnote \
  --arm transcript-depnote --model claude-haiku-5.5 --turns 2
# LongDS, Script ReAct
bash $S/run-env.sh benchmark/bench longds smolagents --prepared $P --out $S/runs/demo-longds/smolagents-depnote \
  --note dependencies --model claude-haiku-5.5 --turns 2
# LongDS is judged afterwards (deepseek-v4-pro through OpenRouter)
bash $S/run-env.sh benchmark/bench longds judge --runs $S/runs/demo-longds
benchmark/bench longds report --runs $S/runs/demo-longds
```

A launcher only adds defaults to `bench run`. The same KramaBench run directly:

```bash
bash $S/run-env.sh benchmark/bench run kramabench bobflow --output $S/runs/demo-kb2 --models Haiku55 \
  --arms evidence_full_flow0 --tasks archeology-easy-6 legal-easy-25 --workers 2
```

## The paper's cells

**KramaBench and PrepBench.** Each cell is one model tag and one system.

| Paper name | Model tag |
|---|---|
| GPT-5.6 Luna, Terra, Sol | `Luna`, `Terra`, `Sol` |
| GPT-6.1 Sol | `Sol61` |
| Gemini 3.8 Flash | `Gemini38Flash`; with optimizations `Gemini38FlashVertex` |
| Gemini 4 Argon | `Gemini4ArgonMedium` |
| DeepSeek V4.1 Flash | `DeepSeek41Flash` |
| Claude Opus 5.5 | `Opus55` |

| System | Arm | KramaBench | PrepBench |
|---|---|---|---|
| Script ReAct | none (`launch-smol.sh`, `launch-prep-smol.sh`) | 3 repetitions | 1 |
| BobFlow | `evidence_full_flow0` | 3 repetitions | 1 |
| + statistics | `evidence_data1_flow0` | 3 repetitions | - |
| + optimizations | `evidence_data1_flow0_opt` on Opus, `evidence_data1_flow0_opt_strict` on the others | 1 | 1 |
| Flow Evidence | `evidence_full_flow1`, `evidence_data1_flow1` | 3 repetitions | - |

GPT-6.1 Sol and Gemini 4 Argon first ran once on KramaBench; their two later repetitions are the `r3-kb-*` runs. The four
close "+ optimizations" KramaBench cells (GPT-6.1 Sol, Gemini 4 Argon, DeepSeek, Opus) also have two reruns of their
flip-prone tasks.

```bash
benchmark/campaign/launch.sh kb-luna Luna 3 6      # the default arms: evidence_full_flow0, evidence_data1_flow0
ARMS=evidence_data1_flow0_opt_strict benchmark/campaign/launch.sh opt-kb-luna Luna 1 6
ARMS=evidence_data1_flow0_opt benchmark/campaign/launch.sh opt-kb-opus55 Opus55 1 6
ARMS="evidence_full_flow1 evidence_data1_flow1" benchmark/campaign/launch.sh flow-kb-luna Luna 3 6
benchmark/campaign/launch-smol.sh smol-kb-luna Luna 3 3
benchmark/campaign/launch-prep.sh pb-luna Luna 6
ARMS=evidence_data1_flow0_opt_strict benchmark/campaign/launch-prep.sh opt-pb-luna Luna 6
benchmark/campaign/launch-prep-smol.sh smol-pb-luna Luna 3
```

Workers change how long a run takes, not its settings. Run heavy runs one at a time. `campaign/provider_failures.py`
lists attempts killed by a slow provider: rerun those tasks into a new run and read both with `bench report --merge`.

`bench report` on the recorded runs gives these (accuracy, cost of one full pass):

| Model | KramaBench + optimizations | KramaBench Script ReAct | PrepBench + optimizations | PrepBench Script ReAct |
|---|---|---|---|---|
| GPT-5.6 Luna | 72.1% $0.30 | 58.3% $0.40 | 83.3% $0.99 | 69.9% $1.21 |
| GPT-5.6 Terra | 68.3% $2.76 | 65.4% $6.99 | 86.3% $8.67 | 79.4% $24.56 |
| GPT-5.6 Sol | 73.1% $5.09 | 60.6% $10.22 | 88.6% $16.50 | 71.9% $45.97 |
| GPT-6.1 Sol | 74.0% $1.67 | 75.0% $3.35 | 90.8% $6.33 | 90.5% $17.33 |
| Gemini 3.8 Flash | 78.8% $7.24 | 66.3% $11.27 | 89.5% $15.80 | 70.9% $40.87 |
| Gemini 4 Argon | 72.1% $6.15 | 74.0% $11.68 | 91.5% $15.42 | 88.6% $33.41 |
| DeepSeek V4.1 Flash | 69.2% $0.66 | 66.7% $0.62 | 88.9% $1.31 | 85.6% $1.40 |
| Claude Opus 5.5 | 73.1% $4.35 | 74.7% $4.76 | 90.5% $16.89 | 90.2% $17.76 |

The 89.5% for Gemini 3.8 Flash on PrepBench counts one attempt as failed, `--fail opt2-pb-gemflash:prepbench-hard-277`:
it fetched the published solution. The engine's sandbox does not block the network; `campaign/integrity_scan.py` lists
model code that reached outside the task data.

**LongDS.** Three arms, 24 sessions, one run per model:

| System | Arm | `gpt-5.6-luna` | `gpt-5.6-terra` | `deepseek-v4.1-flash` |
|---|---|---|---|---|
| BobFlow, task catalog | `catalog-gold` | 333 $4.85 | 454 $43.47 | 458 $7.28 |
| BobFlow, full history | `transcript-depnote` | 333 $3.54 | 424 $29.52 | 451 $2.57 |
| Script ReAct | `smolagents-depnote` | 332 $3.59 | 450 $25.49 | 453 $2.83 |

(correct of 777, billed.)

```bash
R=$S/runs/longds-luna
bash $S/run-env.sh benchmark/bench longds campaign --root $R --model gpt-5.6-luna --parallel 6
bash $S/run-env.sh benchmark/bench longds judge --runs $R/runs
benchmark/bench longds report --runs $R/runs --json $R/summary.json
```

## Report, score, compare

All of these read files only: no model, judge or service, $0.

```bash
benchmark/bench report $S/runs/kb-luna                        # KramaBench attempts are scored during the run
benchmark/bench score prepbench scores.json $S/runs/pb-luna   # PrepBench's own evaluator; the runner's score is 0 there
benchmark/bench report $S/runs/pb-luna --scores scores.json
benchmark/bench report $S/runs/kb-luna $S/runs/kb-luna-rerun --merge      # a later run replaces the same attempts
benchmark/bench compare $S/runs/kb-luna:evidence_full_flow0 $S/runs/kb-luna:evidence_data1_flow0   # who solves what
benchmark/bench recost $S/runs/kb-luna                        # re-price from the exact responses
benchmark/bench audit $S/runs/kb-luna                         # re-run the per-attempt checks
```

A pass is a score of 1.0 (KramaBench) or PrepBench's evaluator's pass; the last attempt per task and repetition counts;
the cost of one full pass is the mean billed cost per attempt times the task count. `bench report --help` has the rest.

## Run folders and profiling

```
<run>/manifest.json            settings, revisions, prices, judge cache hash
<run>/progress.json            one row per attempt
<run>/host-resources.jsonl     load, memory, swap, disk, attempts in flight, every 15 s (profiling/host.py)
<run>/logs/                    one log per attempt
<run>/system_scratch/<system>/<task>/
  prompt.txt, response.txt, answer.json, evaluation.json, ground_truth.json, settings.json, provenance.json
  stats.json                   tokens, billed cost and how it was priced, steps, elapsed seconds (profiling/usage.py)
  wire/                        BobFlow: every model request and response; Script ReAct: model-request-trace.jsonl
  react_steps.json             BobFlow: every step, with the agent's timers (timing) and the engine's (execution_runs)
  workflow.json, snapshot.json BobFlow: the final dataflow
  attempt-audit.json, metrics-audit.json           the per-attempt checks
  outputs/                     PrepBench: the output tables
```

Cost is each response's provider charge when it reports one, else the frozen rates in `models.py`. The memory guard
(`campaign/guard.py`) pauses runs when the host is short of memory. The context tracker's overhead (agent memory and
jump time, the paper's "Human Interaction Support") has its own experiments: [tracker/README.md](tracker/README.md).

## Tests and gates

```bash
benchmark/bench test                     # the whole offline tree on both interpreters, about 20 s, no stack
benchmark/bench test tests/longds -k judge    # pytest's arguments work
```

The gate replays recorded Haiku smokes through this checkout's runners with a stub model, $0, and fails on any change in
what a model sees or how an attempt ends. It needs a stack's services up and the baseline runs:
[tests/gate/README.md](tests/gate/README.md).

```bash
benchmark/tests/gate/rgate.sh <out>          # kb, kbflow, pb, kbsmol, pbsmol: 28 attempts
benchmark/tests/gate/rgate-longds.sh <out>   # the 3 LongDS arms
```
