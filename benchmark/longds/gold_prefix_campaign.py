#!/usr/bin/env python3
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.

"""Gold-prefix campaign: every dependent turn, each arm, from reference state.

    run    launch the jobs (session x eligible turn x arm x model x rep) with a
           fixed concurrency; each job is one process (`run-gold-prefix.ts` for
           the dataflow arms, `gold_prefix_dsgym.py` for the script arm) and
           writes results_with_ground_truth.json; finished jobs are skipped.
    judge  score every unjudged job with the paper's judge (results_eval.json).
    report accuracy by arm, session and state label; token cost at frozen rates.

Run under the private stack's profile so the dataflow runner finds the engine
and the wire-capture directory; the repo `.env` supplies the gateway and judge
keys. Nothing here edits agent-service source while jobs are live.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
DSGYM_PYTHON = Path(os.environ.get(
    "LONGDS_DSGYM_PYTHON",
    str(HERE / ".dsgym-venv/bin/python"),
))
GOLD_STATE_ROOT = Path(os.environ.get("LONGDS_GOLD_STATE_ROOT", "/var/tmp/texera-gold-state-20261002"))
PREPARED_ROOT = Path(os.environ.get("LONGDS_PREPARED_ROOT", "/var/tmp/texera-state-history-20261001/prepared"))
SESSIONS = [
    "business__nyc_restaurants_data_food_ordering_and_delivery__task2",
    "social_good__data_science_for_good_kiva_crowdfunding__task1",
    "business__netflix_movies_and_tv_shows__task3",
    "community__kaggle-survey-2022__task2",
    "sports__nfl_big_data_bowl_2023__task1",
]
#: USD per token, the repository's frozen tables (history-verification-plan-20261002.json).
RATES = {
    "gpt-5.6-luna": {"input": 2e-07, "output": 1.2e-06, "cache_read": 2e-08, "cache_creation": 2.5e-07},
    "gpt-5.6-terra": {"input": 2e-06, "output": 1.2e-05, "cache_read": 2e-07, "cache_creation": 2.5e-06},
}
DATAFLOW_ARMS = {"baseline", "history", "ledger"}
LOCK = threading.Lock()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def job_dir(root: Path, model: str, arm: str, rep: int, session: str, turn: int) -> Path:
    return root / "runs" / f"{model}-{arm}-r{rep}" / session / f"t{turn:02d}"


def eligible_turns(session: str, selection: str) -> list[int]:
    index = json.loads((GOLD_STATE_ROOT / session / "prefix" / "index.json").read_text())
    turns = [t for t in index["turns"] if t["eligible"]]
    if selection == "dependent":
        turns = [t for t in turns if t["depends_tasks"]]
    elif selection != "all":
        wanted = {int(x) for x in selection.split(",")}
        turns = [t for t in turns if t["turn_id"] in wanted]
    return [t["turn_id"] for t in turns]


def run_job(root: Path, model: str, arm: str, rep: int, session: str, turn: int, log) -> dict:
    out = job_dir(root, model, arm, rep, session, turn)
    turn_dir = GOLD_STATE_ROOT / session / "prefix" / "turns" / f"t{turn:02d}"
    prepared = PREPARED_ROOT / session
    if (out / "results_with_ground_truth.json").exists():
        return {"job": str(out), "status": "done"}
    if out.exists():
        # A previous attempt died without a record; keep it for the postmortem.
        stamp = time.strftime("%Y%m%d-%H%M%S")
        out.rename(out.with_name(f"{out.name}.failed-{stamp}"))
    out.parent.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    started = time.monotonic()
    if arm in DATAFLOW_ARMS:
        env["TEXERA_AGENT_MODEL"] = model
        command = ["bun", "run", str(REPO / "agent-service/benchmark/multiturn/run-gold-prefix.ts"),
                   str(turn_dir), str(prepared), str(out), arm]
        cwd = REPO / "agent-service"
    else:
        rates = root / f"rates-{model}.json"
        if not rates.exists():
            rates.write_text(json.dumps(RATES[model]))
        command = [str(DSGYM_PYTHON), str(HERE / "gold_prefix_dsgym.py"), "--turn-dir", str(turn_dir),
                   "--prepared", str(prepared), "--out", str(out), "--model", model, "--rates", str(rates)]
        cwd = HERE
    out.parent.mkdir(parents=True, exist_ok=True)
    log_path = out.parent / f"{out.name}.log"
    with log_path.open("w") as stream:
        proc = subprocess.run(command, cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT, timeout=3600)
    record = {"job": str(out), "status": "ok" if proc.returncode == 0 else f"exit {proc.returncode}",
              "seconds": round(time.monotonic() - started, 1), "log": str(log_path)}
    with LOCK:
        log.write(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S"), **record}) + "\n")
        log.flush()
    print(json.dumps(record), flush=True)
    return record


def cmd_run(args) -> int:
    root = Path(args.root)
    root.mkdir(parents=True, exist_ok=True)
    models = args.models.split(",")
    arms = args.arms.split(",")
    sessions = args.sessions.split(",") if args.sessions else SESSIONS
    jobs = []
    for rep in range(1, args.reps + 1):
        for session in sessions:
            for turn in eligible_turns(session, args.turns):
                for model in models:
                    for arm in arms:
                        jobs.append((model, arm, rep, session, turn))
    if args.limit:
        jobs = jobs[: args.limit]
    manifest = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "protocol": "gold-prefix",
        "models": models, "arms": arms, "sessions": sessions, "turn_selection": args.turns, "reps": args.reps,
        "jobs": len(jobs), "concurrency": args.concurrency,
        "sources": {
            "agent-service/benchmark/multiturn/run-gold-prefix.ts": sha256(REPO / "agent-service/benchmark/multiturn/run-gold-prefix.ts"),
            "benchmark/longds/gold_prefix_dsgym.py": sha256(HERE / "gold_prefix_dsgym.py"),
            "benchmark/longds/dsgym_agent.py": sha256(HERE / "dsgym_agent.py"),
            "benchmark/longds/dsgym_executor.py": sha256(HERE / "dsgym_executor.py"),
            "benchmark/longds/gold_prefix.py": sha256(HERE / "gold_prefix.py"),
            "benchmark/longds/gold_state.py": sha256(HERE / "gold_state.py"),
        },
        "gold_state_root": str(GOLD_STATE_ROOT), "prepared_root": str(PREPARED_ROOT), "rates": RATES,
        "agent_service": os.environ.get("TEXERA_AGENT_SERVICE_ENDPOINT"),
        "engine": os.environ.get("WORKFLOW_EXECUTION_SERVICE_ENDPOINT"),
        "script_api_base": os.environ.get("LONGDS_SCRIPT_API_BASE", "http://localhost:34000/v1"),
        "git_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip(),
    }
    (root / f"campaign-{time.strftime('%Y%m%d-%H%M%S')}.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps({k: v for k, v in manifest.items() if k not in ("sources", "rates")}), flush=True)
    with (root / "jobs.jsonl").open("a") as log, ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = [pool.submit(run_job, root, *job, log) for job in jobs]
        for future in as_completed(futures):
            future.result()
    return 0


def judge_client(base_url: str | None = None, api_key_env: str = "OPENROUTER_API_KEY"):
    """The paper's judge (DeepSeek-V4-Pro) is reached through OpenRouter; the
    repo's JUDGE_* variables point at the local proxy and are not used here."""
    from openai import OpenAI

    base = base_url or os.environ.get("OPENROUTER_BASE_URL") or "https://openrouter.ai/api/v1"
    key = os.environ.get(api_key_env)
    if not key:
        raise SystemExit(f"{api_key_env} is required for the judge")
    return OpenAI(base_url=base, api_key=key)


