# BobFlow — Learned Context Construction: Design & Implementation Plan

**Status:** Draft v1 (ready to implement Stage 0–2)
**Scope:** Learn a cost-aware utility model over dataflow-derived features to construct the per-step LLM context for the BobFlow dataflow ReAct agent.
**Companion notes:** `ML_TRAINING.md` (raw brainstorm with Claude/GPT). This doc supersedes it for execution.
**Data source:** KramaBench (`/Users/jiadongbai/Desktop/projects/bobflow/Kramabench`).
**Code home:** `agent-service/` (TS extractor + deploy), `agent-service/training/ml/` (Python training).

---

## 0. TL;DR

At each ReAct step the agent has a budget of tokens for context. Today a deterministic renderer (the `flow/data` rung ladder) decides what to put in. We want to **learn** a per-item utility `û(i,t)=f_θ(φ(i,t))` from *exact dataflow features* `φ`, ranked under an exact token cost, and select a coherent context under budget. The supervision comes from **KramaBench subtask checkpoints** (dense, real outcomes) plus **future-use weak labels** read off completed traces. The headline scientific result is the ablation **temporal ≺ flow ≺ flow+execution/data** at matched token budget, with SHAP showing *which* structural facts are load-bearing. The deployable artifact is a tiny model (LightGBM) called once per step.

**The one belief this whole design defends:** in a dataflow agent, "what is worth remembering" is a learnable function of *exact* execution structure (lineage, supersession, cardinality, coercion loss, error propagation) — not a text/recency proxy. The falsifier is explicit (§3.4): if structural features don't beat recency, we have no contribution, and the cheap pilot tells us that first.

---

## 1. Problem statement

### 1.1 The trajectory problem
A BobFlow run is a ReAct loop that edits a versioned dataflow DAG. The full trajectory is complete but accretive: updates and deletions leave stale operator versions, superseded result summaries, and dead branches in the history. Over a long horizon the naive context grows with the *edit history* rather than the *current analysis*, blowing the token budget on low-value items while a faithful "current state" would be small.

### 1.2 What we want
A per-step **budgeted context construction** policy. At step `t`, given a token budget `B`, choose which candidate evidence items to include and at what representation level, to maximize downstream decision quality:

```
maximize   U_t(X)                      (expected downstream decision quality of context X)
subject to Tok(core) + Σ_{i∈X} c(i, ℓ_i) ≤ B
```

where `X` selects optional evidence bundles at chosen representation levels `ℓ_i`, on top of a **mandatory core** (current DAG skeleton). We approximate `U_t(X) ≈ Σ_{i∈X} û(i,t)` initially (additive), `û(i,t)=f_θ(φ(i,t))`, and select by **value-density** `û / c` under the budget.

### 1.3 The relationship we are discovering
The fitted `f_θ` maps observable dataflow features of a context item to its marginal contribution to downstream accuracy under a budget. We claim a *layered* set of relationships (R1–R7, §3.3): existence of signal, **privilege of structural features over recency**, attribution (which features), interaction shape, value-density, the accuracy–token frontier, and transfer across domains/budgets/models.

### 1.4 Non-goals
- Not building a new LLM or a learned summarizer. The summaries are engine-faithful already.
- Not replacing the engine's result computation. We featurize and select; the engine measures.
- Not (initially) a fully set-aware combinatorial `U_t`. We start additive and make the scorer partly set-aware via redundancy features.

---

## 2. Background & prerequisites

### 2.1 BobFlow / agent-service (what exists)
- **ReAct agent** with per-step **snapshot tree**: `src/agent/workflow-snapshot-storage.ts` → `SnapshotData{ id, parentId, reactStepId, workflow: WorkflowContent, results: Map<opId, ResultEntry{info: OperatorInfo, sourceStepId}> }`.
- **Per-operator results**: `src/types/execution.ts` → `OperatorInfo{ state, inputTuples, outputTuples, totalRowCount, inputPortShapes, result, error, warnings, columnStats: Record<string,string> }`. `columnStats` carries reserved diagnostic keys `__table_hints__`, `__join_telemetry__`, `__coercion_telemetry__` and per-column `(<type>)` / `format=<tag>`.
- **Graph features**: `src/agent/workflow-state.ts` → `getDownstreamSinks(opId)`, `getSubDag(targetOpId)` (dependency closure), `getFrontierOperators(depth)`, `getAllLinks()` (fan-in/out).
- **Context renderers (the rung ladder)**: `src/agent/context/decorate/{registry.ts, flow/*, data/*}` (loader-remediation, error-context, graph-audit, cardinality, schema, structural-profile, value-format, coercion/join diagnostics) and reinjection `src/agent/context/select/reinjection/*` (edit count, error reflection). **These are the cost-side serializers we reuse; they are NOT the feature extractor (§3.5).**
- **Tunable context**: env `TEXERA_AGENT_CONTEXT_MODE` (latest/delta), `TEXERA_AGENT_FLOW_LEVEL`, `TEXERA_AGENT_DATA_LEVEL` (0–3). This is an existing *group-ablation axis*.
- **Trace generation**: `benchmark/llm-training-data-generation/{run.ts,protocol.ts,evaluate.ts}` (FeTaQA today). `TraceRecord` persists `snapshots: Record<stepId, WorkflowContent>`, `reactSteps`, `finalWorkflow`, `score`.

