#!/usr/bin/env python3
"""v40d vs v41 A/B on the three sessions the fixes target.

v41 = v40d plus three trace-derived changes, all agent-service source (the arm
settings are byte-identical, so this isolates the renderer/driver):

  1. the dataflow index no longer head-clips column lists at 400 chars
     (derived flags are appended, so a head-only cut hid the very column later
     turns filter on);
  2. a `### Working set` block names the previous turn's operators and what
     they read, columns uncut — which frame the analysis stands on;
  3. a driver answer guard: a turn whose operators succeeded may not end
     without a final answer.

Reports per-session rep scores, the specific target turns each fix aims at,
and the turn-level flip list — because the session mean is the weakest part of
the evidence at n=3 and the target turns are the strongest.
"""
import json
import os
import statistics as st
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _paths import SCRATCH  # noqa: E402

BASE = str(SCRATCH)

SESSIONS = [
    ("water-potability", "geoscience__water-potability__task3", (8, 16),
     "working set: severity built on the narrowed frame, not the wider base"),
    ("nfl", "sports__nfl_big_data_bowl_2023__task1", (23, 26, 29, 33),
     "column clip: `reliable_pool` visible, so the pool filter survives"),
    ("wids", "geoscience__phase-ii-widsdatathon2022__task1", (13,),
     "answer guard: a finished turn may not end on an apology"),
]

ARMS = {
    "v40d": ["LongDS_LongDSLunaTEV40D", "LongDS_LongDSLunaTEV40DR2", "LongDS_LongDSLunaTEV40DR3"],
    "v41": ["LongDS_LongDSLunaTEV41", "LongDS_LongDSLunaTEV41R2", "LongDS_LongDSLunaTEV41R3"],
    "full": ["LongDS_LongDSLunaTop10Session", "LongDS_LongDSLunaTop10SessionR2",
             "LongDS_LongDSLunaTop10SessionR3", "LongDS_LongDSLunaTESession",
             "LongDS_LongDSLunaTESessionR2", "LongDS_LongDSLunaTESessionR3"],
}


def rows(sut, task):
    p = os.path.join(BASE, sut, task, "results_eval.json")
    if not os.path.exists(p):
        return None
    return json.load(open(p))


def rep_score(sut, task):
    r = rows(sut, task)
    if not r:
        return None
    v = [float(x["judge"]["score"]) for x in r
         if x.get("judge") and x["judge"].get("score") not in (None, "None")]
    return round(100 * sum(v) / len(v), 1) if v else None


def turn_matrix(suts, task):
    m = {}
    for s in suts:
        r = rows(s, task)
        if not r:
            continue
        for x in r:
            sc = x.get("judge", {}).get("score")
            if sc not in (None, "None"):
                m.setdefault(x["turn_id"], []).append(int(float(sc)))
    return m


def main():
    for label, task, targets, why in SESSIONS:
        print(f"\n{'=' * 74}\n{label}  —  {why}\n{'=' * 74}")
        scores = {}
        for arm, suts in ARMS.items():
            s = [x for x in (rep_score(u, task) for u in suts) if x is not None]
            scores[arm] = s
            if s:
                print(f"  {arm:5s} {s}   mean {st.mean(s):5.1f}")
        v40, v41 = turn_matrix(ARMS["v40d"], task), turn_matrix(ARMS["v41"], task)
        full = turn_matrix(ARMS["full"], task)
        print(f"\n  target turns   {'v40d':>8} {'v41':>8} {'full':>8}")
        for t in targets:
            f = lambda m: "".join(map(str, m.get(t, []))) or "-"  # noqa: E731
            print(f"    t{t:<11d} {f(v40):>8} {f(v41):>8} {f(full):>8}")
        gained, lost = [], []
        for t in sorted(set(v40) & set(v41)):
            a, b = sum(v40[t]) / len(v40[t]), sum(v41[t]) / len(v41[t])
            if b - a >= 0.5:
                gained.append(t)
            elif a - b >= 0.5:
                lost.append(t)
        print(f"\n  turns gained: {gained}")
        print(f"  turns lost:   {lost}")


main()
