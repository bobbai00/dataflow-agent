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
"""Scan the model-written text of every attempt (dataflow: tool-call arguments and replies in wire/*-response.json;
smolagents: response content in model-request-trace.jsonl) for reaching outside the task data: shell or git, process
spawning, network clients, home/repo/warehouse paths, root-level directory walks, gold or answer files. Also tallies the
serving provider and service tier the responses report. Prints each match with context for review.
Usage: integrity_scan.py <run dir>..."""
import collections, glob, json, os, re, sys
PATTERNS = {
    "process": r"\bsubprocess\b|\bos\.system\(|\bos\.popen\(|\bPopen\(|\bpty\b|\bos\.exec",
    "git": r"\bgit\s+(show|log|grep|diff|ls-files|clone)\b|\.git\b",
    "network": r"\brequests\.(get|post)\(|\burllib\.request\b|\bhttp\.client\b|\bsocket\.socket\(|\bcurl\s",
    "paths": r"/home/|/var/tmp|/root\b|/proc/|/etc/|user-resources|workflow-results|registered-python|worktrees|Kramabench",
    "root walk": r"os\.walk\(\s*['\"]/['\"]|glob\(\s*['\"]/\*\*|rglob\(|Path\(\s*['\"]/['\"]\s*\)|os\.listdir\(\s*['\"]/['\"]|os\.walk\(\s*['\"]\.\.",
    "gold": r"ground_truth|\bgold\b|answers?\.json|evaluation\.json|expected_answer",
}
tiers, providers = collections.Counter(), collections.Counter()
hits = collections.Counter()


def texts_dag(attempt):
    for f in sorted(glob.glob(os.path.join(attempt, "wire", "*-response.json"))):
        try:
            d = json.load(open(f))
        except ValueError:
            continue
        providers[d.get("provider")] += 1
        tiers[d.get("service_tier")] += 1
        for c in d.get("choices") or []:
            m = c.get("message") or {}
            if m.get("content"):
                yield os.path.basename(f), m["content"]
            for t in m.get("tool_calls") or []:
                yield os.path.basename(f), t["function"]["arguments"]


def texts_smol(attempt):
    trace = os.path.join(attempt, "model-request-trace.jsonl")
    if not os.path.exists(trace):
        return
    for line in open(trace):
        e = json.loads(line)
        if e.get("phase") != "response":
            continue
        providers[e.get("provider") or (e.get("response_model"))] += 1
        for c in e.get("choices") or []:
            m = c.get("message") or {}
            if m.get("content"):
                yield f"call {e.get('call')}", m["content"]


for run in sys.argv[1:]:
    attempts = sorted(glob.glob(os.path.join(run, "system_scratch", "*", "*")))
    for attempt in attempts:
        if not os.path.isdir(attempt):
            continue
        source = texts_smol if os.path.exists(os.path.join(attempt, "model-request-trace.jsonl")) else texts_dag
        for where, text in source(attempt):
            for name, pattern in PATTERNS.items():
                for m in re.finditer(pattern, text):
                    hits[name] += 1
                    lo, hi = max(0, m.start() - 90), min(len(text), m.end() + 90)
                    print(f"[{name}] {os.path.basename(run)}/{os.path.basename(attempt)} {where}: ...{text[lo:hi]!r}...")
    print(f"== {run}: {len(attempts)} attempts scanned")
print("hits:", dict(hits) or "none")
print("providers:", dict(providers), "| service tiers:", dict(tiers))
