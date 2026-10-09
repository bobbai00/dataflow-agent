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
"""Audit retrieval exposure and stored profile invariants; never judge answers."""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path


def audit(directory):
    analysis = json.loads((directory / "analysis.json").read_text())
    profiles, violations, reads = Counter(), [], []
    for row in analysis["rows"]:
        path = directory / "system_scratch" / row["sut"] / row["task"]
        snapshot = json.loads((path / "snapshot.json").read_text()) if (path / "snapshot.json").exists() else {}
        for operator, info in snapshot.get("results", {}).items():
            profile, version = info.get("tableProfile"), info.get("resultVersion")
            if not profile:
                continue
            profiles["profiles"] += 1
            profiles[profile["status"]] += 1
            identity = {"sut": row["sut"], "task": row["task"], "operator": operator}
            if version and profile.get("resultVersion") != version["id"]:
                violations.append({**identity, "violation": "profile_version_mismatch"})
            for column, data in profile.get("columns", {}).items():
                profiles["columns"] += 1
                if data["nullCount"] + data["nonnullCount"] != data["rowsProcessed"]:
                    violations.append({**identity, "column": column, "violation": "count_equation"})
                if data["distinctCount"] is not None and data["distinctCount"] > data["nonnullCount"]:
                    violations.append({**identity, "column": column, "violation": "distinct_exceeds_nonnull"})
                freq = data.get("frequencies")
                if freq and sum(v["count"] for v in freq["values"]) + freq["otherCount"] != data["nonnullCount"]:
                    violations.append({**identity, "column": column, "violation": "frequency_equation"})
        raw = json.loads((path / "react_steps.json").read_text()) if (path / "react_steps.json").exists() else []
        steps = raw if isinstance(raw, list) else raw.get("steps", [])
        for step in steps:
            calls = {c.get("toolCallId"): c.get("input", {}) for c in step.get("toolCalls", [])}
            for result in step.get("toolResults", []):
                output = result.get("output")
                if not isinstance(output, dict):
                    continue
                rationale = calls.get(result.get("toolCallId"), {}).get("reasoning", "")
                for item in output.get("actions", []):
                    action, observation = item.get("action", {}), item.get("output", {})
                    if action.get("type") != "retrieve" or item.get("status") != "ok":
                        continue
                    text, facts = observation.get("text", ""), observation.get("evidence", [])
                    reads.append({"model": row["model"], "arm": row["arm"], "task": row["task"],
                        "rep": row["rep"], "sut": row["sut"], "step": step.get("stepId"),
                        "operator": action["operator_id"], "view": action["view"], "rationale": rationale,
                        "chars": len(text), "table": observation.get("table"),
                        "data_facts": sum(f.startswith("data.") for f in facts),
                        "full_scope_data": "column counts (full=" in text,
                        "partial_scope_data": "column counts (partial prefix=" in text,
                        "coverage_notice": "Data statistics:" in text,
                        "source_preview_label": "source preview only" in text})
    groups = defaultdict(list)
    for read in reads:
        if read["arm"].startswith("adaptive"):
            groups[read["model"]].append(read)
    choices = {}
    for model, items in groups.items():
        full = [r for r in items if r["view"] == "full"]
        stats = [r for r in items if r["view"] == "sample_stats"]
        choices[model] = {"reads": len(items), "views": dict(Counter(r["view"] for r in items)),
            "full_at_most_2000_chars": sum(r["chars"] <= 2000 for r in full),
            "full_over_10000_chars": sum(r["chars"] > 10000 for r in full),
            "full_incomplete": sum(not (r["table"] or {}).get("complete") for r in full),
            "stats_reads": len(stats), "stats_with_data": sum(r["data_facts"] > 0 for r in stats),
            "stats_with_partial_coverage": sum(r["partial_scope_data"] for r in stats)}
    return {"profile_checks": dict(profiles), "violations": violations, "adaptive_choices": choices,
            "large_adaptive_full_reads": sorted([r for r in reads if r["arm"].startswith("adaptive")
                and r["view"] == "full" and r["chars"] > 2000], key=lambda r: -r["chars"]), "reads": reads,
            "interpretation": "Size thresholds identify cases for manual review, not improper choices. Snapshot checks cover retained final results, not every historical result."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    result = audit(args.directory)
    (args.directory / "retrieval-audit.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({k: result[k] for k in ["profile_checks", "violations", "adaptive_choices"]}, indent=2))


if __name__ == "__main__":
    main()
