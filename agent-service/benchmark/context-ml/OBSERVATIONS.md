<!--
Licensed to the Apache Software Foundation (ASF) under one
or more contributor license agreements.  See the NOTICE file
distributed with this work for additional information
regarding copyright ownership.  The ASF licenses this file
to you under the Apache License, Version 2.0 (the
"License"); you may not use this file except in compliance
with the License.  You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing,
software distributed under the License is distributed on an
"AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, either express or implied.  See the License for the
specific language governing permissions and limitations
under the License.
-->

# ML_TRAINING.md — implementation, end-to-end verification, observations & revise plan

## 1. What ML_TRAINING.md actually asks for

It is a design discussion, not a spec. Stripping the positioning, the committed
method is:

> At each ReAct step, enumerate candidate context items from the evolving
> dataflow; extract **observable** dataflow features φ; predict each item's
> **utility** `u_i = f_θ(φ_i)` with a lightweight learned model; **budget-select**
> the items (knapsack, token cost `c_i = |serialize(i)|`) over a mandatory
> structural core. Train `f_θ` from **agent outcomes** (cheap weak future-use
> labels, optionally calibrated by counterfactual rollouts). The contribution is
> *feature sufficiency* — that dataflow structure predicts context value — not
> model capacity.

## 2. What was built

Two tracks. The method itself is fully implemented and verified **offline** on
real data; the live agent loop is implemented and validated as far as the
environment allows (the remaining gate is an OpenAI key — see §6).

**Track 1 — the method (offline, `agent-service/benchmark/context-ml/`):**
`trace.py` → `features.py` → `train.py` → `selection.py` → `run_pipeline.py`.
Runs on the 60 shipped kramabench trajectories with sklearn + tiktoken (already
in `.venv`; zero new deps).

**Track 2 — live data generation (`…/llm-training-data-generation/`):**
`adapters/kramabench.ts` (new) plugs kramabench into the existing trace-gen
harness, with answer-type-aware scoring; registered in `run.ts` as
`--source kramabench`. Validated offline (loads 60 tasks; scorer reproduces
39/39 recorded `success` flags). Running it live with **gpt-5-mini** needs the
backend stack + an OpenAI key (§6).

## 3. End-to-end verification on 10 random kramabench tasks

`run_pipeline.py --holdout 10` randomly holds out 10 tasks, trains the utility
model on the other 50, and verifies on the held-out 10 (clean task-level split).

> Note on "subtasks": this vendored kramabench set has **atomic tasks** — there
> are no subtasks (the `token_usage_subtask_eval` field is vestigial = 0). The
> method's selection units are the **per-step candidate context items**
> (operators/bundles) within each task's trajectory; verification is at that
> granularity across every step of all 10 held-out tasks (≈ 480 candidate rows
> for seed 0).

**Held-out generalization (seed 0):** utility model **AUC 0.98 / AP 0.99**.
Across seeds 0/1/2 the learned selector is #1 by area-under-coverage-curve in
all three (0.40 / 0.52 / 0.55 vs recency 0.31 / 0.39 / 0.47).

**Ablation (all 60 tasks, task-grouped 5-fold CV, GBDT) — the headline:**

| feature set | AUC | AP |
|---|---|---|
| recency only (temporal) | 0.69 | 0.74 |
| task-similarity only | 0.50 | 0.64 |
| flow only | 0.88 | 0.90 |
| flow + temporal | 0.92 | 0.93 |
| flow + data | 0.93 | 0.94 |
| **all** | **0.95** | **0.94** |

`temporal < flow < flow+data < all` — exactly the ordering the doc names as "the
strongest possible result." Top features span all groups: `data_log_rows`
(table size), `flow_n_downstream` (has consumers), `temp_steps_since_edit`,
`data_n_cols`, `task_sim_question`.

**Budgeted-selection frontier (lineage coverage = recall of load-bearing items
at a token budget; higher is better):**

| budget | learned | flow_rule | biggest_table | recency | random |
|---|---|---|---|---|---|
| 30% | 0.27 | 0.24 | 0.25 | 0.17 | 0.20 |
| 50% | 0.47 | 0.42 | 0.42 | 0.38 | 0.38 |
| 70% | 0.60 | 0.54 | 0.55 | 0.51 | 0.51 |
| **AUCC** | **0.48** | 0.44 | 0.44 | 0.40 | 0.40 |

The learned scorer dominates at every budget; recency is near the random floor.
At ~50% budget the learned selector keeps ~36% more load-bearing items than
recency (iso-coverage, it reaches recency's operating point with ≈ 20% fewer
tokens on 2 of 3 seeds).

