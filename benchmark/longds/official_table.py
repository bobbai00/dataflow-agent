#!/usr/bin/env python3
"""Accuracy and cost of the official-protocol arms, per task and model.

Reads each SUT `LongDS_Official_<arm>_<model>_t<trial>` under system_scratch:
`results_eval.json` (the judge's per-turn 0/1; unjudged tasks show accuracy
as `-`) and the per-turn `stats` recorded with every answer (tokens, calls,
cost at the repository's accounting rates). Cost is comparable across arms of
the same model only; the rate table is Luna's for every model.

    python official_table.py --trial 3 [--arms dsgym,react-catalog] [--per-turn TASK]
"""
import argparse
import json
from collections import defaultdict
from pathlib import Path

from _paths import SCRATCH

TASKS = {
    "community__github_programming_languages_data__task1": "github",
    "education__world_university_rankings__task2": "university",
    "social_good__center_for_policing_equity__task1": "policing",
    "business__netflix_movies_and_tv_shows__task2": "netflix2",
    "business__netflix_movies_and_tv_shows__task3": "netflix3",
    "business__my_uber_drivers__task1": "uber1",
}
MODELS = {"luna": "gpt-5.6-luna", "terra": "gpt-5.6-terra"}


def load_runs(trial: int, arms: list[str]) -> dict:
    """{(task, model, arm): {"turns": [record...], "judged": bool}}"""
    runs = {}
    for tail in MODELS:
        for arm in arms:
            root = SCRATCH / f"LongDS_Official_{arm}_{tail}_t{trial}"
            if not root.exists():
                continue
            for task_dir in sorted(p for p in root.iterdir() if p.is_dir()):
                judged = (task_dir / "results_eval.json").exists()
                source = task_dir / ("results_eval.json" if judged else "results_with_ground_truth.json")
                if not source.exists():
                    continue
                runs[(task_dir.name, tail, arm)] = {"turns": json.loads(source.read_text()), "judged": judged}
    return runs


def summarize(turns: list[dict], judged: bool) -> dict:
    stats = [t.get("stats") or {} for t in turns]
    total = lambda key: sum(s.get(key, 0) or 0 for s in stats)  # noqa: E731
    scored = [t["judge"]["score"] for t in turns if judged and (t.get("judge") or {}).get("score") is not None]
    input_tokens, cached = total("input_tokens"), total("cached_tokens")
    return {
        "turns": len(turns),
        "answered": sum(1 for t in turns if t.get("solution")),
        "correct": sum(scored) if judged else None,
        "judged": len(scored) if judged else None,
        "accuracy": (100.0 * sum(scored) / len(scored)) if scored else None,
        "cost_usd": total("cost_usd"),
        "input_tokens": input_tokens,
        "cached_tokens": cached,
        "cached_share": (100.0 * cached / input_tokens) if input_tokens else None,
        "output_tokens": total("output_tokens"),
        "reasoning_tokens": total("reasoning_tokens"),
        "llm_calls": total("llm_calls"),
        "steps": sum(t.get("steps", 0) or 0 for t in turns),
        "minutes": total("elapsed_seconds") / 60,
    }


def fmt(value, spec: str, missing: str = "-") -> str:
    return missing if value is None else format(value, spec)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trial", type=int, default=3)
    ap.add_argument("--arms", default="dsgym,react-catalog,react-entries,react-restore")
    ap.add_argument("--per-turn", help="task key or short name: print both arms' per-turn score and cost side by side")
    args = ap.parse_args()
    arms = args.arms.split(",")
    runs = load_runs(args.trial, arms)
    if not runs:
        print(f"no runs for trial {args.trial}")
        return 1

    header = f"{'task':<11}{'model':<7}{'arm':<15}{'acc%':>7}{'n':>7}{'cost$':>9}{'in tok':>10}{'cached%':>9}{'out tok':>9}{'calls':>7}{'steps':>7}{'min':>7}"
    print(header)
    print("-" * len(header))
    totals: dict = defaultdict(list)
    for (task, tail, arm), run in sorted(runs.items(), key=lambda kv: (list(TASKS).index(kv[0][0]) if kv[0][0] in TASKS else 9, kv[0][1], kv[0][2])):
        s = summarize(run["turns"], run["judged"])
        totals[(tail, arm)].append(s)
        counts = f"{s['correct']}/{s['judged']}" if s["judged"] is not None else f"{s['answered']}/{s['turns']}"
        print(
            f"{TASKS.get(task, task)[:10]:<11}{tail:<7}{arm:<15}{fmt(s['accuracy'], '.1f'):>7}"
            f"{counts:>7}"
            f"{s['cost_usd']:>9.4f}{s['input_tokens']:>10,}{fmt(s['cached_share'], '.0f'):>9}{s['output_tokens']:>9,}"
            f"{s['llm_calls']:>7}{s['steps']:>7}{s['minutes']:>7.1f}"
        )
    print("-" * len(header))
    for (tail, arm), rows in sorted(totals.items()):
        correct = sum(r["correct"] or 0 for r in rows if r["judged"])
        judged = sum(r["judged"] or 0 for r in rows if r["judged"])
        cost = sum(r["cost_usd"] for r in rows)
        input_tokens = sum(r["input_tokens"] for r in rows)
        cached = sum(r["cached_tokens"] for r in rows)
        print(
            f"{'ALL':<11}{tail:<7}{arm:<15}{fmt(100.0 * correct / judged if judged else None, '.1f'):>7}{(str(correct) + '/' + str(judged)) if judged else '-':>7}"
            f"{cost:>9.4f}{input_tokens:>10,}{fmt(100.0 * cached / input_tokens if input_tokens else None, '.0f'):>9}"
            f"{sum(r['output_tokens'] for r in rows):>9,}{sum(r['llm_calls'] for r in rows):>7}{sum(r['steps'] for r in rows):>7}{sum(r['minutes'] for r in rows):>7.1f}"
        )

    if args.per_turn:
        key = next((k for k, v in TASKS.items() if args.per_turn in (k, v)), args.per_turn)
        for tail in MODELS:
            columns = {arm: runs.get((key, tail, arm)) for arm in arms}
            if not any(columns.values()):
                continue
            print(f"\n{TASKS.get(key, key)} / {tail}: per turn (score, cost$, calls)   state_type / depends")
            length = max(len(r["turns"]) for r in columns.values() if r)
            for i in range(length):
                cells = []
                for arm in arms:
                    run = columns[arm]
                    t = run["turns"][i] if run and i < len(run["turns"]) else None
                    if t is None:
                        cells.append(f"{arm:<14}{'-':>22}")
                        continue
                    score = (t.get("judge") or {}).get("score")
                    st = t.get("stats") or {}
                    cells.append(f"{arm:<14}{fmt(score, 'd', '?'):>3}{st.get('cost_usd', 0):>9.4f}{st.get('llm_calls', 0):>4}")
                gold_turn = next((r["turns"][i] for r in columns.values() if r and i < len(r["turns"])), {})
                meta = f"{','.join(gold_turn.get('state_type') or []) or '-'} / {len(gold_turn.get('depends_tasks') or [])}"
                print(f"  t{i + 1:02}  " + "   ".join(cells) + f"   {meta}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
