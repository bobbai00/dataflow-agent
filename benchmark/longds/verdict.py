#!/usr/bin/env python3
"""Three-rep verdict: per-task rep means, arm means, pooled turn accuracy with
binomial CIs, cost per task-run and steps per turn. Restricted to the tasks a
given arm set has actually covered in ALL reps, so a half-finished extension
cannot quietly change an arm's mean."""
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _paths import SCRATCH  # noqa: E402

TASKS = {
    "kaggle": "community__kaggle-survey-2022__task3",
    "nfl": "sports__nfl_big_data_bowl_2023__task1",
    "acea2": "geoscience__acea_water_prediction__task2",
    "acea3": "geoscience__acea_water_prediction__task3",
    "wids1": "geoscience__phase-ii-widsdatathon2022__task1",
    "wids2": "geoscience__phase-ii-widsdatathon2022__task2",
    "cdp": "geoscience__cdp-unlocking-climate-solutions__task1",
    "cpe1": "social_good__center_for_policing_equity__task1",
    "cpe2": "social_good__center_for_policing_equity__task2",
    "la": "social_good__data_science_for_good_city_of_los_angeles__task1",
}
ARMS = {
    "session": ["LongDS_LongDSLunaTop10Session", "LongDS_LongDSLunaTop10SessionR2",
                "LongDS_LongDSLunaTop10SessionR3"],
    "v36": ["LongDS_LongDSLunaSub5V36", "LongDS_LongDSLunaSub5V36R2", "LongDS_LongDSLunaSub5V36R3"],
    "v37": ["LongDS_LongDSLunaSub5V37", "LongDS_LongDSLunaSub5V37R2", "LongDS_LongDSLunaSub5V37R3"],
}


def scores(sut, task):
    p = SCRATCH / sut / task / "results_eval.json"
    if not p.exists():
        return None
    return [t["judge"]["score"] for t in json.loads(p.read_text())
            if (t.get("judge") or {}).get("score") is not None] or None


covered = [n for n, t in TASKS.items()
           if all(scores(s, t) for suts in ARMS.values() for s in suts)]
print(f"tasks judged in every rep of every arm: {' '.join(covered)}\n")
print(f"{'task':<8}" + "".join(f"{a:>22}" for a in ARMS))
for name in covered:
    row = f"{name:<8}"
    for arm, suts in ARMS.items():
        vals = [100 * sum(s) / len(s) for s in (scores(x, TASKS[name]) for x in suts) if s]
        row += f"{'/'.join(f'{v:.0f}' for v in vals):>15}{sum(vals)/len(vals):>7.1f}"
    print(row)
print()
for arm, suts in ARMS.items():
    per_task = []
    for name in covered:
        vals = [100 * sum(s) / len(s) for s in (scores(x, TASKS[name]) for x in suts) if s]
        per_task.append(sum(vals) / len(vals))
    k = n = 0
    cost = []
    steps = turns = 0
    for s in suts:
        for name in covered:
            sc = scores(s, TASKS[name])
            if sc:
                k += sum(sc)
                n += len(sc)
            sm = SCRATCH / s / TASKS[name] / "summary.json"
            if sm.exists():
                cost.append(json.loads(sm.read_text())["totals"]["cost_usd"])
            for tdir in (SCRATCH / s / TASKS[name]).glob("t[0-9]*"):
                rs = tdir / "react_steps.json"
                if rs.exists():
                    st = [x for x in json.loads(rs.read_text())["steps"] if x.get("role") == "agent"]
                    if st:
                        turns += 1
                        steps += len(st)
    pr = k / n
    ci = 1.96 * math.sqrt(pr * (1 - pr) / n)
    print(f"{arm:8} task-mean {sum(per_task)/len(per_task):5.1f} | pooled turns {100*pr:5.1f}% ±{100*ci:.1f} "
          f"(n={n}) | ${sum(cost)/len(cost):.3f}/task-run | {steps/max(1,turns):.1f} steps/turn")