def exact_match(turn: dict) -> bool | None:
    """The numeric gate: True when the solution equals the gold answer under
    the judge-equivalent normalization of `numeric_gate.diff` (same keys, same
    values, trailing zeros insignificant), False when it differs, None when
    either side does not parse. Exact answers need no judge call and get no
    judge noise."""
    import ast

    sys.path.insert(0, str(HERE))
    from numeric_gate import diff

    def parse(value):
        if isinstance(value, (dict, list)):
            return value
        text = str(value or "").strip()
        for loader in (json.loads, ast.literal_eval):
            try:
                return loader(text)
            except Exception:
                continue
        return None

    gold, got = parse(turn.get("ground_truth")), parse(turn.get("solution"))
    if gold is None or got is None or not isinstance(gold, (dict, list)):
        return None
    try:
        return not list(diff(gold, got)) and not list(diff(got, gold))
    except Exception:
        return None


def judge_turn(client, model: str, prompt: str, turn: dict, max_tokens: int, samples: int) -> dict:
    """The verdict of a turn: the numeric gate when the answer is exact;
    otherwise the judge, sampled until two verdicts agree (at most three
    calls), so a single inconsistent judgment does not decide a turn."""
    from judge_longds import judge_one

    if exact_match(turn) is True:
        return {"score": 1, "reasoning": "exact match with the gold answer (numeric gate)", "error_detail": "",
                "method": "numeric_gate", "model": model, "usage": [], "raw_responses": []}
    verdicts = []
    for _ in range(max(1, samples)):
        verdicts.append(judge_one(client, model, prompt, turn, 3, max_tokens))
        scores = [v["score"] for v in verdicts if v.get("score") is not None]
        if len(scores) >= 2 and scores.count(scores[-1]) >= 2:
            break
        if len(verdicts) >= 3:
            break
    scores = [v["score"] for v in verdicts if v.get("score") is not None]
    if not scores:
        return {**verdicts[-1], "method": "judge", "samples": verdicts}
    majority = 1 if scores.count(1) > scores.count(0) else 0 if scores.count(0) > scores.count(1) else scores[-1]
    chosen = next(v for v in verdicts if v.get("score") == majority)
    return {**chosen, "score": majority, "method": "judge", "samples": verdicts,
            "agreement": f"{scores.count(majority)}/{len(scores)}"}


