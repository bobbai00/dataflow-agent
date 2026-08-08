# BobFlow Learned Knob Tuning: Study Plan & Training-Data Generation

**Goal:** study the relationship between the agent's tuning knobs (result sampling size,
stats on/off and richness, char limits, context window, …) and LLM **accuracy + token
cost**, then train a **parameter tuner** — a policy that chooses knob settings, first
per-task, ultimately **per-step during the run** (e.g. raise a source operator's sample
size while the load is being debugged, shrink it once the schema has converged).

**Relation to prior docs:** `ML_TRAINING_PLAN.md` / `bobflow_context_selection_training_pipeline.md`
learn *which context items* to include. This plan learns *how the observations and
context are parameterized*. It reuses their checkpoint/replay machinery (§10) and the
`context-ml` feature extractor, but the action space is the knob vector, not a bundle set.

---

## 0. TL;DR

1. **Formulate** knob tuning as a budgeted policy problem: reward `R = Q(answer) − λ·tokens`.
2. **Phase 0 (free):** mine the ~70 existing KramaBench SUT result dirs into a
   task × knob-vector outcome matrix → per-knob effect sizes + the **oracle-headroom
   gate**: how much would a perfect per-task config chooser beat the best fixed config?
   If headroom ≈ 0 for accuracy, the payoff is *cost* reduction at iso-accuracy — still
   a valid target, but it changes what we optimize.
3. **Phase 1:** controlled interventional sweeps (OFAT + a small factorial block) on a
   stratified 30-task subset × 3 seeds → per-task categorical labels exactly as
   envisioned: *both-solve→prefer cheap · only-rich-solves→knob needed ·
   only-lean-solves→rich distracts · both-fail→discard*.
4. **Phase 2:** static config chooser (contextual bandit over pre-run task/data features).
   First learned artifact; cheap to train and evaluate.
5. **Phase 3:** step-level credit assignment — paired-trace divergence alignment (cheap)
   + checkpoint knob interventions (gold standard) → per-(state, knob-change) ΔQ rewards.
6. **Phase 4:** dynamic tuner — hand-written schedule baseline → behavior-cloned GBDT →
   offline RL only if BC leaves value on the table.
7. **Phase 5:** runtime `KnobController` hook (trivially enabled by the existing
   `updateSettings()`), final A/B on the full 103 tasks.

**Two hard-won constraints baked in from earlier experiments:** (a) single-run
differences of ±2 tasks/20 are noise → seeds + paired designs are mandatory; (b)
changing the system prompt or history rendering mid-run **breaks prompt caching**
(~86% of input tokens are cache reads at 10× discount) — a tuner that flips knobs
every step can cost more than it saves. Cache-aware cost must be *in the reward*.

---

## 1. Problem formulation

- **State `s_t`:** task text + partial DAG + observations so far + errors so far +
  tokens spent + current knob vector.
- **Action `a_t = θ_t`:** the knob vector (possibly scoped per operator).
- **Transition:** one ReAct step (LLM call + tool execution) under rendering θ_t.
- **Reward:** terminal `R = Q(final answer) − λ · cache_aware_cost`. `Q` from the
  KramaBench evaluator (answer-type-aware score). Report the **Pareto frontier** over λ
  rather than committing to one trade-off.
- **Two regimes:**
  - **Static (contextual bandit):** pick θ once per task from pre-run features.
    One decision, dense labels from Phase 1, first milestone.
  - **Dynamic (sequential):** θ_t per step. The real vision — e.g. `maxResultRows`
    high while a loader is unconverged, low afterwards.

## 2. Knob inventory (ground truth: `TexeraAgent.updateSettings()`, texera-agent.ts:717)

All are **already runtime-mutable mid-run**; prompt rebuild on mode changes is handled.

