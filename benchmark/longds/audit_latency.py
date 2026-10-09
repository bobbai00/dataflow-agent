# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.
"""Audit completed campaign latency without model calls or engine execution.

python benchmark/longds/audit_latency.py --control <campaign-directory> --output <json>
Model timings include proxy/network latency. Nonmodel time includes execution,
context assembly and harness work, and must not be labeled purely engine time.
Judging delay includes queueing; concurrent phase durations are not additive.
"""

import argparse
import json
import statistics
from collections import defaultdict
from datetime import datetime
from pathlib import Path


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def json_lines(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def audit(control):
    campaign = json.loads((control / "campaign.json").read_text())
    events = json_lines(control / "events.jsonl")
    lifecycle = defaultdict(dict)
    for event in events:
        if event["event"] in ("start", "complete", "judged"):
            lifecycle[(event["arm"], event["task"])][event["event"]] = timestamp(event["at"])
    rows = []
    for job in campaign["jobs"]:
        run = Path(job["run_dir"])
        summary_path = run / "summary.json"
        if not summary_path.exists():
            continue
        summary = json.loads(summary_path.read_text())
        times = lifecycle[(job["arm"], job["task"])]
        wall = (times["complete"] - times["start"]).total_seconds() if "complete" in times else summary.get("elapsed_seconds")
        wire_path = run / "wire-usage.json"
        gaps = []
        if wire_path.exists():
            wire = json.loads(wire_path.read_text())
            durations = [(timestamp(r["meta"]["finished_at"]) - timestamp(r["meta"]["started_at"])).total_seconds()
                         for r in wire if r.get("meta", {}).get("finished_at")]
            for previous, current in zip(wire, wire[1:]):
                finish = previous.get("meta", {}).get("finished_at")
                if finish:
                    seconds = (timestamp(current["meta"]["started_at"]) - timestamp(finish)).total_seconds()
                    if seconds > 60:
                        gaps.append({"after_call": previous["call"], "seconds": seconds, "finished_at": finish})
            prompt = sum(r.get("prompt_tokens") or 0 for r in wire)
            cached = sum(r.get("cached_tokens") or 0 for r in wire)
            prefix_mutations = sum(bool((r.get("prefix") or {}).get("changed_fields")) or
                                   (r.get("prefix") or {}).get("first_changed_message") is not None for r in wire)
        else:
            wire = json_lines(run / "wire" / "audit.jsonl")
            durations = [r["seconds"] for r in wire]
            prompt = sum(r["usage"].get("prompt_tokens") or 0 for r in wire)
            cached = sum((r["usage"].get("prompt_tokens_details") or {}).get("cached_tokens") or 0 for r in wire)
            prefix_mutations = sum(bool(r.get("prefix_changed")) for r in wire)
        # Read traces only for long gaps; avoid loading giant request transcripts.
        if gaps:
            steps = [s for s in json.loads((run / "react_steps.json").read_text()) if s.get("role") == "agent"]
            for gap in gaps:
                stamp = timestamp(gap.pop("finished_at")).timestamp() * 1000
                step = min(steps, key=lambda s: abs(s["timestamp"] - stamp))
                gap["step_id"] = step["id"]
                gap["actions"] = [{"type": a["action"]["type"], "status": a["status"],
                                   "operator_ids": a["action"].get("operator_ids"),
                                   "execution_timeout": "EXECUTION_TIMEOUT" in json.dumps(a.get("output"))}
                                  for r in step.get("toolResults", []) for a in r.get("output", {}).get("actions", [])
                                  if a["action"]["type"] == "execute"]
        rows.append({"arm": job["arm"], "task": job["task"], "questions": summary["turns_completed"],
                     "wall_seconds": wall, "calls": len(wire), "model_seconds": sum(durations),
                     "nonmodel_seconds": wall - sum(durations) if wall is not None else None,
                     "median_model_seconds": statistics.median(durations) if durations else None,
                     "cached_input_fraction": cached / prompt if prompt else None,
                     "prefix_mutations": prefix_mutations, "long_gaps": gaps,
                     "completion_to_judged_seconds": (times["judged"] - times["complete"]).total_seconds()
                     if "judged" in times and "complete" in times else None})
    complete = [t for t in lifecycle.values() if "complete" in t]
    first = min(t["start"] for t in complete)
    last = max(t["complete"] for t in complete)
    judged = max((t["judged"] for t in complete if "judged" in t), default=last)
    annotations = [json.loads(p.read_text()) for p in control.glob("annotations/runs/*/*/status.json")]
    return {"source": str(control), "solver_revision": campaign.get("sut_code_revision"),
            "solver_wall_seconds": (last - first).total_seconds(),
            "solver_job_sum_seconds": sum(r["wall_seconds"] or 0 for r in rows),
            "correctness_judging_tail_seconds": (judged - last).total_seconds(),
            "minimum_available_memory_gib": min(e["available_memory_bytes"] for e in events if "available_memory_bytes" in e) / 1024**3,
            "annotation_sessions": len(annotations),
            "annotation_job_sum_seconds": sum(a.get("elapsed_seconds", 0) for a in annotations),
            "note": "Nonmodel time includes execution and harness work. Judge delay includes queueing. Concurrent job times must not be added to campaign wall time.",
            "runs": rows}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--control", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = audit(args.control)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"output": str(args.output), "runs": len(report["runs"]),
                      "solver_minutes": report["solver_wall_seconds"] / 60,
                      "judge_tail_minutes": report["correctness_judging_tail_seconds"] / 60}))
