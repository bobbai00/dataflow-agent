# Benchmarks

Two benchmarks drive the dataflow agent end-to-end; `bench.sh` is the single
entry point for both. The full Texera stack must be up first
(`bin/local-dev.sh up` — see [docs/local-dev-with-agent.md](../docs/local-dev-with-agent.md)).

| | KramaBench | LongDS-Bench |
|---|---|---|
| Where | `benchmark/Kramabench` — git **submodule**, branch `stable` | `benchmark/longds` — part of this repo |
| Shape | 104 single-question tasks over 6 domain data lakes | 68 tasks / 2,225 turns of long-horizon multi-turn analysis |
| Driver | `kb.py` (inside the submodule) | `run_longds.py` (one agent + one workflow per task) |
| Scoring | repo's `evaluate.py` (gpt-4o-mini metrics — needs `OPENAI_API_KEY` in `Kramabench/.env`) | LLM judge with upstream DataMind's own prompt |
| Data | committed in the submodule, except wildfire's WeatherEvents csv (Kaggle) | downloaded per-task from HF `zjunlp/LongDS` |

## One-time setup

```bash
benchmark/bench.sh setup [--copy-from ~/path/to/old/Kramabench]
```

Creates the submodule venv, wires the symlinks, clones `zjunlp/DataMind`
(judge prompt + dataset home), fetches the Kaggle csv (or copies it from an
existing checkout), downloads + prepares the LongDS sample task
(`sports/nfl_big_data_bowl_2023/task1`, 42 turns).

Symlink layout (one relative `data/...` path resolves in this harness, the JVM
services, and the Python UDF workers):

```
dataflow-agent/data              -> benchmark/Kramabench/data
benchmark/Kramabench/data/longds -> ../../longds/DataMind/longds/dataset/data/longds
```

`Kramabench/.env` needs a real `OPENAI_API_KEY` — KramaBench's paraphrase/f1
metrics call gpt-4o-mini directly, and a dummy key silently zeroes scores.

## KramaBench

```bash
benchmark/bench.sh kb systems                                    # list SUTs
benchmark/bench.sh kb tasks --sut DataflowSystemStableHaiku \
    --ids "legal-easy-3 wildfire-easy-1" --parallel              # run specific tasks
benchmark/bench.sh kb run --sut DataflowSystemStableHaiku --parallel   # all 6 workloads
benchmark/bench.sh kb scores --sut DataflowSystemStableHaiku     # leaderboard
benchmark/bench.sh kb failed --sut DataflowSystemStableHaiku --zero-only --ids-only
benchmark/bench.sh kb setup-data                                 # verify/fetch data lake
```

`DataflowSystemStableHaiku` (claude-haiku-4.5 on the converge stack) is the
cheap smoke arm; the sweep arms live in `Kramabench/systems/dataflow_system.py`.
A "system" is one of those classes — subclass `DataflowSystem` with your knob
set and export it from `systems/__init__.py` to add one.

Known upstream wart: `astronomy-hard-7/-10` reference `STORM-AI` file names
whose date suffixes don't match the shipped files; `setup-data` reports them
as missing. Pre-existing on every branch.

## LongDS

```bash
benchmark/bench.sh longds download --task sports/nfl_big_data_bowl_2023/task1
benchmark/bench.sh longds prepare  --task sports/nfl_big_data_bowl_2023/task1
benchmark/bench.sh longds run     --task sports__nfl_big_data_bowl_2023__task1 \
    --arm haiku-delta-1k --turn-limit 3          # smoke; drop --turn-limit for all 42 turns
benchmark/bench.sh longds judge   --sut LongDS_LongDSHaikuDelta1k --judge-model gpt-5.4
benchmark/bench.sh longds analyze --sut LongDS_LongDSHaikuDelta1k \
    --task sports__nfl_big_data_bowl_2023__task1
```

The judge defaults to `JUDGE_BASE_URL=http://localhost:4000/v1` (the compose
litellm, which has no provider keys) — point it at the DKNet gateway instead:

```bash
export JUDGE_BASE_URL="https://texera.dknet-ai.org/litellm/v1"
export JUDGE_API_KEY="<dknet master key>"
```

Arms live in `benchmark/longds/arms.py` (`haiku-delta-1k` is the
gateway-reachable smoke arm; the `luna-*` arms name `gpt-5.6-luna`, which the
DKNet gateway does not serve). Run artifacts land in
`benchmark/longds/system_scratch/<SUT>/<task>/` — per-turn prompt, response,
react steps, workflow snapshot, token/cost stats. `prepared/`, `DataMind/`,
and `system_scratch/` are gitignored.