| Group | Knob | Default | Levels to sweep | Expected mechanism |
|---|---|---|---|---|
| **Observation size** | `maxResultRows` | 20 | 3 / 8 / 20 / 100 | the user's headline knob: rows rendered per result |
| | `maxOperatorResultCharLimit` | 1000 | 500 / 1k / 3k / 10k | per-operator render budget |
| | `maxOperatorResultCellCharLimit` | — | on/off | wide-cell truncation |
| | `operatorResultSerializationMode` | table | table / csv / json | render density |
| **Stats & hints** | `columnStats` | on | off / current / **old-rich** | old-rich = top_10-always + datetime detection (the untested lever from the fe91739 study) |
| | `dataLevel` | 0 | 0–3 | structural/value profiling depth |
| | `flowLevel`, `valueFormat`, `dataHints` | off | on/off | lineage + format hints |
| **History** | `contextMode` | latest | latest / delta | snapshot vs trajectory |
| | `contextWindowTokens` | 0 | 0 / 3k / 6k | budget trigger |
| | `compactionStrategy` | compress | compress / sliding | known: compress +4.4pt at 3k |
| | `deckSampleRatio` | 0.10 | 0.05–0.25 | deck row sampling |
| | `thoughtReplay(K)`, `errorReflection`, `attemptReflection` | off | on/off | reinjection features |
| **Control** | `parallelToolCalls` | on | (known: off = −8pt, +38% tokens — keep on) | |
| | `maxSteps` | 25 | 15 / 25 / 40 | step budget |

**Engineering gaps (not blockers for Phases 0–2):** knobs are global — per-operator
scoping for the observation-size group is needed for the sampling-size schedule (§7);
and there is no REST/WS exposure or controller hook yet (§10).

## 3. Existing assets

- **`Kramabench/results/` — ~70 SUT variants** across gpt-5.2 / gpt-5-mini / gpt-5.4 /
  haiku-4.5 / sonnet-4.6, many forming near-OFAT pairs: `Rows3/Rows5/FewRows/Cap20`
  (result rows), `StatsOn/Off`, `Latest/Delta`, `Win3k/6k × Compress/Sliding(±Lean)`,
  `NoParallel`, `ColumnStatsOldStyle`, `ErrorReflect`, `ThoughtReplay`, hint variants.
  Plus `system_scratch/` (110 configs) with full per-task `react_steps.json`,
  `stats.json`, `evaluation.json`.
- **`kb.py`** — run / reeval / scores / cost / compare; watchdog-recovery scripts.
- **`agent-service/benchmark/context-ml/`** — `trace.py` replays `react_steps.json`
  into per-step DAG decision points; `features.py` gives φ (flow/temporal/data/task)
  — reusable as the dynamic tuner's state features.
- **Validated knob effects to sanity-check the pipeline against:** compress > sliding
  at 3k (+4.4pt); parallel off −8pt; lean deck −2.5pt; compaction prompt section
  accuracy-neutral; prompt-example restoration no lift.
- **Known pitfalls:** cost totals dominated by outliers (use median + 5/10% trimmed
  means — baseline: mean $0.0434, 10%-trim $0.0297, median $0.0259/task);
  `astronomy-hard-11` hangs on every config (exclude symmetrically); gpt-5-mini hangs
  on ~40% of tasks (use gpt-5.2 as primary study model).

## 4. Phase 0 — mine existing data (headroom gate) — no new runs

1. **Config registry:** one YAML mapping every SUT class name → explicit knob vector
   (parse `systems/dataflow_system.py` constructor args). Kills the implicit-config
   problem going forward.
2. **Outcome matrix:** task × config → (score, cost_usd, in/out tokens, steps,
   completed?) from `evaluation.json` + `stats.json`. ~70 configs × up to 104 tasks.
3. **Per-knob marginal effects** from matched near-pairs (configs differing in one
   knob, same model): Δaccuracy, Δcost with sign-test p-values across tasks.
4. **Oracle headroom:** for each task, `best config among swept`; compare
   oracle-per-task accuracy vs best fixed config. Also **cost headroom**: cheapest
   config that still solves each task vs fixed-config cost.
5. **Confound audit:** existing configs were run at different times/commits — treat
   effects as hypotheses to confirm in Phase 1, not conclusions.

