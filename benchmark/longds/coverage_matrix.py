#!/usr/bin/env python3
"""What is actually run, per (arm-rep, task) — the ledger that decides what to
launch next. Prints a matrix over the 10 longest LongDS tasks, marking each
cell run+judged (score), run-but-unjudged (·), or missing (—)."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _paths import SCRATCH  # noqa: E402

TOP10 = [
    ("kaggle", "community__kaggle-survey-2022__task3"),
    ("nfl", "sports__nfl_big_data_bowl_2023__task1"),
    ("acea2", "geoscience__acea_water_prediction__task2"),
    ("acea3", "geoscience__acea_water_prediction__task3"),
    ("wids1", "geoscience__phase-ii-widsdatathon2022__task1"),
    ("wids2", "geoscience__phase-ii-widsdatathon2022__task2"),
    ("cdp", "geoscience__cdp-unlocking-climate-solutions__task1"),
    ("cpe1", "social_good__center_for_policing_equity__task1"),
    ("cpe2", "social_good__center_for_policing_equity__task2"),
    ("la", "social_good__data_science_for_good_city_of_los_angeles__task1"),
]
REPS = [
    ("ses-r1", "LongDS_LongDSLunaTop10Session"),
    ("ses-r2", "LongDS_LongDSLunaTop10SessionR2"),
    ("ses-r3", "LongDS_LongDSLunaTop10SessionR3"),
    ("v36-r1", "LongDS_LongDSLunaSub5V36"),
    ("v36-r2", "LongDS_LongDSLunaSub5V36R2"),
    ("v36-r3", "LongDS_LongDSLunaSub5V36R3"),
    ("v37-r1", "LongDS_LongDSLunaSub5V37"),
    ("v37-r2", "LongDS_LongDSLunaSub5V37R2"),
    ("v37-r3", "LongDS_LongDSLunaSub5V37R3"),
]


def cell(sut, task):
    d = SCRATCH / sut / task
    sm, ev = d / "summary.json", d / "results_eval.json"
    if not sm.exists():
        return "—", None
    s = json.loads(sm.read_text())
    complete = s["turns_completed"] == s["turns_total"]
    if not ev.exists():
        return ("·" if complete else "~"), None
    e = json.loads(ev.read_text())
    sc = [t["judge"]["score"] for t in e if (t.get("judge") or {}).get("score") is not None]
    return (f"{100*sum(sc)/len(sc):.0f}" if sc else "?"), (100 * sum(sc) / len(sc) if sc else None)


print(f"{'':8}" + "".join(f"{n:>7}" for n, _ in TOP10))
missing = []
for rep, sut in REPS:
    row = f"{rep:8}"
    for name, task in TOP10:
        mark, _ = cell(sut, task)
        row += f"{mark:>7}"
        if mark == "—":
            missing.append((rep, sut, name, task))
    print(row)
print("\nlegend: number = judged accuracy | · = run, unjudged | ~ = partial run | — = not run")
print(f"missing cells: {len(missing)}")
by_rep = {}
for rep, sut, name, task in missing:
    by_rep.setdefault((rep, sut), []).append((name, task))
for (rep, sut), items in by_rep.items():
    print(f"  {rep}: {' '.join(n for n, _ in items)}")
