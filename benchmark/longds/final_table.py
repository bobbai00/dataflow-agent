#!/usr/bin/env python3
"""Arm-vs-arm across every judged LongDS task: accuracy, cost, cost per correct.

Cost alone is misleading when accuracy differs by 30 points: an arm that answers
in two steps and gets 6% right looks "cheap". Cost per correct turn is the honest
efficiency number, so it is reported alongside both raw axes.

Two rules the reduction follows, both learned the hard way:

  * **Only tasks every arm has judged enter the comparison.** A turn-weighted
    mean over a different task set per arm is not a comparison, and a partial
    score looks like a result — which is worse than no score. Tasks held by only
    some arms are listed separately, never folded into the total.
  * **Turn-weighted, not task-weighted.** A 15-turn task and a 42-turn task are
    not equal evidence.
"""
import argparse
import json
import statistics
from pathlib import Path

from _paths import SCRATCH

DEFAULT_ARMS = [
    ("baseline", "LongDS_LongDSLunaDelta1k"),
    ("recall", "LongDS_LongDSLunaRecall"),
    ("turn-recall", "LongDS_LongDSLunaTurnRecall"),
]


def load(arm: str, task: str) -> dict | None:
    run = SCRATCH / arm / task
    ev = run / "results_eval.json"
    if not ev.exists():
        return None
    turns = json.loads(ev.read_text())
    scored = [t["judge"]["score"] for t in turns if t.get("judge", {}).get("score") is not None]
    if not scored:
        return None
    stats = [json.loads(p.read_text()) for p in sorted(run.glob("t[0-9][0-9]/stats.json"))]
    cost = sum(s["cost_usd"] for s in stats)
    steps = sum(s["agent_steps"] for s in stats)
    return {
        "n": len(scored),
        "acc": statistics.mean(scored) * 100,
        "correct": sum(scored),
        "cost": cost,
        "steps": steps / max(1, len(stats)),
    }


def short(task: str) -> str:
    for p in ("business__", "geoscience__", "social_good__", "community__", "education__", "sports__"):
        task = task.replace(p, "")
    return task[:36]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--arm",
        action="append",
        metavar="LABEL=SUT",
        help="repeatable; defaults to baseline / recall / turn-recall",
    )
    args = ap.parse_args()
    arms = (
        [tuple(a.split("=", 1)) if "=" in a else (a, a) for a in args.arm]
        if args.arm
        else DEFAULT_ARMS
    )

    rows, partial = [], []
    tasks = sorted({p.name for a in arms if (SCRATCH / a[1]).is_dir() for p in (SCRATCH / a[1]).iterdir()})
    for task in tasks:
        got = {label: load(sut, task) for label, sut in arms}
        (rows if all(got.values()) else partial).append((task, got))
    if not rows:
        print("no task is judged on every arm yet")
        if partial:
            print("\npartial coverage:")
            for task, got in partial:
                have = ", ".join(l for l, v in got.items() if v) or "(none)"
                print(f"  {short(task):<38} judged on: {have}")
        return 1

    labels = [l for l, _ in arms]
    head = f"{'task':<38}{'turns':>6}" + "".join(f"{l[:11]+' acc':>16}" for l in labels) + "".join(
        f"{l[:11]+' $':>14}" for l in labels
    )
    print(head)
    print("-" * len(head))
    for task, got in rows:
        n = next(iter(got.values()))["n"]
        line = f"{short(task):<38}{n:>6}"
        line += "".join(f"{got[l]['acc']:>15.1f}%" for l in labels)
        line += "".join(f"{got[l]['cost']:>14.2f}" for l in labels)
        print(line)

    total_turns = sum(next(iter(g.values()))["n"] for _, g in rows)
    print("-" * len(head))
    agg = {}
    for l in labels:
        acc = sum(g[l]["acc"] * g[l]["n"] for _, g in rows) / total_turns
        cost = sum(g[l]["cost"] for _, g in rows)
        ok = sum(g[l]["correct"] for _, g in rows)
        steps = statistics.mean([g[l]["steps"] for _, g in rows])
        agg[l] = (acc, cost, ok, steps)
    line = f"{'TURN-WEIGHTED':<38}{total_turns:>6}"
    line += "".join(f"{agg[l][0]:>15.1f}%" for l in labels)
    line += "".join(f"{agg[l][1]:>14.2f}" for l in labels)
    print(line)

    print(f"\n{'arm':<16}{'correct':>9}{'of':>6}{'cost':>10}{'$/correct':>12}{'steps/turn':>12}")
    for l in labels:
        acc, cost, ok, steps = agg[l]
        print(f"{l:<16}{ok:>9.0f}{total_turns:>6}{cost:>10.2f}{cost / max(1, ok):>12.3f}{steps:>12.1f}")

    if partial:
        print(f"\nnot in the comparison — judged on only some arms ({len(partial)}):")
        for task, got in partial:
            bits = "  ".join(
                f"{l}={got[l]['acc']:.1f}%/${got[l]['cost']:.2f}" if got[l] else f"{l}=-" for l in labels
            )
            print(f"  {short(task):<38} {bits}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
