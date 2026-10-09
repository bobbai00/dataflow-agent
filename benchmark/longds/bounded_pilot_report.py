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

"""Supplement frozen LongDS pilots with provider-wire and task diagnostics.

Original judgments and solver statistics remain untouched. Uniform pricing
avoids route-specific cache-write reporting differences; unknown billed usage
remains unknown. Failed/unattempted subset comparisons are descriptive only.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path

from bounded_pilot import score_rubric
from comparison_budget import load_json, estimate_full_input, audit_requests
from comparison_cost import script_turn_metrics
from comparison_report import build_report
from state_comparison import save


def strict_answer(value):
    if not isinstance(value, str):
        return None, False
    try:

        def reject(value):
            raise ValueError(value)

        result = json.loads(value, parse_constant=reject)
        return result, isinstance(result, dict)
    except (ValueError, TypeError):
        return None, False


def both_attempted_pairs(rows):
    """Pair each native arm with the baseline without duplicating its costs."""
    lookup = {(r["task"], r["rep"], r["turn_id"], r["arm"]): r for r in rows}
    result = {}
    for arm in sorted({r["arm"] for r in rows} - {"dsgym"}):
        paired = []
        for row in rows:
            if row["arm"] != arm:
                continue
            baseline = lookup.get((row["task"], row["rep"], row["turn_id"], "dsgym"))
            if baseline and row["code_attempted"] and baseline["code_attempted"]:
                paired.extend([row, baseline])
        result[arm] = {}
        for label in ["dsgym", arm]:
            selected = [r for r in paired if r["arm"] == label]
            unknown = sum(r["cost_usd"] is None for r in selected)
            result[arm][label] = {
                "turns": len(selected), "correct": sum(r["score"] == 1 for r in selected),
                "cost_usd": sum(r["cost_usd"] for r in selected) if not unknown else None,
                "unknown_cost_turns": unknown,
            }
    return result


def job_diagnostics(output, phase, job, protocol):
    path = output / phase / "runs" / f"{job['arm']}-r{job['rep']}" / job["task"].replace("/", "__")
    steps, message_turn, attempted, mechanical = {}, {}, set(), Counter()
    if job["arm"] == "dsgym":
        calls_path = path / "agent/calls.jsonl"
        calls = [json.loads(line) for line in calls_path.read_text().splitlines()] if calls_path.exists() else []
        wire = path / "agent/wire"
        for tid, data in script_turn_metrics(path).items():
            if data["python_blocks"] or data["execution_observations"]:
                attempted.add(tid)
        mechanical["summary_calls"] = sum(c.get("summary", False) for c in calls)
    else:
        resource = load_json(path / "resources.json")
        wire = Path(protocol["wire_root"]) / resource["agent_id"]
        calls = []
        for trace in sorted(path.glob("t*/react_steps.json.gz")):
            tid = int(trace.parent.name[1:])
            steps[tid] = load_json(trace)["steps"]
            for step in steps[tid]:
                if step.get("messageId"):
                    message_turn[step["messageId"]] = tid
                for result in step.get("toolResults", []):
                    payload = result.get("output")
                    if not isinstance(payload, dict):
                        continue
                    for receipt in payload.get("actions", []):
                        action = receipt.get("action", {})
                        kind, status = action.get("type"), receipt.get("status")
                        mechanical[f"action_{kind}_{status}"] += 1
                        if status != "skipped" and kind == "execute":
                            attempted.add(tid)
                        if kind == "inspect":
                            mechanical[f"inspect_{action.get('target')}"] += 1
                        if kind == "retrieve" and status == "ok":
                            mechanical["retrieved_characters"] += len(str(receipt.get("output", {}).get("text", "")))
    request_files = sorted(wire.glob("*-request.json*"))
    sequences = {int(p.name.split("-", 1)[0]) for p in request_files}
    if not request_files or (job["arm"] == "dsgym" and set(range(1, len(calls) + 1)) - sequences):
        raise ValueError(f"Incomplete provider request capture: {wire}")
    per_turn, requests, total = (
        defaultdict(lambda: {"provider_calls": 0, "known_usage_cost_usd": 0.0, "unknown_usage_calls": 0}),
        [],
        Counter(),
    )
    for request_file in request_files:
        request = load_json(request_file)
        response_file = request_file.with_name(request_file.name.replace("-request.", "-response."))
        usage = load_json(response_file).get("usage", {}) if response_file.exists() else {}
        seq = int(request_file.name.split("-", 1)[0])
        if job["arm"] == "dsgym":
            tid = calls[seq - 1]["turn_index"] + 1 if seq <= len(calls) else None
        else:
            meta_file = request_file.with_name(request_file.name.replace("-request.", "-meta."))
            tid = message_turn.get(load_json(meta_file).get("messageId")) if meta_file.exists() else None
        if tid is None:
            raise ValueError(f"Provider request has no turn identity: {request_file}")
        actual = usage.get("prompt_tokens")
        requests.append(
            {"estimate": estimate_full_input(request, protocol["full_input_policy"]["scale"]), "actual": actual}
        )
        total["provider_requests"] += 1
        per_turn[tid]["provider_calls"] += 1
        completion = usage.get("completion_tokens")
        cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0) or 0
        if actual is None or completion is None:
            total["unknown_usage_calls"] += 1
            per_turn[tid]["unknown_usage_calls"] += 1
            continue
        if not 0 <= cached <= actual:
            raise ValueError("Invalid wire cache usage")
        rates = protocol["rates_usd_per_million"]
        cost = ((actual - cached) * rates["input"] + cached * rates["cached"] + completion * rates["output"]) / 1e6
        total["known_usage_cost_usd"] += cost
        total["input_tokens"] += actual
        total["cached_tokens"] += cached
        total["output_tokens"] += completion
        per_turn[tid]["known_usage_cost_usd"] += cost
    return {
        "task": job["task"],
        "arm": job["arm"],
        "rep": job["rep"],
        "attempted_turns": sorted(attempted),
        "mechanical": dict(mechanical),
        "wire": dict(total),
        "per_turn_wire": dict(per_turn),
        "input_audit": audit_requests(requests, protocol["context_budget"]),
    }


def phase_report(output, phase):
    protocol = load_json(output / phase / "manifest.json")
    original = build_report(output / phase)
    jobs = [job_diagnostics(output, phase, j, protocol) for j in protocol["jobs"]]
    diagnostics = {(j["task"], j["arm"], j["rep"]): j for j in jobs}
    rows = []
    for source in original["turns"]:
        row = {k: source[k] for k in ["task", "arm", "rep", "turn_id", "score"]}
        value, valid = strict_answer(source.get("solution"))
        diag = diagnostics[(row["task"], row["arm"], row["rep"])]
        wire = diag["per_turn_wire"].get(
            row["turn_id"], {"provider_calls": 0, "known_usage_cost_usd": 0.0, "unknown_usage_calls": 0}
        )
        row.update(
            valid_json_object=valid,
            code_attempted=row["turn_id"] in diag["attempted_turns"],
            explicit_nonanswer=isinstance(value, dict) and "error" in value,
            input_budget_error="Full model input estimates" in str(source.get("solution")),
            cost_usd=wire["known_usage_cost_usd"] if not wire["unknown_usage_calls"] else None,
            provider_calls=wire["provider_calls"],
            elapsed_seconds=(source.get("stats") or {}).get("elapsed_seconds"),
        )
        rubric = protocol["cases"][row["task"]]["rubric"]
        if row["turn_id"] == rubric["turn_id"]:
            expected = source["ground_truth"]
            if isinstance(expected, str):
                expected = json.loads(expected)
            row["target_components"] = score_rubric(expected, value, rubric)
            row["solution"] = source.get("solution")
        rows.append(row)
    by_arm = {}
    for arm in sorted({r["arm"] for r in rows}):
        chosen = [r for r in rows if r["arm"] == arm]
        wire_jobs = [j for j in jobs if j["arm"] == arm]
        unknown = sum(j["wire"].get("unknown_usage_calls", 0) for j in wire_jobs)
        by_arm[arm] = {
            "correct": sum(r["score"] == 1 for r in chosen),
            "turns": len(chosen),
            "unjudged": sum(r["score"] is None for r in chosen),
            "valid_json": sum(r["valid_json_object"] for r in chosen),
            "unattempted_nonanswers": sum(not r["code_attempted"] and r["explicit_nonanswer"] for r in chosen),
            "input_budget_errors": sum(r["input_budget_error"] for r in chosen),
            "provider_calls": sum(j["wire"].get("provider_requests", 0) for j in wire_jobs),
            "summary_calls": sum(j["mechanical"].get("summary_calls", 0) for j in wire_jobs),
            "cost_usd": sum(j["wire"].get("known_usage_cost_usd", 0) for j in wire_jobs) if not unknown else None,
            "unknown_usage_calls": unknown,
            "elapsed_seconds": sum(r["elapsed_seconds"] or 0 for r in chosen),
        }
    matched_pairs = both_attempted_pairs(rows)
    return {
        "source_revision": protocol["source_revision"],
        "protocol_sha256": hashlib.sha256((output / phase / "manifest.json").read_bytes()).hexdigest(),
        "summary": by_arm,
        "both_attempted_subset": matched_pairs.get("history", {}),
        "both_attempted_subsets": matched_pairs,
        "jobs": jobs,
        "turns": rows,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--phases", nargs="+", default=["bounded", "repaired"])
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    result = {
        "analysis_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "cost_policy": "All captured provider requests including summaries; same fresh/cache rates across routes, no write surcharge. Estimates, not invoices. Unknown usage is never assigned zero.",
        "subset_policy": "Both-attempted subset is aligned by task/turn and descriptive; conditioning on outcomes is not a causal adjustment.",
        "phases": {p: phase_report(args.output, p) for p in args.phases},
    }
    save(args.destination, result)
    print(json.dumps({p: v["summary"] for p, v in result["phases"].items()}, indent=2))