def cmd_judge(args) -> int:
    sys.path.insert(0, str(HERE))
    from judge_longds import load_judge_prompt

    client = judge_client(args.judge_base_url, args.judge_api_key_env)
    prompt = load_judge_prompt()

    def unjudged(folder: Path) -> bool:
        path = folder / "results_eval.json"
        if args.overwrite or not path.exists():
            return True
        return any((t.get("judge") or {}).get("score") is None for t in json.loads(path.read_text()))

    pending = [p.parent for p in Path(args.root).glob("runs/*/*/t*/results_with_ground_truth.json") if unjudged(p.parent)]
    print(f"judging {len(pending)} jobs with {args.judge_model}", flush=True)

    def one(folder: Path):
        turns = json.loads((folder / "results_with_ground_truth.json").read_text())
        for turn in turns:
            turn["judge"] = judge_turn(client, args.judge_model, prompt, turn, args.max_tokens, args.samples)
        (folder / "results_eval.json").write_text(json.dumps(turns, indent=2, ensure_ascii=False))
        return folder, [f"{t['judge'].get('score')}:{t['judge'].get('method', '')[:1]}" for t in turns]

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for folder, scores in pool.map(one, pending):
            print(f"{folder.relative_to(args.root)}: {scores}", flush=True)
    return 0


def cost_of(record: dict, uniform: bool = False) -> float | None:
    """Solver cost at the frozen rates. `uniform` prices every token the same
    way for every arm: fresh input (prompt minus cached) at the input rate,
    cached input at the cached rate, output at the output rate, no cache-write
    surcharge. The default keeps the gateway's own write accounting, which
    only the script arm's gateway reports."""
    stats = record.get("stats") or {}
    model = record.get("model")
    if model not in RATES:
        return stats.get("cost_usd")
    r = RATES[model]
    cached = stats.get("cached_tokens") or 0
    writes = 0 if uniform else (stats.get("cache_write_tokens") or 0)
    fresh = max(0, (stats.get("input_tokens") or 0) - cached - writes)
    return (fresh * r["input"] + cached * r["cache_read"] + writes * r["cache_creation"]
            + (stats.get("output_tokens") or 0) * r["output"])


