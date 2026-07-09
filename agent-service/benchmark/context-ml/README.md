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

# context-ml — learned dataflow context selection (ML_TRAINING.md)

A reference implementation of the BobFlow context-construction method described
in `ML_TRAINING.md`: extract **dataflow features** per candidate context item,
learn a lightweight **utility model** `u_i = f_θ(φ_i)`, and do **budgeted
selection** under a token budget over a mandatory structural core. It runs
fully offline on the shipped kramabench trajectories — no live LLM required.

## Pipeline

| module | role |
|---|---|
| `trace.py` | Load a kramabench task dir; replay `react_steps.json` tool events into per-step DAG **decision points** (operators + versions + inferred links + parsed result shapes). Links are recovered from `def process(args)` signatures; result shapes from the rendered `# Current Dataflow` context. |
| `features.py` | Per (decision-point, candidate-operator): φ = flow / temporal / data / task features; weak **future-use labels** (`y` = load-bearing on the final answer lineage); token **cost** via `tiktoken`. |
| `train.py` | Task-grouped CV utility model (sklearn `HistGradientBoosting`/`LogReg`); the ML_TRAINING.md **ablation** (temporal < flow < flow+data); permutation importance. |
| `selection.py` | 0/1-knapsack greedy budgeted selection + an **accuracy–token frontier** evaluation (lineage-coverage vs budget) against recency / structural-rule / random baselines. |
| `run_pipeline.py` | End-to-end: hold out N random tasks, train on the rest, verify on the held-out set; writes `report.json`. |

## Run

```bash
cd agent-service/benchmark/context-ml
PY=../../../.venv/bin/python      # sklearn + pandas + tiktoken already installed

$PY trace.py            # reconstruct one task (sanity)
$PY features.py         # feature matrix + label/feature stats over all 60 tasks
$PY train.py            # ablation + importance (the headline result)
$PY selection.py        # budgeted-selection frontier vs baselines
$PY run_pipeline.py --holdout 10 --seed 0   # full end-to-end on 10 random tasks → report.json
```

## Headline result (task-grouped 5-fold CV, GBDT)

Predicting whether a candidate item is **load-bearing for the final answer**,
from features observable at that step:

| feature set | AUC |
|---|---|
| recency only (temporal) | 0.69 |
| task-similarity only | 0.50 |
| flow only | 0.88 |
| flow + temporal | 0.92 |
| flow + data | 0.93 |
| **all** | **0.95** |

This reproduces the ordering ML_TRAINING.md predicts (temporal < flow <
flow+data) and rebuts its stated "biggest warning sign" — recency alone is a
weak proxy for context value. In budgeted selection the learned scorer beats
recency / structural-rule / random at every budget (AUCC: learned ≈ 0.48 vs
recency ≈ 0.40 over all tasks). See `OBSERVATIONS.md` for the full write-up.

## Labels & observability

The label (`y`) is computed from the **final** DAG (a row is load-bearing iff
its operator lies on the answer sink's ancestor closure). Features come from the
**partial** DAG at step *t*, so this is a genuine prediction, not a tautology —
and it respects ML_TRAINING.md's observability rule: future lineage is used only
as an offline training label, never as a runtime input. It is a cheap weak
"future-use" signal, not a counterfactual rollout label (see `OBSERVATIONS.md`).
