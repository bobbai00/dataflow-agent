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
"""bench report: accuracy and cost per (benchmark, model, arm) over the attempts of one or more runs.

    bench report <run> [<run> ...] [--scores <bench score prepbench output> ...] [--fail RUN:TASK ...] [--merge]
                 [--json OUT]

- Attempts: the last attempt per (task, repetition, SUT) of each run's progress.json, as the paper's tables count them.
- KramaBench accuracy: the share of attempts whose score (the best of the evaluator's metrics) reaches the run's pass
  threshold (1.0); an unscored attempt counts as failed. The mean score is shown beside it.
- PrepBench accuracy: the pass rate PrepBench's evaluator gave the attempt's output tables (`bench score prepbench`
  output, matched by run folder name and task); without one the cell has no accuracy.
- Cost of one full pass: the mean billed cost per attempt times the benchmark's task count (104 / 306). An attempt
  without a complete bill counts what its finished calls billed (killed attempts, unbilled failed calls); one with no
  bill at all counts $0 and is flagged in the table (every model call rejected, nothing charged).
- --fail RUN:TASK counts an attempt as failed whatever its score (an integrity exclusion; the paper's
  opt2-pb-gemflash:prepbench-hard-277 fetched the published solution).
- --merge treats the runs, in the order given, as one run: a later run's attempt replaces an earlier run's attempt of
  the same model, arm, task and repetition (provider-failure reruns, a run continued in another folder). Without it,
  separate runs of a cell are separate repetitions and all count.

It reads old run folders as well (the 2026-10 layout: no system/benchmark in the manifest, Script ReAct manifests with
script_settings). Only files are read; no model, judge or service is called.
"""
import argparse
from collections import defaultdict
import json
from pathlib import Path
import statistics

TASKS = {"kramabench": 104, "prepbench": 306}


def load(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def kind(manifest):
    """(benchmark, system) of a run, from its manifest (inferred for runs before the manifest said)."""
    ids = manifest.get("task_ids") or []
    benchmark = manifest.get("benchmark") or (
        "prepbench" if ids and all(t.startswith("prepbench-") for t in ids) else "kramabench")
    system = manifest.get("system") or ("scriptreact" if "script_settings" in manifest else "bobflow")
    return benchmark, system


def attempts(run):
    """The last attempt per (task, repetition, SUT)."""
    last = {}
    for row in (load(run / "progress.json") or {}).get("completed", []):
        last[(row["task"], row.get("rep", 1), row.get("sut"))] = row
    return list(last.values())


def billed(row, stats, scored=None):
    """An attempt's billed cost: the runner's (or score.py's) figure; else what its finished calls billed."""
    cost = (scored or {}).get("cost_usd") or row.get("cost_usd")
    if cost is None:
        cost = stats.get("partial_provider_reported_cost_usd") or stats.get("reported_usage_cost_usd") \
            or stats.get("estimated_cost_usd")
    return cost


def rows(runs, scores, failed):
    found = []
    for run in runs:
        run = Path(run)
        manifest = load(run / "manifest.json") or {}
        benchmark, system = kind(manifest)
        threshold = manifest.get("pass_threshold", 1.0)
        for row in attempts(run):
            attempt = run / "system_scratch" / row["sut"] / row["task"]
            stats = load(attempt / "stats.json", {})
            scored = scores.get((run.name, row["task"])) if benchmark == "prepbench" else None
            if benchmark == "prepbench":
                passed = None if scored is None else bool(scored.get("passed"))
                score = None
            else:
                score = row.get("score")
                passed = (score or 0) >= threshold
            if (run.name, row["task"]) in failed:
                passed = False
            found.append({"run": run.name, "benchmark": benchmark, "system": system, "model": row["model"],
                          "model_id": (manifest.get("models") or {}).get(row["model"], row["model"]),
                          "arm": row.get("arm") if system == "bobflow" else "smolagents", "task": row["task"],
                          "rep": row.get("rep", 1), "passed": passed, "score": score,
                          "cost_usd": billed(row, stats, scored), "timeout": bool(row.get("timeout")),
                          "seconds": row.get("seconds")})
    return found


def merged(found):
    """The last attempt per (benchmark, model, arm, task, repetition), in run order."""
    last = {}
    for row in found:
        last[(row["benchmark"], row["model"], row["arm"], row["task"], row["rep"])] = row
    return list(last.values())


def cells(found):
    groups = defaultdict(list)
    for row in found:
        groups[(row["benchmark"], row["model"], row["arm"])].append(row)
    table = []
    for (benchmark, model, arm), items in sorted(groups.items()):
        judged = [r["passed"] for r in items if r["passed"] is not None]
        scores = [r["score"] for r in items if r["score"] is not None]
        costs = [r["cost_usd"] for r in items if r["cost_usd"] is not None]
        unbilled = len(items) - len(costs)
        table.append({"benchmark": benchmark, "model": model, "model_id": items[0]["model_id"], "arm": arm,
                      "runs": sorted({r["run"] for r in items}), "attempts": len(items),
                      "accuracy": 100 * sum(judged) / len(judged) if judged and len(judged) == len(items) else None,
                      "mean_score": 100 * statistics.mean(scores) if scores else None,
                      "cost_per_pass": sum(costs) / len(items) * TASKS[benchmark] if costs else None,
                      "unbilled": unbilled, "timeouts": sum(r["timeout"] for r in items)})
    return table


def render(table):
    lines = ["| Benchmark | Model | Arm | Attempts | Accuracy | Mean score | Cost per pass | Timeouts | Runs |",
             "|---|---|---|---|---|---|---|---|---|"]
    for c in table:
        accuracy = f"{c['accuracy']:.1f}%" if c["accuracy"] is not None else "n/a (needs --scores)"
        score = f"{c['mean_score']:.1f}" if c["mean_score"] is not None else "-"
        cost = f"${c['cost_per_pass']:.2f}" if c["cost_per_pass"] is not None else "-"
        if c["unbilled"]:
            cost += f" ({c['unbilled']} with no bill, counted $0)"
        lines.append(f"| {c['benchmark']} | {c['model']} | {c['arm']} | {c['attempts']} | {accuracy} | {score} | {cost} "
                     f"| {c['timeouts']} | {', '.join(c['runs'])} |")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(prog="bench report", description=__doc__.split("\n\n")[0],
                                     formatter_class=argparse.RawDescriptionHelpFormatter,
                                     epilog=__doc__.split("\n\n", 1)[1])
    parser.add_argument("runs", nargs="+", type=Path)
    parser.add_argument("--scores", nargs="+", type=Path, default=[], help="bench score prepbench outputs")
    parser.add_argument("--fail", nargs="+", default=[], metavar="RUN:TASK", help="count these attempts as failed")
    parser.add_argument("--merge", action="store_true", help="later runs replace earlier attempts of the same task")
    parser.add_argument("--json", type=Path, help="also write the cells and attempts here")
    args = parser.parse_args()
    scores = {}
    for path in args.scores:
        for row in load(path, []):
            scores[(Path(row["run"]).name, row["task"])] = row
    failed = {tuple(item.split(":", 1)) for item in args.fail}
    found = rows(args.runs, scores, failed)
    if args.merge:
        found = merged(found)
    table = cells(found)
    print(render(table))
    if args.json:
        args.json.write_text(json.dumps({"cells": table, "attempts": found}, indent=1) + "\n")


if __name__ == "__main__":
    main()
