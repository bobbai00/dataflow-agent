#!/usr/bin/env python
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the "License").
"""
Train the learned context-selection utility model + run the ablation falsifier.

Input : the CSV from dump-features.ts (one row per (step, operator)).
Output: model.json (standardized logistic regression, weights in FEATURE_NAMES
        order) that the TS evaluator (context/learned/model.ts) loads verbatim.

The headline is a logistic regression (per the action plan: "logistic headline +
regularized trees; feature sufficiency, not capacity, is the contribution"). A
HistGradientBoosting model is trained ALONGSIDE only to report the ablation
ceiling — it is not exported.

The ablation ladder is the go/no-go FALSIFIER (pipeline §11.5): if dataflow
structure + data features do NOT beat recency-only, there is no contribution and
we should stop. All CV is grouped by trace so no trace leaks across folds.
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.model_selection import GroupKFold

# Must match FEATURE_NAMES in agent-service/src/agent/context/learned/features-ml.ts
FEATURE_NAMES = [
    "role_deleted", "role_blocked", "role_frontier", "role_near_frontier",
    "role_terminal", "role_source", "role_interior",
    "edit_count", "steps_since_edit", "norm_recency", "deleted",
    "is_erroring", "has_result", "has_healthy_consumer", "has_column_stats",
    "wide", "dirty_load", "categorical_low_card", "numeric_as_text",
    "n_cols", "log_rows",
    "is_source", "is_terminal", "n_upstream", "n_downstream",
    "n_ancestors", "n_descendants", "depth", "is_sink", "dist_to_frontier",
    "task_sim",
]

# Ablation groups (the falsifier ladder).
GROUPS = {
    "temporal": ["edit_count", "steps_since_edit", "norm_recency", "deleted"],
    "role": ["role_deleted", "role_blocked", "role_frontier", "role_near_frontier",
             "role_terminal", "role_source", "role_interior"],
    "execdata": ["is_erroring", "has_result", "has_healthy_consumer", "has_column_stats",
                 "wide", "dirty_load", "categorical_low_card", "numeric_as_text"],
    "datasummary": ["n_cols", "log_rows"],
    "flow": ["is_source", "is_terminal", "n_upstream", "n_downstream",
             "n_ancestors", "n_descendants", "depth", "is_sink", "dist_to_frontier"],
    "task": ["task_sim"],
}

LADDER = [
    ("recency-only", GROUPS["temporal"]),
    ("role-only", GROUPS["role"]),
    ("flow-only", GROUPS["flow"]),
    ("flow+temporal", GROUPS["flow"] + GROUPS["temporal"]),
    ("flow+data", GROUPS["flow"] + GROUPS["datasummary"] + GROUPS["execdata"]),
    ("all", FEATURE_NAMES),
]


def grouped_cv_scores(X, y, groups, cols, model_kind, n_splits=5):
    idx = [FEATURE_NAMES.index(c) for c in cols]
    Xs = X[:, idx]
    gkf = GroupKFold(n_splits=min(n_splits, len(np.unique(groups))))
    aucs, aps = [], []
    for tr, te in gkf.split(Xs, y, groups):
        if len(np.unique(y[tr])) < 2 or len(np.unique(y[te])) < 2:
            continue
        if model_kind == "logistic":
            mu, sd = Xs[tr].mean(0), Xs[tr].std(0)
            sd[sd == 0] = 1.0
            clf = LogisticRegression(max_iter=2000, C=1.0, class_weight="balanced")
            clf.fit((Xs[tr] - mu) / sd, y[tr])
            p = clf.predict_proba((Xs[te] - mu) / sd)[:, 1]
        else:
            clf = HistGradientBoostingClassifier(max_iter=200, max_depth=4,
                                                 learning_rate=0.05, l2_regularization=1.0)
            clf.fit(Xs[tr], y[tr])
            p = clf.predict_proba(Xs[te])[:, 1]
        aucs.append(roc_auc_score(y[te], p))
        aps.append(average_precision_score(y[te], p))
    return float(np.mean(aucs)), float(np.mean(aps))


def domain_holdout(X, y, domains, cols, model_kind="logistic"):
    """Train on all-but-one domain, test on the held-out domain (transfer, R7)."""
    idx = [FEATURE_NAMES.index(c) for c in cols]
    Xs = X[:, idx]
    out = {}
    for dom in sorted(np.unique(domains)):
        tr = domains != dom
        te = domains == dom
        if len(np.unique(y[tr])) < 2 or len(np.unique(y[te])) < 2:
            continue
        mu, sd = Xs[tr].mean(0), Xs[tr].std(0)
        sd[sd == 0] = 1.0
        clf = LogisticRegression(max_iter=2000, class_weight="balanced")
        clf.fit((Xs[tr] - mu) / sd, y[tr])
        p = clf.predict_proba((Xs[te] - mu) / sd)[:, 1]
        out[dom] = float(roc_auc_score(y[te], p))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    df = pd.read_csv(args.csv)
    X = df[FEATURE_NAMES].to_numpy(dtype=float)
    y = df["label"].to_numpy(dtype=int)
    groups = df["trace_id"].to_numpy()
    domains = df["domain"].to_numpy()

    print(f"rows={len(df)}  traces={len(np.unique(groups))}  domains={len(np.unique(domains))}"
          f"  pos_rate={y.mean():.3f}\n")

    print(f"{'ablation':<16}{'LogReg AUC':>12}{'LogReg AP':>12}{'GBDT AUC':>12}")
    results = {}
    for name, cols in LADDER:
        lr_auc, lr_ap = grouped_cv_scores(X, y, groups, cols, "logistic")
        gb_auc, _ = grouped_cv_scores(X, y, groups, cols, "gbdt")
        results[name] = {"logreg_auc": lr_auc, "logreg_ap": lr_ap, "gbdt_auc": gb_auc}
        print(f"{name:<16}{lr_auc:>12.3f}{lr_ap:>12.3f}{gb_auc:>12.3f}")

    rec = results["recency-only"]["logreg_auc"]
    flow = results["flow-only"]["logreg_auc"]
    allf = results["all"]["logreg_auc"]
    print("\n--- FALSIFIER ---")
    print(f"recency-only AUC = {rec:.3f}")
    print(f"flow-only    AUC = {flow:.3f}   (Δ vs recency = {flow-rec:+.3f})")
    print(f"all          AUC = {allf:.3f}   (Δ vs recency = {allf-rec:+.3f})")
    verdict = "PASS — dataflow structure beats recency; contribution is real." if (flow - rec) >= 0.05 \
        else "FAIL — structure does not beat recency; no contribution."
    print(f"verdict: {verdict}")

    print("\n--- domain holdout (train 5 domains, test 1; logistic, all features) ---")
    dh = domain_holdout(X, y, domains, FEATURE_NAMES)
    for dom, auc in dh.items():
        print(f"  {dom:<14} AUC={auc:.3f}")
    if dh:
        print(f"  mean transfer AUC = {np.mean(list(dh.values())):.3f}")

    # Export the headline logistic trained on ALL data.
    mu, sd = X.mean(0), X.std(0)
    sd[sd == 0] = 1.0
    clf = LogisticRegression(max_iter=5000, C=1.0, class_weight="balanced")
    clf.fit((X - mu) / sd, y)
    model = {
        "kind": "logistic",
        "featureNames": FEATURE_NAMES,
        "mean": [float(v) for v in mu],
        "std": [float(v) for v in sd],
        "weights": [float(v) for v in clf.coef_[0]],
        "bias": float(clf.intercept_[0]),
        "meta": {
            "trainedOn": Path(args.csv).name,
            "rows": int(len(df)),
            "traces": int(len(np.unique(groups))),
            "posRate": float(y.mean()),
            "cvAucAll": results["all"]["logreg_auc"],
            "falsifier": verdict,
        },
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(model, indent=2))

    # Coefficient magnitudes (standardized => comparable importance).
    order = np.argsort(-np.abs(clf.coef_[0]))
    print("\n--- top standardized coefficients ---")
    for i in order[:10]:
        print(f"  {FEATURE_NAMES[i]:<20}{clf.coef_[0][i]:+.3f}")
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    sys.exit(main())
