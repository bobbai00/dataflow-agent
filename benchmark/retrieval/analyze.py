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
"""Summarize official scores, cache-aware costs and actual retrieval behavior."""
import argparse
from collections import Counter, defaultdict
import csv
import json
from pathlib import Path
import random
import statistics
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "benchmark/Kramabench"))
import kb


def read(path, fallback=None):
    return json.loads(path.read_text()) if path.exists() else fallback


def interval(values):
    """Bootstrap task means, keeping repetitions of the same task together."""
    if not values:
        return None
    rng = random.Random(101)
    samples = sorted(statistics.mean(rng.choices(values, k=len(values))) for _ in range(4000))
    return [samples[100], samples[3899]]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    directory = args.directory.resolve()
    manifest = read(directory / "manifest.json")
    progress = read(directory / "progress.json", {"completed": []})
    done = {(j["sut"], j["task"]): j for j in progress["completed"]}
    rows, retrievals, errors = [], [], []
    for job in manifest["jobs"]:
        if (job["sut"], job["task"]) not in done:
            continue
        path = directory / "system_scratch" / job["sut"] / job["task"]
        stats = read(path / "stats.json", {})
        evaluation = read(path / "evaluation.json", {})
        scores = [float(evaluation[k]) for k in kb.SCORE_METRICS if evaluation.get(k) is not None]
        score = max(scores) if scores else None
        raw = read(path / "react_steps.json", [])
        steps = raw if isinstance(raw, list) else raw.get("steps", [])
        views, types, statuses, edits, created = (Counter() for _ in range(5))
        response = (path / "response.txt").read_text() if (path / "response.txt").exists() else ""
        row = {**job, "score": score, "pass": score is not None and score >= manifest["pass_threshold"],
               "cost_usd": stats.get("cost_usd"), "input_tokens": stats.get("input_tokens", 0),
               "output_tokens": stats.get("output_tokens", 0), "cached_tokens": stats.get("cached_tokens", 0),
               "reasoning_tokens": stats.get("reasoning_tokens", 0),
               "cache_creation_tokens": stats.get("cache_creation_tokens", 0),
               "no_answer": "turn ended without an answer action" in response,
               "model_calls": 0, "prefix_checks": 0, "prefix_failures": 0}
        previous = None
        for step in steps:
            messages = step.get("inputMessages")
            if step.get("role") == "agent" and messages:
                row["model_calls"] += 1
                if previous is not None:
                    row["prefix_checks"] += 1
                    row["prefix_failures"] += messages[:len(previous)] != previous
                previous = messages
            for result in step.get("toolResults", []):
                output = result.get("output")
                if result.get("isError") and (not isinstance(output, dict) or not output.get("actions")):
                    errors.append({**job, "step": step.get("stepId"), "action": {"type": "tool_envelope"},
                                   "error": str(output)[:1600]})
                if not isinstance(output, dict):
                    continue
                for item in output.get("actions", []):
                    action, observation = item.get("action", {}), item.get("output")
                    types[action.get("type")] += 1
                    statuses[item.get("status")] += 1
                    if item.get("status") == "error":
                        errors.append({**job, "step": step.get("stepId"), "action": action,
                                       "error": str(observation)[:1600]})
                    if action.get("type") == "edit" and item.get("status") == "ok" and isinstance(observation, dict):
                        edits.update(c["operation"] for c in observation.get("changes", []))
                        created.update(o["op"] for o in observation.get("operators", []) if o.get("status") == "added")
                    if action.get("type") != "retrieve":
                        continue
                    view = action.get("view", "missing")
                    views[view] += 1
                    observation = observation if isinstance(observation, dict) else {}
                    evidence = observation.get("evidence", [])
                    retrievals.append({**job, "step": step.get("stepId"), "operator_id": action.get("operator_id"),
                        "view": view, "status": item.get("status"), "result_version": observation.get("result_version"),
                        **observation.get("table", {}), "chars": len(observation.get("text", "")),
                        "data_facts": sum(e.startswith("data.") for e in evidence),
                        "flow_facts": sum(e.startswith("flow.") for e in evidence),
                        "upstream_facts": sum(e.startswith("flow.upstream.") for e in evidence)})
        script_trace = path / "model-request-trace.jsonl"
        if script_trace.exists():
            events = [json.loads(line) for line in script_trace.read_text().splitlines()]
            row["model_calls"] = sum(event["phase"] == "response" for event in events)
            requests = [event["request"]["messages"] for event in events if event["phase"] == "request"]
            for previous_request, current_request in zip(requests, requests[1:]):
                row["prefix_checks"] += 1
                row["prefix_failures"] += current_request[:len(previous_request)] != previous_request
        row.update(views=dict(views), actions=dict(types), statuses=dict(statuses),
                   edit_operations=dict(edits), operators_created=dict(created))
        rows.append(row)
    groups = defaultdict(list)
    for row in rows:
        groups[(row["model"], row["arm"])].append(row)
    summary = []
    lines = ["KramaBench campaign: official scores and model costs", "",
             f"Agent revision: {manifest['agent_revision']}",
             f"Completed: {len(rows)}/{len(manifest['jobs'])}; {manifest['repetitions']} independent repetitions",
             "Pass threshold: official score >= 1.0. Mean score below includes only scored attempts.",
             "Costs: stats.json cost_usd, including cached-input discounts; evaluator and engine costs excluded.",
             manifest["selection"], "", "Model | Arm | Passes/attempts | Scored | Mean score | Total USD | Calls | Retrieve views"]
    for (model, arm), items in sorted(groups.items()):
        scores = [r["score"] for r in items if r["score"] is not None]
        costs = [r["cost_usd"] for r in items if r["cost_usd"] is not None]
        views = Counter()
        for row in items:
            views.update(row["views"])
        successful_reads = [r for r in retrievals if r["model"] == model and r["arm"] == arm and r["status"] == "ok"]
        s = {"model": model, "arm": arm, "attempts": len(items), "passes": sum(r["pass"] for r in items),
             "scored": len(scores), "mean_score": statistics.mean(scores) if scores else None,
             "cost_usd": sum(costs), "costs_known": len(costs), "model_calls": sum(r["model_calls"] for r in items),
             "retrieval_views": dict(views), "retrieval_chars": sum(r["chars"] for r in successful_reads),
             "reads_with_data": sum(r["data_facts"] > 0 for r in successful_reads),
             "reads_with_flow": sum(r["flow_facts"] > 0 for r in successful_reads),
             "reads_with_upstream": sum(r["upstream_facts"] > 0 for r in successful_reads),
             "partial_full_reads": sum(r["view"] == "full" and not r.get("complete", False) for r in successful_reads),
             "successful_reads": len(successful_reads), "no_answer": sum(r["no_answer"] for r in items),
             "prefix_checks": sum(r["prefix_checks"] for r in items), "prefix_failures": sum(r["prefix_failures"] for r in items)}
        for key in ["input_tokens", "output_tokens", "cached_tokens", "reasoning_tokens", "cache_creation_tokens"]:
            s[key] = sum(r[key] for r in items)
        s["cache_fraction"] = s["cached_tokens"] / s["input_tokens"] if s["input_tokens"] else None
        for key in ["actions", "statuses", "edit_operations", "operators_created"]:
            counts = Counter()
            for row in items:
                counts.update(row[key])
            s[key] = dict(counts)
        summary.append(s)
        mean = f"{s['mean_score']:.1%}" if s["mean_score"] is not None else "unknown"
        lines.append(f"{model} | {arm} | {s['passes']}/{len(items)} | {len(scores)} | {mean} | ${sum(costs):.6f} ({len(costs)} known) | {s['model_calls']} | {dict(views)}")
    contrasts = []
    pairs = [("sample_stats_flow0", "full_flow0"), ("sample_stats_flow0", "sample_flow0")]
    pairs += [(f"{view}_flow1", f"{view}_flow0") for view in ["full", "sample", "sample_stats", "adaptive"]]
    pairs += [("adaptive_flow0", "sample_stats_flow0"), ("adaptive_flow1", "sample_stats_flow1")]
    if manifest.get("script_settings"):
        pairs.append(("adaptive_flow1", "guided_script"))
    for model in manifest["models"]:
        lookup = {(r["arm"], r["task"], r["rep"]): r for r in rows if r["model"] == model}
        for treatment, control in pairs:
            differences = defaultdict(list)
            for task in manifest["task_ids"]:
                for rep in range(1, manifest["repetitions"] + 1):
                    a, b = lookup.get((treatment, task, rep)), lookup.get((control, task, rep))
                    if a and b and a["score"] is not None and b["score"] is not None and a["cost_usd"] is not None and b["cost_usd"] is not None:
                        differences[task].append((a["score"] - b["score"], a["cost_usd"] - b["cost_usd"]))
            if differences:
                means = [(statistics.mean(v[0] for v in values), statistics.mean(v[1] for v in values)) for values in differences.values()]
                contrasts.append({"model": model, "treatment": treatment, "control": control, "tasks": len(means),
                    "score_delta": statistics.mean(v[0] for v in means), "score_delta_ci95": interval([v[0] for v in means]),
                    "cost_delta_usd": statistics.mean(v[1] for v in means), "cost_delta_ci95": interval([v[1] for v in means])})
    report = {"summary": summary, "contrasts": contrasts, "rows": rows, "retrievals": retrievals, "errors": errors}
    (directory / "analysis.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    (directory / "REPORT.txt").write_text("\n".join(lines) + "\n")
    if rows:
        with (directory / "per-task.csv").open("w") as stream:
            writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
    print("\n".join(lines))


if __name__ == "__main__":
    main()
