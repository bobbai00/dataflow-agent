# Benchmark systems (SUTs)

A **system** (SUT) is one named, frozen configuration that KramaBench runs
against a workload. The harness resolves a system by *class name* —
`getattr(systems, "<name>")` — so the string passed to `--sut` is the Python
class name. Renaming a class silently orphans every result recorded under the
old name.

There are **three categories**, distinguished by *what agent harness solves the
problem*. All three receive the same task prompt and produce the same
`answer.json` / `evaluation.json` pair, which is what makes them comparable.

| Category | Harness | Where the work happens |
|---|---|---|
| [`DataflowSystem`](#1-dataflowsystem) | Texera DAG agent | Operators on the Texera engine |
| [`CodeAgentSystem`](#2-codeagentsystem) | [smolagents](https://github.com/huggingface/smolagents) `CodeAgent` | Python in one local process |
| [`ClaudeCodeSystem`](#3-claudecodesystem) | Claude Code (Agent SDK) | A `run_python` MCP tool in a workspace |

Runner: [`bin/bench.sh`](../bin/bench.sh) (wraps `Kramabench/kb.py`).
Operator notes: [`Kramabench/CLAUDE.md`](Kramabench/CLAUDE.md).

---

## 1. `DataflowSystem`

**A DAG-based agent harness.** The model does not write one script. It
incrementally builds a *dataflow graph*: each `createOrModifyOperator` call
defines a named operator with a Python body, the engine executes it, and the
result (schema, rows, stats) is rendered back into the model's context. The
model then reads that evidence and edits the graph. Solving a data-science
question means converging on a graph whose terminal operator holds the answer.

The research question this family exists to answer is **what the agent should
be shown between steps** — that is what the configs vary.

### 1.1 The two axes

**`context_mode`** — what the agent sees about its own history.

- `delta` — a replayed trajectory: every past step as `Thought` / `Action` /
  `Observation`. History is append-only; the agent reads what it *did*.
- `latest` — only the current graph state, re-rendered each step. No history;
  the agent reads what *is*.

**`data_level`** — how much is said about the data.

- `1` — schema only (column names and types).
- `2` — schema plus a structural profile: per-column null counts, distinct
  counts, duplicate counts.

Plus **result chars** (`max_operator_result_char_limit`), which bounds how much
of each operator's output table is rendered — 1k starves, 5k is generous.

### 1.2 The six configs

Constant across all: `flow_level=1`, `max_steps=25`, `attempt_reflection=True`,
`message_layout="blockSplit"`.

| Config | `context_mode` | chars | `data_level` | stats |
|---|---|---|---|---|
| Anchor | delta | 1k | 1 | no |
| C1 | delta | 5k | 1 | no |
| C2 | delta | 1k | 2 | yes |
| C3 | latest | 1k | 1 | no |
| C4 | latest | 5k | 2 | yes |
| C5 | latest | 5k | 1 | no |

Anchor is the starved baseline. C1 isolates the rows knob, C2 the stats knob,
C3 the mode knob. C4 is everything on; C5 is C4 minus stats.

### 1.3 What each config actually looks like

All examples below are **real excerpts** from recorded traces in
`system_scratch/`, not illustrations.

#### `delta` — trajectory replay (Anchor, C1, C2)

Top-level sections are `# User Task` then `# Agent Events`:

```text
# Agent Events

## Agent Event 2

Thought: I'll help you find which region had the most rainfall in June, July,
and August of 2020. Let me start by loading and exploring the data files.

Action:
- createOrModifyOperator
    operatorId: boston_data
    summary: Load Boston monthly precipitation data
    code:
      def load() -> pd.DataFrame:
          return pd.read_csv('data/environment/input/monthly_precipitations_boston.csv')

Observation:

- operator boston_data added
  result:
    Output Table: 29 rows, 14 cols
      Year  Jan   Feb   Mar   ...  Annual
    0 2000  2.62  2.55  3.59  ...  45.60
    1 2001  1.58  1.37  7.57  ...  30.72
```

Each step appends one `## Agent Event N`. Earlier events never change — that
append-only property is what makes prompt caching possible (see §4).

#### `latest` — current state only (C3, C4, C5)

Top-level sections are `# User Task` then `# Current Dataflow`. No history:

```text
# Current Dataflow
## Operators

### Operator `chatham_raw` (DataLoading)
Summary: Raw preview of Chatham precipitation data
Code:
  def load():
      lines = open('data/environment/input/monthly_precipitations_chatham.csv').read().splitlines()
      return pd.DataFrame({"line": lines[:5] + lines[len(lines)//2:len(lines)//2+5]})
Result:
  Output Table: 10 rows, 1 cols
    line
  0 Year,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec,Annual
  1 2000,4.23,3.19,4.86,5.29,2.69,2.05,4.62,5.19,M,2.55,3.96,M,M
  Schema (1 cols): line (str)
```

The same operator appears every step with its *current* code and result. A
`delta` context grows with the number of steps; a `latest` context grows with
the size of the graph.

#### `data_level=1` vs `data_level=2`

`data_level=1` ends each operator at the schema line:

```text
  Schema (14 cols): Nov (str), Jul (str), Oct (str), Year (str), ... Annual (str)
```

`data_level=2` appends the structural profile:

```text
  Schema (14 cols): Nov (str), Jul (str), Oct (str), Year (str), ... Annual (str)
  Column Schema and stats:
  - "Nov" (str): null=0, distinct=24, duplicate_values=5
  - "Jul" (str): null=0, distinct=25, duplicate_values=4
  - "Year" (str): null=0, distinct=29
  - "Apr" (str): null=0, distinct=22, duplicate_values=7
```

Note `(str)` on numeric-looking columns — that is the signal stats are meant to
surface. Here the CSV uses `M` for missing, so every column parsed as string;
a mean over `Jun` would fail until the agent notices and coerces.

### 1.4 Registered systems

- Grid: `DataflowSystem{Haiku,Sonnet,GPT5Mini}{Anchor,C1..C5}Rep{1,2,3}` (54)
- `Best` (delta 5k + stats, the 79.1% gpt-5.2-medium campaign winner):
  `DataflowSystem{GPT52Medium,GPT5Mini,Luna,Terra}BestRep{1,2,3}` (12)
- Experiment arms (haiku, 8): `HaikuScoped{Control,Split,Lean,SrcStats}`
  (position-scoped stat channels), `HaikuLayout{Block,BlockSplit,Native}` (§4).

> The gpt-5-mini / luna / terra `Best` arms are a **proxy** — their own campaign
> results are not in this checkout, so the config is inherited from
> gpt-5.2-medium rather than measured for those models.

### 1.5 Setup

The heaviest of the three: the agent builds real workflows on a real engine.

1. **Infra containers** (Postgres, LakeFS, MinIO, pgroonga):
   ```bash
   docker compose -f file-service/src/main/resources/docker-compose.yml up -d
   ```
2. **LiteLLM proxy** on `:4000` — this is where the Anthropic cache breakpoints
   and `additional_drop_params` live (`bin/single-node/litellm-config.yaml`).
3. **Texera JVM services** — see the table in the repo-root `CLAUDE.md`.
   Minimum for a benchmark run: ConfigService, AccessControlService,
   FileService, ComputingUnitManagingService, WorkflowCompilingService,
   ComputingUnitMaster, ComputingUnitWorker, TexeraWebApplication.
4. **Agent service** on `:3001`:
   ```bash
   cd agent-service && bun run dev
   ```
5. **`GUI_WORKFLOW_WORKSPACE_COPILOT_ENABLED=true`** must be set, or every
   agent endpoint returns 403.

**Exactly one agent-service.** Bun binds with `SO_REUSEPORT`, so a second
`bun run dev` silently shares port 3001 and the kernel load-balances between
them. An agent created on one process is invisible to the other and the task
dies with `Error: Agent not found` — 0 steps, scored as a wrong answer.
`lsof -tiTCP:3001 -sTCP:LISTEN` reports only **one** PID even when two are
running, so check the process list instead:

```bash
ps -eo comm --no-headers | grep -cx bun   # expect 2 (wrapper + server)
ss -ltn | grep -c ':3001'                  # expect 1
```

**Never edit `agent-service/src` mid-run** — `bun --watch` restarts the service
and wipes the in-memory agent store.

---

## 2. `CodeAgentSystem`

**The [smolagents](https://github.com/huggingface/smolagents) `CodeAgent`
harness.** The model writes Python, it executes locally, stdout comes back, and
it iterates. One process, no graph, no engine — the standard
write-code/run-code/read-output loop
([docs](https://huggingface.co/docs/smolagents/index),
[`CodeAgent` guide](https://huggingface.co/docs/smolagents/en/guided_tour)).

This family is the substrate baseline: same tasks, same models, same step
budget, no dataflow structure.

### 2.1 The two parameters

**Result truncation (`max_print_outputs_length`)** — caps how many characters
of stdout are fed back after each execution. Registered at 1k / 2k / 5k. This
is the direct analogue of the dataflow family's result-char knob, so the two
substrates can be compared at equal observation budgets. Print a whole
DataFrame at 1k and it is cut off mid-table; the agent must learn to print
summaries rather than dumps.

**Custom prompt (`use_custom_prompt`)** — swaps smolagents' stock system prompt
for `CUSTOM_INSTRUCTIONS` in `code_agent_custom_prompt.py`, which adds
data-science-specific guidance. Every registered arm is `Guided` (custom prompt
**on**); the unguided arms were removed when that A/B concluded.

Also pinned: `max_steps=25`, matching the dataflow family so a cross-substrate
comparison differs on substrate alone rather than on step budget (the
smolagents default is 50).

### 2.2 Registered systems

`CodeAgentSystem{MiniMed,Gpt52Med,Luna}Chars{1k,2k,5k}GuidedRep{0,1,2}` and
`CodeAgentSystemSonnetChars{1k,5k}GuidedRep{0,1,2}` — 33 arms plus the
`CodeAgentSystem` base class.

### 2.3 Setup

Much lighter than dataflow — **no Texera services needed**.

1. `smolagents` installed in `Kramabench/.venv` (already in `requirements.txt`).
2. **LiteLLM proxy** on `:4000` — the agent points at it via
   `CODE_AGENT_API_BASE` (default `http://localhost:4000`) with
   `CODE_AGENT_API_KEY` / `LITELLM_MASTER_KEY`.
3. `OPENAI_API_KEY` exported — the *scorer* needs it (`llm_paraphrase` and
   `f1_approximate` call `gpt-4o-mini`), independent of the SUT's own model.

```bash
export OPENAI_API_KEY=sk-...
# optional overrides
export CODE_AGENT_API_BASE=http://localhost:4000
export CODE_AGENT_MAX_STEPS=25
```

---

## 3. `ClaudeCodeSystem`

**Claude Code as the agent harness**, driven through the
[Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview)
(`claude_agent_sdk`). Unlike a normal Claude Code session, every built-in tool
(Bash, Read, Write, Edit, Glob, Grep, WebSearch, …) is stripped: the agent is
given **exactly one tool**, an in-process `run_python` MCP tool
(`mcp__py__run_python`). That keeps it comparable to the other two families —
the difference is the harness, not tool access.

### 3.1 The parameters

**Output cap (`max_output_chars`)** — the same observation-budget knob as the
other two families, applied to `run_python` output. Registered at 1k / 5k
(default 5000, `CLAUDE_CODE_MAX_OUTPUT_CHARS`).

**`exec_mode`** — `stateless` runs each snippet in a fresh interpreter;
`persistent` keeps one interpreter alive across steps, so variables survive
between tool calls. The sonnet arms use `persistent`, matching the existing
haiku persistent arms so a model comparison isn't confounded by exec mode.

Also `max_steps` (`CLAUDE_CODE_MAX_STEPS`, default 50).

### 3.2 Registered systems

`ClaudeCodeSystemSonnetChars{1k,5k}Rep{0,1,2}` (6), plus `ClaudeCodeSystem`
(opus-5) and `ClaudeCodeSystemHaiku45{Stateless,Persistent,PersistentChars2k}`.

### 3.3 Setup

1. `claude_agent_sdk` installed in `Kramabench/.venv`.
2. **`ANTHROPIC_API_KEY` exported.** This family talks to the Anthropic API
   **directly** and does *not* go through LiteLLM — so proxy-side settings
   (cache breakpoints, `additional_drop_params`) do not apply to it.
3. `OPENAI_API_KEY` for the scorer, as above.

> That direct path is worth remembering when debugging: a proxy misconfiguration
> can break `DataflowSystem` and `CodeAgentSystem` while `ClaudeCodeSystem`
> keeps passing. Exactly that happened with sonnet-5 — see §4.

---

## 4. Cross-cutting: caching and `message_layout`

`DataflowSystem` renders the same context regardless of layout; only the wire
framing differs.

| Layout | Wire shape | Claude caching |
|---|---|---|
| `block` | one user message | **none** |
| `blockSplit` | `[history][current state]` — two user messages | yes |
| `native` | real assistant/tool-call transcript | yes |

Anthropic reuses a prefix only when an earlier request wrote a cache entry at
that exact boundary. `block` re-renders everything into one message per step,
so the volatile current-state section sits inside the only cacheable unit and
nothing prefix-matches. Splitting the volatile tail into its own message gives
the cache a stable prefix. Measured at the proxy: one message re-wrote all
19,814 tokens on the second call and read 0; the same bytes split in two wrote
10 and read 19,804.

`blockSplit` is content-preserving by construction — `summarize.ts` rebuilds
`head + tail`, compares it against the original render, and falls back to a
single block if they differ. **New Claude dataflow arms should use it.**

OpenAI models cache prefixes automatically and need no breakpoints.

**Model quirks live in the proxy.** sonnet-5 rejects `temperature` outright
(`` `temperature` is deprecated for this model ``), which 400s every dataflow
and code-agent request while ClaudeCode — bypassing the proxy — passes happily.
Handled with `additional_drop_params: ["temperature"]` on `claude-sonnet-5`, so
callers need no per-model special-casing.

---

## 5. Replicates and aggregation

**A replicate is a re-run of an identical configuration.** `Rep1` and `Rep2`
differ only in the model's sampling. They exist because single runs are not
decidable: on a 10-task slice the same config scored 43.5% and 74.0% on
consecutive runs.

Each replicate is its own SUT with its own scratch and results — nothing
aggregates automatically. Aggregate across reps yourself:

```bash
cd benchmark/Kramabench
python3 - <<'PY'
import csv, glob, statistics
HEAD = {"success", "llm_paraphrase", "rae_score", "f1", "f1_approximate"}
means = []
for rep in (1, 2, 3):
    fs = sorted(glob.glob(f"results/DataflowSystemHaikuC4Rep{rep}/environment_measures_*.csv"))
    if not fs:
        continue
    v = [float(r["value"]) for r in csv.DictReader(open(fs[-1])) if r["metric"] in HEAD]
    if v:
        means.append(sum(v) / len(v))
print("per-rep:", [f"{m:.3f}" for m in means])
print("mean:", f"{statistics.mean(means):.3f}",
      "sd:", f"{statistics.stdev(means):.3f}" if len(means) > 1 else "n/a")
PY
```

Report the mean **and** the spread. A gap between two configs smaller than the
spread across reps of either one is not a result.

---

## 6. Defining a new system

Systems are generated from tables, not written one class at a time — add a row
and the replicates come for free.

**Dataflow, new model** (`systems/dataflow_system.py`):

```python
_GRID_MODELS = {"Haiku": "claude-haiku-4.5", "Sonnet": "claude-sonnet-5",
                "GPT5Mini": "gpt-5-mini-medium"}      # <- add "Tag": "litellm-alias"
```

**Dataflow, new config:**

```python
_GRID_CONFIGS = {
    "Anchor": ("delta", 1000, False),   # (context_mode, result_chars, stats_on)
    "C6": ("latest", 2000, True),        # <- new
}
```

**Code agent, new model** (`systems/code_agent_system.py`):

```python
_MATRIX_MODELS = (..., ("Sonnet", "claude-sonnet-5"))
_MODEL_BUDGETS = {"Sonnet": (("1k", 1000), ("5k", 5000))}   # optional; default 1k/2k/5k
```

Generated names are collected in `GRID_SYSTEM_NAMES` /
`CODE_AGENT_MATRIX_NAMES` / `CLAUDE_CODE_SONNET_NAMES` and re-exported at the
bottom of `systems/__init__.py`. Verify before running:

```bash
cd benchmark/Kramabench
./.venv/bin/python -c "
import systems
c = systems.DataflowSystemSonnetC4Rep1()
print(c.model_type, c.context_mode, c.max_operator_result_char_limit,
      c.data_level, c.message_layout)"
```

**Never rebind an existing name.** The generators raise rather than overwrite —
silently redefining a name changes the meaning of results already on disk.

### Register the model's price

A new model alias also needs a row in `systems/cost_utils.py::_FALLBACK`, as
`(input, output, cache_read, cache_creation)` USD **per token**:

```python
"claude-sonnet-5": (3.0e-6, 15.0e-6, 3.0e-7, 3.75e-6),
```

Without it the run still records real token counts but reports
`cost_usd = 0.0`, so the arm looks *free* rather than *unpriced* — the more
dangerous of the two failure modes, because a zero reads as a result.

Prices come from `litellm.model_cost` where available; `_FALLBACK` covers what
litellm lacks (litellm is not installed in this venv, so in practice `_FALLBACK`
is the whole table). Source input/output from published rates; the cache legs
default to read = 10% of input and creation = 1.25x input.

> `claude-opus-5` currently has **no** entry, so `ClaudeCodeSystem` (the opus
> base arm) reports `cost_usd = 0.0`. Its token counts are correct, so cost is
> recomputable once a rate is added.

---

## 7. Running and checking results

```bash
# full workload
bin/bench.sh kb run   --sut DataflowSystemHaikuC4Rep1 --workload environment

# specific tasks (--isolate = one process per task; recommended)
bin/bench.sh kb tasks --sut CodeAgentSystemMiniMedChars2kGuidedRep0 \
    --ids "environment-easy-4 environment-easy-5" --isolate

# tasks that never produced a result
bin/bench.sh kb missing --sut ClaudeCodeSystemSonnetChars5kRep0

# token + cost rollup
bin/bench.sh kb cost --sut DataflowSystemHaikuC4Rep1
```

Env knobs: `KB_MAX_PARALLEL` (default 6) bounds concurrent units;
`KB_LAUNCH_STAGGER` (default 3s) spaces launches;
`KB_EMPTY_TURN_RETRIES` (default 2) retries a turn that returns 0 steps.

### Checking a run

Artifacts land in `system_scratch/{SUT}/{task_id}/`:

| File | Dataflow | CodeAgent | ClaudeCode |
|---|---|---|---|
| `answer.json` / `evaluation.json` | yes | yes | yes |
| `stats.json` (tokens, cache, cost, steps) | yes | yes | yes |
| `react_steps.json` (per-step trace) | yes | — | yes |
| `reasoning_trace.json` | — | yes | — |
| `workflow.json` (the DAG) | yes | — | — |
| `work/` (agent workspace) | — | — | yes |

```bash
python3 -c "
import json
s = json.load(open('benchmark/Kramabench/system_scratch/<SUT>/<task>/stats.json'))
print('steps', s['num_steps'], '| in', s['input_tokens'],
      '| cached', s['cached_tokens'], '| \$', round(s['cost_usd'], 4))"
```

**A broken run still exits 0.** Always check the numbers:

- `num_steps=0`, `input_tokens=0` — the agent never ran. Infrastructure
  failure (duplicate agent-service, cold start), recorded by the scorer as a
  *wrong answer* rather than an error. Treat it as a failed run, not a low score.
- `num_steps=2`, `input_tokens≈200`, `cost=0` — the model rejected the request.
  Read `response.txt`; a proxy `BadRequestError` usually lands here.

Scores are in `results/{SUT}/{workload}_measures_{ts}.csv`. The headline
percentage counts only `success`, `llm_paraphrase`, `rae_score`, `f1`,
`f1_approximate`; `precision` / `recall` / error metrics are recorded but
excluded. **The denominator is the whole workload**, so running 10 of 20 tasks
reports at most 50% — divide by tasks actually run when comparing partial runs.
