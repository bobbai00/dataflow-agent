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
"""Timed-out smolagents attempts of a run that count as provider failures under the campaign rule: model calls that
took >= 120 s (or never answered before the wall clock) add up to >= 300 s. Prints the task ids, space-separated. Usage: provider_failures.py <run dir>"""
import json, glob, sys, datetime
run = sys.argv[1]
progress = json.load(open(f"{run}/progress.json"))
out = []
for d in progress["completed"]:
    if not d.get("timeout"):
        continue
    f = glob.glob(f"{run}/system_scratch/*/{d['task']}/model-request-trace.jsonl")
    if not f:
        continue
    rows = [json.loads(l) for l in open(f[0])]
    sent, slow, finished = {}, 0.0, set()
    for r in rows:
        if r["phase"] == "transport_request":
            sent[r["call"]] = datetime.datetime.fromisoformat(r["timestamp"])
        if r["phase"] in ("response", "error"):
            finished.add(r["call"])
            s = float(r.get("seconds") or 0)
            slow += s if s >= 120 else 0
    if sent:
        end = max(datetime.datetime.fromisoformat(r["timestamp"]) for r in rows)
        last_call = max(sent)
        if last_call not in finished:
            pending = (d.get("seconds") or 0) - (sent[last_call] - min(sent.values())).total_seconds()
            slow += pending if pending >= 120 else 0
    if slow >= 300:
        out.append(d["task"])
print(" ".join(out))
