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
"""Final tables for the 2026-10-16/17 texera-stable runs (GPT-6.1 Sol, Gemini 4 Argon medium, Haiku 5.5 low thinking) on
KramaBench (104 tasks) and PrepBench (306 cases, PrepBench's evaluator). One rep per cell unless noted; Haiku's
3-rep KramaBench cells report rep 1 (the one-rep number) and the 3-rep mean. Provider-failure timeouts (calls >= 120 s
adding up to >= 300 s) are replaced by their rerun (up to 2), as in earlier campaigns. Dataflow vs smolagents is paired
per task (exact McNemar). Usage: final_tables.py  (expects $PREP_SCORES, default $STACK_DIR/prep/score-final.json, from benchmark/prepbench/score.py)."""
import json, math, os, statistics as st, collections
STACK = os.environ.get("STACK_DIR", "/var/tmp/texera-stable").rstrip("/")
S = f"{STACK}/runs"
SCORES = os.environ.get("PREP_SCORES", f"{STACK}/prep/score-final.json")


def kb(run, arm=None, rep=None, reruns=()):
    """{task: (passed, cost)} for a KramaBench run, rep 1 unless rep='mean' (then fraction of reps passed)."""
    rows = [d for d in json.load(open(f"{S}/{run}/progress.json"))["completed"] if arm is None or d["arm"] == arm]
    for rr in reruns:
        for d in json.load(open(f"{S}/{rr}/progress.json"))["completed"]:
            if not d.get("timeout"):
                rows = [x for x in rows if x["task"] != d["task"]] + [d]
    out = collections.defaultdict(list)
    for d in rows:
        if rep is None or rep == "mean" or d["rep"] == rep:
            out[d["task"]].append(((d.get("score") or 0) >= 1, d.get("cost_usd") or 0))
    return {t: (st.mean(p for p, _ in v), st.mean(c for _, c in v)) for t, v in out.items()}


def prep(model, system, runs, reruns=()):
    rows = [r for r in json.load(open(SCORES))
            if r["model"] == model and r["system"] == system and r["run"] in runs]
    res = {r["task"]: (float(r["passed"]), r["cost_usd"]) for r in rows}
    for rr in reruns:  # reruns in order: a later rerun replaces an earlier timeout
        for r in json.load(open(SCORES)):
            if r["run"] == rr and r["model"] == model and r["system"] == system:
                if not r["timeout"] or r["task"] not in res or res[r["task"]][0] == 0:
                    res[r["task"]] = (float(r["passed"]), r["cost_usd"])
    return res


def cell(res):
    return f"{100 * st.mean(p for p, _ in res.values()):.1f}% ({len(res)})", f"${st.mean(c for _, c in res.values()):.4f}"


def paired(a, b):
    tasks = sorted(set(a) & set(b))
    x = sum(a[t][0] >= 1 and b[t][0] < 1 for t in tasks); y = sum(b[t][0] >= 1 and a[t][0] < 1 for t in tasks); n = x + y
    p = min(1.0, 2 * sum(math.comb(n, k) for k in range(min(x, y) + 1)) / 2 ** n) if n else 1.0
    return f"{100 * (x - y) / len(tasks):+.1f} pts ({x} vs {y}, p={p:.2f})"


rows = []
def add(model, bench, system, res, note=""):
    acc, cost = cell(res); rows.append((model, bench, system, acc, cost, note))