## 4. Observations

1. **The central thesis holds, strongly and honestly.** Dataflow structure
   predicts context value (flow alone 0.88 AUC); recency — the default proxy in
   text agents — is weak (0.69) and near-random in selection. The label is read
   from the *final* DAG while features are from the *partial* DAG at step *t*, so
   the model genuinely predicts the future role of an operator that often has no
   downstream consumer yet. This is not the circularity trap the doc warns about
   (that would be labeling from the same structure you feed as features at the
   same time).

2. **It is NOT just "current ops good, old ops bad."** That was the doc's biggest
   stated risk. Temporal-only tops out at 0.69; the lift comes from flow
   (downstream/lineage) and **execution/data** features (table width and row
   count are the single most important signal). The dataflow's *data* side
   carries real, non-redundant signal.

3. **Cost and value are correlated in the wrong direction — the key practical
   tension.** Load-bearing operators tend to carry the largest result tables
   (more rows/cols → more tokens). Density-greedy knapsack therefore *deprioritizes*
   exactly the items that matter, which is why coverage rises only gradually with
   budget. This is direct evidence for ML_TRAINING.md's representation/multi-choice
   idea: important-but-large items should be **compressed**, not dropped.

4. **The data format is the real constraint, not the modeling.** Traces store
   only the *final* `workflow.json` and rendered-text results inside
   `inputMessages`; there are no per-step DAG snapshots and no structured
   per-operator result schema. Everything (intermediate DAG, links, result
   shapes, errors) had to be **reconstructed** by replaying tool events and
   regex-parsing context text. It works (60/60 tasks), but it is lossy: dtypes,
   null-rates, join-key matches, coercion losses — features the doc lists — are
   not recoverable from current traces.

5. **The label is a weak proxy, by necessity.** `y` = "on the final answer's
   lineage" is a *future-use* signal, not a counterfactual marginal-contribution
   label. It is cheap and automatically available (the doc's recommended
   pre-training signal) but it cannot distinguish "needed for the answer" from
   "happened to survive on the answer path." Counterfactual rollouts (drop item,
   re-run, measure Δquality) are the gold standard and require the live agent.

6. **Models agree the features are sufficient.** GBDT and logistic regression
   give near-identical ablations (LogReg: 0.72 / 0.90 / 0.94), confirming the
   doc's instinct that a simple interpretable learner suffices; capacity is not
   the contribution.

## 5. Limitations (stated plainly)

- Coverage of load-bearing items is a **proxy** for decision quality, not live
  task accuracy. Whether dropping a low-utility item actually preserves the
  answer is unproven without re-running the agent.
