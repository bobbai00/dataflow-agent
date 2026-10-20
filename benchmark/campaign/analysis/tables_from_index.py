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
"""Rebuild the result tables from scores/index.csv alone, without the traces: the final table (attempts tagged `final`,
and `final-3rep-mean` for Haiku's 3-rep means), dataflow minus smolagents paired per task with an exact McNemar test (as
final_tables.py), and the Haiku 3-rep tests (attempts tagged `haiku-tests`) with haiku_tests.py's bootstrap over tasks
(4,000 draws, seed 7). Usage: python3 tables_from_index.py [index.csv]   (default: ../scores/index.csv)"""
import collections
import csv
import math
import os
import random
import statistics as st
import sys

path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scores", "index.csv")
rows = list(csv.DictReader(open(path)))


def pick(bench, model, sett, tag="final"):
    """{task: (pass rate, mean cost)} over the attempts of one cell that carry the tag."""
    out = collections.defaultdict(list)
    for r in rows:
        if r["benchmark"] == bench and r["model"] == model and r["setting"] == sett and tag in r["used_in"].split(";"):
            out[r["task"]].append((int(r["pass"]), float(r["cost_usd"] or 0)))
    return {t: (st.mean(p for p, _ in v), st.mean(c for _, c in v)) for t, v in out.items()}


def cell(res):
    return f"{100 * st.mean(p for p, _ in res.values()):.1f}% ({len(res)})", f"${st.mean(c for _, c in res.values()):.4f}"


def paired(a, b):
    tasks = sorted(set(a) & set(b))
    x = sum(a[t][0] >= 1 and b[t][0] < 1 for t in tasks)
    y = sum(b[t][0] >= 1 and a[t][0] < 1 for t in tasks)
    n = x + y
    p = min(1.0, 2 * sum(math.comb(n, k) for k in range(min(x, y) + 1)) / 2 ** n) if n else 1.0
    return f"{100 * (x - y) / len(tasks):+.1f} pts ({x} vs {y}, p={p:.2f})"


NAMES = {"gpt-6.1-sol": "GPT-6.1 Sol", "gemini-4-argon-medium": "Gemini 4 Argon", "claude-haiku-5.5-lowthink": "Haiku 5.5 low"}
SYSTEMS = {"dataflow-baseline": "dataflow, without statistics", "dataflow-statistics": "dataflow, with statistics", "smolagents": "smolagents"}
print("| Model | Benchmark | System | Passed (n) | Cost/attempt | 3-rep mean |\n|---|---|---|---|---|---|")
cells = {}
for model, name in NAMES.items():
    for bench in ("kramabench", "prepbench"):
        for sett, label in SYSTEMS.items():
            res = pick(bench, model, sett)
            if not res:
                continue
            cells[(model, bench, sett)] = res
            if bench == "prepbench" and sett == "dataflow-baseline":
                label = "dataflow, basic"
            mean3 = pick(bench, model, sett, "final-3rep-mean")
            print(f"| {name} | {'KramaBench' if bench == 'kramabench' else 'PrepBench'} | {label} | {cell(res)[0]} | {cell(res)[1]} | "
                  f"{cell(mean3)[0].split(' ')[0] if mean3 else ''} |")
print("\nDataflow minus smolagents, paired per task:")
for label, a, b in (("GPT-6.1 Sol KramaBench (without statistics)", ("gpt-6.1-sol", "kramabench", "dataflow-baseline"), ("gpt-6.1-sol", "kramabench", "smolagents")),
                    ("GPT-6.1 Sol PrepBench", ("gpt-6.1-sol", "prepbench", "dataflow-baseline"), ("gpt-6.1-sol", "prepbench", "smolagents")),
                    ("Argon KramaBench (without statistics)", ("gemini-4-argon-medium", "kramabench", "dataflow-baseline"), ("gemini-4-argon-medium", "kramabench", "smolagents")),
                    ("Argon PrepBench", ("gemini-4-argon-medium", "prepbench", "dataflow-baseline"), ("gemini-4-argon-medium", "prepbench", "smolagents")),
                    ("Haiku low KramaBench (without statistics, rep 1)", ("claude-haiku-5.5-lowthink", "kramabench", "dataflow-baseline"), ("claude-haiku-5.5-lowthink", "kramabench", "smolagents")),
                    ("Haiku low KramaBench (with statistics, rep 1)", ("claude-haiku-5.5-lowthink", "kramabench", "dataflow-statistics"), ("claude-haiku-5.5-lowthink", "kramabench", "smolagents")),
                    ("Haiku low PrepBench", ("claude-haiku-5.5-lowthink", "prepbench", "dataflow-baseline"), ("claude-haiku-5.5-lowthink", "prepbench", "smolagents"))):
    print(f"  {label:52s} {paired(cells[a], cells[b])}")

print("\nHaiku 5.5 3-rep tests on KramaBench (mean of 3 reps per task):")
tests = {"dataflow, default thinking": "st-haiku-r3", "dataflow, low thinking": "st-haiku-low-r3",
         "dataflow, 1,000-char samples": "st-haiku-s1000-r3", "smolagents, default thinking": "st-smol-haiku-r3",
         "smolagents, low thinking": "st-smol-haiku-low-r3"}
per = {}
for name, run in tests.items():
    sel = [r for r in rows if r["run"] == run and "haiku-tests" in r["used_in"].split(";")]
    by = collections.defaultdict(list)
    for r in sel:
        by[r["task"]].append(int(r["pass"]))
    per[name] = {t: st.mean(v) for t, v in by.items()}
    reps = collections.defaultdict(list)
    for r in sel:
        reps[r["rep"]].append(int(r["pass"]))
    print(f"  {name:30s} {100 * st.mean(per[name].values()):5.1f}%  reps {[round(100 * st.mean(v), 1) for k, v in sorted(reps.items())]}  "
          f"${st.mean(float(r['cost_usd'] or 0) for r in sel):.4f}/attempt  ({len(sel)} attempts)")


def diff(a, b, label):
    tasks = sorted(set(per[a]) & set(per[b]))
    rng = random.Random(7)
    d = [per[a][t] - per[b][t] for t in tasks]
    boots = sorted(st.mean(rng.choice(d) for _ in d) for _ in range(4000))
    print(f"  {label:58s} {100 * st.mean(d):+5.1f} pts  95% CI [{100 * boots[100]:+.1f}, {100 * boots[3899]:+.1f}]")


diff("dataflow, low thinking", "dataflow, default thinking", "dataflow: low − default thinking")
diff("dataflow, 1,000-char samples", "dataflow, default thinking", "dataflow: 1,000 − 2,000-char samples")
diff("smolagents, low thinking", "smolagents, default thinking", "smolagents: low − default thinking")
diff("dataflow, default thinking", "smolagents, default thinking", "default thinking: dataflow − smolagents")
diff("dataflow, low thinking", "smolagents, low thinking", "low thinking: dataflow − smolagents")
