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
from metrics import retrieval_results, tool_error_counts, edit_operations
from comparison import evidence_matrix_contrasts, layout_contrasts
from matrix_audit import audit_attempt as audit_wire_attempt

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
               "official_scores": {k: evaluation[k] for k in sorted(kb.SCORE_METRICS) if evaluation.get(k) is not None},
               "cost_usd": stats.get("cost_usd"), "input_tokens": stats.get("input_tokens", 0),
               "provider_reported_cost_usd": stats.get("provider_reported_cost_usd"),
               "provider_cost_complete": stats.get("provider_cost_complete"),
               "response_providers": stats.get("response_providers", []),
               "output_tokens": stats.get("output_tokens", 0), "cached_tokens": stats.get("cached_tokens", 0),
               "reasoning_tokens": stats.get("reasoning_tokens", 0),
               "cache_creation_tokens": stats.get("cache_creation_tokens", 0),
               "cache_read_usage_complete": stats.get("cache_usage_reporting", {}).get("cached_tokens", {}).get("complete", False),
               "cache_write_usage_complete": stats.get("cache_usage_reporting", {}).get("cache_creation_tokens", {}).get("complete", False),
               "cost_estimate_assumptions": stats.get("cost_estimate_assumptions", []),
               "elapsed_seconds": stats.get("elapsed_seconds"),
               "model_latency_seconds": stats.get("model_latency_seconds"),
               "attempt_seconds": done[(job["sut"], job["task"])].get("seconds"),
               "usage_complete": stats.get("usage_complete"),
               "model_requests": stats.get("model_requests"),
               "no_answer": "turn ended without an answer action" in response,
               "answer_recorded": False, "native_actions_observed": False,
               "tool_errors": 0, "envelope_errors": 0, "action_errors": 0,
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
                counts = tool_error_counts(result)
                for key, value in counts.items():
                    row[key] += value
                output = result.get("output")
                if counts["envelope_errors"]:
                    errors.append({**job, "step": step.get("stepId"), "action": {"type": "tool_envelope"},
                                   "error": str(output)[:1600]})
                if not isinstance(output, dict):
                    continue
                row["native_actions_observed"] |= isinstance(output.get("actions"), list)
                for item in output.get("actions", []):
                    action, observation = item.get("action", {}), item.get("output")
                    types[action.get("type")] += 1
                    statuses[item.get("status")] += 1
                    row["answer_recorded"] |= action.get("type") == "answer" and item.get("status") == "ok"
                    if item.get("status") == "error":
                        errors.append({**job, "step": step.get("stepId"), "action": action,
                                       "error": str(observation)[:1600]})
                    if action.get("type") == "edit" and item.get("status") == "ok" and isinstance(observation, dict):
                        edits.update(edit_operations(observation))
                        created.update(o["op"] for o in observation.get("operators", []) if o.get("status") == "added")
                    if action.get("type") != "retrieve":
                        continue
                    view = action.get("view", "missing")
                    views[view] += 1
                    for target in retrieval_results(item):
                        evidence = target.get("evidence", [])
                        retrievals.append({**job, "step": step.get("stepId"), "operator_id": target.get("operator_id"),
                            "view": view, "status": target.get("status"), "result_version": target.get("result_version"),
                            **target.get("table", {}), "chars": len(target.get("text", "")),
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
        elif row["native_actions_observed"] or manifest.get("settings", {}).get("agentMode") == "native":
            row["no_answer"] = not row["answer_recorded"]
        wire = audit_wire_attempt(path, {**manifest.get("settings", {}), **manifest.get("arms", {}).get(job["arm"], {})})
        row["answer_diagnostics"] = wire["answer_diagnostics"]
        row["format_compliant"] = wire["answer_diagnostics"]["format_compliant"]
        row["numeric_support"] = wire["answer_diagnostics"]["numeric_support"]["status"]
        row["wire_requests"] = wire["wire_requests"]
        row["wire_prefix_checks"] = wire["wire_prefix_checks"]
        row["wire_prefix_failures"] = sum(not pair["full_previous_prefix"] for pair in wire["wire_context"]["prefix_pairs"])
        row["wire_context_bytes"] = wire["wire_context"]["total_context_bytes"] if wire["wire_requests"] else None
        row["wire_roles"] = wire["wire_context"]["roles"]
        row["wire_violations"] = wire["violations"]
        row["wire_warnings"] = wire["warnings"]
        row["wire_http_errors"] = sum(request["http_status"] is not None and request["http_status"] != 200
                                     for request in wire["wire_context"]["requests"])
        row["wire_http_status_unknown"] = sum(request["http_status"] is None for request in wire["wire_context"]["requests"])
        row["answered_after_action_errors"] = row["answer_recorded"] and statuses["error"] > 0
        row["answered_after_tool_errors"] = row["answer_recorded"] and row["tool_errors"] > 0
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
             "Costs: token estimates with separate cache reads/writes; reasoning is already included in output. Missing costs stay unknown. Evaluator and engine costs excluded.",
             "Provider-reported USD is shown separately when every response includes usage.cost; it can differ from public-rate estimates. Exact billed prompt/tool token splits are not provided by these APIs.",
             "Agent seconds include model and tool execution, excluding scoring. Model seconds sum gateway requests. Attempt seconds also include setup, artifact collection and scoring.",
             manifest["selection"], "", "Model | Arm | Passes/attempts | Scored | Mean score | Total USD | Mean agent seconds | Calls | Retrieve views"]
    for (model, arm), items in sorted(groups.items()):
        scores = [r["score"] for r in items if r["score"] is not None]
        costs = [r["cost_usd"] for r in items if r["cost_usd"] is not None]
        views = Counter()
        for row in items:
            views.update(row["views"])
        successful_reads = [r for r in retrievals if r["model"] == model and r["arm"] == arm and r["status"] == "ok"]
        s = {"model": model, "arm": arm, "attempts": len(items), "passes": sum(r["pass"] for r in items),
             "scored": len(scores), "mean_score": statistics.mean(scores) if scores else None,
             "cost_usd": sum(costs) if costs else None, "costs_known": len(costs), "model_calls": sum(r["model_calls"] for r in items),
             "retrieval_views": dict(views), "retrieval_chars": sum(r["chars"] for r in successful_reads),
             "reads_with_data": sum(r["data_facts"] > 0 for r in successful_reads),
             "reads_with_flow": sum(r["flow_facts"] > 0 for r in successful_reads),
             "reads_with_upstream": sum(r["upstream_facts"] > 0 for r in successful_reads),
             "partial_full_reads": sum(r["view"] == "full" and not r.get("complete", False) for r in successful_reads),
             "successful_reads": len(successful_reads), "no_answer": sum(r["no_answer"] for r in items),
             "prefix_checks": sum(r["prefix_checks"] for r in items), "prefix_failures": sum(r["prefix_failures"] for r in items)}
        s["usage_complete_attempts"] = sum(r["usage_complete"] is True for r in items)
        s["model_requests"] = sum(r["model_requests"] for r in items if r["model_requests"] is not None)
        provider_costs = [r["provider_reported_cost_usd"] for r in items if r["provider_reported_cost_usd"] is not None]
        s["provider_reported_cost_usd"] = sum(provider_costs) if len(provider_costs) == len(items) else None
        s["provider_costs_known"] = len(provider_costs)
        s["response_providers"] = sorted({p for r in items for p in r["response_providers"]})
        for key in ["tool_errors", "envelope_errors", "action_errors", "answered_after_tool_errors"]:
            s[key] = sum(r[key] for r in items)
        for key in ["input_tokens", "output_tokens", "cached_tokens", "reasoning_tokens", "cache_creation_tokens"]:
            s[key] = sum(r[key] for r in items)
        for key in ["elapsed_seconds", "model_latency_seconds", "attempt_seconds"]:
            values = [r[key] for r in items if r[key] is not None]
            s["mean_" + key] = statistics.mean(values) if values else None
            s[key + "_known"] = len(values)
        s["cache_fraction"] = (s["cached_tokens"] / s["input_tokens"] if s["input_tokens"] and
            all(r["usage_complete"] is True and r["cache_read_usage_complete"] for r in items) else None)
        s["cost_estimate_assumptions"] = sorted({note for r in items for note in r["cost_estimate_assumptions"]})
        for key in ["wire_requests", "wire_prefix_checks", "wire_prefix_failures", "wire_http_errors"]:
            s[key] = sum(r[key] for r in items)
        s["wire_context_bytes"] = sum(r["wire_context_bytes"] for r in items if r["wire_context_bytes"] is not None)
        s["wire_context_known"] = sum(r["wire_context_bytes"] is not None for r in items)
        s["format_compliant"] = sum(r["format_compliant"] is True for r in items)
        s["format_required"] = sum(r["format_compliant"] is not None for r in items)
        s["numeric_support"] = dict(Counter(r["numeric_support"] for r in items))
        s["wire_violations"] = dict(Counter(value for r in items for value in r["wire_violations"]))
        s["wire_roles"] = dict(sum((Counter(r["wire_roles"]) for r in items), Counter()))
        for key in ["actions", "statuses", "edit_operations", "operators_created"]:
            counts = Counter()
            for row in items:
                counts.update(row[key])
            s[key] = dict(counts)
        summary.append(s)
        mean = f"{s['mean_score']:.1%}" if s["mean_score"] is not None else "unknown"
        cost = f"${sum(costs):.6f}" if costs else "unknown"
        elapsed = f"{s['mean_elapsed_seconds']:.1f}" if s["mean_elapsed_seconds"] is not None else "unknown"
        lines.append(f"{model} | {arm} | {s['passes']}/{len(items)} | {len(scores)} | {mean} | {cost} ({len(costs)} known) | {elapsed} | {s['model_calls']} | {dict(views)}")
    lines += ["", "Token totals (cache reads/writes are subsets of input; reasoning is a subset of output)",
              "Model | Arm | Input | Cached input | Cache writes | Output | Reasoning | Complete usage attempts"]
    for item in summary:
        lines.append(f"{item['model']} | {item['arm']} | {item['input_tokens']} | {item['cached_tokens']} | {item['cache_creation_tokens']} | {item['output_tokens']} | {item['reasoning_tokens']} | {item['usage_complete_attempts']}/{item['attempts']}")
    lines += ["", "Failures and provider-reported cost", "Model | Failed calls | Before-action rejections | Failed actions | Provider USD | Providers"]
    for item in summary:
        cost = f"${item['provider_reported_cost_usd']:.6f}" if item["provider_reported_cost_usd"] is not None else "unknown"
        lines.append(f"{item['model']} | {item['tool_errors']} | {item['envelope_errors']} | {item['action_errors']} | {cost} | {', '.join(item['response_providers']) or 'not reported'}")
    lines += ["", "Captured wire context and answer contract",
              "Wire requests include retries; agent calls count recorded model decisions. Context bytes are canonical compact UTF-8 JSON messages/tools, not provider token counts.",
              "Numeric cell matches establish visible support, not correctness; missing bounded cells are inconclusive. Official scores do not enforce final-line formatting.",
              "Model | Arm | Wire requests | Wire HTTP errors | Stable prefix pairs | Context bytes | Final-line format | Numeric support"]
    for item in summary:
        lines.append(f"{item['model']} | {item['arm']} | {item['wire_requests']} | {item['wire_http_errors']} | "
                     f"{item['wire_prefix_checks'] - item['wire_prefix_failures']}/{item['wire_prefix_checks']} | "
                     f"{item['wire_context_bytes']} ({item['wire_context_known']} known) | "
                     f"{item['format_compliant']}/{item['format_required']} | {item['numeric_support']}")
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
    matrix_contrasts = evidence_matrix_contrasts(rows, manifest["models"])
    contrasts.extend(matrix_contrasts)
    if matrix_contrasts:
        lines += ["", "Evidence matrix: descriptive matched differences (treatment minus control)",
                  "These diagnostic task means have no significance test or confidence interval. Missing metrics are excluded independently; analysis.json records their pair counts.",
                  "Model | Treatment | Control | Matched tasks | Score delta | Mean cost delta USD | Calls delta"]
        for contrast in matrix_contrasts:
            values = [f"{contrast[key]:+.6f}" if contrast[key] is not None else "unknown"
                      for key in ["score_delta", "cost_delta_usd", "model_calls_delta"]]
            lines.append(f"{contrast['model']} | {contrast['treatment']} | {contrast['control']} | {contrast['tasks']} | " + " | ".join(values))
    layout_pairs = layout_contrasts(rows, manifest["models"])
    contrasts.extend(layout_pairs)
    if layout_pairs:
        lines += ["", "Message layout: descriptive matched differences (markdown minus native)",
                  "Same tasks/repetition/model with both evidence channels and full profiling fixed. One repetition on two tasks does not estimate general accuracy or significance.",
                  "Task means receive equal weight; missing metrics are excluded independently with pair counts in analysis.json. Live token/call differences also reflect model behavior, not only serialization.",
                  "Cache reads depend on provider routing, warm prefixes and run order; shuffled jobs do not control initial provider cache state. Frozen-rate estimates are not invoices.",
                  "Model | Matched tasks | Score delta | Mean USD delta | API requests delta | Input tokens delta | Output tokens delta | Cache reads delta | Format delta"]
        for contrast in layout_pairs:
            values = [f"{contrast[key]:+.6f}" if contrast[key] is not None else "unknown" for key in
                      ["score_delta", "cost_delta_usd", "model_requests_delta", "input_tokens_delta",
                       "output_tokens_delta", "cached_tokens_delta", "format_compliant_delta"]]
            lines.append(f"{contrast['model']} | {contrast['tasks']} | " + " | ".join(values))
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