# GPT-6.1 Sol
s61_base, s61_stat = kb("st-sol61-r1", "evidence_full_flow0"), kb("st-sol61-r1", "evidence_data1_flow0")
s61_smol = kb("st-smol-sol61-r1", reruns=("st-smol-sol61-r1-rerun",))
add("GPT-6.1 Sol", "KramaBench", "dataflow, without statistics", s61_base)
add("GPT-6.1 Sol", "KramaBench", "dataflow, with statistics", s61_stat)
add("GPT-6.1 Sol", "KramaBench", "smolagents", s61_smol, "3 hung OpenAI calls rerun")
p61_dag = prep("Sol61", "dataflow baseline", ("sp-sol61-r1",)); p61_smol = prep("Sol61", "smolagents", ("sp-smol-sol61-r1",))
add("GPT-6.1 Sol", "PrepBench", "dataflow, basic", p61_dag); add("GPT-6.1 Sol", "PrepBench", "smolagents", p61_smol)
# Gemini 4 Argon (medium)
ar_base, ar_stat = kb("st-argon-r1", "evidence_full_flow0"), kb("st-argon-r1", "evidence_data1_flow0")
ar_smol = kb("st-smol-argon-r1", reruns=("st-smol-argon-r1-rerun",))
add("Gemini 4 Argon", "KramaBench", "dataflow, without statistics", ar_base)
add("Gemini 4 Argon", "KramaBench", "dataflow, with statistics", ar_stat)
add("Gemini 4 Argon", "KramaBench", "smolagents", ar_smol, "35% empty replies; 1 provider failure rerun")
pa_dag = prep("Gemini4ArgonMedium", "dataflow baseline", ("sp-argon-r1",))
pa_smol = prep("Gemini4ArgonMedium", "smolagents", ("sp-smol-argon-r1", "sp-smol-argon-r1b", "sp-smol-argon-r1c"),
               reruns=("sp-smol-argon-rerun", "sp-smol-argon-rerun2"))
add("Gemini 4 Argon", "PrepBench", "dataflow, basic", pa_dag); add("Gemini 4 Argon", "PrepBench", "smolagents", pa_smol, "3 provider failures rerun")
# Haiku 5.5 low thinking (rep 1 = the one-rep number; 3-rep mean in the note)
hl_base = kb("st-haiku-low-base-r1", "evidence_full_flow0")
hl_stat1, hl_stat3 = kb("st-haiku-low-r3", "evidence_data1_flow0", rep=1), kb("st-haiku-low-r3", "evidence_data1_flow0", rep="mean")
hl_smol1, hl_smol3 = kb("st-smol-haiku-low-r3", rep=1), kb("st-smol-haiku-low-r3", rep="mean")
add("Haiku 5.5 low", "KramaBench", "dataflow, without statistics", hl_base)
add("Haiku 5.5 low", "KramaBench", "dataflow, with statistics", hl_stat1, f"3-rep mean {cell(hl_stat3)[0].split(' ')[0]}")
add("Haiku 5.5 low", "KramaBench", "smolagents", hl_smol1, f"3-rep mean {cell(hl_smol3)[0].split(' ')[0]}")
ph_dag = prep("Haiku55LowThink", "dataflow baseline", ("sp-haiku-low-r1",))
ph_smol = prep("Haiku55LowThink", "smolagents", ("sp-smol-haiku-low-r1",))
add("Haiku 5.5 low", "PrepBench", "dataflow, basic", ph_dag); add("Haiku 5.5 low", "PrepBench", "smolagents", ph_smol)

print("| Model | Benchmark | System | Passed (n) | Cost/attempt | Note |\n|---|---|---|---|---|---|")
for r in rows:
    print("| " + " | ".join(r) + " |")
print("\nDataflow minus smolagents, paired per task:")
for label, a, b in (("GPT-6.1 Sol KramaBench (without statistics)", s61_base, s61_smol), ("GPT-6.1 Sol PrepBench", p61_dag, p61_smol),
                    ("Argon KramaBench (without statistics)", ar_base, ar_smol), ("Argon PrepBench", pa_dag, pa_smol),
                    ("Haiku low KramaBench (without statistics, rep 1)", hl_base, hl_smol1),
                    ("Haiku low KramaBench (with statistics, rep 1)", hl_stat1, hl_smol1),
                    ("Haiku low PrepBench", ph_dag, ph_smol)):
    print(f"  {label:52s} {paired(a, b)}")
