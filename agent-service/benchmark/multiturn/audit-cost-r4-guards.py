#!/usr/bin/env python3
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
"""Check whether final compatibility guards affect recorded R4 contexts.

Reads saved settings and profiles only; never runs an agent or changes scores.
The profile scan is conservative: it includes unobserved small tables, not just
the complete displayed tables whose redundant profile facts can be omitted.
"""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
report = json.loads((ROOT / "docs/cost-r4-results.json").read_text())
hits = []
settings = []
hashes = {}
files = 0


def read(path):
    data = path.read_bytes()
    hashes[str(path.relative_to(ROOT))] = hashlib.sha256(data).hexdigest()
    return json.loads(data)


for row in report["rows"]:
    if not row["complete"]:
        continue
    directory = ROOT / "benchmark/longds/system_scratch" / row["sut"] / row["task"]
    config = read(directory / "turns/config.json")["settings"]
    settings.append({
        "sut": row["sut"], "task": row["task"],
        "manual_compaction": config.get("enableCompactTool"),
        "result_budget": config.get("maxOperatorResultCharLimit"),
    })
    paths = list((directory / "turns").glob("t[0-9][0-9]/operator_results.json"))
    if (directory / "interrupted-operator-results.json").exists():
        paths.append(directory / "interrupted-operator-results.json")
    for path in paths:
        data = read(path)
        files += 1
        if "results" in data:
            data = data["results"]
        for operator, info in data.items():
            total = info.get("totalRowCount")
            if total is not None and total > 20:
                continue
            for record in info.get("sampleRecords") or info.get("result") or []:
                for name, value in record.items():
                    if isinstance(value, str) and value in ("NULL", "NaN"):
                        hits.append({"file": str(path.relative_to(ROOT)), "operator": operator,
                                     "column": name, "value": value, "source": "displayed_rows"})
            for name, column in (info.get("tableProfile") or {}).get("columns", {}).items():
                for frequency in (column.get("frequencies") or {}).get("values", []):
                    value = frequency.get("value")
                    if isinstance(value, dict):
                        value = value.get("value")
                    if value in ("NULL", "NaN"):
                        hits.append({"file": str(path.relative_to(ROOT)), "operator": operator,
                                     "column": name, "value": value, "source": "profile"})

unaffected = (not hits and bool(settings)
              and all(s["manual_compaction"] is False and isinstance(s["result_budget"], (int, float))
                      and s["result_budget"] <= 5000 for s in settings))
output = {
    "files_checked": files, "sessions_checked": len(settings),
    "scope": "All saved small-output profiles and held rows in completed R4 sessions, a superset of observed entry tables.",
    "ambiguous_literal_candidates": hits, "settings": settings,
    "final_guard_conditions_absent": unaffected, "source_sha256": hashes,
    "limit": "Checks guards for manual compaction, larger result budgets and ambiguous categorical literals. "
             "The budget-supervisor race fix affects external bookkeeping, not solver context. "
             "This audit does not relabel the evaluated source hash as the final source hash.",
}
(ROOT / "docs/cost-r4-guard-impact.json").write_text(json.dumps(output, indent=2) + "\n")
print(json.dumps({"files_checked": files, "sessions_checked": len(settings),
                  "final_guard_conditions_absent": unaffected, "candidates": len(hits)}))
