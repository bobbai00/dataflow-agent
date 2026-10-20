# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements. See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Compare two run directories of run.py (e.g. a previous and a new base).

Usage: python benchmark/retrieval/compare_runs.py OLD_DIR NEW_DIR [--history results.json ...]
Per model: passes, mean official score, total and per-attempt cost, model
calls, cached input share, action errors, plain-text replies, timeouts. Per
task: the scores of every repetition and the median cost, side by side.
History files are run.py-style reports with an `attempts` list, or progress.json files.
"""
import argparse
import json
import statistics
from pathlib import Path


def attempts(run_dir):
    progress = json.loads((run_dir / "progress.json").read_text())
    rows = []
    for row in progress.get("completed", []):
        scratch = run_dir / "system_scratch" / row["sut"] / row["task"]
        stats = json.loads((scratch / "stats.json").read_text()) if (scratch / "stats.json").exists() else {}
        rows.append({**row, "calls": stats.get("num_steps"), "input": stats.get("input_tokens", 0),
                     "cached": stats.get("cached_tokens", 0), "output": stats.get("output_tokens", 0)})
    return rows


def history(path):
    data = json.loads(Path(path).read_text())
    rows = data.get("attempts") or data.get("completed") or []
    return [r for r in rows if r.get("arm") == "adaptive_flow1"]


def summary(rows):
    scores = [r["score"] or 0.0 for r in rows]
    costs = [r["cost_usd"] or 0.0 for r in rows]
    audits = [r.get("audit") or {} for r in rows]
    tokens = sum(r.get("input", 0) for r in rows)
    return {"attempts": len(rows), "passes": sum(s >= 1 for s in scores),
            "mean_score": statistics.mean(scores) if scores else None,
            "cost": sum(costs), "cost_per": statistics.mean(costs) if costs else None,
            "calls": statistics.mean(r["calls"] for r in rows if r.get("calls")) if any(r.get("calls") for r in rows) else None,
            "cached": sum(r.get("cached", 0) for r in rows) / tokens if tokens else None,
            "action_errors": sum(a.get("action_errors", 0) for a in audits),
            "text_replies": sum(a.get("text_replies", 0) for a in audits),
            "timeouts": sum(bool(r.get("timeout")) for r in rows)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("old", type=Path)
    parser.add_argument("new", type=Path)
    parser.add_argument("--history", nargs="*", default=[])
    args = parser.parse_args()
    runs = {"old": attempts(args.old), "new": attempts(args.new)}
    past = [r for path in args.history for r in history(path)]
    models = sorted({r["model"] for rows in runs.values() for r in rows})
    for model in models:
        print(f"\n=== {model}")
        print(f"{'base':5s} {'passes':>7s} {'score':>6s} {'cost':>9s} {'per try':>9s} {'calls':>6s} {'cached':>7s} "
              f"{'act.err':>7s} {'text':>5s} {'t/o':>4s}")
        for base, rows in runs.items():
            s = summary([r for r in rows if r["model"] == model])
            print(f"{base:5s} {s['passes']:3d}/{s['attempts']:<3d} {s['mean_score']:6.3f} ${s['cost']:8.4f} ${s['cost_per']:8.4f} "
                  f"{s['calls']:6.1f} {s['cached']:7.0%} {s['action_errors']:7d} {s['text_replies']:5d} {s['timeouts']:4d}")
        tasks = sorted({r["task"] for rows in runs.values() for r in rows if r["model"] == model})
        print(f"{'task':22s} {'old scores':>16s} {'new scores':>16s} {'old median $':>13s} {'new median $':>13s}   history (adaptive_flow1)")
        for task in tasks:
            cells = {}
            for base, rows in runs.items():
                mine = sorted((r for r in rows if r["model"] == model and r["task"] == task), key=lambda r: r["rep"])
                cells[base] = (" ".join(f"{(r['score'] or 0):.2g}" for r in mine),
                               statistics.median(r["cost_usd"] or 0 for r in mine) if mine else float("nan"))
            hist = [r for r in past if r["model"] == model and r["task"] == task]
            hist_text = " ".join(f"{(r.get('score') or 0):.2g}/${r.get('cost_usd') or 0:.4f}" for r in hist)
            print(f"{task:22s} {cells['old'][0]:>16s} {cells['new'][0]:>16s} {cells['old'][1]:13.4f} {cells['new'][1]:13.4f}   {hist_text}")


if __name__ == "__main__":
    main()
