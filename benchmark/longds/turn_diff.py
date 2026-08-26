#!/usr/bin/env python3
"""Per-turn win/loss matrix between v40d and session for one task.

Prints turns where the arms DISAGREE consistently across reps — the cells
where a mechanism (not noise) is doing the work. Usage:
    python3 logs/turn_diff.py <task_key> [--min-reps 2]
"""
import json, os, sys, glob
from collections import defaultdict

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _paths import SCRATCH  # noqa: E402

BASE = str(SCRATCH)
V = ["LongDS_LongDSLunaTEV40D", "LongDS_LongDSLunaTEV40DR2", "LongDS_LongDSLunaTEV40DR3"]
S = ["LongDS_LongDSLunaTESession", "LongDS_LongDSLunaTESessionR2", "LongDS_LongDSLunaTESessionR3",
     "LongDS_LongDSLunaTop10Session", "LongDS_LongDSLunaTop10SessionR2", "LongDS_LongDSLunaTop10SessionR3",
     "LongDS_LongDSLunaBSSession", "LongDS_LongDSLunaBSSessionR2", "LongDS_LongDSLunaBSSessionR3"]


def per_turn(suts, task):
    """turn_id -> list of scores across reps"""
    out = defaultdict(list)
    for s in suts:
        p = os.path.join(BASE, s, task, "results_eval.json")
        if not os.path.exists(p):
            continue
        for x in json.load(open(p)):
            sc = x.get("judge", {}).get("score")
            if sc not in (None, "None"):
                out[x["turn_id"]].append(float(sc))
    return out


def main():
    task = sys.argv[1]
    minreps = 2
    if "--min-reps" in sys.argv:
        minreps = int(sys.argv[sys.argv.index("--min-reps") + 1])
    v, s = per_turn(V, task), per_turn(S, task)
    turns = sorted(set(v) | set(s))
    print(f"task: {task}")
    print(f"{'turn':>5} {'v40d':>16} {'session':>16}  verdict")
    vwin, swin, tie = [], [], []
    for t in turns:
        vv, ss = v.get(t, []), s.get(t, [])
        if len(vv) < minreps or len(ss) < minreps:
            continue
        vm, sm = sum(vv) / len(vv), sum(ss) / len(ss)
        vs = "/".join(f"{x:.0f}" for x in vv)
        ss_ = "/".join(f"{x:.0f}" for x in ss)
        tag = ""
        if vm >= 0.99 and sm <= 0.01:
            tag = "*** V40D ONLY ***"; vwin.append(t)
        elif sm >= 0.99 and vm <= 0.01:
            tag = "*** SESSION ONLY ***"; swin.append(t)
        elif vm - sm >= 0.5:
            tag = "v40d better"; vwin.append(t)
        elif sm - vm >= 0.5:
            tag = "session better"; swin.append(t)
        else:
            tie.append(t)
        if tag:
            print(f"{t:5d} {vs:>16} {ss_:>16}  {tag}")
    print(f"\nv40d-favouring turns: {vwin}")
    print(f"session-favouring turns: {swin}")
    print(f"tied turns: {len(tie)}")


main()
