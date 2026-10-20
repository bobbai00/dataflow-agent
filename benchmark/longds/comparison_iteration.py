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
"""Freeze the predeclared context/ledger iteration on one verified revision.

Native trajectories stay unbounded in recorded agent settings: the service's
full-input policy compacts them only after accounting for system/tools. Every
arm uses one development-calibrated estimate, with provider violations audited.
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
from state_comparison import HERE, ROOT, MODEL, RATES, arm_settings, make_jobs, save, digest

COHORT = ["business/my_uber_drivers/task2", "geoscience/cdp-unlocking-climate-solutions/task1",
          "sports/big_data_derby_2022/task1", "community/kaggle-survey-2019/task2"]


def freeze(args):
    folder = args.output.resolve() / args.phase
    if folder.exists():
        raise FileExistsError(folder)
    if args.budget < 0 or args.reps < 1:
        raise ValueError("Budget must be nonnegative and repetitions positive")
    calibration_path = args.previous.resolve() / "input-budget-calibration.json"
    calibration = json.loads(calibration_path.read_text())["calibration"]
    if calibration["estimator"] != ESTIMATOR:
        raise ValueError("Calibration estimator mismatch")
    tasks = ["synthetic/operator_history/task1"] if args.phase == "budget-smoke" else COHORT
    arms = ["history", "ledger"] if args.phase == "ledger" else ["dsgym", "baseline", "history"]
    jobs = make_jobs(tasks, arms, args.reps, args.phase)
    gates = {row["task"]: row for row in json.loads((args.previous / "gates-engine.json").read_text())}
    for task in tasks:
        if task in COHORT and gates.get(task, {}).get("exit_code") != 0:
            raise ValueError(f"Reference preflight did not pass: {task}")
        src = args.previous / "prepared" / task.replace("/", "__")
        dest = args.output / "prepared" / task.replace("/", "__")
        if dest.exists():
            for name in ["manifest.json", "gold.json", "prompts.json"]:
                if digest(dest / name) != digest(src / name):
                    raise ValueError(f"Prepared input drift: {task}/{name}")
        else:
            shutil.copytree(src, dest)
        manifest = json.loads((dest / "manifest.json").read_text())
        for job in jobs:
            if job["task"] == task:
                job["turns_total"] = len(manifest["turns"])
                job["settings"] = None if job["arm"] == "dsgym" else arm_settings(job["arm"])
    files = [HERE / name for name in ["state_comparison.py", "comparison_job.py", "comparison_capture.py",
             "comparison_iteration.py", "comparison_budget.py", "dsgym_agent.py", "dsgym_executor.py", "judge_longds.py", "numeric_gate.py"]]
    files += [ROOT / "agent-service/benchmark/multiturn/run-comparison-session.ts"]
    files += [p for p in (ROOT / "agent-service/src").rglob("*") if p.is_file() and p.suffix in {".ts", ".md", ".py"}
              and not p.name.endswith(".test.ts")]
    files += list((HERE / "DataMind/longds/runners/DSGym/dsgym/agents").rglob("*.py"))
    files += [HERE / "DataMind/longds/runners/DSGym/scripts/prompt.py"]
    prepared_hashes = {task: {name: digest(args.output / "prepared" / task.replace("/", "__") / name)
                             for name in ["manifest.json", "gold.json", "prompts.json"]} for task in tasks}
    names = {name for task in tasks for name in json.loads((args.output / "prepared" / task.replace("/", "__") / "manifest.json").read_text())["files"]}
    inputs = {name: {"bytes": (ROOT / name).stat().st_size, "mtime_ns": (ROOT / name).stat().st_mtime_ns,
                     "sha256": digest(ROOT / name)} for name in sorted(names)}
    protocol = {
        "phase": args.phase, "created_at": datetime.now(timezone.utc).isoformat(),
        "model": MODEL, "reasoning_effort": "medium", "max_model_calls_per_turn": 40, "max_output_tokens_per_call": 8192,
        "context_budget": args.budget, "endpoint": args.endpoint, "api_base": args.api_base, "views": "stats",
        "full_input_policy": {"budget_tokens": args.budget, "scale": calibration["scale"], "estimator": ESTIMATOR,
            "semantics": "Nominal full INPUT budget, includes system/tools; output cap separate. Actual usage/violations audited.",
            "calibration_sha256": digest(calibration_path)},
        "wire_root": str(args.output.resolve() / "wire"), "repetitions": args.reps,
        "solver_attempt_policy": "All independent repetitions retained; no best-of or score-selected retries",
        "rates_usd_per_million": RATES, "pricing_source": "Frozen repository fallback; estimates, not invoices",
        "judge": "deepseek/deepseek-v4-pro", "judge_prompt_sha256": digest(files[-1]),
        "source_root": str(ROOT), "source_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "source_hashes": {str(path.relative_to(ROOT)): digest(path) for path in files},
        "prepared_hashes": prepared_hashes, "prompt_hashes": {task: hashes["prompts.json"] for task, hashes in prepared_hashes.items()},
        "input_files": inputs, "jobs": jobs,
        "runtime": {"python": sys.version, "executable": sys.executable,
                    "packages": {name: metadata.version(name) for name in ["numpy", "pandas", "scipy", "scikit-learn", "statsmodels", "ipykernel", "jupyter-client"]}},
        "cohort_policy": "Metadata-selected four full sessions, three repetitions. Smoke is a separate synthetic protocol rehearsal.",
    }
    for name, sha in protocol["source_hashes"].items():
        archive = folder / "source" / name
        archive.parent.mkdir(parents=True, exist_ok=True)
        with archive.open("xb") as stream:
            stream.write((ROOT / name).read_bytes())
        if digest(archive) != sha:
            raise RuntimeError(f"Source changed while freezing: {name}")
    shutil.copyfile(calibration_path, folder / "calibration.json")
    save(folder / "manifest.json", protocol)
    print(f"Frozen {args.phase}: {len(tasks)} sessions, {len(jobs)} jobs, {sum(job['turns_total'] for job in jobs)} solver turns")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--previous", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--phase", choices=["budget-smoke", "control", "bounded", "ledger"], required=True)
    parser.add_argument("--budget", type=int, required=True)
    parser.add_argument("--reps", type=int, default=3)
    parser.add_argument("--endpoint", default="http://localhost:3051")
    parser.add_argument("--api-base", default="http://localhost:34000/v1")
    freeze(parser.parse_args())
