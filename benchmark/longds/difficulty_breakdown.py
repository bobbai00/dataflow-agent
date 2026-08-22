#!/usr/bin/env python3
"""Difficulty x turns breakdown over the turns_frame CSV (goal item 3.3).

Hypothesis under test: the harder the task and the deeper into the session a
turn sits, the more the catalog/version-based arm (v37) gains over the
extremes. Buckets:
  * turn depth (turn_id): 1-5 / 6-15 / 16-25 / 26+
  * dependency span (max turns back a turn's inputs reach): 0 / 1 / 2-4 / 5+
  * state_type: Initial vs Update vs Recall-ish mixtures
Per bucket x family: accuracy, mean cost/turn, cache-hit ratio, steps.

Usage: difficulty_breakdown.py turns.csv [--campaign bs|top10|all]
"""
import csv
import sys
from collections import defaultdict

path = sys.argv[1]
campaign = "all"
if "--campaign" in sys.argv:
    campaign = sys.argv[sys.argv.index("--campaign") + 1]

rows = []
for r in csv.DictReader(open(path)):
    if campaign != "all" and r["campaign"] != campaign:
        continue
    rows.append(r)

FAMS = ["session", "v37", "qo"]


def depth_bucket(t):
    t = int(t)
    return "01-05" if t <= 5 else "06-15" if t <= 15 else "16-25" if t <= 25 else "26+"


def span_bucket(s):
    s = int(s)
    return "0" if s == 0 else "1" if s == 1 else "2-4" if s <= 4 else "5+"


def agg(key_fn, title):
    cells = defaultdict(lambda: defaultdict(list))
    for r in rows:
        cells[key_fn(r)][r["family"]].append(r)
    print(f"\n== {title} (campaign={campaign}) ==")
    hdr = f"{'bucket':<8}" + "".join(
        f"{f + ' acc%':>10}{f + ' $/t':>9}{f + ' n':>7}" for f in FAMS
    )
    print(hdr)
    for b in sorted(cells):
        line = f"{b:<8}"
        for f in FAMS:
            rs = cells[b][f]
            if rs:
                acc = 100 * sum(int(x["score"]) for x in rs) / len(rs)
                cost = sum(float(x["cost_usd"] or 0) for x in rs) / len(rs)
                line += f"{acc:>10.1f}{cost:>9.4f}{len(rs):>7}"
            else:
                line += f"{'-':>10}{'-':>9}{'-':>7}"
        print(line)


agg(lambda r: depth_bucket(r["turn_id"]), "by turn depth")
agg(lambda r: span_bucket(r["depends_span_max"]), "by dependency span (max turns back)")
agg(lambda r: (r["state_type"] or "none").split("|")[0], "by state type (first)")

# cache economics: mean cache-hit ratio by family and depth
print(f"\n== cache-hit ratio (cached/input) by depth (campaign={campaign}) ==")
cells = defaultdict(lambda: defaultdict(list))
for r in rows:
    if r["input_tokens"] and float(r["input_tokens"]) > 0:
        cells[depth_bucket(r["turn_id"])][r["family"]].append(
            float(r["cached_tokens"] or 0) / float(r["input_tokens"])
        )
print(f"{'bucket':<8}" + "".join(f"{f:>10}" for f in FAMS))
for b in sorted(cells):
    line = f"{b:<8}"
    for f in FAMS:
        v = cells[b][f]
        line += f"{(100 * sum(v) / len(v)):>9.1f}%" if v else f"{'-':>10}"
    print(line)
