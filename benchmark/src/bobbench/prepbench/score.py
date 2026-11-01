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
"""Score PrepBench attempts with PrepBench's own evaluator (<prepbench repo>/src/evaluate, unchanged) on each attempt's
outputs/, and report pass rate, failure types and billed cost per model x system.

A case passes when every output file matches the gold: same row count, a one-to-one key match, values within the
column's matcher (2% for numbers). The evaluator reports the first error per case; its type is kept (NOT_FOUND = no
output written, ROW_COUNT_MISMATCH, KEY_MISMATCH, VALUE_MISMATCH, MISSING_COLUMNS, ...). Costs are billed as in every
run: BobFlow from stats.json (wire-reconciled), Script ReAct from the usage in model-request-trace.jsonl, priced with
bobbench.profiling.usage (OpenRouter responses carry their billed usage.cost).

PREPBENCH_REPO is a checkout of TsinghuaDatabaseGroup/prepbench at 993a313 (default ~/datasets/prepbench); its src/
must be on PYTHONPATH and KramaBench's root must not be (its evaluate.py would shadow PrepBench's evaluate package).

    bench score prepbench <out.json> <run> [<run> ...]
"""
import argparse
import collections
import json
from pathlib import Path
import statistics as st

from evaluate.core import evaluate  # PrepBench's evaluator

from bobbench.models import MODEL_TYPES as MODELS, price_schedule
from bobbench.paths import PREPBENCH_REPO
from bobbench.prepbench.hooks import INDEX
from bobbench.profiling.usage import response_cost

GT = PREPBENCH_REPO / "src/evaluate/gt"
SYSTEMS = {"smolagents": "smolagents", "evidence_data1_flow0": "dataflow, flow off", "evidence_data1_flow1": "dataflow, flow on",
           "evidence_full_flow0": "dataflow baseline", "evidence_full_flow1": "dataflow, flow only"}


def smol_cost(attempt, model):
    pricing, cost = price_schedule(MODELS[model]), 0.0
    trace = attempt / "model-request-trace.jsonl"
    if trace.exists():
        for line in trace.open():
            event = json.loads(line)
            if event.get("phase") == "response" and event.get("usage"):
                cost += response_cost(event["usage"], pricing) or 0
    return cost


def score(run):
    rows = []
    for row in json.loads((Path(run) / "progress.json").read_text())["completed"]:
        attempt = Path(run) / "system_scratch" / row["sut"] / row["task"]
        outputs = attempt / "outputs"
        if outputs.is_dir() and any(outputs.glob("output_*.csv")):
            try:
                passed, error = evaluate(str(GT / INDEX[row["task"]]["case"]), str(outputs))
            except Exception as exc:  # the evaluator's own errors count as a failed case, as in PrepBench
                passed, error = False, {"error_type": "EXCEPTION", "message": repr(exc)}
        else:
            passed, error = False, {"error_type": "NOT_FOUND", "message": "no output file was written"}
        if row["arm"] == "smolagents":
            cost = smol_cost(attempt, row["model"])
        else:
            stats = json.loads((attempt / "stats.json").read_text()) if (attempt / "stats.json").exists() else {}
            cost = stats.get("cost_usd") or row.get("cost_usd") or 0.0
        rows.append({"run": Path(run).name, "model": row["model"], "system": SYSTEMS.get(row["arm"], row["arm"]),
                     "task": row["task"], "rep": row["rep"], "passed": bool(passed),
                     "error_type": None if passed else (error or {}).get("error_type"),
                     "error": None if passed else str((error or {}).get("message"))[:300],
                     "cost_usd": cost, "seconds": row.get("seconds"), "timeout": row.get("timeout")})
    return rows


def main():
    parser = argparse.ArgumentParser(prog="bench score prepbench", description=__doc__.split("\n\n")[0])
    parser.add_argument("out", type=Path, help="where the per-attempt rows go (JSON)")
    parser.add_argument("runs", nargs="+", type=Path)
    args = parser.parse_args()
    rows = [r for run in args.runs for r in score(run)]
    args.out.write_text(json.dumps(rows, indent=1) + "\n")
    cells = collections.defaultdict(list)
    for r in rows:
        cells[(r["model"], r["system"])].append(r)
    print("| Model | System | Attempts | Pass | Mean $/task | Mean s | Failures by type |")
    print("|---|---|---|---|---|---|---|")
    for (model, system), rs in sorted(cells.items()):
        kinds = collections.Counter(r["error_type"] for r in rs if not r["passed"])
        print(f"| {model} | {system} | {len(rs)} | {100 * st.mean(r['passed'] for r in rs):.1f}% "
              f"({sum(r['passed'] for r in rs)}) | {st.mean(r['cost_usd'] for r in rs):.4f} | "
              f"{st.mean(r['seconds'] or 0 for r in rs):.0f} | {', '.join(f'{k} {v}' for k, v in kinds.most_common())} |")


if __name__ == "__main__":
    main()
