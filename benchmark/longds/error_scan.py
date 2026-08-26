#!/usr/bin/env python3
"""Which runs contain turns answered with an infrastructure error?

The engine died twice mid-campaign. The first time the agents answered
`{"error":"dataflow execution service unavailable"}`; the second time
`Error: Failed after 3 attempts. Last error: Cannot connect to ...`. A grep for
one misses the other, so match the CLASS: a final answer that is an error
string rather than an answer.

Prints, per SUT/task: how many turns are error-answered, and whether the run is
salvageable (a handful of turns) or has to be re-run (a cluster)."""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _paths import SCRATCH  # noqa: E402

ERR = re.compile(
    r"execution service unavailable|Cannot connect|Failed after \d+ attempts|"
    r"ConnectionRefused|ECONNREFUSED|service unavailable",
    re.I,
)

for sut_dir in sorted(SCRATCH.glob("LongDS_*")):
    if not any(x in sut_dir.name for x in sys.argv[1:]) and len(sys.argv) > 1:
        continue
    rows = []
    for task_dir in sorted(sut_dir.glob("*__task*")):
        res = task_dir / "results_with_ground_truth.json"
        if not res.exists():
            continue
        try:
            data = json.loads(res.read_text())
        except Exception:
            continue
        bad = sum(1 for t in data if ERR.search(str(t.get("solution") or "")))
        if bad:
            rows.append((task_dir.name, bad, len(data)))
    if rows:
        print(f"== {sut_dir.name}")
        for name, bad, total in rows:
            verdict = "RERUN" if bad > 2 else "minor"
            print(f"   {verdict:6} {name.split('__', 1)[1][:44]:44} {bad}/{total} turns error-answered")
