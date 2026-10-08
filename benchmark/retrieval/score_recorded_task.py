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
"""Score an existing raw answer with the unchanged KramaBench evaluator."""

import argparse
import json
from pathlib import Path
import sys

KB = Path(__file__).resolve().parents[1] / "Kramabench"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--attempt", type=Path, required=True)
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--system", choices=["native", "smolagents"], required=True)
    args = parser.parse_args()
    if (args.attempt / "evaluation.json").exists():
        raise SystemExit("Existing official evaluation is immutable")
    sys.path.insert(0, str(KB))
    from benchmark.benchmark import Evaluator
    from utils.answer_parser import parse_answer, parse_explicit_answer

    workload = args.task_id.split("-", 1)[0]
    raw = (args.attempt / "response.txt").read_text()
    status = json.loads((args.attempt / "status.json").read_text())
    parsed = (
        parse_explicit_answer(raw) if args.system == "smolagents" and status.get("completed") else parse_answer(raw)
    )
    evaluator = Evaluator(
        workload_path=KB / f"workload/{workload}.json",
        task_fixture_directory=KB / "benchmark/fixtures",
        results_directory=args.attempt,
        evaluate_pipeline=False,
        task_id_filter=[args.task_id],
    )
    response = {"task_id": args.task_id, "model_output": {"id": "main-task", "answer": parsed}, "code": ""}
    result = evaluator.evaluate_results([response])[0]
    result["provenance"] = {
        "evaluator": "Unchanged benchmark.Kramabench Evaluator",
        "pipeline_evaluation": False,
        "answer_parser": (
            "parse_explicit_answer" if args.system == "smolagents" and status.get("completed") else "parse_answer"
        ),
        "raw_prediction_file": "response.txt",
    }
    with (args.attempt / "evaluation.json").open("x") as stream:
        json.dump(result, stream, indent=2, default=str)
        stream.write("\n")


if __name__ == "__main__":
    main()
