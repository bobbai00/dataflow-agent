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
Train a lightweight utility model u_i = f_theta(phi_i) over dataflow features
(ML_TRAINING.md 4.3). Per the doc, feature *sufficiency* — not model capacity —
is the contribution, so we use a small sklearn classifier (GBDT by default).

Provides:
  - task-grouped cross-validated out-of-fold (OOF) utility predictions, so the
    downstream selection evaluation never scores a task the model trained on;
  - the ML_TRAINING.md ablation (temporal < flow < flow+data < all);
  - permutation feature importance.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from features import ALL_FEATURES, FEATURE_GROUPS


def make_model(kind: str = "gbdt"):
    if kind == "logreg":
        return make_pipeline(
            StandardScaler(),
            LogisticRegression(max_iter=2000, class_weight="balanced"),
        )
    return HistGradientBoostingClassifier(
        max_depth=3, max_iter=200, learning_rate=0.08,
        l2_regularization=1.0, min_samples_leaf=20, random_state=0,
    )


@dataclass
class CVResult:
    oof_pred: np.ndarray          # out-of-fold P(load-bearing) per row
    auc: float
    ap: float
    n_pos: int
    n: int


def cv_predict(df: pd.DataFrame, feature_cols: list[str], kind: str = "gbdt",
               n_splits: int = 5) -> CVResult:
    """Task-grouped CV. Returns OOF predictions + aggregate AUC/AP."""
    X = df[feature_cols].to_numpy(dtype=float)
    y = df["y"].to_numpy(dtype=int)
    groups = df["task_id"].to_numpy()
    n_groups = len(np.unique(groups))
    splits = min(n_splits, n_groups)
    oof = np.full(len(df), np.nan)
    gkf = GroupKFold(n_splits=splits)
    for tr_idx, te_idx in gkf.split(X, y, groups):
        if len(np.unique(y[tr_idx])) < 2:
            oof[te_idx] = y[tr_idx].mean()
            continue
        m = make_model(kind)
        m.fit(X[tr_idx], y[tr_idx])
        oof[te_idx] = m.predict_proba(X[te_idx])[:, 1]
    mask = ~np.isnan(oof)
    auc = roc_auc_score(y[mask], oof[mask]) if len(np.unique(y[mask])) > 1 else float("nan")
    ap = average_precision_score(y[mask], oof[mask])
    return CVResult(oof_pred=oof, auc=auc, ap=ap, n_pos=int(y.sum()), n=len(df))


def ablation(df: pd.DataFrame, kind: str = "gbdt") -> pd.DataFrame:
    """The headline ML_TRAINING.md ablation: do flow + execution features beat
    temporal/recency baselines at predicting context value?"""
    configs = {
        "recency_only (temporal)": FEATURE_GROUPS["temporal"],
        "task_only": FEATURE_GROUPS["task"],
        "flow_only": FEATURE_GROUPS["flow"],
        "flow+temporal": FEATURE_GROUPS["flow"] + FEATURE_GROUPS["temporal"],
        "flow+data": FEATURE_GROUPS["flow"] + FEATURE_GROUPS["data"],
        "all": ALL_FEATURES,
    }
    rows = []
    for name, cols in configs.items():
        r = cv_predict(df, cols, kind=kind)
        rows.append({"feature_set": name, "n_features": len(cols), "auc": r.auc, "ap": r.ap})
    return pd.DataFrame(rows)


def importances(df: pd.DataFrame, feature_cols: list[str] = None, kind: str = "gbdt") -> pd.DataFrame:
    feature_cols = feature_cols or ALL_FEATURES
    X = df[feature_cols].to_numpy(dtype=float)
    y = df["y"].to_numpy(dtype=int)
    m = make_model(kind)
    m.fit(X, y)
    pi = permutation_importance(m, X, y, n_repeats=10, random_state=0, scoring="roc_auc")
    return (
        pd.DataFrame({"feature": feature_cols, "importance": pi.importances_mean,
                      "std": pi.importances_std})
        .sort_values("importance", ascending=False)
        .reset_index(drop=True)
    )


def fit_full(df: pd.DataFrame, feature_cols: list[str] = None, kind: str = "gbdt"):
    feature_cols = feature_cols or ALL_FEATURES
    m = make_model(kind)
    m.fit(df[feature_cols].to_numpy(dtype=float), df["y"].to_numpy(dtype=int))
    return m


if __name__ == "__main__":
    import sys
    from trace import reconstruct, find_task_dirs
    from features import build_dataframe

    root = sys.argv[1] if len(sys.argv) > 1 else (
        "/home/bob/Desktop/bobflow/dataflow-agent/llm-training-set-v1-kramabench"
    )
    traces = [reconstruct(d) for d in find_task_dirs(root)]
    df = build_dataframe(traces)
    pd.set_option("display.width", 200)

    print(f"rows={len(df)} tasks={df.task_id.nunique()} pos_rate={df.y.mean():.3f}\n")
    print("=== ablation (task-grouped 5-fold CV) — GBDT ===")
    print(ablation(df, "gbdt").to_string(index=False))
    print("\n=== ablation — LogReg ===")
    print(ablation(df, "logreg").to_string(index=False))
    print("\n=== permutation importance (GBDT, all features) ===")
    print(importances(df).head(15).to_string(index=False))