### 2.2 KramaBench (the data source)
- End-to-end data-science agent benchmark: 104 tasks / 633 subtasks / 6 domains (archaeology, astronomy, biomedical, environment, legal, wildfire), real data lakes with messy data.
- **Task structure** (`workload/{domain}.json`): `{id, query, answer, answer_type, data_sources, subtasks[]}`; each subtask `{id, step (gold pipeline op description), query, answer, answer_type, data_sources}` → a **gold decomposed pipeline with intermediate ground-truth answers**.
- **Session evaluation** (`benchmark/session_evaluator.py`, `benchmark/session.py`): runs subtasks sequentially with state maintained; `SubtaskResult{score, actual_answer, expected_answer, answer_type, error}`; `SessionResult{chain_accuracy, first_error_step, subtask_results, final_score, all_correct}`. Metrics in `benchmark/metrics.py` (Success/RAEScore/F1/LLMParaphrase by answer_type).
- **BobFlow wiring**: `systems/dataflow_agent_session.py` + `dataflow_agent.py` drive agent-service over `ws://localhost:3001/api/agents/{id}/react`; pull `GET /api/agents/{id}/react-steps` and `/workflow`. Endpoints: backend 8080, CU-mgr 8888, agent 3001, exec 8085.
- **Already generated**: `llm-training-set-v1-kramabench.zip` (~600 per-task bundles: `react_steps.json`, `workflow.json`, `evaluation.json`, `stats.json`, `ground_truth.json`), 3 `DataflowSystemLocalLlm30BV*_failed_tasks.zip` (hard negatives), `results/` (69 SUT config variants incl. Latest/Delta, StatsOn/Off, Cap0/1 → an existing config sweep), `system_scratch/` (110 configs).

### 2.3 The one capture gap (must fix before v2 data)
Trace capture persists only **final** `workflow.json` and **text** tool-results. It drops the per-step structured `SnapshotData.results` (the `OperatorInfo` map). Consequence: flow/graph features are *reconstructable* by replaying tool calls; **execution/data features live only as rendered text**. Fix = persist per-step `{workflow, results}` (Stage 0).

### 2.4 Notation / glossary
- `t` — ReAct step index. `i` — candidate evidence item. `ℓ ∈ {0,1,2,3}` — representation level.
- `φ(i,t)` — feature vector (function of state **≤ t**). `c(i,ℓ)` — token cost of item `i` at level `ℓ`.
- `û(i,t)` — predicted utility. **Core** — mandatory always-in context (current DAG skeleton).
- **Segment** — the trajectory steps between two KramaBench subtask checkpoints.

---

## 3. Formulation

### 3.1 Candidate unit & mandatory core
- **Mandatory core** (never a candidate, always rendered): current DAG skeleton = `{op ids, descriptions, version state, edges}` + the task `T`. This guarantees graph coherence.
- **Candidate `i`** = an **evidence bundle** keyed on an operator (or a historical attempt): `{op result summary, structural profile, schema, diagnostics, attempt/error history, superseded versions, lineage diagnostics}`.
- **Candidate set `U_t`** = **every** bundle that exists at step `t`, *including stale/superseded/dead ones a heuristic would drop*. (This exhaustiveness is the point — §3.5.)

