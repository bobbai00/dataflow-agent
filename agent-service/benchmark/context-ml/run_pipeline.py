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
End-to-end verification of the ML_TRAINING.md context-selection method on
kramabench traces — the offline track (no live LLM required).

  1. Reconstruct DAG decision points from every task's react_steps.
  2. Randomly hold out N tasks (default 10); train the utility model on the
     rest; predict held-out utilities (clean train/test split).
  3. Verify on the held-out tasks: budgeted-selection frontier vs baselines.
  4. Also report task-grouped CV ablation + feature importance over all tasks.
  5. Write a JSON report.

Usage:
  python run_pipeline.py [--root DIR] [--holdout 10] [--seed 0] [--model gbdt|logreg]
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

import numpy as np
import pandas as pd

from trace import reconstruct, find_task_dirs
from features import build_dataframe, ALL_FEATURES
from train import cv_predict, ablation, importances, fit_full
from selection import evaluate_frontier, coverage_at


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="/home/bob/Desktop/bobflow/dataflow-agent/llm-training-set-v1-kramabench")
    ap.add_argument("--holdout", type=int, default=10)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--model", default="gbdt", choices=["gbdt", "logreg"])
    ap.add_argument("--out", default="report.json")
    args = ap.parse_args()

    dirs = find_task_dirs(args.root)
    traces = [reconstruct(d) for d in dirs]
    df = build_dataframe(traces)

    rng = random.Random(args.seed)
    task_ids = sorted(df.task_id.unique())
    holdout = sorted(rng.sample(task_ids, min(args.holdout, len(task_ids))))
    train_ids = [t for t in task_ids if t not in holdout]

    print("=" * 78)
    print(f"context-ML pipeline  |  {len(task_ids)} tasks, {len(df)} candidate rows")
    print(f"holdout ({len(holdout)}): {holdout}")
    print("=" * 78)

    # ---- per-task reconstruction summary ----
    per_task = []
    for tr in traces:
        sub = df[df.task_id == tr.task_id]
        per_task.append({
            "task_id": tr.task_id, "domain": tr.domain, "success": tr.success,
            "answer_type": tr.answer_type, "decision_points": len(tr.decisions),
            "final_ops": tr.n_final_ops, "lineage": len(tr.final_lineage),
            "candidate_rows": len(sub), "load_bearing_rate": round(float(sub.y.mean()), 3) if len(sub) else 0.0,
            "held_out": tr.task_id in holdout,
        })
    pt = pd.DataFrame(per_task)
    print("\n--- held-out tasks ---")
    pd.set_option("display.width", 200, "display.max_columns", 40)
    print(pt[pt.held_out].drop(columns=["held_out"]).to_string(index=False))

    # ---- clean train/test: fit on train tasks, predict held-out ----
    tr_df = df[df.task_id.isin(train_ids)]
    te_df = df[df.task_id.isin(holdout)].copy()
    model = fit_full(tr_df, ALL_FEATURES, kind=args.model)
    te_df["pred"] = model.predict_proba(te_df[ALL_FEATURES].to_numpy(dtype=float))[:, 1]

    from sklearn.metrics import roc_auc_score, average_precision_score
    holdout_auc = roc_auc_score(te_df.y, te_df.pred) if te_df.y.nunique() > 1 else float("nan")
    holdout_ap = average_precision_score(te_df.y, te_df.pred)
    print(f"\n--- held-out utility model: AUC={holdout_auc:.3f}  AP={holdout_ap:.3f} ---")

    # ---- frontier on held-out tasks ----
    curves, aucc = evaluate_frontier(te_df)
    cov40 = coverage_at(te_df, 0.4)
    cov60 = coverage_at(te_df, 0.6)
    print("\n--- held-out coverage-vs-budget (mean lineage recall) ---")
    print(curves.round(3).to_string(index=False))
    print("\n--- AUCC (held-out, higher=better) ---")
    print(aucc.round(4).to_string())

    # Token savings, iso-coverage: pick a coverage target that recency actually
    # reaches inside the mid-budget band (its coverage at 80% budget), then find
    # the smallest budget at which the learned selector already reaches it.
    from selection import coverage_at_budgets
    bs = np.linspace(0.05, 0.95, 19)
    rec_curve = coverage_at_budgets(te_df, "recency", bs)
    lrn_curve = coverage_at_budgets(te_df, "learned", bs)
    ref_budget = 0.8
    target = float(coverage_at_budgets(te_df, "recency", np.array([ref_budget]))[0])
    hit = np.where(lrn_curve >= target)[0]
    learned_b = float(bs[hit[0]]) if len(hit) else 1.0
    recency_b = ref_budget
    savings = 1 - learned_b / recency_b
    print(f"\niso-coverage ({target:.0%} lineage recall, recency@{recency_b:.0%} budget): "
          f"learned reaches it at {learned_b:.0%} budget → {savings:+.0%} tokens vs recency")

    # ---- ablation + importance over ALL tasks (CV) ----
    print("\n--- ablation (task-grouped CV, all tasks) ---")
    abl = ablation(df, kind=args.model)
    print(abl.to_string(index=False))
    print("\n--- feature importance (top 12) ---")
    imp = importances(df, kind=args.model)
    print(imp.head(12).to_string(index=False))

    # ---- write report ----
    report = {
        "config": vars(args),
        "n_tasks": len(task_ids), "n_rows": len(df),
        "holdout_tasks": holdout,
        "overall_load_bearing_rate": round(float(df.y.mean()), 4),
        "holdout_model": {"auc": holdout_auc, "ap": holdout_ap},
        "holdout_frontier_aucc": {k: round(v, 4) for k, v in aucc.items()},
        "holdout_coverage_at_40pct": {k: round(v, 4) for k, v in cov40.items()},
        "holdout_coverage_at_60pct": {k: round(v, 4) for k, v in cov60.items()},
        "holdout_curves": {k: [round(x, 4) for x in v] for k, v in
                           curves.to_dict(orient="list").items()},
        "token_budget_for_60pct_coverage": {"learned": learned_b, "recency": recency_b,
                                            "learned_token_savings_vs_recency": round(savings, 4)},
        "ablation_cv": abl.round(4).to_dict(orient="records"),
        "feature_importance": imp.round(5).to_dict(orient="records"),
        "per_task": per_task,
    }
    out = Path(__file__).parent / args.out
    out.write_text(json.dumps(report, indent=2))
    print(f"\nreport written: {out}")


if __name__ == "__main__":
    main()
