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
Cross-model transfer test (ML_TRAINING.md §6.F): does a context-utility model
trained on one agent model's traces transfer to another?

Train on the 60 shipped kramabench traces (claude-haiku-4.5); test on freshly
generated gpt-5-mini traces (the live run). This is the end-to-end verification
of the method on the live gpt-5-mini tasks.

Usage:
  python cross_model.py [--train DIR] [--test DIR]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, roc_auc_score

from trace import reconstruct, find_task_dirs
from features import build_dataframe, ALL_FEATURES
from train import fit_full
from selection import evaluate_frontier, coverage_at


def _load(root: str) -> tuple[list, pd.DataFrame]:
    # trace-gen output keeps traces under <root>/traces/<task>; kramabench keeps
    # them as <root>/<task>. Detect which.
    root_p = Path(root)
    traces_dir = root_p / "traces"
    base = traces_dir if traces_dir.is_dir() else root_p
    dirs = find_task_dirs(base)
    traces = [reconstruct(d) for d in dirs]
    return traces, build_dataframe(traces)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", default="/home/bob/Desktop/bobflow/dataflow-agent/llm-training-set-v1-kramabench")
    ap.add_argument("--test", default="/home/bob/Desktop/bobflow/dataflow-agent/agent-service/benchmark/llm-training-data-generation/output/kramabench")
    ap.add_argument("--out", default="cross_model_report.json")
    args = ap.parse_args()

    tr_traces, tr_df = _load(args.train)
    te_traces, te_df = _load(args.test)
    pd.set_option("display.width", 200)

    print("=" * 74)
    print(f"CROSS-MODEL TRANSFER  train={tr_traces[0].model_type or '?'} ({tr_df.task_id.nunique()} tasks, {len(tr_df)} rows)")
    print(f"                      test ={te_traces[0].model_type or '?'} ({te_df.task_id.nunique()} tasks, {len(te_df)} rows)")
    print("=" * 74)

    print("\n--- live gpt-5-mini test tasks ---")
    rows = []
    for tr in te_traces:
        sub = te_df[te_df.task_id == tr.task_id]
        rows.append({"task_id": tr.task_id, "success": tr.success, "decisions": len(tr.decisions),
                     "final_ops": tr.n_final_ops, "lineage": len(tr.final_lineage),
                     "rows": len(sub), "load_bearing": round(float(sub.y.mean()), 2) if len(sub) else 0.0})
    print(pd.DataFrame(rows).to_string(index=False))

    # Train on haiku, predict gpt-5-mini
    model = fit_full(tr_df, ALL_FEATURES, kind="gbdt")
    te_df = te_df.copy()
    te_df["pred"] = model.predict_proba(te_df[ALL_FEATURES].to_numpy(dtype=float))[:, 1]

    auc = roc_auc_score(te_df.y, te_df.pred) if te_df.y.nunique() > 1 else float("nan")
    ap_ = average_precision_score(te_df.y, te_df.pred)
    base_rate = float(te_df.y.mean())
    print(f"\n--- transfer (haiku→gpt-5-mini): AUC={auc:.3f}  AP={ap_:.3f}  (base rate={base_rate:.3f}) ---")

    curves, aucc = evaluate_frontier(te_df)
    print("\n--- selection frontier on gpt-5-mini traces (lineage recall vs budget) ---")
    print(curves.round(3).to_string(index=False))
    print("\n--- AUCC (higher=better) ---")
    print(aucc.round(4).to_string())
    cov40 = coverage_at(te_df, 0.4)
    print("\n--- coverage @ 40% budget ---")
    print(cov40.round(3).to_string())

    report = {
        "train_model": tr_traces[0].model_type, "test_model": te_traces[0].model_type,
        "train_tasks": int(tr_df.task_id.nunique()), "test_tasks": int(te_df.task_id.nunique()),
        "transfer_auc": auc, "transfer_ap": ap_, "test_base_rate": base_rate,
        "frontier_aucc": {k: round(v, 4) for k, v in aucc.items()},
        "coverage_at_40pct": {k: round(v, 4) for k, v in cov40.items()},
        "test_tasks_detail": rows,
    }
    out = Path(__file__).parent / args.out
    out.write_text(json.dumps(report, indent=2))
    print(f"\nreport written: {out}")


if __name__ == "__main__":
    main()