### 3.2 Representation levels (the action space = existing rung ladder)
For each candidate, the selector chooses a level:
```
ℓ=0  drop (skeleton only)
ℓ=1  compact summary        (≈ data L1)
ℓ=2  + structural profile / schema   (≈ data L2 + flow L2)
ℓ=3  + full history / sample rows / attempt diffs  (≈ L3)
```
Cost `c(i,ℓ)=Tok(serialize(i@ℓ))` is computed by the **real renderers** so training cost == deploy cost. Selection is a **grouped (multi-choice) knapsack**: at most one level per candidate.

### 3.3 The relationships to discover (claim order)
- **R1 Existence** — does `φ` predict utility at all? (AUC of `φ→future-use`; corr `φ→checkpoint Δ`.)
- **R2 Privilege (headline)** — `{temporal} ≺ {+flow} ≺ {+flow+exec/data}` at **matched token budget**, measured on downstream accuracy. (Partly minable from existing `results/` sweep.)
- **R3 Attribution** — SHAP: *which* dataflow facts carry signal (target sentence: "lineage/coercion/error-propagation dominate; absolute recency contributes little").
- **R4 Shape** — interactions/nonlinearity (e.g. supersession matters only off live path; cardinality alarms only on errored ops).
- **R5 Value-density** — which features predict Δaccuracy **per token** (the budget-relevant object), not just Δaccuracy.
- **R6 Frontier** — learned cost-aware selection vs {snapshot, FIFO, recency-cap, deterministic preset, oracle} on the accuracy–token Pareto frontier.
- **R7 Transfer** — hold-out **domain** (train 5, test wildfire), hold-out budget, cross-model.

### 3.4 Falsifier (state up front)
If R2 collapses (`temporal ≈ flow ≈ flow+data`) or R3 shows only `is_current_version`/recency matter, then `f_θ` has rediscovered the snapshot heuristic and there is **no contribution**. The cheap Tier-0 pilot (Stage 2) must clear this bar before any heavier investment.

### 3.5 Design principle: extractor ≠ assembler
The runtime assembler is **forward, lossy, text-output, current-snapshot-only**. The training featurizer is **retrospective, exhaustive, vector-output, full-prefix (+future for labels)**. They share *only* the cost function. Rationale: you can only learn "looked droppable but was load-bearing" if you featurize the items the heuristic throws away.

| | Runtime assembler | Training extractor |
|---|---|---|
| coverage | rendered subset | **all candidates `U_t`** |
| output | text | numeric `φ∈ℝ^d` |
| time | snapshot at `t` | prefix `≤t` (features) + future (labels) |
| featurize vs select | fused | decoupled (pure `φ`) |

---

## 4. Feature definition (`φ`)

Every feature is `φ: (item, state ≤ t) → ℝ`, computed for **all** candidates, **no future leakage**. Families **B, D, E** are *new* relative to the renderer and carry the learning leverage. Source column: `engine`=from `OperatorInfo`, `graph`=from `WorkflowState`, `derived`=replay/prefix.

### A. Structural / lineage (flow) — source: graph
| name | type | def |
|---|---|---|
| `on_live_path` | bin | i on a source→current-frontier path |
| `dist_to_frontier` | int | min hops i→frontier (∞→capped) |
| `in_closure_of_current_op` | bin | i ∈ `getSubDag(currentOp)` |
| `fan_in`, `fan_out` | int | link degrees |
| `reaches_no_sink` | bin | dead load (`getDownstreamSinks`==∅) |
| `depth_from_source` | int | topo depth |
| `n_ancestors`, `n_descendants` | int | closure sizes |

### B. Version / temporal — *dynamic, prefix-spanning* (NEW) — source: derived
| name | type | def |
|---|---|---|
| `is_superseded` | bin | a newer version of this op exists |
| `n_revisions`, `n_errored_revisions` | int | edit/error counts on this op |
| `steps_since_created/last_edit/last_referenced` | int | staleness in steps |
| `edit_churn` | float | revisions per step-alive |
| `convergence` | cat{shrinking,stable,oscillating} | trend of error sequence |
| `stale_wrt_inputs` | bin | produced before its last upstream change |

### C. Execution / data quality — source: engine (needs Stage 0 fix)
| name | type | def |
|---|---|---|
| `run_state` | cat | completed/failed/running |
| `error_class` | cat | parsed exception class (or none) |
| `in_card`, `out_card`, `kept_ratio` | int/float | cardinalities, `out/max_in` |
| `empty_output`, `fanout_explosion` | bin | degenerate transitions |
| `schema_width` | int | #columns |
| `coercion_dataloss_rows`, `coercion_flag` | int/bin | from `__coercion_telemetry__` |
| `join_match_ratio`, `join_flag` | float/bin | from `__join_telemetry__` |
| `dirty_load_flags` | bin×k | from `__table_hints__` |
| `value_format_flags` | bin×k | currency/percent/thousands |

