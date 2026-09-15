# Multi-turn Dataflow research

This is an exploratory diagnostic, not a replacement for LongDS or a representative leaderboard. It tests definition rollback, fixed cohort membership, changed data, temporary branches, and preservation of published results. Nine related requests operate on two deterministic customer exports. Seeds change the numeric data; they do not create independent task families.

## Isolation

The research branch is `feat/multiturn-dataflow-research`, forked from committed `feat/native-python-dataflow` at `aa3841145`. Its service uses port **3021** and launcher state/logs under `/tmp/texera-multiturn-dataflow-research`. The other backend services are shared. No engine deployment is required for these experiments.

Start only the research service from this worktree:

```bash
TEXERA_AGENT_SERVICE_PORT=3021 \
TEXERA_LOCAL_DEV_DIR=/tmp/texera-multiturn-dataflow-research \
TEXERA_COMPUTING_UNIT_ENDPOINT=http://localhost:8888 \
TEXERA_FILE_SERVICE_ENDPOINT=http://localhost:9092 \
bin/local-dev.sh up agent-service --skip-build
```

The live shared backend rejected V2's structured-result request with HTTP 400. Therefore the measured arms use **V1 native batching**. The recipe implementation supports both catalog representations, but these runs do not qualify V2 execution, typed scalar transport, profiles, or the parent branch's uncommitted optimization work.

## Prototype

`settings.nativeRecipes: true` extends `dataflow` with:

```json
{
  "operators": [],
  "reuse": {
    "recipe": "initial",
    "targets": ["report"],
    "bind": {"eligible_customers": "replacement_members"},
    "prefix": "local"
  }
}
```

Save a definition using `save_as: "initial"` on its original batch. Names are immutable. Reuse traverses backward from the requested targets, stops at explicit bindings, shares matching live definitions, and restores changed definitions under fresh IDs. Ordinary batch validation and execution handle the resulting graph. A positional adapter preserves UDF source when inputs change.

A recipe freezes **definitions**, not source-file contents or successful output values. Inputs with identical paths are not independently fingerprinted by this prototype. The engine owns execution and cache validity. The in-memory recipe store is experimental: it survives tool rebuilding and resets with clear-history; durable session export and checkout-aware recipe visibility are future work.

`settings.userTaskPlacement: "chronological"` keeps requests at their actual positions in the native DELTA transcript. The existing `top` and `bottom` modes remain available. This option is intended for the flat native transcript used here; other context layouts need separate qualification.

## Reproduce

Generate data and evaluator-only gold:

```bash
python agent-service/benchmark/multiturn/study.py generate /tmp/study/seed41 --seed 41
```

Run one Dataflow session (the output directory must be new):

```bash
TEXERA_AGENT_SERVICE_ENDPOINT=http://localhost:3021 \
TEXERA_COMPUTING_UNIT_ENDPOINT=http://localhost:8888 \
TEXERA_FILE_SERVICE_ENDPOINT=http://localhost:9092 \
bun agent-service/benchmark/multiturn/run-native.ts \
  /tmp/study/seed41/session.json /tmp/study/runs/batch batch-chronological
```

Arms: `batch`, `recipes`, `batch-bottom`, `recipes-bottom`, `recipes-guided-bottom`, `batch-chronological`, `recipes-guided-chronological`. Guided arms add a worked, domain-independent example of selecting a recipe and binding an input. The unguided arm measures spontaneous adoption.

Run the existing LongDS smolagents wrapper using a Python environment containing its dependencies:

```bash
python agent-service/benchmark/multiturn/run-code.py \
  /tmp/study/seed41/session.json /tmp/study/runs/code \
  --kb-root /path/to/Kramabench --env-file /path/to/repo/.env
```

`--functions` is an additional control that encourages reusable parameterized Python functions. It does not give the code agent a prewritten solution or the Dataflow graph engine.

Score without an LLM judge:

```bash
python agent-service/benchmark/multiturn/study.py score /tmp/study/seed41 /tmp/study/runs/code
```

## Measurement

- Same Luna model, 25 steps per request, 2,000-character result/print budget. Native tool messages and smolagents execution are inherently different protocols.
- Public prompts and data paths are shared; gold is never included in a prompt. Both preserve a single agent session across requests.
- Exact ranked region names; numeric absolute tolerance `0.0001` percentage points. A request passes only if every requested field passes.
- Full per-turn traces, answers, settings, token classes, model-call counts, and Dataflow graph/results are saved. User-message token estimates are excluded from billable native usage.
- Cost uses repository Luna accounting: $0.20/M uncached input, $0.02/M cached input, $1.20/M output. This is an estimate, not an invoice. Cache state is shared, so compare cached-aware and cache-normalized costs and inspect cold/warm starts.
- Calibration variants and failed hypotheses remain in the artifact directory. Do not pool them as independent benchmark cases or attribute a non-adopted feature's outcome to its algorithm.
- Before freezing a failure comparison, use the same two additional recovery rounds for all affected arms, retaining original outcomes and costs. This exploratory study reports first-pass accuracy separately.

See `REPORT.md` for measured outcomes and the next benchmark design.
