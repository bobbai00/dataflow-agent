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
"""Read-only paired analysis of a frozen state comparison."""
import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import json
from pathlib import Path
import random
import re
import statistics

from state_comparison import RATES, cost_of, save, summarize
from comparison_cost import analyze_cost
from comparison_adjudicate import resolved_rows


def native_metrics(folder):
    counts = Counter()
    last = None
    for path in sorted(folder.glob("t*/react_steps.json.gz")):
        steps = json.loads(gzip.decompress(path.read_bytes()))["steps"]
        previous = None
        for step in steps:
            messages = step.get("inputMessages")
            if step.get("role") == "agent" and messages:
                if previous is not None:
                    counts["prefix_checks"] += 1
                    counts["prefix_changes"] += messages[:len(previous)] != previous
                elif last is not None:
                    counts["cross_task_prefix_checks"] += 1
                    counts["cross_task_prefix_changes"] += messages[:len(last)] != last
                previous = messages
                last = messages
            for call in step.get("toolCalls", []):
                for action in call.get("input", {}).get("actions", []):
                    if action.get("type") == "edit":
                        counts["edit_characters"] += len(action.get("changes", ""))
            for result in step.get("toolResults", []):
                output = result.get("output")
                if not isinstance(output, dict):
                    continue
                for receipt in output.get("actions", []):
                    action = receipt.get("action", {})
                    # An unsuccessful execution can still do useful cached or
                    # completed work before its root failure blocks descendants.
                    # Count operator visits, not distinct operators or CPU time.
                    if action.get("type") == "execute" and receipt.get("status") != "skipped":
                        counts["execute_receipts"] += 1
                        execution = receipt.get("output")
                        operators = execution.get("operators") if isinstance(execution, dict) else None
                        if isinstance(operators, list):
                            counts["execute_operator_outcomes"] += len(operators)
                            for operator in operators:
                                state = str(operator.get("state", "unknown")).replace(" ", "_")
                                counts["execute_state_"+state] += 1
                        else:
                            counts["execute_receipts_missing_outcomes"] += 1
                    if receipt.get("status") != "ok":
                        counts["action_"+str(receipt.get("status"))] += 1
                        continue
                    counts["action_"+action.get("type", "unknown")] += 1
                    if action.get("type") == "edit":
                        for line in action.get("changes", "").splitlines():
                            # Graph commands (traces before 2026-10-06).
                            for command in ["fork", "restore", "update", "create", "delete"]:
                                if re.match(rf"\s*{command} operator\b", line):
                                    counts[command+"_operator"] += 1
                            if re.match(r"\s*update operator\s+\S+\s+from task\b", line):
                                counts["restore_operator"] += 1
                            # Assignments: `x = at(x, task=N)` restores, `y = at(x, task=N)` forks.
                            version = re.match(r"(\w+)\s*=\s*at\(\s*(\w+)\s*,\s*task\s*=", line)
                            if version:
                                counts["restore_operator" if version[1] == version[2] else "fork_operator"] += 1
                            elif re.match(r"\w+\s*=\s*\w+\(", line):
                                counts["assign_operator"] += 1
                            elif re.match(r"del\s+\w", line):
                                counts["delete_operator"] += 1
                    if action.get("type") == "inspect" and action.get("target") == "state":
                        if action.get("task_id") is not None:
                            counts["historical_inspect"] += 1
                        else:
                            counts["version_listing"] += 1
                    if action.get("type") == "retrieve":
                        obs = receipt.get("output", {})
                        if isinstance(obs, dict):
                            counts["view_"+str(action.get("view"))] += 1
                            counts["retrieved_characters"] += len(obs.get("text", ""))
                            counts["statistics_displayed"] += any(str(f).startswith("data.column.") for f in obs.get("evidence", []))
    return dict(counts)


def bootstrap_delta(rows, a, b, draws=4000):
    """Resample whole sessions, then repetitions within each session."""
    groups = defaultdict(dict)
    for row in rows:
        groups[(row["task"], row["rep"], row["turn_id"])][row["arm"]] = row.get("score")
    sessions = defaultdict(lambda: defaultdict(list))
    for (task, rep, _), arms in groups.items():
        if arms.get(a) is not None and arms.get(b) is not None:
            sessions[task][rep].append(arms[a]-arms[b])
    if len(sessions) < 2:
        return {"estimate": None, "interval": None, "reason": "Fewer than two independent sessions"}
    keys = sorted(sessions)
    estimate = statistics.mean(statistics.mean(statistics.mean(v) for v in sessions[k].values()) for k in keys)
    rng = random.Random(103)
    samples = []
    for _ in range(draws):
        sampled = []
        for k in rng.choices(keys, k=len(keys)):
            reps = list(sessions[k].values())
            sampled.append(statistics.mean(statistics.mean(v) for v in rng.choices(reps, k=len(reps))))
        samples.append(statistics.mean(sampled))
    samples.sort()
    return {"estimate": estimate, "interval": [samples[int(.025*draws)], samples[int(.975*draws)]],
            "unit": "accuracy difference, macro over sessions and repetitions", "sessions": len(keys)}


