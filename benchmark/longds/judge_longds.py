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

"""Score a LongDS run with upstream's own judge.

`JUDGE_PROMPT` is loaded BY PATH from the upstream DataMind clone rather than
copied, so an upstream edit cannot silently desync our scoring from theirs. Only
the endpoint and the judge model differ from the paper.

The paper's judge, `deepseek-v4-pro`, is reachable through OpenRouter:

    JUDGE_BASE_URL=https://openrouter.ai/api/v1 JUDGE_API_KEY=$OPENROUTER_API_KEY \
      python benchmark/longds/judge_longds.py --sut <SUT> --judge-model deepseek/deepseek-v4-pro

Use it for anything that will be compared to published numbers. The litellm default
(`gpt-5.2`) is the cheap local option; measured against deepseek-v4-pro on 41 turns
the two agree on 38 (92.7%, about the paper's own 93.11% human-vs-LLM agreement),
so it is a sound stand-in for arm-vs-arm work but not for absolute claims.

Both aggregations are reported. Upstream's shipped aggregator takes a
turn-weighted mean; the paper's eq. 2 macro-averages per task and then across
tasks. With 15-42 turns per task these differ, so neither is left implicit.

Usage:
    python benchmark/longds/judge_longds.py --sut LongDS_LongDSLunaDelta1k
    python benchmark/longds/judge_longds.py --sut ... --task <key> --overwrite
"""
import argparse
import importlib.util
import json
import os
import re
import statistics
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from _paths import UPSTREAM_PROMPT, SCRATCH

JUDGE_BASE_URL = os.environ.get("JUDGE_BASE_URL", "http://localhost:4000/v1")
JUDGE_API_KEY = os.environ.get("JUDGE_API_KEY", "sk-noauth")
DEFAULT_JUDGE_MODEL = "gpt-5.2"

SCORE_RE = re.compile(r"<score>\s*(\d)\s*</score>")
REASON_RE = re.compile(r"<reasoning>(.*?)</reasoning>", re.DOTALL)
ERROR_RE = re.compile(r"<error>(.*?)</error>", re.DOTALL)


def load_judge_prompt() -> str:
    if not UPSTREAM_PROMPT.exists():
        raise SystemExit(f"FATAL: upstream judge prompt not found at {UPSTREAM_PROMPT}")
    spec = importlib.util.spec_from_file_location("longds_upstream_prompt", UPSTREAM_PROMPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.JUDGE_PROMPT


def judge_one(client, model: str, prompt_tpl: str, turn: dict, retries: int = 3,
              max_tokens: int = 4000) -> dict:
    """One turn, binary. Upstream's own conventions preserved.

    An empty solution or gold scores 0 and still counts in the denominator
    (upstream does the same); an unparsable judge reply after `retries` scores
    None and is EXCLUDED from the mean, so judge failures cannot masquerade as
    model failures.
    """
    gold, solution = turn.get("ground_truth"), turn.get("solution")
    if not gold or not solution:
        return {"score": 0.0, "reasoning": "", "error_detail": "Empty solution or ground truth"}
    gold_str = (
        json.dumps(gold, ensure_ascii=False) if isinstance(gold, (dict, list)) else str(gold)
    )
    prompt = prompt_tpl.format(
        question=f"{turn['context']}\nQuestion: {turn['question']}",
        ground_truth=gold_str,
        solution=solution,
    )
    text = ""
    usage = []
    responses = []
    def recorded(verdict):
        return {**verdict, "model": model, "usage": usage, "raw_responses": responses}
    for _ in range(retries):
        try:
            # max_tokens is explicit because OpenRouter authorizes a request against
            # the account's remaining credit: with no purchased credits it rejects
            # (402) on the model's default ceiling long before any tokens are spent.
            # It also has to leave room for a reasoning model's hidden tokens, or the
            # reply gets truncated before the <score> tag.
            resp = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=max_tokens,
            )
            usage.append(resp.usage.model_dump() if resp.usage is not None else {})
            responses.append(resp.model_dump())
            text = resp.choices[0].message.content or ""
        except Exception as exc:  # noqa: BLE001
            return recorded({"score": None, "reasoning": "", "error_detail": f"judge call failed: {exc}"})
        m = SCORE_RE.search(text)
        if m and m.group(1) in ("0", "1"):
            return recorded({
                "score": int(m.group(1)),
                "reasoning": (REASON_RE.search(text).group(1).strip() if REASON_RE.search(text) else ""),
                "error_detail": (ERROR_RE.search(text).group(1).strip() if ERROR_RE.search(text) else ""),
            })
    return recorded({"score": None, "reasoning": "", "error_detail": "unparsable judge reply", "raw": text})


