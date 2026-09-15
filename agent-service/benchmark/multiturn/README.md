# Multi-turn Dataflow research

Current branch: `feat/multiturn-dataflow-research`. The current milestone merges
`feat/native-python-dataflow` at `8ef6b6201` and adds versioned analytical state.
[The milestone report](MVP_REPORT.md) contains results and limitations.
[RESEARCH_PLAN.md](RESEARCH_PLAN.md) describes the larger investigation.
[REPORT.md](REPORT.md) preserves the earlier V1 batching/recipe experiment.

## Current baseline and treatment

- **Code Agent:** the existing persistent LongDS smolagents wrapper, with its
  ordinary Python environment and no extra reusable-function instructions.
- **Dataflow:** native Python V2 operators and data/flow evidence, with
  `nativeState: true`. Named versions preserve historical definitions, expand
  revisions through dependencies, and promote active references after execution.

The earlier function-guided arm is removed from the current runner. Its historical
results remain reproducible at `c1d6c0a8f`. Python code can naturally define functions.

## Fully isolated backend stack

Run from this worktree, using the supported launcher. Generated credentials and
all state stay outside the repository. The engine is built from this checkout.

```bash
.venv/bin/python agent-service/benchmark/multiturn/isolated_stack.py /tmp/texera-multiturn-mvp
source .venv/bin/activate
bash bin/python-proto-gen.sh
TEXERA_LOCAL_DEV_PROFILE=/tmp/texera-multiturn-mvp/profile.sh bin/local-dev.sh up --skip=frontend --build
```

The private Compose project is `texera-multiturn-mvp`. Agent `3031`, engine HTTP
`18085`, engine cluster `12552`, web `18080`, PostgreSQL `15432`, MinIO `19000`,
LakeFS `18000`, and LiteLLM `14000` are separate from other efforts. The frontend
is unnecessary for these API experiments and is skipped. Python packages may be
shared; running services and mutable workflow/result stores are separate.

Always pass the profile for status, logs, start, or shutdown:

```bash
TEXERA_LOCAL_DEV_PROFILE=/tmp/texera-multiturn-mvp/profile.sh bin/local-dev.sh status
TEXERA_LOCAL_DEV_PROFILE=/tmp/texera-multiturn-mvp/profile.sh bin/local-dev.sh down
```

## State API

Create an agent with native mode, batch tools, V2 catalog, `nativeState: true`,
`nativeProfileCollection: true`, and the desired evidence budgets. Ordinary
sessions retain their existing behavior because the new option defaults off.

```javascript
// Publish after building these operators in the same call or earlier calls.
dataflow({
  operators: [],
  publish: {
    name: "report",
    inputs: {raw: "source", values: "eligible"},
    outputs: {total: "total", regional: "regional"}
  }
});

// Use original logical IDs; the runtime creates new physical IDs downstream.
dataflow({
  operators: [],
  revise: {
    analysis: "report", scope: "active",
    overrides: {eligible: {func: "def apply(row):\n    return row['orders'] >= 5"}}
  }
});

// Distinct historical membership keys select rows from the new value table.
dataflow({
  operators: [],
  revise: {
    analysis: "report", base: "report@1", scope: "temporary",
    bindings: {values: {operator: "new_values", membership: {operator: "eligible", keys: ["id"]}}}
  }
});

dataflow({operators: [], state_catalog: true});
```

An analysis version stores its definitions, named boundaries and outputs, source
content hashes, and physical dependencies. Successful published nodes become
immutable. Revisions share unchanged branches and create changed descendants.
The active reference advances only when every named output has a successful,
complete result bound to the requested operator revision. Temporary versions
remain accessible without changing that reference. Receipts identify created
and reused operator definitions; they do not claim every reused node was a
backend cache hit.

The MVP supports in-memory sessions and explicit local Scan files. Source bytes
must remain unchanged; new data needs a new path. It detects changes rather than
archiving source files. UDFs and Python callbacks can have untracked external
dependencies, and the model must choose the correct
analysis, formula, and input boundary. Workflow checkout is blocked once managed
state exists; use `revise.base` or clear the session. This prototype does not add
selective history retrieval or a mandatory planning call.

## Smoke and real-model runs

Export the private endpoints before running harnesses:

```bash
set -a
source /tmp/texera-multiturn-mvp/profile.sh
set +a
bun agent-service/benchmark/multiturn/state-smoke.ts /tmp/state-smoke-new
python agent-service/benchmark/multiturn/state-study.py generate /tmp/state-study-new
```

Three mechanism families have five turns each. The older customer diagnostic has
nine turns per seed and is a regression case, not three distinct task families.
Generate it with `study.py generate <directory> --seed 41`.

```bash
bun agent-service/benchmark/multiturn/run-native.ts   /tmp/state-study-new/fanout_correction/session.json /tmp/state-dataflow-new state-v2

# Use the multi-turn-optimization LongDS wrapper (its run method accepts reset)
# and a Python environment containing its smolagents dependencies.
python agent-service/benchmark/multiturn/run-code.py   /tmp/state-study-new/fanout_correction/session.json /tmp/state-code-new   --kb-root /path/to/multi-turn-optimization/benchmark/Kramabench   --env-file /path/to/repo/.env

python agent-service/benchmark/multiturn/state-study.py score   /tmp/state-study-new/fanout_correction /tmp/state-dataflow-new
```

Output directories must be fresh. Both runners save prompts, answers, traces,
settings, per-turn token accounting and estimated cost; Dataflow also saves DAGs
and results. Gold is evaluator-only. Every requested field must match; numeric
absolute tolerance is `0.0001`. Recovery attempts run whole sessions from scratch
and remain separate from first-pass scores and costs. No LLM judge assigns success.