**Decision gate:** if accuracy headroom < ~3pt AND cost headroom < ~25%, a per-task
static tuner has nothing to win — skip Phase 2, go straight to the dynamic question
(where headroom can exist even when static headroom doesn't).

**Deliverable:** `benchmark/knob-tuning/phase0_report.md` + `outcome_matrix.parquet`.

## 5. Phase 1 — controlled sweeps (task-level training data)

- **Task set:** 30 tasks stratified by domain × difficulty (5 per runnable domain,
  easy/hard mixed), fixed across all runs. **3 seeds** per config (repeat runs — the
  agent is nondeterministic even at temp 0.2).
- **Design:** OFAT around the current best baseline (`LatestColumnStatsOnly`-style
  center) over the 6–8 knobs Phase 0 says matter, always including the headline axis
  `maxResultRows ∈ {3, 8, 20, 100}` and `maxOperatorResultCharLimit ∈ {500, 1k, 3k, 10k}`;
  plus **one fractional-factorial block** for suspected interactions
  (rows × columnStats × charLimit) since OFAT can't see them.
- **Runner:** replace the named-SUT-class explosion with a **parameterized SUT** that
  takes the knob vector from env/CLI and writes it into `stats.json` (engineering
  item E1, §10). All traces self-describe their config.
- **Labels — exactly the four envisioned categories,** per (task, knob, level-pair):

  | lean outcome | rich outcome | label | training use |
  |---|---|---|---|
  | solve | solve | `prefer_cheap` | negative reward for extra tokens |
  | fail | solve | `knob_needed` | the knob's information was load-bearing |
  | solve | fail | `rich_distracts` | more context actively hurt |
  | fail | fail | `uninformative` | exclude from primary training |

  With 3 seeds, use majority outcome + a confidence weight (2/3 vs 3/3 agreement).
  Record schema: JSONL, one row per (task, config, seed) with the full knob vector,
  score, cache-aware cost, steps, first-error step.
- **Budget:** baseline ≈ $0.043/task → 30-task run ≈ $1.3. E.g. 8 knobs × 3 extra
  levels × 3 seeds + center × 3 ≈ 78 runs ≈ **$100–150** on gpt-5.2 including
  watchdog reruns. Days of wall-clock, not weeks (runs parallelize per-config).

**Deliverable:** `knob_effects.md` — per-knob accuracy/cost curves with noise bars —
this alone is the "see the effect of each parameter" study, publishable as analysis
even before any model is trained.

## 6. Phase 2 — static config chooser

- **Features (pre-run observables only):** task text (lexical/embedding), domain,
  answer_type, data-lake profile (file count, total bytes, formats, est. column
  counts from headers — cheap to compute without the LLM).
- **Model:** cost-sensitive GBDT choosing among the swept configs (or independent
  per-knob heads); trained on Phase 0+1 outcome matrix; task-grouped CV.
- **Eval:** held-out tasks; accuracy and cost vs (a) best fixed config, (b) oracle.
  Success = recovering ≥ half the oracle headroom, or ≥ 25% cost cut at iso-accuracy.

## 7. Phase 3 — step-level credit assignment (data for the dynamic tuner)

Two generators, cheap→expensive:

1. **Paired-trace divergence alignment (uses Phase 1 traces, no new runs):** for the
   same task under knob A vs B, align trajectory prefixes (same operator edits) until
   they diverge; the divergence step + downstream outcome difference localizes
   *where* the knob mattered ("the 100-row render exposed the header issue at step 2").
   Coarse but free; produces the first per-step labels.
2. **Checkpoint knob interventions (gold standard):** save a replayable state before
   each Think call (same Stage-0 capture the context-selection plan needs); branch:
   continue with knob=A vs knob=B for one step (cheap: score execution success +
   progress) or roll out to completion under a fixed reference config (expensive:
   score final answer). `ΔQ(s_t, θ→θ')` is a direct per-step reward. Reuse the
   intervention/label schema from `bobflow_context_selection_training_pipeline.md`
   §7–8 with `bundle` → `knob-change`.

**Named first experiment — the sampling-size schedule (the motivating intuition):**
- *Down-intervention:* at states where a source operator's schema has been stable and
  error-free for k steps, drop that operator's rendered rows (100→8). Hypothesis:
  answer survives, tokens drop. Measures over-provisioning waste.
- *Up-intervention:* at states with an active loader error/coercion problem, raise
  rows (8→100). Hypothesis: fix-rate improves. Measures under-provisioning cost.
If this single scheduled heuristic already beats the best fixed config on the Pareto
frontier, dynamic headroom is proven and the heuristic becomes the baseline to beat.

## 8. Phase 4 — dynamic tuner

- **Action space:** small and discrete per knob (rows ∈ {8, 20, 100}; stats ∈
  {off, basic, rich}; window ∈ {0, 3k}; …), factored policy; **knob changes allowed
  only at "boundary" states** (post-execution, post-error, schema-convergence) to
  bound cache invalidation (§9-R3).
- **Policy ladder — do not jump to RL:**
  1. Hand-written schedule from Phase 3 findings (baseline).
  2. **Behavior cloning of the per-state oracle:** GBDT on state features φ
     (reuse `context-ml/features.py`: flow/data/temporal + budget-spent + error counts
     + schema-stability) → best knob per state from intervention ΔQ labels.
  3. Offline RL (IQL/CQL) only if BC demonstrably leaves sequential value on the
     table (e.g. myopic choices that pay off later). The dataset will be small
     (10²–10³ intervention labels); per-state contextual decisions with shaped ΔQ
     likely suffice.

## 9. Risks & falsifiers

- **R1 — noise swamps effects.** Prior data: ±2 tasks/20 between identical runs.
  Mitigation: 3 seeds, paired per-task comparisons, sign tests; Phase 0/1 gates kill
  the project cheaply if no knob shows a stable effect.
- **R2 — knob interactions invalidate OFAT.** Mitigation: factorial block in Phase 1;
  tuner features include the other knobs' current values.
- **R3 — cache economics (the sleeper risk).** ~86% of baseline input tokens are
  cache reads at ~10× discount. A knob flip that rebuilds the system prompt or
  rewrites history invalidates the prefix → the *same* token count costs up to 10×
  more. Reward must use **cache-aware cost** (litellm `cost_usd`, not raw tokens),
  and the tuner's action points are restricted to boundaries. Measure cache-hit rate
  as a first-class metric in every phase.
- **R4 — replay fidelity** for checkpoint interventions (engine cache determinism,
  wall-clock-dependent code). Mitigation: pin dataset snapshots; verify replay
  reproduces the original step before trusting branches.
- **R5 — small N / overfitting 104 tasks.** Domain-grouped CV; report per-domain;
  treat cross-model transfer as a separate question (prior finding: utility models do
  NOT transfer blind across agent models — expect the same here; train per model).

## 10. Engineering prerequisites (ordered by phase)

| # | Item | Needed for | Size |
|---|---|---|---|
| E1 | Parameterized SUT: knob vector via env/CLI, echoed into `stats.json` | Phase 1 | S |
| E2 | Config registry YAML for the ~70 legacy SUTs | Phase 0 | S |
| E3 | Per-step structured snapshot capture (`{workflow, results}` per step in traces) — same Stage 0 as `ML_TRAINING_PLAN.md` §2.3 | Phase 3 features | M |
| E4 | Checkpoint save/replay before each Think call | Phase 3 interventions | L |
| E5 | Per-operator observation-size overrides (`operatorId → {rows, charLimit}`) | §7 schedule, Phase 4 | M |
| E6 | `KnobController` hook: `controller(state) → updateSettings(θ_t)` before each Think (the mutation path already exists — texera-agent.ts:717) | Phase 4/5 | S |

## 11. Sequence

1. **Week 1:** E2 + Phase 0 (registry, outcome matrix, headroom gate, effect sizes).
2. **Week 2–3:** E1 + Phase 1 sweeps → `knob_effects.md`; Phase 2 static chooser.
3. **Week 3–4:** E3/E4; Phase 3 paired-trace labels + intervention pilot on ~10 tasks;
   run the sampling-size-schedule experiment (E5).
4. **Week 5+:** Phase 4 tuner ladder; E6; Phase 5 full-set A/B (103 tasks × 3 seeds,
   tuner vs best-fixed vs static chooser, Pareto + trimmed-cost reporting).