def cmd_report(args) -> int:
    root = Path(args.root)
    rows = []
    for path in sorted(root.glob("runs/*/*/t*/results_eval.json")):
        arm_dir = path.parents[2].name
        session = path.parents[1].name
        for record in json.loads(path.read_text()):
            score = (record.get("judge") or {}).get("score")
            rows.append({
                "arm": arm_dir, "session": session, "turn": record["turn_id"], "score": score,
                "labels": record.get("state_type") or [], "cost": cost_of(record), "uniform_cost": cost_of(record, uniform=True),
                "method": (record.get("judge") or {}).get("method"),
                "calls": (record.get("stats") or {}).get("llm_calls") or record.get("steps"),
                "output_tokens": (record.get("stats") or {}).get("output_tokens"),
                "answered": bool(record.get("solution")),
            })
    by_arm = defaultdict(list)
    for row in rows:
        by_arm[row["arm"]].append(row)
    judge_cost = 0.0
    for path in root.glob("runs/*/*/t*/results_eval.json"):
        for record in json.loads(path.read_text()):
            for usage in (record.get("judge") or {}).get("usage") or []:
                judge_cost += float((usage or {}).get("cost") or 0)
    print(f"judge spend recorded by the gateway: ${judge_cost:.4f}\n")
    summary = {"_judge_cost_usd": judge_cost}
    print(f"{'arm':34s} {'correct':>9s} {'unjudged':>8s} {'answered':>8s} {'cost $':>8s} {'uniform $':>9s} {'$/turn':>7s} {'calls/turn':>10s} {'out tok/turn':>12s} {'exact':>5s}")
    for arm, items in sorted(by_arm.items()):
        judged = [r for r in items if r["score"] is not None]
        correct = sum(1 for r in judged if r["score"] >= 1)
        cost = sum(r["cost"] or 0 for r in items)
        uniform = sum(r["uniform_cost"] or 0 for r in items)
        calls = sum(r["calls"] or 0 for r in items) / max(1, len(items))
        out = sum(r["output_tokens"] or 0 for r in items) / max(1, len(items))
        exact = sum(1 for r in items if r["method"] == "numeric_gate")
        print(f"{arm:34s} {correct:>4d}/{len(judged):<4d} {len(items) - len(judged):>8d} {sum(r['answered'] for r in items):>8d} {cost:>8.3f} {uniform:>9.3f} {uniform / max(1, len(items)):>7.4f} {calls:>10.2f} {out:>12.0f} {exact:>5d}")
        per_session = defaultdict(lambda: [0, 0])
        per_label = defaultdict(lambda: [0, 0])
        for r in judged:
            per_session[r["session"]][1] += 1
            per_session[r["session"]][0] += int(r["score"] >= 1)
            for label in r["labels"]:
                per_label[label][1] += 1
                per_label[label][0] += int(r["score"] >= 1)
        for session, (k, n) in sorted(per_session.items()):
            print(f"    {session[:60]:60s} {k:>3d}/{n:<3d}")
        print("    by label: " + "  ".join(f"{label} {k}/{n}" for label, (k, n) in sorted(per_label.items())))
        summary[arm] = {"correct": correct, "judged": len(judged), "jobs": len(items), "cost_usd": cost,
                        "uniform_cost_usd": uniform, "exact_matches": exact,
                        "by_session": {s: v for s, v in per_session.items()}, "by_label": {l: v for l, v in per_label.items()}}
    (root / "summary.json").write_text(json.dumps({"rows": rows, "summary": summary}, indent=1))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run")
    run.add_argument("--root", required=True)
    run.add_argument("--models", default="gpt-5.6-terra")
    run.add_argument("--arms", default="dsgym,baseline")
    run.add_argument("--sessions", default="")
    run.add_argument("--turns", default="dependent", help="dependent | all | comma-separated turn ids")
    run.add_argument("--reps", type=int, default=1)
    run.add_argument("--concurrency", type=int, default=2)
    run.add_argument("--limit", type=int, default=0, help="run only the first N jobs (smoke)")
    run.set_defaults(func=cmd_run)
    judge = sub.add_parser("judge")
    judge.add_argument("--root", required=True)
    judge.add_argument("--judge-model", default="deepseek/deepseek-v4-pro")
    judge.add_argument("--max-tokens", type=int, default=8192)
    judge.add_argument("--workers", type=int, default=4)
    judge.add_argument("--overwrite", action="store_true")
    judge.add_argument("--judge-base-url", default=None)
    judge.add_argument("--judge-api-key-env", default="OPENROUTER_API_KEY")
    judge.add_argument("--samples", type=int, default=2, help="judge samples per turn; a third decides a split (1 = single)")
    judge.set_defaults(func=cmd_judge)
    report = sub.add_parser("report")
    report.add_argument("--root", required=True)
    report.set_defaults(func=cmd_report)
    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
