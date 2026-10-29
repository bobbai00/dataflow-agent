# Learned context selection — end-to-end (v1)

A working, measured end-to-end slice of the learned context-selection pipeline:
recorded traces → feature extraction → trained utility model → **representation-
level** runtime selector → live evaluation. Every stage is real code that runs;
scaling up is turning dials, not building the rest.

This operationalizes `LEARNED_CONTEXT_SELECTION_ACTION_PLAN.md` and folds in the
`benchmark/context-ml/` prototype's findings. Where the plan is a 15–20 day
production build, this is the vertical slice that proves the loop and de-risks it.

---

## 0. What "learned context selection" means here

Every ReAct step, the agent's context is re-assembled from a git-like snapshot of
the dataflow. The lever is **per-operator representation level**: each operator's
latest result can be rendered at `omit ≺ shape (schema only) ≺ sample (rows) ≺
sample+stats`. The question: *given the dataflow state + task, which operators
deserve which level, under a token budget?*

- **Rule selector** (shipped): hand-tuned policy over features → levels.
- **Learned selector** (this doc): a trained utility model scores each operator;
  a budget knapsack assigns levels by utility density — **compress, don't drop**.

The core (task, DAG skeleton, per-op schema line) is never removed; only the
*result body* representation is selected.

## 1. Architecture (all stages built)

```
recorded traces ──importReActSteps──► per-step Dossier
       │                                   │
       │                          perOperatorMLFeatures  ◄── SAME code ──┐
       ▼                                   ▼                             │
  loadBearingOps (label)            FEATURE_NAMES vector                 │
       └──────────────┬─────────────────┘                               │
                      ▼                                                  │
             features.csv (4351 rows)                                    │
                      ▼                                                  │
         training/ml/train.py  (logistic + ablation falsifier)          │
                      ▼                                                  │
             model.json  ──buildUtilityModel──►  UtilityModel (TS) ──────┤
                                                        ▼                │
                          RUNTIME: buildDossier → perOperatorMLFeatures ─┘
                                   → model.score → budget knapsack
                                   → SummarizeParams → summarize()
```

Key modules (`src/agent/context/learned/`): `features-ml.ts` (feature vector, used
BOTH offline and at serve → parity by construction), `label.ts` (future-use weak
label), `model.ts` (TS evaluator + stale-model guard), `score.ts` (utility →
representation-level knapsack). Wiring: `server.ts` assembler precedence
`learned > tuner > selector > legacy`; `AgentSettings.learnedConfig`.

## 2. Features (31) and the leakage rule

Reuses the committed `extractFeatures` (role, editCount, stepsSinceEdit, wide,
dirtyLoad, categoricalLowCard, numericAsText, …) and ADDS what the base set
lacked and the prototype found dominant:
- **`log_rows`** — the prototype's single strongest feature (was absent).
- **graph/lineage** — n_upstream/downstream, n_ancestors/descendants, depth,
  is_sink, dist_to_frontier.
- **task lexical overlap** (op summary vs task question).

Leakage rule (enforced by construction): every feature reads state **≤ t** only —
the dossier is built from the step-t prefix, so its leaf snapshot IS the DAG at t.
The label (future-use) reads the final DAG and is never a runtime input.

## 3. Offline results — the falsifier (real numbers)

Training set: the 60 recorded KramaBench traces (haiku) replayed through the
runtime feature code → **4,351 rows, positive rate 0.532**. Grouped 5-fold CV by
trace (no trace leaks across folds):

| ablation | LogReg AUC | LogReg AP | GBDT AUC |
|---|---|---|---|
| recency-only | 0.720 | 0.739 | 0.777 |
| role-only | 0.845 | 0.815 | 0.845 |
| **flow-only** | **0.893** | 0.886 | 0.903 |
| flow+temporal | 0.914 | 0.907 | 0.927 |
| flow+data | 0.914 | 0.918 | 0.936 |
| **all** | **0.922** | 0.922 | 0.947 |