### D. Set-relative / redundancy (NEW; renderer can't) — source: derived
| name | type | def |
|---|---|---|
| `schema_jaccard_max` | float | max schema overlap vs other candidates |
| `summary_redundancy` | float | similarity of summary to others |
| `marginal_novelty_vs_core` | float | new columns/info beyond the core |
| `rank_on_recency`, `rank_on_distance` | ord | rank among sibling candidates |

### E. Outcome-history — *past* outcomes only (NEW) — source: derived
| name | type | def |
|---|---|---|
| `last_edit_fixed_error` | bin | error present before, gone after last edit |
| `downstream_consumer_errored` | bin | error propagation signal |
| `caused_prior_subtask_failure` | bin | from checkpoints ≤ t |

### F. Task-conditioned (cheap/interpretable) — source: derived
| name | type | def |
|---|---|---|
| `sim_desc_task` | float | token-overlap (or 1 small embedding) op-desc vs task query |
| `sim_desc_thought` | float | op-desc vs current thought |
| `col_overlap_task_entities` | float | columns ∩ task entities |

### G. Cost (the bridge) — source: renderers
| name | type | def |
|---|---|---|
| `tok_level_0..3` | int | `Tok(serialize(i@ℓ))` via real renderers |

**Leakage rule (enforced by test, §8.2):** A,C read snapshot `≤t`; B,D,E,F read prefix `≤t`; G is content-only. Anything reading `>t` is a **label**, never a feature.

---

## 5. Label definition & row schema

### 5.1 Label tiers (increasing cost/validity)
- **`y_future_use`** (weak, free; from trajectory `>t`): ordinal `0=unused-or-deleted, 1=later-referenced, 2=on-final-output-lineage`. Non-circular (reads future structure). Plus the raw bits: `on_final_lineage`, `later_referenced`, `deleted_or_superseded_later`, `predecessor_of_later_insert`.
- **`seg_checkpoint_score`** (KramaBench, dense): the `SubtaskResult.score` at the next checkpoint after `t`, attributed to items present in that segment; `seg_checkpoint_correct = score ≥ τ`.
- **`y_cf_delta`** (counterfactual, small N, nullable): Δ(next-checkpoint score) from include/exclude replay — the per-item validity anchor.
- **`y_gold_aligned`** (optional, external/non-circular): i aligns to a gold subtask `step` functionality.

### 5.2 Row schema (one row per `(trace, step, candidate)`, JSONL)
Single source of truth: `agent-service/src/training/schema.ts` (TS type + JSON-schema export).
```
# identity / strata
trace_id, task_id, domain, difficulty, run_config{model,context_mode,flow_level,data_level,caps}
step_t (int), subtask_id, segment_idx (int)
candidate_op_id, candidate_kind ∈ {operator, attempt, superseded_version, diagnostic}
group_id = (trace_id, step_t)          # the LambdaMART query group

# features  (§4)  — flat columns, families A–G
phi__on_live_path, phi__dist_to_frontier, ... , phi__tok_level_0..3

# labels  (§5.1)
y_future_use (0/1/2), y_on_final_lineage, y_later_referenced,
y_deleted_or_superseded_later, y_predecessor_of_later_insert,
seg_checkpoint_score (float|null), seg_checkpoint_correct (bool|null),
y_gold_aligned (bool|null), y_cf_delta (float|null)
```
Conventions: missing engine feature → explicit `null` + a `*_present` bit (never silent 0). Categorical → small fixed vocab + `other`.

---

## 6. Data generation pipeline

### 6.1 Stage 0 — feature-complete capture
- **agent-service**: serialize per-step `{workflow, results: OperatorInfo map}` in the trace. Touch `benchmark/llm-training-data-generation/{run.ts,protocol.ts}` (add `results: Record<stepId, Record<opId, OperatorInfo>>` to `TraceRecord`; the live agent already holds `turn.snapshots[].results`). Optionally expose via `GET /api/agents/{id}/snapshots`.
- **KramaBench**: `dataflow_agent.py` already pulls `react-steps`/`workflow`; also pull/persist per-step structured results into the per-task bundle (`snapshots.json`).
- **Acceptance**: a regenerated trace contains, for ≥1 step, structured `columnStats`/`error`/`row counts` per op (asserted by a unit test).