def build_report(folder):
    protocol = json.loads((folder / "manifest.json").read_text())
    rates = protocol.get("rates_usd_per_million", RATES)
    rows, metrics = [], []
    for job in protocol["jobs"]:
        path = folder / "runs" / f"{job['arm']}-r{job['rep']}" / job["task"].replace("/", "__")
        file = path / "results_eval.json"
        if not file.exists():
            file = path / "results_with_ground_truth.json"
        if not file.exists():
            continue
        for row in resolved_rows(path):
            stats = dict(row.get("stats") or {})
            if "cost_usd" not in stats:
                stats["cost_usd"] = cost_of(stats, rates)
            # Native gateway wire responses omit cache-write counters that the
            # script route reports. Retain recorded rates and also
            # show one shared fresh-input pricing rule as a sensitivity check.
            uniform = None if any(stats.get(k) is None for k in ["input_tokens", "cached_tokens", "output_tokens"]) else (
                (stats["input_tokens"]-stats["cached_tokens"])*rates["input"] + stats["cached_tokens"]*rates["cached"] + stats["output_tokens"]*rates["output"])/1e6
            rows.append({**row, "stats": stats, "task": job["task"], "arm": job["arm"], "rep": job["rep"],
                         "score": row.get("judge", {}).get("score"), "uniform_cost_usd": uniform,
                         "reused_control": bool(job.get("reuse_from"))})
        if job["arm"] != "dsgym":
            metrics.append({"task": job["task"], "arm": job["arm"], "rep": job["rep"], **native_metrics(path)})
    summary = summarize(protocol["jobs"], rows)
    lookup = {(r["task"], r["arm"], r["rep"], r["turn_id"]): r for r in rows}
    for row in rows:
        deps = [lookup.get((row["task"], row["arm"], row["rep"], n)) for n in row.get("depends_tasks", [])]
        row["dependency_answers"] = ("none" if not deps else "unknown" if any(r is None or r.get("score") is None for r in deps)
                                     else "all_correct" if all(r["score"] == 1 for r in deps) else "some_wrong")
    breakdowns = {}
    for name, selector in [
        ("state_type", lambda r: r.get("state_type") or ["none"]),
        ("dependency_answers", lambda r: [r["dependency_answers"]]),
        ("dependency_distance", lambda r: ["none" if not r.get("depends_tasks") else
            "1" if r["turn_id"]-min(r["depends_tasks"]) == 1 else
            "2-5" if r["turn_id"]-min(r["depends_tasks"]) <= 5 else "6+"]),
    ]:
        groups = defaultdict(lambda: defaultdict(list))
        for row in rows:
            for label in selector(row):
                groups[label][row["arm"]].append(row)
        breakdowns[name] = {label: {arm: {"n": len(rs), "judged": sum(r["score"] is not None for r in rs),
                "correct": sum(r["score"] == 1 for r in rs)} for arm, rs in arms.items()}
                for label, arms in groups.items()}
    paired = defaultdict(dict)
    for row in rows:
        paired[(row["task"], row["rep"], row["turn_id"])][row["arm"]] = row
    pairs = {}
    arms = sorted(summary)
    for i, a in enumerate(arms):
        for b in arms[i+1:]:
            common = [p for p in paired.values() if a in p and b in p and p[a]["score"] is not None and p[b]["score"] is not None]
            both = [p for p in common if p[a]["score"] == p[b]["score"] == 1]
            pairs[a+"__"+b] = {"paired_judged_turns": len(common), "a_only": sum(p[a]["score"] == 1 and p[b]["score"] == 0 for p in common),
                "b_only": sum(p[b]["score"] == 1 and p[a]["score"] == 0 for p in common), "both_correct": len(both),
                "both_correct_cost_usd": {arm: sum(p[arm]["stats"].get("cost_usd") or 0 for p in both) for arm in [a, b]},
                "both_correct_uniform_cost_usd": {arm: sum(p[arm]["uniform_cost_usd"] or 0 for p in both) for arm in [a, b]},
                "both_correct_unknown_cost_turns": {arm: sum(p[arm]["stats"].get("cost_usd") is None for p in both) for arm in [a, b]},
                "macro_accuracy_delta": bootstrap_delta(rows, a, b) if all(s["complete"] for s in summary.values()) else None}
    for arm, stats in summary.items():
        selected = [r for r in rows if r["arm"] == arm]
        fresh = [r for r in selected if not r['reused_control']]
        stats['judge_recovered_turns'] = sum(r.get('judge_recovered', False) for r in selected)
        stats['reused_control_turns'] = len(selected) - len(fresh)
        stats['new_solver_cost_usd'] = sum(r['stats'].get('cost_usd') or 0 for r in fresh)
        stats['new_solver_unknown_cost_turns'] = sum(r['stats'].get('cost_usd') is None for r in fresh)
        stats["uniform_cost_usd"] = sum(r["uniform_cost_usd"] or 0 for r in selected)
        stats["unknown_uniform_cost_turns"] = sum(r["uniform_cost_usd"] is None for r in selected)
        stats["llm_calls"] = sum(r["stats"].get("llm_calls", 0) for r in selected)
        for name in ["input_tokens", "cached_tokens", "output_tokens", "cache_write_tokens", "elapsed_seconds"]:
            values = [r["stats"].get(name) for r in selected]
            stats[name] = sum(values) if all(v is not None for v in values) else None
        stats["cache_hit_rate"] = (stats["cached_tokens"]/stats["input_tokens"]
                                    if stats["input_tokens"] and stats["cached_tokens"] is not None else None)
        stats["macro_accuracy"] = statistics.mean(statistics.mean(r["score"] for r in selected if r["task"] == t and r["rep"] == rep)
            for t, rep in sorted({(r["task"], r["rep"]) for r in selected})) if stats["complete"] else None
    result = {"analysis_source_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "summary": summary, "breakdowns": breakdowns, "pairs": pairs, "metrics": metrics, "turns": rows}
    result["cost_analysis"] = analyze_cost(folder, result)
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("folder", type=Path)
    args = ap.parse_args()
    result = build_report(args.folder)
    save(args.folder / "report.json", result)
    print(json.dumps(result["summary"], indent=2))


if __name__ == "__main__":
    main()
