#!/usr/bin/env python3
"""Full audit of the business+sports campaign: classify every expected run.

For each of 14 tasks x 6 reps (84 runs), decide exactly one state:
  MISSING     — never run (or wiped for re-run and not yet re-run)
  RUNNING     — turns_completed < turns_total
  CONTAMINATED— complete but holds infrastructure-error answers -> RE-RUN
  UNJUDGED    — complete + clean, no eval yet -> judge
  JUDGE-GAP   — judged but >1 turn unscored -> RE-JUDGE
  OK          — complete, clean, judged with at most 1 flaky turn

Then print the counts and the exact lists, so "how many to re-run / re-judge"
has one authoritative answer.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _paths import SCRATCH  # noqa: E402

ERR = re.compile(
    r"execution service unavailable|Cannot connect|Failed after \d+ attempts|ConnectionRefused",
    re.I,
)
REPS = [
    ("ses-r1", "LongDS_LongDSLunaBSSession"),
    ("ses-r2", "LongDS_LongDSLunaBSSessionR2"),
    ("ses-r3", "LongDS_LongDSLunaBSSessionR3"),
    ("v37-r1", "LongDS_LongDSLunaBSV37"),
    ("v37-r2", "LongDS_LongDSLunaBSV37R2"),
    ("v37-r3", "LongDS_LongDSLunaBSV37R3"),
]
TASKS = (Path(__file__).resolve().parents[2] / "logs" / "bs-tasks.txt").read_text().split()

buckets = {k: [] for k in ("MISSING", "RUNNING", "CONTAMINATED", "UNJUDGED", "JUDGE-GAP", "OK")}
for rep, sut in REPS:
    for t in TASKS:
        d = SCRATCH / sut / t
        label = f"{rep}/{t.split('__', 1)[1][:40]}"
        sm = d / "summary.json"
        if not sm.exists():
            buckets["MISSING"].append(label)
            continue
        s = json.loads(sm.read_text())
        if s["turns_completed"] != s["turns_total"]:
            buckets["RUNNING"].append(label)
            continue
        res = d / "results_with_ground_truth.json"
        bad = 0
        if res.exists():
            try:
                # An empty solution is as diagnostic as an error string: the
                # runner records '' when the turn died on infrastructure (e.g.
                # agent-service down -> ConnectionRefused printed to the lane
                # log only). No real turn legitimately answers nothing.
                bad = sum(
                    1
                    for x in json.loads(res.read_text())
                    if ERR.search(str(x.get("solution") or "")) or not str(x.get("solution") or "").strip()
                )
            except Exception:
                pass
        if bad:
            buckets["CONTAMINATED"].append(f"{label} ({bad} err turns)")
            continue
        ev = d / "results_eval.json"
        if not ev.exists():
            buckets["UNJUDGED"].append(label)
            continue
        e = json.loads(ev.read_text())
        unscored = sum(1 for x in e if (x.get("judge") or {}).get("score") is None)
        if unscored > 1:
            buckets["JUDGE-GAP"].append(f"{label} ({unscored} unscored)")
        else:
            buckets["OK"].append(label)

total = sum(len(v) for v in buckets.values())
print(f"expected runs: {len(REPS) * len(TASKS)} | accounted: {total}\n")
for k in ("OK", "RUNNING", "MISSING", "CONTAMINATED", "UNJUDGED", "JUDGE-GAP"):
    print(f"{k:13} {len(buckets[k])}")
print()
for k in ("MISSING", "CONTAMINATED", "UNJUDGED", "JUDGE-GAP", "RUNNING"):
    if buckets[k]:
        print(f"-- {k}:")
        for x in buckets[k]:
            print(f"   {x}")
