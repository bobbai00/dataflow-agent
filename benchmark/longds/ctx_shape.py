#!/usr/bin/env python3
"""Context-shape comparison: how the assembled prompt grows with turn depth,
per layout. Measures the FIRST assembled context of each turn (what the model
sees before it acts), plus recall/rebuild behaviour."""
import json, glob, os, sys
from collections import defaultdict

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _paths import SCRATCH  # noqa: E402

BASE = str(SCRATCH)


def first_ctx(turn_dir):
    p = os.path.join(turn_dir, "react_steps.json")
    if not os.path.exists(p):
        return None
    try:
        steps = json.load(open(p))["steps"]
    except Exception:
        return None
    for st in steps:
        for m in (st.get("inputMessages") or []):
            c = m.get("content") if isinstance(m, dict) else None
            if isinstance(c, str) and len(c) > 500:
                return c
    return None


def stats(sut, task):
    out = []
    for d in sorted(glob.glob(os.path.join(BASE, sut, task, "t*"))):
        if not os.path.isdir(d):
            continue
        t = int(os.path.basename(d)[1:])
        c = first_ctx(d)
        if c is None:
            continue
        steps = json.load(open(os.path.join(d, "react_steps.json")))["steps"]
        calls = [x for st in steps for x in (st.get("toolCalls") or [])]
        out.append(dict(turn=t, chars=len(c),
                        writes=sum(1 for x in calls if x.get("toolName") == "createOrModifyOperator"),
                        recalls=sum(1 for x in calls if x.get("toolName") == "recallState"),
                        steps=len(steps)))
    return out


def main():
    task = sys.argv[1]
    V = "LongDS_LongDSLunaTEV40D"
    S = next((s for s in ["LongDS_LongDSLunaTop10Session", "LongDS_LongDSLunaTESession",
                          "LongDS_LongDSLunaBSSession"]
              if os.path.isdir(os.path.join(BASE, s, task))), None)
    v, s = stats(V, task), stats(S, task) if S else []
    vm = {x["turn"]: x for x in v}
    sm = {x["turn"]: x for x in s}
    print(f"task: {task}   v40d={V}  session={S}")
    print(f"{'turn':>5} {'v40d KB':>9} {'ses KB':>9} {'ratio':>7} {'v40d w/r':>9} {'ses w/r':>8}")
    for t in sorted(set(vm) | set(sm)):
        a, b = vm.get(t), sm.get(t)
        if not a or not b:
            continue
        print(f"{t:5d} {a['chars']/1024:9.1f} {b['chars']/1024:9.1f} {a['chars']/b['chars']:7.2f}"
              f" {a['writes']:4d}/{a['recalls']:<4d} {b['writes']:4d}/{b['recalls']:<3d}")
    if vm and sm:
        common = sorted(set(vm) & set(sm))
        early = [t for t in common if t <= 5]
        late = [t for t in common if t >= max(common) - 5]
        for name, band in (("early(<=5)", early), ("late(last 6)", late)):
            if not band:
                continue
            av = sum(vm[t]["chars"] for t in band) / len(band) / 1024
            bs = sum(sm[t]["chars"] for t in band) / len(band) / 1024
            print(f"  {name:14s} v40d {av:7.1f}KB   session {bs:7.1f}KB   ratio {av/bs:.2f}")
        print(f"  total writes  v40d {sum(x['writes'] for x in v):4d}   session {sum(x['writes'] for x in s):4d}")
        print(f"  total recalls v40d {sum(x['recalls'] for x in v):4d}   session {sum(x['recalls'] for x in s):4d}")


main()
