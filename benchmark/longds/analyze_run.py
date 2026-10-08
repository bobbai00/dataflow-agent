#!/usr/bin/env python3
# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements. See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Per-turn cost/steps/context report for a LongDS run.

The accuracy breakdowns live in `judge_longds.py`. This is the other half of the
pilot's purpose: how the wire context grows when DELTA appends every turn's events
and nothing is trimmed. Under append-only history that growth is the thing that
eventually ends the session, so it gets measured directly from each step's
`inputMessages` rather than estimated.

Usage:
    python longds/analyze_run.py --sut LongDS_LongDSLunaDelta1k --task <key>
"""
import argparse
import json
import statistics
import sys
from pathlib import Path

from _paths import PREPARED, SCRATCH
#: gpt-5.6 context window, for the headroom projection.
WINDOW_TOKENS = 272_000
#: agent-service renders a JSON message array; ~4 chars per token is the same
#: approximation its own budget code uses.
CHARS_PER_TOKEN = 4


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sut", required=True)
    ap.add_argument("--task", required=True)
    args = ap.parse_args()

    run_dir = SCRATCH / args.sut / args.task
    if not run_dir.exists():
        print(f"FATAL: {run_dir} missing")
        return 2

    scores = {}
    eval_path = run_dir / "results_eval.json"
    if eval_path.exists():
        for turn in json.loads(eval_path.read_text()):
            scores[turn["turn_id"]] = turn.get("judge", {}).get("score")

    gold_path = PREPARED / args.task / "gold.json"
    patterns = {}
    if gold_path.exists():
        for turn in json.loads(gold_path.read_text())["turns"]:
            patterns[turn["turn_id"]] = ",".join(turn.get("state_type") or []) or "-"

    rows = []
    for tdir in sorted(run_dir.glob("t[0-9][0-9]")):
        stats_path = tdir / "stats.json"
        if stats_path.exists():
            rows.append(json.loads(stats_path.read_text()))
    if not rows:
        print("no completed turns yet")
        return 1

    print(f"{args.sut}  {args.task}   {len(rows)} turns\n")
    print(f"{'turn':>4} {'steps':>5} {'ctx kB':>8} {'in tok':>8} {'cached':>8} "
          f"{'out':>6} {'sec':>5} {'$':>8}  {'ok':>3}  pattern")
    for r in rows:
        tid = r["turn_id"]
        verdict = {1: "1", 0: "0", None: "?"}.get(scores.get(tid), " ")
        cost = f"{r['cost_usd']:.4f}" if r.get("cost_usd") is not None else "unknown"
        print(
            f"{tid:>4} {r['agent_steps']:>5} {r['max_prompt_bytes'] / 1000:>8.1f} "
            f"{r['input_tokens']:>8} {r['cached_tokens']:>8} {r['output_tokens']:>6} "
            f"{r['elapsed_seconds']:>5.0f} {cost:>8}  {verdict:>3}  {patterns.get(tid, '')}"
        )

    ctx = [r["max_prompt_bytes"] for r in rows]
    known_costs = [r["cost_usd"] for r in rows if r.get("cost_usd") is not None]
    if len(known_costs) == len(rows):
        total_cost = sum(known_costs)
        cost_report = f"total ${total_cost:.4f}   mean ${total_cost / len(rows):.4f}/turn"
    else:
        cost_report = f"total unknown ({len(rows) - len(known_costs)} unpriced/incomplete turns); known ${sum(known_costs):.4f}"
    print(f"\n{cost_report}   {sum(r['elapsed_seconds'] for r in rows) / 60:.1f} min")
    print(f"steps/turn: mean {statistics.mean(r['agent_steps'] for r in rows):.1f}  "
          f"max {max(r['agent_steps'] for r in rows)}")
    print(f"context: first {ctx[0] / 1000:.1f} kB  last {ctx[-1] / 1000:.1f} kB")
    if len(ctx) > 2:
        # Slope over the run so far, then where that lands at the paper's cap.
        per_turn = (ctx[-1] - ctx[0]) / (len(ctx) - 1)
        est_final = ctx[-1] + per_turn * (42 - len(ctx))
        print(f"         growth {per_turn / 1000:.1f} kB/turn  "
              f"=> ~{est_final / 1000:.0f} kB at turn 42 "
              f"(~{est_final / CHARS_PER_TOKEN / 1000:.0f}k tokens, "
              f"{est_final / CHARS_PER_TOKEN / WINDOW_TOKENS * 100:.0f}% of the window)")
    errs = [r for r in rows if r.get("error")]
    if errs:
        print(f"\nturns with errors: {[(r['turn_id'], r['error'][:60]) for r in errs]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
