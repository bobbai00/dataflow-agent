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
"""Bind verbatim predictions to DSBench gold by task identity, outside execution."""

import argparse
import json
from pathlib import Path

if __package__:
    from .judge import JUDGE_MODEL, SOURCE_REVISION, cache_key, official_request
else:
    from judge import JUDGE_MODEL, SOURCE_REVISION, cache_key, official_request

ARMS = ["data0_flow0", "data1_flow0", "data0_flow1", "data1_flow1", "smol_custom"]


def judge_inputs(prepared_root, output_root):
    prepared_root, output_root = Path(prepared_root), Path(output_root)
    manifest = json.loads((prepared_root / "manifest.json").read_text())
    task_ids = [task["task_id"] for task in manifest["tasks"]]
    gold = json.loads((prepared_root / "evaluation/gold.json").read_text())
    records = gold["tasks"] if isinstance(gold, dict) else gold
    by_id = {row["task_id"]: row for row in records}
    if len(by_id) != len(records) or set(by_id) != set(task_ids):
        raise ValueError("Gold identities differ from the prepared task manifest")
    rows = []
    for arm in ARMS:
        for task_id in task_ids:
            directory = output_root / "system_scratch" / arm / task_id
            if not (directory / "status.json").exists():
                continue
            prediction = (directory / "response.txt").read_bytes().decode("utf-8")
            task = by_id[task_id]
            rows.append(
                {
                    "task_id": task_id,
                    "arm": arm,
                    "question": task["question"],
                    "answer": task["answer"],
                    "prediction": prediction,
                }
            )
    return rows


def verify_judgment(record, request, key, label):
    """Reject stale or cross-wired records without changing official labels."""
    if record.get("cache_key") != key or record.get("request") != request:
        raise ValueError(f"{label} request differs from current gold or prediction")
    if record.get("model") != JUDGE_MODEL or record.get("source_revision") != SOURCE_REVISION:
        raise ValueError(f"{label} request has different official provenance")
    if not {"judgment", "official_correct", "error"} <= record.keys():
        raise ValueError(f"{label} is missing official judgment or error fields")
    judgment, error = record["judgment"], record["error"]
    if not isinstance(judgment, str):
        raise ValueError(f"{label} has an invalid official judgment")
    expected = "true" in judgment.lower() if error is None else False
    if type(record["official_correct"]) is not bool or record["official_correct"] != expected:
        raise ValueError(f"{label} verdict differs from the official judgment rule")
    if error is not None and judgment != "False":
        raise ValueError(f"{label} judgment differs from the official error rule")
    if error is None and record.get("response_model") != JUDGE_MODEL:
        raise ValueError(f"{label} response model differs from the official request")


def verified_records(prepared_root, output_root, by_identity, cache_dir):
    inputs = judge_inputs(prepared_root, output_root)
    current = {(row["arm"], row["task_id"]): row for row in inputs}
    if len(current) != len(inputs) or set(current) != set(by_identity):
        raise ValueError("Final grades differ from the available declared predictions")
    records = {}
    for identity, row in current.items():
        request = official_request(row["question"], row["answer"], row["prediction"])
        key = cache_key(request)
        grade = by_identity[identity]
        verify_judgment(grade, request, key, f"Grade {identity}")
        if key not in records:
            # Read only the completed filename for this request. Pending and
            # unrelated records do not contribute verdicts or duplicate costs.
            path = cache_dir / f"{key}.json"
            if not path.is_file():
                raise ValueError("Final grades refer to missing completed judge records")
            record = json.loads(path.read_text())
            verify_judgment(record, request, key, f"Cache {key}")
            if record.get("original_estimated_cost_usd") is None:
                raise ValueError("Incomplete judge cost: original usage is unknown")
            records[key] = record
        record = records[key]
        if any(grade[field] != record[field] for field in ("judgment", "official_correct", "error")):
            raise ValueError(f"Grade {identity} judgment, verdict or error differs from its cache record")
    return current, list(records.values())