### 6.2 Stage 1 — retrospective extractor (TS, `agent-service/src/training/`)
Per completed KramaBench session trace:
1. `replay.ts`: reconstruct DAG state at each step `t` from `createOrModify/delete` tool calls (and attach Stage-0 structured results).
2. `candidate.ts`: enumerate full `U_t` (incl. stale/superseded/dead) + define the core.
3. `features/*.ts` + `featurize.ts`: compute `φ(i,t)` (families A–G), leakage-guarded.
4. `labels.ts`: compute future-use weak labels from trajectory `>t`.
5. `cost`: call real renderers for `tok_level_0..3`.
6. `extract.ts` (CLI): `bun run extract --traces <dir> --out rows.jsonl`.
- **Acceptance**: golden-trace test (§8.2) — committed sample trace → stable row count + spot-checked feature values; leakage test passes.

### 6.3 Stage 1b — label join (Python, `training/ml/join_labels.py`)
Join `rows.jsonl` with KramaBench `session_result.json` (`subtask_results[].score`, `first_error_step`, `chain_accuracy`) on `(task_id, segment_idx/subtask_id)` → fill `seg_checkpoint_*`. Optionally compute `y_gold_aligned` by matching agent ops to gold `step` text (embedding/keyword).
- **Acceptance**: every row has a non-null `y_future_use`; ≥X% have a `seg_checkpoint_score`; join report printed.

### 6.4 Stage 4 — feature-guided active counterfactuals (later)
Use the Tier-0 model's **uncertainty** + **feature-space coverage** + **weak-label/checkpoint disagreement** to pick `(t,i)` for include/exclude replay (via agent-service replay-from-snapshot). Score at the *next* subtask checkpoint vs gold → `y_cf_delta`. Budget-bounded (e.g. N≈500 rollouts). This is "features generating data."

---

## 7. Model & analysis (Python, `training/ml/`)

- **Model**: LightGBM **LambdaMART** ranker; query group = `group_id=(trace,step)`; relevance = `y_future_use` (0/1/2), optionally outcome-weighted by `seg_checkpoint_score`. (Also fit logistic/GBDT classifier of `seg_checkpoint_correct` for R1/R3 sanity.) Start small — feature sufficiency, not capacity, is the contribution.
- **Selector** (`select.py`): rank by predicted **value-density** `û/c(i,ℓ*)`; grouped-knapsack over levels; core pre-charged. **Baselines**: snapshot (current-version only), FIFO, recency-cap, the deterministic `flow/data` preset, oracle (label-perfect).
- **Splits**: by **task** and by **domain** (held-out-domain for R7). Never split within a trace.
- **Experiments → relationships**:
  - R1: ranking AUC / NDCG@budget; corr to checkpoint Δ.
  - R2: train on feature-group masks `{temporal}/{+flow}/{+flow+data}`; compare downstream accuracy at matched budget. (Pre-study: mine `results/` config sweep CSVs.)
  - R3: SHAP global + per-family importance.
  - R4: partial dependence + 2-way interactions.
  - R5: refit on `Δ-per-token` target; compare feature importances vs R3.
  - R6: accuracy–token Pareto frontier vs baselines (the systems plot).
  - R7: held-out-domain / budget / model transfer.

---

## 8. Evaluation & E2E testing

### 8.1 Offline metrics
NDCG@budget, future-use AUC, checkpoint-correctness AUC; per-domain; vs baselines + oracle.

### 8.2 Tests for the extractor (the implementation must ship these)
- **Unit**: each `features/*.ts` function on a hand-built 4-op fixture (asserted numeric outputs).
- **Golden-trace**: one committed KramaBench trace → snapshot-tested row count + selected feature columns (catches regressions in replay/featurize).
- **Leakage test** (critical): permute / truncate the trajectory *after* step `t`; assert every `phi__*` value is unchanged (only labels may change). Fails the build on leakage.
- **Cost-parity test**: `tok_level_ℓ` from the extractor == tokens the live renderer emits for the same item (shared code, asserted on fixtures).

### 8.3 Training smoke test
`train.py --sample` on a few hundred rows runs end-to-end and emits a model + SHAP plot + the R2 ablation table (CI-able).

