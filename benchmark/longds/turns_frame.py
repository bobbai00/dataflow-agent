#!/usr/bin/env python3
"""Flatten every judged turn of the paper's arms into one CSV for the
difficulty x turns analysis (goal item 3). One row per (arm-family, campaign,
task, rep, turn): judge score, cost, tokens, cache hit, steps, elapsed, and
the benchmark's own difficulty signals (depends_span, depends_tasks,
state_type, turn depth). Skips runs with error/empty answers so no poisoned
turn leaks into a mean.

Usage: turns_frame.py [out.csv]
"""
import csv
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _paths import SCRATCH  # noqa: E402

ERR = re.compile(
    r"execution service unavailable|Cannot connect|Failed after \d+ attempts|ConnectionRefused",
    re.I,
)

# family -> campaign -> [(rep, SUT)]
FAMILIES = {
    "session": {
        "top10": [(1, "LongDS_LongDSLunaTop10Session"), (2, "LongDS_LongDSLunaTop10SessionR2"), (3, "LongDS_LongDSLunaTop10SessionR3")],
        "bs": [(1, "LongDS_LongDSLunaBSSession"), (2, "LongDS_LongDSLunaBSSessionR2"), (3, "LongDS_LongDSLunaBSSessionR3")],
    },
    "v37": {
        "top10": [(1, "LongDS_LongDSLunaSub5V37"), (2, "LongDS_LongDSLunaSub5V37R2"), (3, "LongDS_LongDSLunaSub5V37R3")],
        "bs": [(1, "LongDS_LongDSLunaBSV37"), (2, "LongDS_LongDSLunaBSV37R2"), (3, "LongDS_LongDSLunaBSV37R3")],
    },
    "qo": {
        "bs": [(1, "LongDS_LongDSLunaBSQO"), (2, "LongDS_LongDSLunaBSQOR2"), (3, "LongDS_LongDSLunaBSQOR3")],
    },
}

COLS = [
    "family", "campaign", "task", "rep", "turn_id", "score",
    "cost_usd", "input_tokens", "cached_tokens", "output_tokens",
    "elapsed_seconds", "agent_steps", "tool_steps", "max_prompt_bytes",
    "depends_span_max", "n_depends", "state_type", "n_turns_total",
]


def clean(run_dir: Path) -> bool:
    sm = run_dir / "summary.json"
    if not sm.exists():
        return False
    s = json.loads(sm.read_text())
    if s["turns_completed"] != s["turns_total"]:
        return False
    res = run_dir / "results_with_ground_truth.json"
    if res.exists():
        try:
            for x in json.loads(res.read_text()):
                sol = str(x.get("solution") or "")
                if ERR.search(sol):
                    return False
                if not sol.strip():
                    # Fast-fail empties are infrastructure; at-budget empties
                    # are legitimate score-0 turns (see bs_audit.py).
                    elapsed = float((x.get("stats") or {}).get("elapsed_seconds") or 0)
                    if elapsed < 1100:
                        return False
        except Exception:
            return False
    return True


def main() -> None:
    out = sys.argv[1] if len(sys.argv) > 1 else "/dev/stdout"
    w = csv.writer(open(out, "w", newline=""))
    w.writerow(COLS)
    n = 0
    for family, campaigns in FAMILIES.items():
        for campaign, reps in campaigns.items():
            for rep, sut in reps:
                root = SCRATCH / sut
                if not root.is_dir():
                    continue
                for run_dir in sorted(root.glob("*__task*")):
                    ev = run_dir / "results_eval.json"
                    if not ev.exists() or not clean(run_dir):
                        continue
                    turns = json.loads(ev.read_text())
                    for t in turns:
                        score = (t.get("judge") or {}).get("score")
                        if score is None:
                            continue
                        st = t.get("stats") or {}
                        span = t.get("depends_span") or []
                        deps = t.get("depends_tasks") or []
                        w.writerow([
                            family, campaign, run_dir.name, rep, t.get("turn_id"), score,
                            st.get("cost_usd"), st.get("input_tokens"), st.get("cached_tokens"),
                            st.get("output_tokens"), st.get("elapsed_seconds"),
                            st.get("agent_steps"), st.get("tool_steps"), st.get("max_prompt_bytes"),
                            max(span) if span else 0, len(deps),
                            "|".join(t.get("state_type") or []), len(turns),
                        ])
                        n += 1
    print(f"# wrote {n} turn rows", file=sys.stderr)


if __name__ == "__main__":
    main()
