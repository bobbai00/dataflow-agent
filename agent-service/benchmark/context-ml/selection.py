# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

"""
Budgeted context selection (ML_TRAINING.md 4.4) + an accuracy-token frontier
evaluation that needs no live LLM.

Selection: over a decision point's candidate operators, greedily pick the
highest value-per-token items until a token budget B' is exhausted (a 0/1
knapsack relaxation; the mandatory skeleton core is always kept and is not
charged against B').

Because we cannot re-run the agent here (no API key), decision quality is
proxied by *lineage coverage*: the fraction of load-bearing operators (the
ones on the final answer's lineage, y=1) that the selected context retains.
Keeping a load-bearing item is necessary for the model to reason correctly
about it; dropping it is the failure mode budgeted selection must avoid. We
sweep B' and compare selectors by coverage-at-budget and area-under-curve.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

# Scoring functions: given a per-decision-point sub-frame, return a score per
# row (higher = include sooner). Cost is always `cost_tokens`.
SCORERS = {
    # learned utility from the model (expects an injected "pred" column)
    "learned": lambda g: g["pred"].to_numpy(dtype=float),
    # recency: most-recently-edited first
    "recency": lambda g: -g["temp_steps_since_edit"].to_numpy(dtype=float),
    # hand-written structural rule (the "read structure" competitor)
    "flow_rule": lambda g: (
        2.0 * g["flow_on_frontier_path"].to_numpy(dtype=float)
        + g["flow_n_downstream"].to_numpy(dtype=float)
        - g["flow_is_sink_now"].to_numpy(dtype=float)
        + 0.5 * g["data_has_result"].to_numpy(dtype=float)
    ),
    # size-aware structural proxy
    "biggest_table": lambda g: g["data_log_rows"].to_numpy(dtype=float),
    "random": lambda g: _rng(g).random(len(g)),
}


def _rng(g: pd.DataFrame) -> np.random.Generator:
    # deterministic per (task, seq) so curves are reproducible
    seed = (hash((g["task_id"].iloc[0], int(g["seq"].iloc[0]))) & 0xFFFFFFFF)
    return np.random.default_rng(seed)


def knapsack_greedy(score: np.ndarray, cost: np.ndarray, budget: float) -> np.ndarray:
    """0/1 knapsack greedy by value density. Returns a boolean keep-mask."""
    cost = np.maximum(cost, 1e-9)
    density = score / cost
    order = np.argsort(-density)
    keep = np.zeros(len(score), dtype=bool)
    spent = 0.0
    for i in order:
        if spent + cost[i] <= budget:
            keep[i] = True
            spent += cost[i]
    return keep


def coverage_at_budgets(
    df: pd.DataFrame, scorer: str, budgets: np.ndarray
) -> np.ndarray:
    """Mean lineage coverage across all decision points, per budget fraction.

    Budget fraction is relative to each decision point's full evidence cost,
    so points of different size are comparable. Coverage at a point = (tokens
    of kept load-bearing items)?  No — recall of load-bearing *items*:
    kept_pos / total_pos. Points with no load-bearing item are skipped.
    """
    score_fn = SCORERS[scorer]
    # group by decision point
    cov = np.zeros((len(budgets),), dtype=float)
    counts = 0
    for (_, _), g in df.groupby(["task_id", "seq"], sort=False):
        pos = g["y"].to_numpy(dtype=int)
        if pos.sum() == 0:
            continue
        counts += 1
        cost = g["cost_tokens"].to_numpy(dtype=float)
        full = cost.sum()
        sc = score_fn(g)
        for bi, b in enumerate(budgets):
            keep = knapsack_greedy(sc, cost, b * full)
            cov[bi] += (keep & (pos == 1)).sum() / pos.sum()
    return cov / max(1, counts)


def evaluate_frontier(df: pd.DataFrame, scorers: list[str] = None,
                      budgets: np.ndarray = None) -> tuple[pd.DataFrame, pd.Series]:
    """Coverage-vs-budget curve per scorer + area-under-curve (AUCC) summary.

    `df` must contain a `pred` column for the 'learned' scorer (OOF or held-out).
    """
    scorers = scorers or ["learned", "flow_rule", "biggest_table", "recency", "random"]
    budgets = budgets if budgets is not None else np.linspace(0.1, 1.0, 10)
    curves = {"budget_frac": budgets}
    aucc = {}
    for s in scorers:
        cov = coverage_at_budgets(df, s, budgets)
        curves[s] = cov
        integrate = getattr(np, "trapezoid", np.trapz)
        aucc[s] = float(integrate(cov, budgets) / (budgets[-1] - budgets[0]))
    return pd.DataFrame(curves), pd.Series(aucc, name="AUCC").sort_values(ascending=False)


def coverage_at(df: pd.DataFrame, frac: float, scorers: list[str] = None) -> pd.Series:
    scorers = scorers or ["learned", "flow_rule", "biggest_table", "recency", "random"]
    return pd.Series(
        {s: float(coverage_at_budgets(df, s, np.array([frac]))[0]) for s in scorers},
        name=f"coverage@{frac:.0%}",
    ).sort_values(ascending=False)


if __name__ == "__main__":
    import sys
    from trace import reconstruct, find_task_dirs
    from features import build_dataframe
    from train import cv_predict, ALL_FEATURES

    root = sys.argv[1] if len(sys.argv) > 1 else (
        "/home/bob/Desktop/bobflow/dataflow-agent/llm-training-set-v1-kramabench"
    )
    traces = [reconstruct(d) for d in find_task_dirs(root)]
    df = build_dataframe(traces)
    res = cv_predict(df, ALL_FEATURES)
    df = df.assign(pred=res.oof_pred)
    pd.set_option("display.width", 200)
    curves, aucc = evaluate_frontier(df)
    print(f"OOF model AUC={res.auc:.3f} AP={res.ap:.3f}\n")
    print("=== coverage-vs-budget curve (mean lineage recall) ===")
    print(curves.round(3).to_string(index=False))
    print("\n=== area under coverage curve (higher=better) ===")
    print(aucc.round(4).to_string())
    print("\n=== coverage at 40% budget ===")
    print(coverage_at(df, 0.4).round(3).to_string())
