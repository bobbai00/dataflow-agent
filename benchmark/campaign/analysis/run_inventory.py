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
"""One row per run of the package: benchmark, model, setting(s), study, attempts, pass rate, timeouts, provider failures,
billed cost, start and finish (UTC), from scores/index.csv and runs/<run>/progress.json.
Usage: python3 run_inventory.py <package dir>   (writes scores/runs.csv and prints it as a Markdown table)"""
import collections
import csv
import json
import os
import sys

P = sys.argv[1]
rows = list(csv.DictReader(open(f"{P}/scores/index.csv")))
by = collections.defaultdict(list)
for r in rows:
    by[r["run"]].append(r)
out = []
for run, rs in by.items():
    prog = json.load(open(f"{P}/runs/{run}/progress.json"))
    scored = [r for r in rs if r["pass"] != ""]
    out.append({"run": run, "benchmark": rs[0]["benchmark"], "model": rs[0]["model"],
                "settings": " + ".join(sorted({r["setting"] for r in rs})), "study": rs[0]["study"],
                "reps": max(int(r["rep"]) for r in rs), "attempts": len(rs),
                "pass_pct": round(100 * sum(int(r["pass"]) for r in scored) / len(scored), 1) if scored else "",
                "timeouts": sum(int(r["timeout"]) for r in rs), "provider_failures": sum(int(r["provider_failure"]) for r in rs),
                "billed_usd": round(sum(float(r["cost_usd"] or 0) for r in rs), 2),
                "started_utc": (prog.get("started_at") or "")[:16].replace("T", " "),
                "finished_utc": (prog.get("finished_at") or "")[:16].replace("T", " ")})
out.sort(key=lambda r: r["started_utc"])
with open(f"{P}/scores/runs.csv", "w", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=list(out[0]))
    w.writeheader()
    w.writerows(out)
print("| " + " | ".join(out[0]) + " |\n|" + "---|" * len(out[0]))
for r in out:
    print("| " + " | ".join(str(v) for v in r.values()) + " |")
