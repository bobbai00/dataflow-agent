#!/usr/bin/env python3
"""Arm-vs-arm comparison on the same LongDS task(s).

Accuracy comes from `results_eval.json` (the official judge's per-turn 0/1);
cost and context growth come from the per-turn `stats.json`. Turns are matched by
turn_id so a partial run still compares fairly — the intersection is reported and
the per-arm turn counts are printed, because comparing a 42-turn arm against a
20-turn arm on "overall accuracy" would silently favour whichever one stopped
before the hard tail.

Usage:
    python longds/compare_arms.py --task <key> --arms LongDS_A LongDS_B
"""
import argparse
import json
import statistics
import sys
from pathlib import Path

from _paths import SCRATCH


def load_arm(sut: str, task: str) -> dict:
    run = SCRATCH / sut / task
    out = {"sut": sut, "turns": {}, "stats": {}}
    ev = run / "results_eval.json"
    if ev.exists():
        for t in json.loads(ev.read_text()):
            out["turns"][t["turn_id"]] = {
                "score": t.get("judge", {}).get("score"),
                "state_type": t.get("state_type") or [],
                "depends": len(t.get("depends_tasks") or []),
            }
    for sdir in sorted(run.glob("t[0-9][0-9]")):
        # A turn dir exists as soon as the turn starts, so an interrupted run has
        # a trailing dir with no stats yet. Skip it rather than dying.
        stats = sdir / "stats.json"
        if not stats.exists():
            continue
        s = json.loads(stats.read_text())
        out["stats"][s["turn_id"]] = s
    return out


def pct(vals: list) -> str:
    return f"{statistics.mean(vals) * 100:5.1f}" if vals else "    -"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", required=True)
    ap.add_argument("--arms", nargs="+", required=True)
    args = ap.parse_args()

    arms = [load_arm(a, args.task) for a in args.arms]
    for a in arms:
        if not a["stats"]:
            print(f"FATAL: no turns found for {a['sut']} / {args.task}")
            return 2

    common = sorted(set.intersection(*[set(a["stats"]) for a in arms]))
    print(f"task: {args.task}")
    for a in arms:
        judged = sum(1 for t in a["turns"].values() if t["score"] is not None)
        print(f"  {a['sut']:<34} turns run {len(a['stats']):>3}  judged {judged:>3}")
    print(f"  comparing the {len(common)} turn(s) both arms ran\n")

    hdr = f"{'metric':<26}" + "".join(f"{a['sut'][-22:]:>24}" for a in arms)
    print(hdr)
    print("-" * len(hdr))

    def row(label: str, fn) -> None:
        print(f"{label:<26}" + "".join(f"{fn(a):>24}" for a in arms))

    row("accuracy (common turns)", lambda a: pct([a["turns"][t]["score"] for t in common
                                                  if a["turns"].get(t, {}).get("score") is not None]))
    row("accuracy (all its turns)", lambda a: pct([v["score"] for v in a["turns"].values()
                                                   if v["score"] is not None]))
    row("cost $ (common turns)", lambda a: f"{sum(a['stats'][t]['cost_usd'] for t in common):.4f}")
    row("steps/turn (common)", lambda a: f"{statistics.mean(a['stats'][t]['agent_steps'] for t in common):.1f}")
    row("input tok (common)", lambda a: f"{sum(a['stats'][t]['input_tokens'] for t in common):,}")
    row("cached share (common)", lambda a: f"{sum(a['stats'][t]['cached_tokens'] for t in common) / max(1, sum(a['stats'][t]['input_tokens'] for t in common)) * 100:.1f}%")
    row("ctx kB at last common", lambda a: f"{a['stats'][common[-1]]['max_prompt_bytes'] / 1000:.1f}")
    row("ctx kB at its last turn", lambda a: f"{a['stats'][max(a['stats'])]['max_prompt_bytes'] / 1000:.1f}")

    print()
    for label, keep in [
        ("Initial", lambda t: "Initial" in t["state_type"]),
        ("Update", lambda t: "Update" in t["state_type"]),
        ("Counterfactual", lambda t: "Counterfactual" in t["state_type"]),
        ("Rollback", lambda t: "Rollback" in t["state_type"]),
    ]:
        row(f"  {label}", lambda a: pct([a["turns"][t]["score"] for t in common
                                         if a["turns"].get(t, {}).get("score") is not None and keep(a["turns"][t])]))

    print()
    n = len(common)
    for i, (label, lo, hi) in enumerate(
        [("first quarter", 0, n // 4), ("second", n // 4, n // 2), ("third", n // 2, 3 * n // 4), ("last quarter", 3 * n // 4, n)]
    ):
        seg = common[lo:hi]
        row(f"  {label}", lambda a, seg=seg: pct([a["turns"][t]["score"] for t in seg
                                                  if a["turns"].get(t, {}).get("score") is not None]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
