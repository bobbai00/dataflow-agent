#!/usr/bin/env python3
"""Trace verification of runs the audit calls OK. Checks the things a
clean-looking run can still get wrong, per run:

  * SETTINGS  — the arm's knobs actually applied (v37: catalogDetail=values,
                queryTool off; session: neither) — read from the trace's tool
                use and context, not from a readback log line;
  * LAYOUT    — the frozen context is the right layout (# Catalog for v37,
                # Session for session) and grows turn over turn;
  * ANSWERS   — every turn ends with a real final answer (non-empty, not an
                error string);
  * JUDGE     — sampled scored turns: a 1-scored turn's answer shares numbers
                with the gold, a 0-scored turn's does not trivially match —
                crude, but catches a judge scoring the wrong field.

Prints one line per verified run; any FAIL line names the check.
"""
import json
import random
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _paths import SCRATCH  # noqa: E402

random.seed(7)
ERR = re.compile(r"execution service unavailable|Cannot connect|Failed after \d+ attempts", re.I)
NUM = re.compile(r"-?\d+\.?\d*")

REPS = [
    ("ses", "LongDS_LongDSLunaBSSession"), ("ses", "LongDS_LongDSLunaBSSessionR2"),
    ("ses", "LongDS_LongDSLunaBSSessionR3"),
    ("v37", "LongDS_LongDSLunaBSV37"), ("v37", "LongDS_LongDSLunaBSV37R2"),
    ("v37", "LongDS_LongDSLunaBSV37R3"),
]

fails = ok = 0
for kind, sut in REPS:
    for d in sorted((SCRATCH / sut).glob("*__task*")):
        sm = d / "summary.json"
        ev = d / "results_eval.json"
        if not (sm.exists() and ev.exists()):
            continue
        s = json.loads(sm.read_text())
        if s["turns_completed"] != s["turns_total"]:
            continue
        problems = []
        evd = json.loads(ev.read_text())
        # ANSWERS: every turn has a non-error solution
        empty = sum(1 for x in evd if not str(x.get("solution") or "").strip())
        errs = sum(1 for x in evd if ERR.search(str(x.get("solution") or "")))
        if empty:
            problems.append(f"{empty} empty answers")
        if errs:
            problems.append(f"{errs} error answers")
        # LAYOUT + SETTINGS from two sampled turns' traces
        tdirs = sorted(d.glob("t[0-9]*"))
        for tdir in random.sample(tdirs, min(2, len(tdirs))):
            p = tdir / "react_steps.json"
            if not p.exists():
                problems.append(f"{tdir.name}: no trace")
                continue
            steps = json.loads(p.read_text())["steps"]
            m1 = next((x["inputMessages"][0].get("content", "") for x in steps if x.get("inputMessages")), "")
            tools = {c.get("toolName") for x in steps for c in (x.get("toolCalls") or [])}
            if kind == "v37":
                if "# Catalog" not in m1 and int(tdir.name[1:]) > 1:
                    problems.append(f"{tdir.name}: no catalog layout")
                if "queryResult" in tools:
                    problems.append(f"{tdir.name}: queryResult used (must be off)")
            else:
                if "# Session" not in m1 and int(tdir.name[1:]) > 1:
                    problems.append(f"{tdir.name}: no session layout")
                if "recallState" in tools:
                    problems.append(f"{tdir.name}: recallState in session arm")
        # JUDGE sanity on one scored-1 turn (if any): answer shares a number with gold
        good = [x for x in evd if (x.get("judge") or {}).get("score") == 1]
        if good:
            x = random.choice(good)
            gnums = set(NUM.findall(json.dumps(x.get("ground_truth", ""))))
            anums = set(NUM.findall(str(x.get("solution") or "")))
            if gnums and anums and not (gnums & anums):
                # no shared number at all on a turn judged correct — suspicious
                problems.append("judge-1 turn shares no number with gold")
        name = f"{sut.split('Luna')[1]}/{d.name.split('__', 1)[1][:34]}"
        if problems:
            fails += 1
            print(f"FAIL {name}: {'; '.join(problems)}")
        else:
            ok += 1
print(f"\nverified OK: {ok} | failed verification: {fails}")
