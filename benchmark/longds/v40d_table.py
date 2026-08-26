#!/usr/bin/env python3
"""v40d campaign table: per-task means across reps, vs banked baselines.

Two blocks: the two-ends 10 (session/qo/v38/v39/lean-v40 baselines from the
TE campaign) and the extension 10 (session baselines from Top10Session for
the most-turns tasks, BSSession for the fewest-turns tasks).
"""
import json, glob, os

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _paths import SCRATCH  # noqa: E402

BASE = str(SCRATCH)

# cdp is EXCLUDED as a dead task: every arm ever run scores 0-2.6% on it
# (session 0.9, v38 0.9, lean-v40 0.0, v40d 2.6/0.0), its turns routinely burn
# the full 1200s budget, and a single run costs ~$1 and 3-5 hours. It carries
# no signal, so it is not worth the money or the wall-clock.
TWO_ENDS = [
    ("sports__nfl_big_data_bowl_2023__task1", 42),
    ("geoscience__phase-ii-widsdatathon2022__task1", 40),
    ("geoscience__acea_water_prediction__task2", 38),
    ("geoscience__acea_water_prediction__task3", 37),
    ("community__kaggle-survey-2021__task1", 25),
    ("education__LearnPlatform_COVID-19_Impact_on_Digital_Learning__task1", 25),
    ("education__world_university_rankings__task3", 23),
    ("education__world_university_rankings__task2", 21),
    ("community__github_programming_languages_data__task1", 15),
]

EXTENSION = [
    ("community__kaggle-survey-2022__task3", 37),
    ("social_good__center_for_policing_equity__task1", 36),
    ("social_good__center_for_policing_equity__task2", 36),
    ("social_good__data_science_for_good_city_of_los_angeles__task1", 36),
    ("geoscience__water-potability__task3", 36),
    ("business__goodreads_books__task1", 32),
    ("business__nyc_restaurants_data_food_ordering_and_delivery__task1", 32),
    ("business__netflix_movies_and_tv_shows__task4", 32),
    # march_madness EXCLUDED: its turn 13 reproducibly hangs the LLM call
    # indefinitely (twice, different arms, identical turn), burning a lane
    # 15+ min per attempt with no result. Also the weakest baseline cell
    # (session only ever completed 2 reps, r3 was deferred as whale debt).
    ("business__nyc_restaurants_data_food_ordering_and_delivery__task2", 33),
]

ARMS_TE = {
    "session": ["LongDS_LongDSLunaTESession", "LongDS_LongDSLunaTESessionR2", "LongDS_LongDSLunaTESessionR3"],
    "qo": ["LongDS_LongDSLunaTEQO", "LongDS_LongDSLunaTEQOR2", "LongDS_LongDSLunaTEQOR3"],
    "v38": ["LongDS_LongDSLunaTEV38", "LongDS_LongDSLunaTEV38R2", "LongDS_LongDSLunaTEV38R3"],
    "lean40": ["LongDS_LongDSLunaTEV40"],
    "v40d": ["LongDS_LongDSLunaTEV40D", "LongDS_LongDSLunaTEV40DR2", "LongDS_LongDSLunaTEV40DR3"],
}

ARMS_EXT = {
    "session": [
        "LongDS_LongDSLunaTop10Session", "LongDS_LongDSLunaTop10SessionR2", "LongDS_LongDSLunaTop10SessionR3",
        "LongDS_LongDSLunaBSSession", "LongDS_LongDSLunaBSSessionR2", "LongDS_LongDSLunaBSSessionR3",
        "LongDS_LongDSLunaTESession", "LongDS_LongDSLunaTESessionR2", "LongDS_LongDSLunaTESessionR3",
    ],
    "qo": ["LongDS_LongDSLunaBSQO", "LongDS_LongDSLunaBSQOR2", "LongDS_LongDSLunaBSQOR3"],
    "v37f": ["LongDS_LongDSLunaBSV37F", "LongDS_LongDSLunaBSV37FR2", "LongDS_LongDSLunaBSV37FR3"],
    "v40d": ["LongDS_LongDSLunaTEV40D", "LongDS_LongDSLunaTEV40DR2", "LongDS_LongDSLunaTEV40DR3"],
}


def score(sut, task):
    p = os.path.join(BASE, sut, task, "results_eval.json")
    if not os.path.exists(p):
        return None
    rows = json.load(open(p))
    v = [float(x["judge"]["score"]) for x in rows
         if x.get("judge") and x["judge"].get("score") not in (None, "None")]
    return 100 * sum(v) / len(v) if v else None


def cost(sut, task):
    tot, n = 0.0, 0
    for f in glob.glob(os.path.join(BASE, sut, task, "t*/stats.json")):
        try:
            tot += json.load(open(f)).get("cost_usd", 0) or 0
            n += 1
        except Exception:
            pass
    return tot if n else None


def block(title, tasks, arms):
    print(f"\n=== {title} ===")
    head = f"{'task':40s}{'turns':>6s}"
    for a in arms:
        head += f"{a:>16s}"
    print(head)
    sums = {a: [] for a in arms}
    for task, turns in tasks:
        short = task.split("__")[1][:26] + "/" + task.rsplit("__", 1)[1]
        row = f"{short[:40]:40s}{turns:6d}"
        for a, suts in arms.items():
            vals = [s for s in (score(s_, task) for s_ in suts) if s is not None]
            cs = [c for c in (cost(s_, task) for s_ in suts) if c]
            if vals:
                mean = sum(vals) / len(vals)
                sums[a].append(mean)
                c = f"${sum(cs)/len(cs):.2f}" if cs else ""
                row += f"{mean:9.1f}·{len(vals)} {c:>5s}"[:16].rjust(16)
            else:
                row += f"{'–':>16s}"
        print(row)
    mrow = f"{'MEAN (tasks w/ data)':40s}{'':6s}"
    for a in arms:
        v = sums[a]
        mrow += f"{sum(v)/len(v):9.1f}·{len(v):<2d}".rjust(16) if v else f"{'–':>16s}"
    print(mrow)


block("TWO-ENDS 10", TWO_ENDS, ARMS_TE)
block("EXTENSION 10 (turn-rank 6-10, both ends)", EXTENSION, ARMS_EXT)