**Falsifier: PASS.** Dataflow structure beats recency by **+0.172 AUC** (flow-only
0.893 vs recency 0.720); all features +0.202. This is the go/no-go from the action
plan (§3.4) — the contribution is real, not a recency proxy. It independently
reproduces the `context-ml` prototype (recency 0.696 / flow 0.871 / all 0.944) on
the *runtime* feature code.

Top standardized coefficients: `n_descendants (+4.16)`, `n_downstream (−3.13)`,
`depth (+1.96)`, `is_source (+1.92)`, `n_ancestors (+1.82)`, `log_rows (+1.22)` —
pure dataflow structure + table size.

Domain holdout (train 5 domains, test 1; the transfer question): mean AUC **0.920**
(astronomy 0.967, biomedical 0.957, legal 0.929, environment 0.910, wildfire 0.837).
Structure transfers across domains. (Cross-*model* transfer is the known caveat —
the prototype saw 0.95→0.72 haiku→gpt-5-mini; train per agent model.)

TS/Python inference parity: **max |Δ| = 2.2e-16** over 40 rows (machine epsilon).

## 4. Deterministic cost replay (all 60 traces, no LLM)

The context is a pure function of `(dossier, params)`, so the render-policy token
delta can be measured exactly by re-rendering every recorded step under LATEST vs
learned and summing summarize()'s own token counts (`cost-replay.ts`). This holds
the trajectory fixed — isolating the render cost from live variance. It is the
faithful lower bound on the cost win and needs no stack.

Budget sweep (learned vs shipped lean LATEST, 60 traces, 1.02M baseline tokens;
v1 default = flow-alarms off, pure cost play):

| budget | overall token reduction | mean per-trace |
|---|---|---|
| 1000 | **23.6%** | 20.8% |
| 2000 | 22.2% | — |
| 4000 | 19.3% | 16.9% |
| 8000 | 17.1% | — |

Monotonic and as-designed: a tighter budget compresses more low-utility result
bodies to `shape`. The biggest wins are the long/wide multi-source traces
(wildfire-hard-17 on a 114k-token trace; astronomy-hard-10, biomedical-hard-4).

**Honest caveat.** The learned mode still adds one thing lean LATEST omits: a per-op
schema line (the always-kept "core"). So a few small traces net slightly *negative*
(worst: biomedical-easy-6 −6.3%) — the schema line exceeds the rows saved on a
tiny table. Turning the optional flow-alarms/stats insurance ON trades ~4pts of the
headline for accuracy safety (15.8% with alarms on). The knob surface makes this an
explicit choice, not a hidden regression.

## 5. Live end-to-end evaluation

Arms run via `run.ts` (`TEXERA_SETTINGS_JSON` injects each arm's settings) on the
live stack (agent-service + 8 JVM services + LLM gateway); aggregated by
`learned-e2e-report.ts`. Metric per (task, arm): passed, score, **context tokens =
Σ provider `usage.inputTokens`** (the real re-rendered-context cost), step count.

- **latest** — the shipped lean LATEST baseline.
- **learned** — `learnedConfig {budgetTokens: 4000}`.

The live loop is validated end-to-end (agent turn under `learnedConfig` fires the
learned assembler — server log: `learned model loaded: 4351 rows, cvAUC 0.922`).

**Result (gpt-4o, 3 tasks, n=1/arm) — and the honest lesson it teaches:**

| task | latest (pass/tok/steps) | learned (pass/tok/steps) |
|---|---|---|
| archeology-easy-3 | ✓ 19,716 / 5 | ✓ 20,338 / 5 |
| archeology-easy-10 | ✗ 9,331 / 3 | ✗ 120,539 / **26** |
| environment-hard-15 | ✗ 14,670 / 4 | ✗ 103,856 / **22** |

Taken at face value this looks catastrophic (+460% tokens). **It is not a valid
result — it is a variance demonstration.** The step count is wildly unstable
run-to-run for gpt-4o with no seed (temperature 0.2): an earlier smoke of
archeology-easy-10 on the *latest* arm took 9 steps; this run's latest took 3;
this run's learned took 26. A single 26-step thrash spiral (which can hit either
arm) swamps everything at n=1. This is precisely the failure mode the action
plan's **mandatory noise floor (ε=2σ) + reps + a capable model** exist to prevent —
observed firsthand. Two things are nonetheless real and worth stating:

