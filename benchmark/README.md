# Benchmarks

KramaBench drives the dataflow agent end-to-end; `bench.sh` is the single
entry point. The full Texera stack must be up first
(`bin/local-dev.sh up` — see [docs/local-dev-with-agent.md](../docs/local-dev-with-agent.md)).

| | KramaBench |
|---|---|
| Where | `benchmark/Kramabench` — git **submodule**, branch `stable` |
| Shape | 104 single-question tasks over 6 domain data lakes |
| Driver | `kb.py` (inside the submodule); native campaigns through `benchmark/retrieval/run.py` |
| Scoring | repo's `evaluate.py` (gpt-5-mini metrics — needs `OPENAI_API_KEY` in `Kramabench/.env`) |
| Data | committed in the submodule, except wildfire's WeatherEvents csv (Kaggle) |

## One-time setup

```bash
bin/bench.sh setup [--copy-from ~/path/to/old/Kramabench]
```

Creates the submodule venv, wires the symlinks, and fetches the Kaggle csv
(or copies it from an existing checkout).

Symlink layout (one relative `data/...` path resolves in this harness, the JVM
services, and the Python UDF workers):

```
dataflow-agent/data              -> benchmark/Kramabench/data
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

This example runs 72 model/task/arm attempts. The agent makes one
`dataflow(python, statements)` tool call per step, and a reply without a tool call
is the answer; see `docs/native-registered-python-design.md`. `--full-result-char-limit` controls
the display budget independently of retained data and records it in the campaign
manifest. Its default remains 100,000 for existing campaign compatibility; pass
5,000 explicitly to match the current service default. Valid values are
128–100,000. Historical arm names retain their original settings.

For an opt-in infrastructure project with independent names and volumes, use
the supported launcher with the isolated overlay. Standard host ports must be
available; existing deployments are left running.

```bash
export TEXERA_DOCKER_PROJECT=texera-python-pilot
export TEXERA_POSTGRES_CONTAINER=texera-python-pilot-postgres
export TEXERA_DOCKER_OVERLAY_FILE="$PWD/bin/local-dev/docker-compose.isolated.yml"
export LITELLM_BASE_URL=http://localhost:4000
export TEXERA_LLM_TRACE_DIR=/tmp/registered-python-wire
# Registered loaders call open(); the engine's static UDF scan must not reject them.
export UDF_PYTHON_ALLOW_FILE_IO=true
bin/local-dev.sh up --build --skip=frontend
bin/local-dev.sh status
```

Reuse those environment overrides for later launcher commands. `--build`
forces a fresh JVM distribution; subsequent `up` commands use verified build
stamps and rebuild when relevant sources change. Trace bodies include prompts
and task data, so keep the trace directory private and outside Git.

### Script-agent baselines

Two agents that write Python against the task's files run on the same tasks,
file lists, format hints, model gateway and official evaluator as the dataflow
agent. They need Linux with bubblewrap (`bwrap`) and the LiteLLM gateway.

| | smolagents | DSGym |
|---|---|---|
| Agent | `CodeAgent` (smolagents 1.23, in the KramaBench venv) with its default prompts | upstream `ReActDSAgent` ([fannie1208/DSGym](https://github.com/fannie1208/DSGym), pinned at `461a464`) with its `SYSTEM_PROMPT` and custom-task template |
| System class | `CodeAgentSystem` (`systems/code_agent_system.py`) | `DSGymSystem` (`systems/dsgym_system.py`) |
| Code runs in | smolagents' interpreter, inside the agent's process | a persistent Jupyter kernel behind DSGym's executor manager |
| Answer | `final_answer(value)` | `<answer>value</answer>` |

One-time setup for DSGym, which needs Python 3.12 and so its own interpreter:

```bash
git clone https://github.com/fannie1208/DSGym.git benchmark/DSGym
git -C benchmark/DSGym checkout --detach 461a464da3e5d2bbea409462c61c8999527b4616
uv venv --python 3.12 benchmark/DSGym/.venv
VIRTUAL_ENV=benchmark/DSGym/.venv uv pip install -r benchmark/retrieval/dsgym-requirements.txt
```

A round of both, from `benchmark/Kramabench` with the provider keys and
`LITELLM_MASTER_KEY` in the environment:

```bash
.venv/bin/python ../retrieval/run_baselines.py --output <new dir> --model Luna --all-tasks
.venv/bin/python ../retrieval/baseline_report.py <dir>     # score, cost, tokens, latency
```

Use `--systems smolagents` to run that baseline without installing DSGym.

`--max-steps` (25) and `--output-chars` (5,000) apply to both agents. Each task
runs once per system in its own process and leaves, under
`<dir>/system_scratch/<SUT>/<task>/`: the prompt, every model request and
response with its token usage and seconds (`model-request-trace.jsonl`), every
code execution with its seconds (`executions.jsonl`; DSGym also has the
kernel-side `kernel-executions.jsonl`), the full conversation, `stats.json`
and the official `evaluation.json`.

Model-written code never sees the workload's answers, the reference solutions,
other runs or the repository. Both agents run it under bubblewrap with the
task's input directory mounted read-only at the relative path the prompt
names, a private working directory and no network:

- smolagents executes code in the agent's own process, so the whole agent runs
  in the sandbox and reaches the gateway through a Unix socket
  (`script_sandbox.py`).
- DSGym's agent loop runs outside; `dsgym_executor.py` stands in for its
  docker executor manager and starts DSGym's own `KernelExecutor` in the
  sandbox.

Two things differ from upstream DSGym, both in `systems/dsgym_runner.py`:
token usage and seconds are recorded, and execution output is cut at
`--output-chars`. Upstream declares that limit (`max_stdout_length=5000`) and
never applies it. `DSGymSystem` alone works against DSGym's docker manager as
well: pass `manager_url`.
