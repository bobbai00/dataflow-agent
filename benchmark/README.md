# Benchmarks

Two benchmarks drive the dataflow agent end-to-end; `bench.sh` is the single
entry point for both. The full Texera stack must be up first
(`bin/local-dev.sh up` — see [docs/local-dev-with-agent.md](../docs/local-dev-with-agent.md)).

| | KramaBench | LongDS-Bench |
|---|---|---|
| Where | `benchmark/Kramabench` — git **submodule**, branch `stable` | `benchmark/longds` — part of this repo |
| Shape | 104 single-question tasks over 6 domain data lakes | 68 tasks / 2,225 turns of long-horizon multi-turn analysis |
| Driver | `kb.py` (inside the submodule) | `run_longds.py` (one agent + one workflow per task) |
| Scoring | repo's `evaluate.py` (gpt-5-mini metrics — needs `OPENAI_API_KEY` in `Kramabench/.env`) | LLM judge with upstream DataMind's own prompt |
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
gpt-5-mini via `OPENAI_API_KEY` directly, and a dummy key silently zeroes
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

Matched native pilots use the same official evaluator:

```bash
bin/bench.sh retrieval run --help
bin/bench.sh retrieval analyze benchmark/retrieval/runs/<campaign>
bin/bench.sh retrieval reconcile benchmark/retrieval/runs/<campaign> # offline accounting refresh
bin/bench.sh retrieval audit benchmark/retrieval/runs/<campaign>     # after analyze
```

For audited provider usage, launch agent-service with `TEXERA_LLM_TRACE_DIR`
and pass that directory as `retrieval run --wire-dir`. The campaign archives
exact request/response bodies without headers or credentials, preserves the
original harness statistics, and reconciles cache reads, cache writes, and
reasoning tokens. Costs use frozen per-request token rates; incomplete usage
or unknown rates remain unpriced. Agent wall time, gateway latency, and total
attempt time are reported separately. Raw campaigns under
`benchmark/retrieval/runs/` are gitignored.
Provider-reported `usage.cost` is recorded separately from token-rate estimates;
whole-call validation failures are counted even when no actions ran.

To compare data statistics and flow evidence independently, select all four
`evidence_data{0,1}_flow{0,1}` arms. Every arm retains full retrieval and full-table
profile collection; data-off offers `sample` and `full`, while data-on offers
`sample_stats` and `full`. This isolates evidence exposure, not collection cost.
The system prompt and tool schema follow each arm's enabled retrieval views.

```bash
bin/bench.sh retrieval run \
    --output benchmark/retrieval/runs/<new-campaign> --endpoint http://localhost:3001 \
    --tasks archeology-easy-6 legal-easy-3 biomedical-hard-3 \
    --models Luna Terra Sol Opus48 Qwen38_27B DeepSeek41Flash \
    --arms evidence_data0_flow0 evidence_data0_flow1 evidence_data1_flow0 evidence_data1_flow1 \
    --repetitions 1 --workers 2 --full-result-char-limit 5000
```

This example runs 72 model/task/arm attempts. `--full-result-char-limit` controls
the display budget independently of retained data and records it in the campaign
manifest. Its default remains 100,000 for existing campaign compatibility; pass
5,000 explicitly to match the current service default. Valid values are
128–100,000. Historical arm names retain their original settings.

For the matched message-layout pilot, `layout_native` and `layout_markdown`
pin the replay format explicitly. Both expose `sample_stats` and `full`, enable
flow evidence, and collect full-table profiles. This command validates all 24
jobs without reading credentials, creating artifacts, or contacting services:

```bash
bin/bench.sh retrieval run --dry-run \
    --output benchmark/retrieval/runs/<new-layout-campaign> --endpoint http://localhost:3001 \
    --tasks legal-easy-3 biomedical-hard-3 \
    --models Luna Terra Sol Opus48 Qwen38_27B DeepSeek41Flash \
    --arms layout_native layout_markdown --repetitions 1 --workers 3 \
    --full-result-char-limit 5000
```

After freezing and validating the runtime, remove `--dry-run` and add
`--wire-dir`, `--agent-revision`, `--engine-revision`, and `--gateway-revision`
for the deployed stack. The source snapshot hashes agent, Amber, gateway,
benchmark and both LiteLLM configuration files. It records working-tree content
independently of the declared deployed revisions.

`analyze` reports matched layout differences, final-line compliance, conservative
numeric-result support, captured request roles, prefix stability, and usage.
`python benchmark/retrieval/matrix_audit.py <campaign>` saves detailed per-request
hashes, context byte counts and cache availability without making API calls.
Context bytes are serialized message size, not measured provider tokens. One
repetition over two tasks is a diagnostic comparison; warm provider caches,
routing and changes in agent behavior can also affect cost and calls.

For an opt-in infrastructure project with independent names and volumes, use
the supported launcher with the isolated overlay. Standard host ports must be
available; existing deployments are left running.

```bash
export TEXERA_DOCKER_PROJECT=texera-python-pilot
export TEXERA_POSTGRES_CONTAINER=texera-python-pilot-postgres
export TEXERA_DOCKER_OVERLAY_FILE="$PWD/bin/local-dev/docker-compose.isolated.yml"
export LITELLM_BASE_URL=http://localhost:4000
export TEXERA_LLM_TRACE_DIR=/tmp/registered-python-wire
bin/local-dev.sh up --build --skip=frontend
bin/local-dev.sh status
```

Reuse those environment overrides for later launcher commands. `--build`
forces a fresh JVM distribution; subsequent `up` commands use verified build
stamps and rebuild when relevant sources change. Trace bodies include prompts
and task data, so keep the trace directory private and outside Git.

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