### 8.4 Deployed selector + A/B (the real e2e)
- Add a `learned` context mode beside `latest/delta` (env `TEXERA_AGENT_CONTEXT_MODE=learned`, model path via env) in agent-service; the selector consumes the live `SnapshotData` (same `φ`, computed online from state ≤ t).
- **Regression gate**: existing `cd agent-service && bun run e2e` must stay green with the learned mode (10/10 workflows complete).
- **A/B**: run KramaBench `evaluate_sessions.py --system DataflowAgentSession` for `learned` vs deterministic preset on a held-out domain; compare `chain_accuracy`, `final_score`, tokens. Success = no accuracy regression at lower tokens, or higher accuracy at matched tokens (a frontier win).

---

## 9. Implementation stages (files · effort · acceptance)

| Stage | Deliverable | Key files | Effort | Acceptance test |
|---|---|---|---|---|
| **0. Capture fix** | feature-complete traces | `benchmark/.../run.ts`,`protocol.ts`; KramaBench `dataflow_agent.py` | 0.5–1d | regenerated trace has structured per-step `OperatorInfo` (unit test) |
| **1. Extractor** | `rows.jsonl` from traces | `src/training/{schema,replay,candidate,featurize,labels,extract}.ts`, `features/*.ts` | 3–5d | golden-trace + leakage + cost-parity tests pass |
| **1b. Label join** | labeled rows | `training/ml/join_labels.py` | 1d | all rows have `y_future_use`; checkpoint coverage report |
| **2. Pilot model (go/no-go)** | R1–R3 on v1 data | `training/ml/{train,select}.py` | 2–3d | R2 ablation table + SHAP; **decide vs §3.4 falsifier** |
| **3. Frontier + baselines** | R5,R6 plots | `training/ml/select.py` | 2–3d | Pareto frontier vs 5 baselines; per-domain |
| **4. Active counterfactuals** | `y_cf_delta` (N≈500) | `training/ml/counterfactual.py` + replay endpoint | 1–1.5wk | calibration of Tier-0 vs CF; uncertainty-sampling beats random |
| **5. Deploy + A/B** | `learned` context mode | `src/agent/context/select/learned.ts` + env wiring | 3–4d | `bun run e2e` green; KramaBench A/B frontier win |

**Critical path to a go/no-go answer:** Stages 0→1→1b→2 (≈1.5 weeks). Stage 2 decides whether the rest is worth building. Stages 3–5 only proceed if R2 clears the falsifier.

---

## 10. Directory & artifact layout
```
agent-service/
  src/training/                 # TS extractor (reuses WorkflowState + renderers)
    schema.ts                   # row schema = single source of truth
    replay.ts candidate.ts featurize.ts labels.ts extract.ts
    features/{flow,version,execution,redundancy,outcome,task,cost}.ts
    __tests__/                  # unit + golden-trace + leakage + cost-parity
  src/agent/context/select/learned.ts   # Stage 5 deployed selector
  training/ml/                  # Python
    join_labels.py train.py select.py counterfactual.py
    requirements.txt | or pyproject extra [ml]: lightgbm, shap, scikit-learn, pandas
data/training/                  # generated rows.jsonl, models, plots (gitignored)
```
Python deps: add `[project.optional-dependencies] ml = ["lightgbm","shap","scikit-learn","pandas"]` to root `pyproject.toml`; install via `uv sync --extra ml`.

---

## 11. Decisions locked / open questions

**Locked:**
- Unit = operator-at-step evidence bundle + mandatory DAG-skeleton core.
- Model = LightGBM LambdaMART, deployed directly (no distillation; small model, negligible runtime).
- Action space = per-op representation level (the existing rung ladder), cost from real renderers.
- Labels = Tier-0 future-use (now) + KramaBench checkpoints (dense) + small CF set (anchor). Splits by task/domain.
- Extractor is a separate exhaustive/retrospective module, not the runtime assembler.

**Open (resolve during Stages 1–2):**
- Future-use grade thresholds and whether to outcome-weight the relevance label.
- Embedding vs token-overlap for task-conditioned features (start token-overlap for interpretability).
- Segment→item attribution rule for `seg_checkpoint_score` (all items live in segment vs only items edited in segment).
- Whether `results/` config-sweep is directly comparable enough to serve as the R2 pre-study (config drift across SUT variants).

**First action:** Stage 0 + Stage 1 (extractor over existing `llm-training-set-v1-kramabench.zip`) in parallel with mining `results/` for an early R2 signal.
