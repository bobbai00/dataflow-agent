# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.

"""Freeze a small, reference-verified bounded-context LongDS pilot.

Run solvers with comparison_campaign.py. Rubrics are diagnostic and frozen
before solver requests; official binary judgments remain authoritative.
"""
import argparse
from datetime import datetime, timezone
from importlib import metadata
import json
from pathlib import Path
import shutil
import subprocess
import sys

from comparison_budget import ESTIMATOR
from partial_score import compare_table
from state_comparison import HERE, ROOT, MODEL, RATES, arm_settings, make_jobs, digest, save

CASES = {
    "community/kaggle-survey-2021/task2": {
        "turn_limit": 19,
        "rationale": "Task 19 reuses earlier Python/Matplotlib selections and compares the new subgroup with the earlier overall framework ranking (tasks 10, 16, 18).",
        "rubric": {"turn_id": 19, "key_fields": ["framework"], "value_fields": ["pct"], "ordered": True, "decimals": 2,
                   "tables": ["python_mpl_top5_men", "python_mpl_top5_women", "overall_top5_men", "overall_top5_women"]},
    },
    "business/netflix_movies_and_tv_shows/task3": {
        "turn_limit": 19,
        "rationale": "Task 19 replaces only the historical long-film rule while preserving current other score components and current top-eight membership (tasks 16, 17).",
        "rubric": {"turn_id": 19, "key_fields": ["country"], "value_fields": ["absolute_score_difference"], "ordered": True, "decimals": 4,
                   "tables": ["most_sensitive_to_decade_adjustment"]},
    },
}


def score_rubric(expected, actual, rubric):
    """Score only recognized table structures; unfamiliar shapes stay unscored.

    Identity, requested values and rank are independent axes. This measures
    answer components, not whether the unseen intermediate procedure was right.
    """
    if not isinstance(actual, dict) or not any(name in actual for name in rubric["tables"]):
        return {"status": "unrecognized_shape", "tables": {}, "partial_score": None}
    tables = {}
    for name in rubric["tables"]:
        value = actual.get(name)
        if value is not None and (not isinstance(value, list) or any(not isinstance(row, dict) for row in value)):
            return {"status": "unrecognized_shape", "tables": {}, "partial_score": None}
        tables[name] = compare_table(expected[name], value, rubric["key_fields"], rubric["value_fields"],
                                     ordered=rubric["ordered"], decimals=rubric["decimals"])
    return {"status": "scored", "tables": tables,
            "partial_score": sum(t["partial_score"] for t in tables.values()) / len(tables)}