def judge_task(client, model: str, prompt_tpl: str, run_dir: Path, workers: int,
               max_tokens: int = 4000) -> list:
    turns = json.loads((run_dir / "results_with_ground_truth.json").read_text())
    results = [None] * len(turns)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(judge_one, client, model, prompt_tpl, t, 3, max_tokens): i for i, t in enumerate(turns)}
        for fut in as_completed(futures):
            results[futures[fut]] = fut.result()
    for turn, verdict in zip(turns, results):
        turn["judge"] = verdict
    (run_dir / "results_eval.json").write_text(json.dumps(turns, indent=2, ensure_ascii=False))
    return turns


def report(all_turns: list[list[dict]], judge_model: str = "") -> None:
    """Overall, by state pattern, by dependency breadth, by task progress."""
    flat = [t for task in all_turns for t in task]
    scored = [t for t in flat if t["judge"].get("score") is not None]
    print(f"\njudged {len(scored)}/{len(flat)} turns")
    if not scored:
        return

    turn_weighted = statistics.mean(t["judge"]["score"] for t in scored) * 100
    per_task = [
        statistics.mean(t["judge"]["score"] for t in task if t["judge"].get("score") is not None) * 100
        for task in all_turns
        if any(t["judge"].get("score") is not None for t in task)
    ]
    print(f"turn-weighted accuracy : {turn_weighted:.2f}   (upstream aggregator)")
    print(f"task-macro accuracy    : {statistics.mean(per_task):.2f}   (paper eq. 2)")

    def bucket(name: str, groups: dict) -> None:
        print(f"\nby {name}:")
        for key in sorted(groups, key=lambda k: (-len(groups[k]), str(k))):
            vals = groups[key]
            print(f"  {str(key):<18} n={len(vals):>4}  {statistics.mean(vals) * 100:>6.2f}")

    patterns: dict = {}
    for t in scored:
        for st in t.get("state_type") or ["(none)"]:
            patterns.setdefault(st, []).append(t["judge"]["score"])
    bucket("state-evolution pattern", patterns)

    breadth: dict = {}
    for t in scored:
        n = len(t.get("depends_tasks") or [])
        key = "0" if n == 0 else "1" if n == 1 else "2-3" if n <= 3 else "4+"
        breadth.setdefault(key, []).append(t["judge"]["score"])
    bucket("dependency breadth", breadth)

    progress: dict = {}
    for task in all_turns:
        n = len(task)
        for i, t in enumerate(task):
            if t["judge"].get("score") is None:
                continue
            key = f"{int(i / n * 4) * 25}-{int(i / n * 4) * 25 + 25}%"
            progress.setdefault(key, []).append(t["judge"]["score"])
    bucket("task progress", progress)

    if "deepseek-v4-pro" in judge_model:
        print("\nJudge is the paper's own model (deepseek-v4-pro), so these scores ARE")
        print("comparable to its published numbers — with the runtime caveat that the")
        print("agent builds a workflow instead of running DSGym's fixed ReAct loop.")
    else:
        print(f"\nNOTE: judge is {judge_model or 'not deepseek-v4-pro'}, not the paper's")
        print("deepseek-v4-pro, so absolute scores are not comparable to its published")
        print("numbers. Arm-vs-arm comparisons hold, with the judge held fixed.")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sut", required=True, help="e.g. LongDS_LongDSLunaDelta1k")
    ap.add_argument("--task", help="single prepared task key (default: every task under --sut)")
    ap.add_argument("--judge-model", default=DEFAULT_JUDGE_MODEL)
    ap.add_argument("--max-workers", type=int, default=8)
    ap.add_argument("--max-tokens", type=int, default=4000, help="judge reply cap; must leave room for a reasoning model's hidden tokens")
    ap.add_argument("--overwrite", action="store_true", help="re-judge tasks that already have results_eval.json")
    args = ap.parse_args()

    root = SCRATCH / args.sut
    if not root.exists():
        print(f"FATAL: {root} missing")
        return 2
    task_dirs = (
        [root / args.task]
        if args.task
        else sorted(d for d in root.iterdir() if (d / "results_with_ground_truth.json").exists())
    )
    if not task_dirs:
        print(f"FATAL: no runs with results_with_ground_truth.json under {root}")
        return 2

    from openai import OpenAI

    client = OpenAI(base_url=JUDGE_BASE_URL, api_key=JUDGE_API_KEY)
    prompt_tpl = load_judge_prompt()
    print(f"judge model: {args.judge_model} via {JUDGE_BASE_URL}")

    all_turns = []
    for d in task_dirs:
        eval_path = d / "results_eval.json"
        if eval_path.exists() and not args.overwrite:
            print(f"  {d.name}: already judged (use --overwrite to redo)")
            all_turns.append(json.loads(eval_path.read_text()))
            continue
        print(f"  {d.name}: judging...")
        all_turns.append(judge_task(client, args.judge_model, prompt_tpl, d, args.max_workers, args.max_tokens))

    report(all_turns, args.judge_model)
    return 0


if __name__ == "__main__":
    sys.exit(main())
