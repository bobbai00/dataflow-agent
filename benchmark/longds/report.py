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
"""Summarize judged LongDS session runs: accuracy, cost and behavior per run
and per arm.

Usage (from the repository root, after judge.py):
    python -m benchmark.longds.report --runs R/runs [--json R/summary.json]
"""
import argparse
from collections import defaultdict
import json
from pathlib import Path
import statistics

from benchmark.longds.behavior import run_behavior
from benchmark.longds.common import load, save

LABELS = ("Initial", "Update", "Rollback", "Counterfactual")


def run_summary(run):
    protocol = load(run / "protocol.json")
    # A run of the first N requests is scored against those N.
    gold = {t["turn_id"]: t for t in load(Path(protocol["prepared"]) / "gold.json")["turns"]
            if t["turn_id"] <= protocol.get("turns", t["turn_id"])}
    records = load(run / "records.json") if (run / "records.json").exists() else []
    scores = {}
    for record in records:
        path = run / f"t{record['turn_id']:02d}" / "judge.json"
        scores[record["turn_id"]] = load(path).get("score") if path.exists() else None
    calls = sum(r["llm_calls"] for r in records)
    usage = {key: sum(r["usage"][key] for r in records) for key in ("input_tokens", "cached_tokens", "output_tokens")}
    costs = [r["cost_usd"] for r in records]
    by_label = {label: [scores.get(n) for n, turn in gold.items() if label in turn["state_type"] and n in scores]
                for label in LABELS}
    behavior = run_behavior(run)
    return {
        "run": run.name, "session": Path(protocol["prepared"]).name, "arm": protocol["arm"], "model": protocol["model"],
        "turns": len(gold), "answered": len(records), "completed": sum(r["completed"] for r in records),
        "correct": sum(1 for s in scores.values() if s == 1), "unscored": sum(1 for s in scores.values() if s is None),
        "by_label": {label: f"{sum(1 for s in v if s == 1)}/{len(v)}" for label, v in by_label.items() if v},
        "cost_usd": round(sum(c for c in costs if c is not None), 4), "unknown_cost": sum(c is None for c in costs),
        "llm_calls": calls, "calls_per_request": round(calls / len(records), 2) if records else None,
        "input_per_call": round(usage["input_tokens"] / calls) if calls else None,
        "cached_share": round(usage["cached_tokens"] / usage["input_tokens"], 3) if usage["input_tokens"] else None,
        "output_per_request": round(usage["output_tokens"] / len(records)) if records else None,
        "max_input_tokens": max((r["max_input_tokens"] for r in records), default=0),
        "behavior": {key: value for key, value in behavior.items() if key != "per request"},
        "scores": {str(n): s for n, s in sorted(scores.items())},
    }


def arm_table(rows):
    """Mean and spread over the runs of each (session, arm)."""
    groups = defaultdict(list)
    for row in rows:
        groups[(row["session"], row["arm"])].append(row)
    out = []
    for (session, arm), group in sorted(groups.items()):
        correct = [row["correct"] for row in group]
        out.append({"session": session, "arm": arm, "runs": len(group), "turns": group[0]["turns"],
                    "correct": correct, "mean_correct": round(statistics.mean(correct), 1),
                    "sd_correct": round(statistics.stdev(correct), 1) if len(correct) > 1 else None,
                    "mean_cost_usd": round(statistics.mean(row["cost_usd"] for row in group), 3),
                    "mean_input_per_call": round(statistics.mean(row["input_per_call"] or 0 for row in group)),
                    "mean_calls_per_request": round(statistics.mean(row["calls_per_request"] or 0 for row in group), 2)})
    return out


def markdown(rows, arms):
    lines = ["| session | arm | runs | correct (each run) | mean | sd | cost/run | input/call | calls/request |",
             "|---|---|---|---|---|---|---|---|---|"]
    for a in arms:
        lines.append(f"| {a['session']} | {a['arm']} | {a['runs']} | {', '.join(map(str, a['correct']))} of {a['turns']} | "
                     f"{a['mean_correct']} | {a['sd_correct'] if a['sd_correct'] is not None else '–'} | "
                     f"${a['mean_cost_usd']:.3f} | {a['mean_input_per_call']:,} | {a['mean_calls_per_request']} |")
    lines += ["", "| run | correct | by label | earlier fns called | settings changes | alternatives | "
                  "earlier tables read | rescans | new fns/request | with settings | revisits reusing |",
              "|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        b = r["behavior"]
        lines.append(f"| {r['run']} | {r['correct']}/{r['turns']} | "
                     f"{', '.join(f'{k[0]} {v}' for k, v in r['by_label'].items())} | {b['earlier functions called']} | "
                     f"{b['settings changes']} | {b['alternatives']} | {b['earlier tables read']} | {b['rescans']} | "
                     f"{b['new functions per request']} | {b['share of new functions with settings']} | "
                     f"{b['revisits reusing']} |")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--runs", type=Path, required=True)
    parser.add_argument("--json", type=Path)
    args = parser.parse_args()
    rows = [run_summary(run) for run in sorted(p for p in args.runs.iterdir() if (p / "protocol.json").exists())]
    arms = arm_table(rows)
    if args.json:
        save(args.json, {"runs": rows, "arms": arms})
    print(markdown(rows, arms))


if __name__ == "__main__":
    main()