def freeze(args):
    output = args.output.resolve()
    folder = output / args.phase
    if folder.exists():
        raise FileExistsError(folder)
    calibration = json.loads(args.calibration.read_text())["calibration"]
    if calibration["estimator"] != ESTIMATOR or args.budget <= 0:
        raise ValueError("A matching calibration and positive input budget are required")
    gates = {row["task"]: row for row in json.loads((output / "gates-prefix.json").read_text())}
    jobs = make_jobs(list(CASES), ["dsgym", "history"], args.reps, args.phase)
    for job in jobs:
        case = CASES[job["task"]]
        if gates[job["task"]]["exit_code"] or gates[job["task"]]["turn_limit"] != case["turn_limit"]:
            raise ValueError(f"Reference prefix did not pass: {job['task']}")
        job.update(turn_limit=case["turn_limit"], turns_total=case["turn_limit"],
                   settings=None if job["arm"] == "dsgym" else {**arm_settings("history"), "taskContext": "dependencies"})
    files = [HERE / name for name in ["bounded_pilot.py", "state_comparison.py", "comparison_job.py", "comparison_capture.py",
              "comparison_budget.py", "partial_score.py", "dsgym_agent.py", "dsgym_executor.py", "judge_longds.py", "numeric_gate.py"]]
    files += [ROOT / "agent-service/benchmark/multiturn/run-comparison-session.ts"]
    files += [p for p in (ROOT / "agent-service/src").rglob("*") if p.is_file() and p.suffix in {".ts", ".md", ".py"} and not p.name.endswith(".test.ts")]
    files += list((HERE / "DataMind/longds/runners/DSGym/dsgym/agents").rglob("*.py"))
    prompt = HERE / "DataMind/longds/runners/DSGym/scripts/prompt.py"
    files += [prompt]
    hashes = {task: {name: digest(output / "prepared" / task.replace("/", "__") / name)
                    for name in ["manifest.json", "gold.json", "prompts.json"]} for task in CASES}
    names = {name for task in CASES for name in json.loads((output / "prepared" / task.replace("/", "__") / "manifest.json").read_text())["files"]}
    protocol = {
        "phase": args.phase, "created_at": datetime.now(timezone.utc).isoformat(), "model": MODEL,
        "reasoning_effort": "medium", "max_model_calls_per_turn": 40, "max_output_tokens_per_call": 8192,
        "context_budget": args.budget, "endpoint": args.endpoint, "api_base": args.api_base, "views": "stats",
        "full_input_policy": {"budget_tokens": args.budget, "scale": calibration["scale"], "estimator": ESTIMATOR,
                              "calibration_sha256": digest(args.calibration), "semantics": "Full input including system/tool schemas; measured provider usage audited separately."},
        "wire_root": str(output / "wire"), "repetitions": args.reps, "cases": CASES,
        "baseline_policy": "Persistent repo Python kernel, same-model incremental summary of complete older messages in bounded chunks plus live kernel inventory. All summary calls/cost included. No resets.",
        "script_kernel_notice": args.kernel_notice,
        "solver_attempt_policy": "All attempts retained, no score-selected retries. One repetition is a feasibility pilot, not a benchmark-wide result.",
        "cohort_policy": "Question/dependency-selected natural prefixes; reference gate only, no solver scores used. 2020 survey rejected before solving because five published answers contain NaN.",
        "metrics_policy": "Official binary grade, strict JSON validity, frozen final-target table identity/value/rank components, calls including summaries, cache, latency, request cap and trace error audit. Unknown partial-score structures stay unscored.",
        "rates_usd_per_million": RATES, "pricing_source": "Frozen repository fallback; estimates, not invoices",
        "judge": "deepseek/deepseek-v4-pro", "judge_prompt_sha256": digest(prompt),
        "source_root": str(ROOT), "source_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "source_hashes": {str(p.relative_to(ROOT)): digest(p) for p in files}, "prepared_hashes": hashes,
        "prompt_hashes": {t: h["prompts.json"] for t, h in hashes.items()},
        "input_files": {n: {"bytes": (ROOT / n).stat().st_size, "mtime_ns": (ROOT / n).stat().st_mtime_ns, "sha256": digest(ROOT / n)} for n in sorted(names)},
        "jobs": jobs, "runtime": {"python": sys.version, "executable": sys.executable,
            "packages": {n: metadata.version(n) for n in ["numpy", "pandas", "scipy", "scikit-learn", "statsmodels", "ipykernel", "jupyter-client"]}},
    }
    for name, sha in protocol["source_hashes"].items():
        archive = folder / "source" / name
        archive.parent.mkdir(parents=True, exist_ok=True)
        with archive.open("xb") as stream:
            stream.write((ROOT / name).read_bytes())
        if digest(archive) != sha:
            raise RuntimeError(f"Source changed while freezing: {name}")
    shutil.copyfile(args.calibration, folder / "calibration.json")
    shutil.copyfile(output / "gates-prefix.json", folder / "reference-gates.json")
    save(folder / "manifest.json", protocol)
    print(f"Frozen {len(jobs)} jobs, {sum(j['turns_total'] for j in jobs)} answers, input cap {args.budget}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--calibration", type=Path, required=True)
    parser.add_argument("--phase", default="bounded")
    parser.add_argument("--budget", type=int, default=32000)
    parser.add_argument("--reps", type=int, default=1)
    parser.add_argument("--kernel-notice", action="store_true")
    parser.add_argument("--endpoint", default="http://localhost:3068")
    parser.add_argument("--api-base", default="http://localhost:4000/v1")
    freeze(parser.parse_args())
