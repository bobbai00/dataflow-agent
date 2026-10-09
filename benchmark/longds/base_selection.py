#!/usr/bin/env python3
"""Did the agent resume from the RIGHT turn?

Answer accuracy conflates two different failures that need different fixes:
picking the wrong state to build on, and computing the wrong thing from the
right state. They are indistinguishable in a score. LongDS ships
`depends_tasks` per turn, so the first one can be measured directly.

The target is `max(depends_tasks)`. Because a dataflow accumulates, the newest
dependency's snapshot already contains the older ones — so resuming there
subsumes the whole dependency set, and a single number is the right target
rather than the set.

Reported separately from accuracy on purpose. An arm can pick bases perfectly
and still answer badly, or pick badly and be rescued by the state happening to
contain what it needed; only seeing both tells you which lever to pull.
"""
import argparse
import json
import os
import glob
import collections
from pathlib import Path

from _paths import PREPARED, SCRATCH


def bases_chosen(arm: str, task: str) -> dict[int, int]:
    """turn -> the turn it resumed from (first successful resume of that turn)."""
    out: dict[int, int] = {}
    for f in sorted(glob.glob(str(SCRATCH / arm / task / "t*/react_steps.json"))):
        turn = int(f.split("/")[-2][1:])
        try:
            steps = json.loads(Path(f).read_text())["steps"]
        except Exception:
            continue
        for s in steps:
            calls = s.get("toolCalls") or []
            results = (s.get("toolResults") or []) + [None] * len(calls)
            for tc, tr in zip(calls, results):
                if tc.get("toolName") != "resumeFrom":
                    continue
                if tr is not None and str(tr.get("output", "")).startswith("[ERROR]"):
                    continue
                if turn not in out:
                    out[turn] = (tc.get("input") or {}).get("turn")
    return {k: v for k, v in out.items() if isinstance(v, int)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sut", required=True)
    ap.add_argument("--task", action="append", help="repeatable; default every task under --sut")
    args = ap.parse_args()

    tasks = args.task or sorted(p.name for p in (SCRATCH / args.sut).iterdir() if p.is_dir())
    tot = right = older_needed = older_taken = 0
    by_pat: dict[str, list[int]] = collections.defaultdict(lambda: [0, 0])

    for task in tasks:
        gold = PREPARED / task / "gold.json"
        if not gold.exists():
            continue
        turns = json.loads(gold.read_text())["turns"]
        deps = {t["turn_id"]: (t.get("depends_tasks") or []) for t in turns}
        pats = {t["turn_id"]: (t.get("state_type") or ["(none)"]) for t in turns}
        chosen = bases_chosen(args.sut, task)
        if not chosen:
            continue
        t_tot = t_right = 0
        for turn, base in sorted(chosen.items()):
            d = [x for x in deps.get(turn, []) if isinstance(x, int) and x < turn]
            if not d:
                continue
            target = max(d)
            tot += 1
            t_tot += 1
            ok = base == target
            right += ok
            t_right += ok
            if target < turn - 1:
                older_needed += 1
                if base < turn - 1:
                    older_taken += 1
            for p in pats.get(turn, ["(none)"]):
                by_pat[p][0] += 1
                by_pat[p][1] += ok
        if t_tot:
            print(f"  {task.split('__', 1)[1][:40]:<42} {t_right}/{t_tot} correct base ({100 * t_right / t_tot:.0f}%)")

    if tot == 0:
        print("no resumed turns with recorded dependencies")
        return 1
    print(f"\nBASE SELECTION  {right}/{tot} = {100 * right / tot:.1f}%")
    print(
        f"  turns needing an OLDER base than the previous turn: {older_needed}"
        f"   of which it went older: {older_taken}"
        f" ({100 * older_taken / older_needed:.0f}%)" if older_needed else ""
    )
    print("\n  by state pattern:")
    for p, (n, ok) in sorted(by_pat.items()):
        print(f"    {p:<16} {ok:>3}/{n:<3} ({100 * ok / n:.0f}%)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