def summarize(prepared_root, output_root, grades, cache_dir):
    prepared_root, output_root, cache_dir = Path(prepared_root), Path(output_root), Path(cache_dir)
    prepared = json.loads((prepared_root / "manifest.json").read_text())
    tasks = [task["task_id"] for task in prepared["tasks"]]
    rows = [json.loads(line) for line in Path(grades).read_text().splitlines() if line.strip()]
    by_identity = {(row["arm"], row["task_id"]): row for row in rows}
    expected = {(arm, task) for arm in ARMS for task in tasks}
    if len(by_identity) != len(rows) or set(by_identity) != expected:
        raise ValueError("Final grades must contain each declared task and arm exactly once")
    current, judged = verified_records(prepared_root, output_root, by_identity, cache_dir)
    summaries, attempts = [], []
    agent_model = None
    for arm in ARMS:
        entries = []
        for task in tasks:
            directory = output_root / "system_scratch" / arm / task
            status = json.loads((directory / "status.json").read_text())
            stats = json.loads((directory / "stats.json").read_text())
            config = json.loads((directory / "config.json").read_text())
            model = config.get("model")
            if not isinstance(model, str) or not model.strip():
                raise ValueError(f"Missing or invalid recorded agent model for {arm}/{task}")
            if stats.get("pricing", {}).get("model") != model:
                raise ValueError(f"Recorded pricing model differs from agent model for {arm}/{task}")
            if agent_model is None:
                agent_model = model
            elif model != agent_model:
                raise ValueError("Final report must contain one homogeneous agent model")
            grade = by_identity[(arm, task)]
            entry = {
                "arm": arm,
                "task_id": task,
                "model": model,
                "completed": status["completed"],
                "official_correct": grade["official_correct"],
                "judge_error": grade["error"],
                "agent_cost_usd": stats["cost_usd"],
                "agent_model_calls": stats["model_calls_succeeded"],
                "input_tokens": stats["input_tokens"],
                "cached_tokens": stats["cached_tokens"],
                "output_tokens": stats["output_tokens"],
                "reasoning_tokens": stats["reasoning_tokens"],
                "elapsed_seconds": stats["elapsed_seconds"],
                "prediction": current[(arm, task)]["prediction"],
                "judge_cache_key": grade["cache_key"],
                "normalized_metrics": (
                    json.loads((directory / "metrics.json").read_text())
                    if (directory / "metrics.json").exists()
                    else None
                ),
            }
            entries.append(entry)
        if any(entry["agent_cost_usd"] is None for entry in entries):
            raise ValueError(f"Incomplete agent usage for {arm}")
        correct = sum(entry["official_correct"] for entry in entries)
        summaries.append(
            {
                "arm": arm,
                "model": agent_model,
                "tasks": len(entries),
                "completed": sum(entry["completed"] for entry in entries),
                "official_correct": correct,
                "task_accuracy": correct / len(entries),
                "agent_cost_usd": sum(entry["agent_cost_usd"] for entry in entries),
                "agent_model_calls": sum(entry["agent_model_calls"] for entry in entries),
                "input_tokens": sum(entry["input_tokens"] for entry in entries),
                "cached_tokens": sum(entry["cached_tokens"] for entry in entries),
                "output_tokens": sum(entry["output_tokens"] for entry in entries),
                "reasoning_tokens": sum(entry["reasoning_tokens"] for entry in entries),
                "sum_elapsed_seconds": sum(entry["elapsed_seconds"] for entry in entries),
                "judge_failures": sum(entry["judge_error"] is not None for entry in entries),
                "normalized_metrics_available": sum(entry["normalized_metrics"] is not None for entry in entries),
                "exact_resource_metrics_complete": sum(
                    bool(
                        entry["normalized_metrics"] and entry["normalized_metrics"]["resource_completeness"]["complete"]
                    )
                    for entry in entries
                ),
            }
        )
        attempts.extend(entries)
    judging = {
        "model": JUDGE_MODEL,
        "predictions_graded": len(rows),
        "unique_requests": len(judged),
        "model_calls": sum(row["incremental_model_calls"] for row in judged),
        "identical_prediction_reuses": len(rows) - len(judged),
        "failures": sum(row["error"] is not None for row in judged),
        "unpriced_calls": 0,
        "cost_usd": sum(row["original_estimated_cost_usd"] for row in judged),
        "input_tokens": sum(row["input_tokens"] or 0 for row in judged),
        "output_tokens": sum(row["output_tokens"] or 0 for row in judged),
        "pricing": judged[0]["pricing"],
    }
    agent_cost = sum(row["agent_cost_usd"] for row in summaries)
    return {
        "benchmark": "DSBench analysis diagnostic pilot",
        "agent_model": agent_model,
        "task_count": len(tasks),
        "attempt_count": len(rows),
        "selection": prepared["selection"],
        "provenance": prepared["provenance"],
        "attempt_policy": "One declared attempt per task and arm; no outcome-selected retries.",
        "grading": "Exact official GPT-4o request and verdict rules; raw predictions, no normalization or rescoring.",
        "cost_scope": "Estimated API token costs; agent costs use frozen gateway pricing and cache discounts. Judge uses exact snapshot $5/M input and $15/M output, with identical-request reuse. Compute excluded.",
        "timing_scope": "sum_elapsed_seconds is legacy adapter task-time sum, not campaign wall time. New normalized_metrics use supervised launch-to-exit with grading excluded and explicit resource scope/completeness.",
        "arms": summaries,
        "judging": judging,
        "agent_cost_usd": agent_cost,
        "total_cost_usd": agent_cost + judging["cost_usd"],
        "attempts": attempts,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepared-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--judge-inputs", type=Path)
    parser.add_argument("--grades", type=Path)
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.judge_inputs:
        rows = judge_inputs(args.prepared_root, args.output_root)
        args.judge_inputs.parent.mkdir(parents=True, exist_ok=True)
        args.judge_inputs.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows))
        args.judge_inputs.chmod(0o600)
        print(json.dumps({"judge_inputs": str(args.judge_inputs), "predictions": len(rows)}))
    if args.report:
        if not args.grades or not args.cache_dir:
            parser.error("--report needs --grades and --cache-dir")
        result = summarize(args.prepared_root, args.output_root, args.grades, args.cache_dir)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
        print(json.dumps({"arms": result["arms"], "judging": result["judging"]}, indent=2))
    if not args.judge_inputs and not args.report:
        parser.error("Choose --judge-inputs or --report")


if __name__ == "__main__":
    main()
