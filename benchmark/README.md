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
bin/bench.sh setup [--copy-from ~/path/to/old/Kramabench]
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

API keys come from the repo-root `.env` (see `.env.example`) — `bin/bench.sh`
exports it before every command. KramaBench's paraphrase/f1 metrics call
gpt-4o-mini via `OPENAI_API_KEY` directly, and a dummy key silently zeroes
scores. (`Kramabench/.env` still works as a fallback for standalone use.)

## KramaBench

```bash
bin/bench.sh kb systems                                    # list SUTs
bin/bench.sh kb tasks --sut DataflowSystemStableHaiku \
    --ids "legal-easy-3 wildfire-easy-1" --parallel              # run specific tasks
bin/bench.sh kb run --sut DataflowSystemStableHaiku --parallel   # all 6 workloads
bin/bench.sh kb scores --sut DataflowSystemStableHaiku     # leaderboard
bin/bench.sh kb failed --sut DataflowSystemStableHaiku --zero-only --ids-only
bin/bench.sh kb setup-data                                 # verify/fetch data lake
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
bin/bench.sh longds download --task sports/nfl_big_data_bowl_2023/task1
bin/bench.sh longds prepare  --task sports/nfl_big_data_bowl_2023/task1
bin/bench.sh longds run     --task sports__nfl_big_data_bowl_2023__task1 \
    --arm haiku-delta-1k --turn-limit 3          # smoke; drop --turn-limit for all 42 turns
bin/bench.sh longds judge   --sut LongDS_LongDSHaikuDelta1k --judge-model gpt-5.2
bin/bench.sh longds analyze --sut LongDS_LongDSHaikuDelta1k \
    --task sports__nfl_big_data_bowl_2023__task1
```

The judge defaults to `JUDGE_BASE_URL=http://localhost:4000/v1` — the
local-dev LiteLLM proxy, which serves every model in
`bin/single-node/litellm-config.yaml` using the provider keys from the root
`.env`. Override `JUDGE_BASE_URL` / `JUDGE_API_KEY` (root `.env` or shell) to
judge through any other OpenAI-compatible endpoint.

Arms live in `benchmark/longds/arms.py` (`haiku-delta-1k` is the
gateway-reachable smoke arm; the `luna-*` arms name `gpt-5.6-luna`, which the
DKNet gateway does not serve). Run artifacts land in
`benchmark/longds/system_scratch/<SUT>/<task>/` — per-turn prompt, response,
react steps, workflow snapshot, token/cost stats. `prepared/`, `DataMind/`,
and `system_scratch/` are gitignored.