1. **Per-step cost ≠ total live cost.** The deterministic replay (§4) proves the
   learned render is ~19% cheaper *at a fixed trajectory*. But live, context
   changes *behavior*: if compression drops something a (weak, off-model) agent
   needed, it can thrash and total cost explodes. The future-use label optimizes
   per-step utility, not trajectory outcome — the proxy gap the method docs warn of.
2. **This model is off-distribution here.** It was trained on haiku traces and
   served to gpt-4o; the prototype already measured utility does not transfer
   across agent models (AUC 0.95→0.72). Serving a haiku-trained selector to gpt-4o
   is expected to misfire.

**Conclusion for the live endpoint:** not yet demonstrable with this setup. The
trustworthy signal today is the deterministic §4 cost result; a valid live verdict
needs (a) a capable model, (b) per-model retraining, (c) reps + noise floor, and
ideally (d) counterfactual labels (§5-scaleup). The harness for all four is built;
what remains is compute, not code.

## 5. How to reproduce / scale up

```bash
# 1. offline feature set (deterministic, no LLM)
bun run benchmark/llm-training-data-generation/scripts/dump-features.ts \
    --out benchmark/llm-training-data-generation/output/learned/features.csv
# 2. train + falsifier + export model.json
.venv/bin/python agent-service/training/ml/train.py \
    --csv .../output/learned/features.csv --out src/agent/context/learned/model.json
# 3. live A/B (per arm)
TEXERA_AGENT_MODEL=gpt-5.2 TEXERA_TASK_IDS=<ids> \
  [TEXERA_SETTINGS_JSON='{"learnedConfig":{"budgetTokens":4000}}'] \
  bun run benchmark/llm-training-data-generation/run.ts --source kramabench --output <dir>
# 4. compare
bun run .../scripts/learned-e2e-report.ts --arm latest=<dir> --arm learned=<dir>
```

**Scale-up path (in priority order):**
1. **Capture v2** (full-state traces): today's offline features are reconstructed
   from rendered text via `importReActSteps` (lossy — dtypes/null-rates/join-key
   overlap not recoverable). Serializing raw `OperatorInfo` per step removes the
   train (regex) vs serve (live) skew and unlocks the data-quality features the
   prototype couldn't build.
2. **Counterfactual labels** (ΔQ): the future-use label is a cheap proxy. The
   replay harness (checkpoint → variant context → 1 step → score) upgrades it to
   the interventional label the method docs specify — with a mandatory noise floor
   (ε = 2σ, no seed support) so a real signal isn't lost in temperature noise.
3. **Per-model training**: utility does not transfer blind across agent models;
   re-collect + retrain per deployed model (haiku ≠ gpt-5.x base rates differ).
4. **Bundles beyond live operators**: extend from per-operator results to the
   method docs' historical-attempt / superseded / deleted bundles.

## 6. Honest limitations (v1)

- **Label is a proxy.** Future-use (ancestor-closure of the answer sink) is
  cheap and offline but not counterfactual — it says "load-bearing," not "helps
  the model this step." Coverage/AUC ≠ live accuracy. §4 is the real test.
- **Trained on haiku traces.** The model bundled today learned from haiku
  trajectories; serving it to gpt-5.x is off-model until re-collected (§5.3).
- **Lossy features.** Reconstructed from rendered text (capture-v2 fixes it).
- **Small corpus.** 60 traces, 4,351 rows; CV variance is visible. Directional,
  not a production model.
