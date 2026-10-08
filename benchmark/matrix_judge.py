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
"""Grade preserved matrix predictions with each original benchmark evaluator.

DSBench may call its exact official GPT-4o snapshot. This separate command
never launches tested agents; diagnostic labels never replace official scores.
"""

import argparse
import ast
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from benchmark.dsbench.judge import (  # noqa: E402 - direct script entrypoint
    judge_prediction,
    cache_key,
    official_request,
)
from benchmark.experiment_matrix import write_new  # noqa: E402


def diagnostic_ds(answer, prediction):
    """Conservative explicit MCQ/numeric diagnostic, with ambiguous text unknown."""
    cleaned = prediction.strip().strip("*` ")
    if isinstance(answer, str) and re.fullmatch(r"[A-H]", answer.strip(), re.I):
        match = re.match(r"^([A-H])(?:[.)\s]|$)", cleaned, re.I)
        if match:
            return {
                "method": "explicit_choice_letter",
                "correct": match[1].upper() == answer.strip().upper(),
                "observed": match[1].upper(),
            }
        return {
            "method": "explicit_choice_letter",
            "correct": None,
            "reason": "No unambiguous explicit option letter; do not infer/rescore.",
        }
    try:
        observed = ast.literal_eval(cleaned)
    except (ValueError, SyntaxError):
        observed = cleaned
    return {"method": "typed_exact_answer", "correct": observed == answer, "observed": observed}


def judge_matrix(output, *, cache_dir, endpoint=None, benchmark=None):
    output = Path(output).resolve()
    manifest = json.loads((output / "manifest.json").read_text())
    gold_path = Path(manifest["ds_prepared_root"]) / "evaluation/gold.json"
    gold = json.loads(gold_path.read_text()) if benchmark != "kramabench" else []
    gold_rows = gold.get("tasks", []) if isinstance(gold, dict) else gold
    gold_by_id = {row["task_id"]: row for row in gold_rows}
    for job in manifest["jobs"]:
        if benchmark and job["benchmark"] != benchmark:
            continue
        directory = output / "attempts" / job["attempt_id"]
        if not (directory / "status.json").exists() or (directory / "evaluation.json").exists():
            continue
        if job["benchmark"] == "dsbench":
            task = gold_by_id[job["task_id"]]
            prediction = (directory / "response.txt").read_text()
            try:
                result = judge_prediction(
                    task["question"], task["answer"], prediction, cache_dir=cache_dir, endpoint=endpoint
                )
            except Exception as error:
                key = cache_key(official_request(task["question"], task["answer"], prediction))
                attempted = any((Path(cache_dir) / f"{key}{suffix}").exists() for suffix in (".json", ".pending.json"))
                result = {
                    "official_correct": None,
                    "error": {"type": type(error).__name__},
                    "state": "grading_capture_failed" if attempted else "grading_preflight_failed",
                    "incremental_model_calls": int(attempted),
                    "incremental_cost_usd": None if attempted else 0,
                    "reason": "No official judgment returned; score remains unknown.",
                }
            if result.get("model_mismatch"):
                # Keep the original evaluator/cache receipt intact. A verdict
                # from another snapshot cannot establish this campaign's score.
                result = {
                    **result,
                    "original_official_verdict": result.get("official_correct"),
                    "official_correct": None,
                    "state": "invalid_judge_model",
                    "reason": "Returned judge model differs from the exact official snapshot.",
                }
            write_new(
                directory / "evaluation.json", {"task_id": job["task_id"], "attempt_id": job["attempt_id"], **result}
            )
            write_new(directory / "diagnostic-evaluation.json", diagnostic_ds(task["answer"], prediction))
        else:
            command = [
                manifest.get("scorer_python", str(ROOT / "benchmark/Kramabench/.venv/bin/python")),
                str(ROOT / "benchmark/retrieval/score_recorded_task.py"),
                "--attempt",
                str(directory),
                "--task-id",
                job["task_id"],
                "--system",
                "smolagents" if job["arm"] == "smol_custom" else "native",
            ]
            with (directory / "evaluation.log").open("x") as log:
                result = subprocess.run(
                    command, cwd=ROOT / "benchmark/Kramabench", stdout=log, stderr=subprocess.STDOUT, check=False
                )
            if result.returncode:
                write_new(
                    directory / "evaluation.json",
                    {
                        "task_id": job["task_id"],
                        "error": f"Official evaluator subprocess exited {result.returncode}",
                        "official_correct": None,
                    },
                )
            write_new(
                directory / "diagnostic-evaluation.json",
                {
                    "method": "raw_response_preservation",
                    "correct": None,
                    "reason": "Official parser/metrics are preserved separately; no diagnostic rescoring.",
                },
            )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--endpoint", help="Exact DSBench GPT-4o snapshot gateway; no aliases substituted")
    parser.add_argument("--benchmark", choices=["dsbench", "kramabench"])
    args = parser.parse_args()
    judge_matrix(args.output, cache_dir=args.cache_dir, endpoint=args.endpoint, benchmark=args.benchmark)


if __name__ == "__main__":
    main()
