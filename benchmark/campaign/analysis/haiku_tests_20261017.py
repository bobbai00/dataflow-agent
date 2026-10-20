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
"""Haiku 5.5 3-rep tests on KramaBench (texera-stable, 2026-10-17): default (adaptive) vs low thinking for dataflow (with
statistics) and smolagents, and 1,000- vs 2,000-character samples for dataflow (default thinking). Per cell: accuracy over
3 reps, cost per attempt, calls, output tokens per call, share of calls with thinking. Differences are paired over tasks
(each task's mean over its 3 reps) with a 4,000-draw bootstrap over tasks (seed 7). This is the code that produced the
numbers reported on 2026-10-17, saved as a file. Usage: (KramaBench venv) python haiku_tests.py"""
import json, glob, os, random, statistics as st, collections, sys
sys.path.insert(0, ".")
S = os.environ.get("STACK_DIR", "/var/tmp/texera-stable").rstrip("/") + "/runs"
cells = {"dataflow, default thinking": ("st-haiku-r3", "dag"), "dataflow, low thinking": ("st-haiku-low-r3", "dag"),
         "dataflow, 1,000-char samples": ("st-haiku-s1000-r3", "dag"), "smolagents, default thinking": ("st-smol-haiku-r3", "smol"),
         "smolagents, low thinking": ("st-smol-haiku-low-r3", "smol")}
per = {}
for name, (run, kind) in cells.items():
    done = json.load(open(f"{S}/{run}/progress.json"))["completed"]
    by = collections.defaultdict(list)
    for d in done: by[d["task"]].append((d.get("score") or 0) >= 1)
    reps = collections.defaultdict(list)
    for d in done: reps[d["rep"]].append((d.get("score") or 0) >= 1)
    cost = [d.get("cost_usd") or 0 for d in done]
    calls = out = think = n = 0
    if kind == "dag":
        for f in glob.glob(f"{S}/{run}/system_scratch/*/*/wire/*-response.json"):
            try: r = json.load(open(f))
            except ValueError: continue
            u = r.get("usage") or {}; m = ((r.get("choices") or [{}])[0].get("message") or {})
            calls += 1; out += u.get("completion_tokens") or 0; think += bool(m.get("thinking_blocks") or m.get("reasoning_content"))
    else:
        for f in glob.glob(f"{S}/{run}/system_scratch/*/*/model-request-trace.jsonl"):
            for line in open(f):
                r = json.loads(line)
                if r["phase"] == "response" and r.get("usage"):
                    m = (r.get("choices") or [{}])[0].get("message") or {}; psf = m.get("provider_specific_fields") or {}
                    calls += 1; out += r["usage"].get("completion_tokens") or 0
                    think += bool(m.get("thinking_blocks") or m.get("reasoning_content") or psf.get("thinking_blocks") or psf.get("reasoning_content"))
    per[name] = {t: st.mean(v) for t, v in by.items()}
    print(f"{name:30s} {100*st.mean(per[name].values()):5.1f}%  reps {[round(100*st.mean(v),1) for k, v in sorted(reps.items())]}  "
          f"${st.mean(cost):.4f}/attempt  {calls/len(done):.1f} calls/attempt  {out/max(calls,1):.0f} output tok/call  thinking on {100*think/max(calls,1):.0f}% of calls")
def diff(a, b, label):
    tasks = sorted(set(per[a]) & set(per[b])); rng = random.Random(7)
    d = [per[a][t] - per[b][t] for t in tasks]; m = st.mean(d)
    boots = sorted(st.mean(rng.choice(d) for _ in d) for _ in range(4000))
    print(f"  {label:58s} {100*m:+5.1f} pts  95% CI [{100*boots[100]:+.1f}, {100*boots[3899]:+.1f}]")
print("paired over tasks (mean of 3 reps):")
diff("dataflow, low thinking", "dataflow, default thinking", "dataflow: low − default thinking")
diff("dataflow, 1,000-char samples", "dataflow, default thinking", "dataflow: 1,000 − 2,000-char samples")
diff("smolagents, low thinking", "smolagents, default thinking", "smolagents: low − default thinking")
diff("dataflow, default thinking", "smolagents, default thinking", "default thinking: dataflow − smolagents")
diff("dataflow, low thinking", "smolagents, low thinking", "low thinking: dataflow − smolagents")
diff("dataflow, low thinking", "smolagents, default thinking", "dataflow low − smolagents default")
