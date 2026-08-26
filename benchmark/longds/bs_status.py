#!/usr/bin/env python3
"""Business + sports campaign ledger: per rep, which of the 14 tasks are run,
judged, contaminated, or missing — and the per-arm 3-rep means once complete.

The equivalent of coverage_matrix.py for the second campaign. Same purpose:
every launch decision comes from here, so nothing finished is re-run and
nothing missing is forgotten."""
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


def short(t):
    return t.split("__", 1)[1].replace("_task", "t")[:14]


rows = []
for rep, sut in REPS:
    cells = {}
    for t in TASKS:
        d = SCRATCH / sut / t
        sm, ev = d / "summary.json", d / "results_eval.json"
        if not sm.exists():
            cells[t] = ("—", None)
            continue
        s = json.loads(sm.read_text())
        if s["turns_completed"] != s["turns_total"]:
            cells[t] = ("~", None)
            continue
        res = d / "results_with_ground_truth.json"
        bad = False
        if res.exists():
            try:
                bad = any(ERR.search(str(x.get("solution") or "")) for x in json.loads(res.read_text()))
            except Exception:
                pass
        if not ev.exists():
            cells[t] = ("!" if bad else "·", None)
            continue
        sc = [x["judge"]["score"] for x in json.loads(ev.read_text())
              if (x.get("judge") or {}).get("score") is not None]
        acc = 100 * sum(sc) / len(sc) if sc else None
        cells[t] = (("X" if bad else f"{acc:.0f}") if acc is not None else "?", None if bad else acc)
    rows.append((rep, cells))

print("legend: number=judged  X=judged but CONTAMINATED (re-run)  ·=run,unjudged  ~=partial  —=not run\n")
print(f"{'rep':<8}" + "".join(f"{short(t):>16}" for t in TASKS[:7]))
for rep, cells in rows:
    print(f"{rep:<8}" + "".join(f"{cells[t][0]:>16}" for t in TASKS[:7]))
print()
print(f"{'rep':<8}" + "".join(f"{short(t):>16}" for t in TASKS[7:]))
for rep, cells in rows:
    print(f"{rep:<8}" + "".join(f"{cells[t][0]:>16}" for t in TASKS[7:]))

print("\nper-rep completeness (clean, judged / 14):")
for rep, cells in rows:
    ok = sum(1 for t in TASKS if cells[t][1] is not None)
    print(f"  {rep}: {ok}/14")

done = {rep: cells for rep, cells in rows}
for arm, reps in (("session", ["ses-r1", "ses-r2", "ses-r3"]), ("v37", ["v37-r1", "v37-r2", "v37-r3"])):
    per = []
    for t in TASKS:
        vals = [done[r][t][1] for r in reps if done[r][t][1] is not None]
        if len(vals) == len(reps):
            per.append(sum(vals) / len(vals))
    if per:
        print(f"{arm:8} mean over {len(per)}/14 fully-covered tasks: {sum(per)/len(per):.1f}")