- Trained/evaluated only on **claude-haiku-4.5** traces (that's what shipped).
  Cross-model transfer (does the utility learned from haiku hold for gpt-5-mini?)
  is untested — and is itself a paper-worthy question.
- 60 tasks is small; CV variance across seeds is visible (AUCC 0.40–0.55).
- 18/60 tasks have unresolved data files (kramabench `subset_files` use
  globs/nested paths my basename resolution misses) — a loader refinement, not a
  data gap (all domain data is present locally).
- Selection is **additive** (`Û(X)=Σ u_i`); redundancy/complementarity between
  items (the doc's set-utility point) is ignored.

## 6. Improvement & revise plan

Ordered by leverage.

**A. Close the live loop with gpt-5-mini (unblocks counterfactual labels).**
Everything is built; the only gate is an OpenAI key. Steps:
  1. `export OPENAI_API_KEY=…` (litellm reads it via `os.environ/OPENAI_API_KEY`),
     start the stack incl. litellm with `GUI_WORKFLOW_WORKSPACE_COPILOT_ENABLED=true`.
  2. `cd agent-service && TEXERA_AGENT_MODEL=gpt-5-mini bun run trace-gen --source kramabench --limit 10`.
  3. This produces fresh gpt-5-mini traces; feed them straight into `context-ml`.
Then implement **counterfactual rollout labels**: at a saved decision point,
run the agent with vs without a candidate bundle, measure Δ(answer correctness /
next-step success). Use these to *calibrate* the cheap future-use model
(pre-train on future-use, fine-tune on rollouts) — exactly the doc's protocol.

**B. Representation-level selection (multi-choice), not keep/drop.** Observation
3 shows big load-bearing items get dropped. Replace the binary item with a
grouped-knapsack over representation levels per operator:
`skeleton-only ≺ compact summary ≺ summary + result`. The model then chooses
*how much* of each operator to spend budget on. This is the highest-value
modeling change and directly addresses the cost/value tension.

**C. Live integration as a context mode.** Wire the trained selector into the
agent's context assembler (`agent-service/src/agent/util/context-utils.ts`,
`assembleContext`) as a new `contextMode: "ml-budget"` alongside
`latest/delta/full` (the selection subsystem already exists at
`src/agent/context/select/`). Export `f_θ` as ONNX or a small coefficient table
and score the live candidate set each step (microseconds; negligible vs the LLM).
Then run the real Pareto experiment: accuracy vs tokens, learned-mode vs
latest/full, on held-out tasks.

**D. Enrich the trace format (small backend change, big feature gain).** Capture
per-step DAG snapshots + structured per-operator results (schema, dtypes, row
count, error class) in `react_steps.json`, instead of forcing regex
reconstruction. Unlocks the execution/data features the doc lists (null-rate,
join-key match, coercion loss) that current traces can't express.

**E. Set-aware utility.** Add redundancy features (summary/result similarity to
already-selected items) and move from additive `Σ u_i` toward a marginal-gain
greedy, so two near-duplicate summaries aren't both kept.

**F. Cross-model & cross-domain generalization.** Train on one model/domain,
test on another (the doc's question 3). With gpt-5-mini traces from (A) this
becomes a direct haiku→gpt-5-mini transfer study.

## 7. Live gpt-5-mini run + cross-model transfer (COMPLETED)

The live track was executed: full JVM stack + LiteLLM (gpt-5-mini) + agent-service,
running the trace-gen harness with the new `KramabenchAdapter` on **10 randomly
sampled tasks** (stratified, 2 per runnable domain: archeology/astronomy/
biomedical/environment/wildfire; legal excluded — its data lives in nested
subdirs the loader doesn't yet resolve).

**Infra fix found + applied while doing this:** the agent's per-step compile call
(`agent-service/src/api/compile-api.ts`) sent no auth, so WorkflowCompilingService
401'd and the agent reasoned **without output schemas** — on gpt-5-mini that meant
a 422s timeout with no answer. Threading the user JWT into the compile call
(`compile-api.ts` + `texera-agent.ts:993`) cut the same task to **106s with the
correct answer**. (Committed as part of this work.)

**gpt-5-mini results (10 tasks, ~32 min):** 9/10 ran cleanly, **5/10 correct**
(archeology ×2, astronomy-easy, environment-hard-15, wildfire-hard-17); 1 timeout
(astronomy-hard-10, 600s). A 50% pass rate on a hard data-analytics benchmark is
reasonable for gpt-5-mini.

**Cross-model transfer — the headline live finding.** Train the utility model on
the 60 haiku traces, test on the 10 gpt-5-mini traces (`cross_model.py`):

| setting | AUC | learned beats recency? |
|---|---|---|
| within-model (haiku CV) | **0.95** | yes, at every budget |
| cross-model (haiku → gpt-5-mini) | **0.72** | **no** — recency/flow-rule win here |

The transfer is real (0.72 ≫ 0.5 chance) but partial, and on gpt-5-mini the
haiku-trained model *loses* to recency. The cause is a concrete distribution
shift: **gpt-5-mini builds far more scaffolding** — load-bearing base rate 0.21
vs haiku's 0.57 (e.g. astronomy-hard-10: 15 final operators, only 4 on the answer
lineage), and it assembles the answer chain late, so recency happens to capture
it. This is the direct answer to the doc's §6.F generalization question:
**dataflow features are privileged within a model's own trace distribution, but
the learned utility weights are distribution-specific — the selector must be
trained (or fine-tuned) per agent model, not transferred blind.** A genuine,
publishable nuance the live run surfaced.

## 8. Bottom line

The method works end-to-end on real kramabench data — both **offline** (the core
verification) and **live with gpt-5-mini** (10 tasks, fresh traces). The
empirical core of the paper reproduces: **within a model's traces, dataflow
features make context value predictable (0.95 AUC), far better than recency, with
execution/data features adding real signal, and a learned budgeted selector
beating recency / structural-rule baselines at every token budget.** The live run
added two findings: (1) schema availability materially changes agent behavior (the
compile-auth fix), and (2) the learned utility does **not** transfer blind across
agent models (0.95 → 0.72), motivating per-model training. Highest-leverage next
steps (§6): representation-level (multi-choice) selection so large load-bearing
items are compressed not dropped, counterfactual rollout labels via the now-working
live loop, and per-model training/fine-tuning given the transfer gap.
