#!/usr/bin/env python3
"""Per-task judge COVERAGE: how many turns actually carry a score, and how many
failed (402 insufficient credits, 401, timeouts). A task whose judge died
mid-way leaves a results_eval.json that looks complete and whose mean is
computed over a handful of turns — which is how a 1-of-37 file reported "0.0"."""
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _paths import SCRATCH  # noqa: E402

for sut in sys.argv[1:]:
    root = SCRATCH / sut
    if not root.exists():
        continue
    print(f"== {sut}")
    for p in sorted(root.glob("*/results_eval.json")):
        ev = json.loads(p.read_text())
        scored = [t for t in ev if (t.get("judge") or {}).get("score") is not None]
        errs = Counter()
        for t in ev:
            # `or ""` matters: error_detail is None on a healthy turn, and
            # str(None) == "None" is truthy — which counted every good turn as
            # an error in the first version of this script.
            raw = (t.get("judge") or {}).get("error_detail")
            d = "" if raw in (None, "", "None") else str(raw)
            if "402" in d:
                errs["402 no credits"] += 1
            elif "401" in d:
                errs["401 auth"] += 1
            elif d:
                errs["other"] += 1
        flag = "OK " if len(scored) == len(ev) else "GAP"
        acc = 100 * sum(t["judge"]["score"] for t in scored) / len(scored) if scored else float("nan")
        print(f"  {flag} {p.parent.name.split('__', 1)[1][:32]:32} scored {len(scored):>3}/{len(ev):<3} "
              f"acc(on scored)={acc:5.1f} {dict(errs) if errs else ''}")
