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

"""Whole Lite sessions solved by two off-the-shelf agents, to set beside the
dataflow and Python-catalog arms of `context_state_pilot.py`.

- `smolagents`: smolagents' `CodeAgent` as the KramaBench harness configures
  it, with its stock system prompt (`smolagents_session.py`).
- `dsgym`: the benchmark's own agent, upstream's `MultiTurnReActDSAgent` with
  its prompt and its <python>/<answer> protocol (`dsgym_agent.py`).

Both receive each request as the benchmark words it, `context` then
`Question: question`; the smolagents arm is also told once where the data is,
which the DSGym system prompt says for its agent. The `-shared` arms send the
task text the dataflow and Python-catalog arms receive instead
(`state_comparison.build_prompts`), and `smolagents-guided` adds KramaBench's
custom instructions to the stock prompt. One attempt per question; a session
that fails stops there and its remaining questions count as wrong.

    context_state_pilot.py prepare --root R --cases <domain/dataset/task> ...
    baseline_pilot.py run --root R --arms smolagents dsgym --models gpt-5.6-luna gpt-5.6-terra
    baseline_pilot.py judge --root R
    baseline_pilot.py report --root R
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import random
import subprocess
import threading
import time

from bounded_pilot import pilot_rates
from state_comparison import HERE, ROOT, port, save

ARMS = {
    "smolagents": {"agent": "smolagents", "task_text": "benchmark", "instructions": None},
    "smolagents-guided": {"agent": "smolagents", "task_text": "benchmark", "instructions": "kramabench"},
    "smolagents-shared": {"agent": "smolagents", "task_text": "shared", "instructions": None},
    "dsgym": {"agent": "dsgym", "task_text": "benchmark"},
    "dsgym-shared": {"agent": "dsgym", "task_text": "shared"},
}
JUDGE = {"model": "deepseek/deepseek-v4-pro", "endpoint": "https://openrouter.ai/api/v1"}


def short(model):
    return model.replace("gpt-5.6-", "")


def job_key(job):
    return "__".join((job["case"], short(job["model"]), job["arm"]))


def benchmark_text(manifest, turn):
    """The request as the benchmark words it. The first one also says where the
    data is, which the DSGym system prompt tells its own agent."""
    where = f"The data for these requests is in `{manifest['data_dir']}`.\n\n" if turn["turn_id"] == 1 else ""
    return f"{where}{turn['context']}\nQuestion: {turn['question']}"


class Spend:
    def __init__(self, limit):
        self.limit, self.total, self.lock = limit, 0.0, threading.Lock()

    def check(self):
        with self.lock:
            if self.total >= self.limit:
                raise RuntimeError(f"Spend limit of ${self.limit} reached")

    def add(self, cost):
        with self.lock:
            self.total += cost or 0.0


def smolagents_job(job, arm, prepared, output, protocol, spend):
    from smolagents_session import Session
    manifest = json.loads((prepared / "manifest.json").read_text())
    prompts = {p["turn_id"]: p["prompt"] for p in json.loads((prepared / "prompts.json").read_text())}
    session = Session(manifest, output, job["model"], api_base=protocol["gateway"] + "/v1",
                      api_key=os.environ["LITELLM_MASTER_KEY"], instructions=arm["instructions"],
                      max_steps=protocol["smolagents_max_steps"])
    records, error = [], None
    try:
        for turn in manifest["turns"]:
            spend.check()
            number = turn["turn_id"]
            text = prompts[number] if arm["task_text"] == "shared" else benchmark_text(manifest, turn)
            record = session.solve(number, text, output / f"t{number:02d}", protocol["rates_usd_per_million"][job["model"]])
            record.update(question=turn["question"], context=turn["context"])
            records.append(record)
            save(output / f"t{number:02d}" / "record.json", record)
            save(output / "records.json", records)
            spend.add(record["stats"]["cost_usd"])
            print(json.dumps({"job": job_key(job), "turn": number, "state": record["state"], "calls": record["stats"]["llm_calls"],
                              "input": record["stats"]["input_tokens"], "cost_usd": record["stats"]["cost_usd"]}), flush=True)
            if record["error"]:
                error = record["error"]
                break
    finally:
        session.close()
    return records, error


def dsgym_job(job, arm, prepared, output, protocol, spend):
    import requests
    from comparison_job import executor_command
    manifest = json.loads((prepared / "manifest.json").read_text())
    workspace = output / "kernel"
    workspace.mkdir()
    number = port()
    command = [str(HERE / ".dsgym-venv/bin/python"), str(HERE / "dsgym_agent.py"),
               "--manifest", str(prepared / "manifest.json"), "--gold", str(prepared / "gold.json"),
               "--model", job["model"], "--out", str(output / "agent"), "--executor-url", f"http://localhost:{number}",
               "--api-base", protocol["gateway"] + "/v1",
               "--token-rates", json.dumps(protocol["rates_usd_per_million"][job["model"]])]
    if arm["task_text"] == "shared":
        command += ["--prompts-file", str(prepared / "prompts.json")]
    spend.check()
    with (output / "executor.log").open("x") as manager_log, (output / "agent.log").open("x") as agent_log:
        manager = subprocess.Popen(executor_command(manifest, workspace, number), stdout=manager_log, stderr=subprocess.STDOUT)
        try:
            for _ in range(300):
                if manager.poll() is not None:
                    raise RuntimeError("Kernel manager exited during setup")
                try:
                    if requests.get(f"http://localhost:{number}/health", timeout=1).ok:
                        break
                except requests.RequestException:
                    pass
                time.sleep(.2)
            else:
                raise RuntimeError("Kernel manager did not become healthy")
            code = subprocess.call(command, stdout=agent_log, stderr=subprocess.STDOUT)
        finally:
            manager.terminate()
            try:
                manager.wait(timeout=15)
            except subprocess.TimeoutExpired:
                manager.kill()
    answers = output / "agent/answers.json"
    turns = {t["turn_id"]: t for t in manifest["turns"]}
    records = []
    for answer in json.loads(answers.read_text()) if answers.exists() else []:
        turn = turns[answer["turn_id"]]
        record = {"turn_id": answer["turn_id"], "question": turn["question"], "context": turn["context"],
                  "answer": answer["answer"] or "", "completed": bool(answer["answer"]), "error": answer.get("error"),
                  "steps": answer.get("steps"), "stats": answer["stats"], "model": job["model"], "policy": "dsgym"}
        records.append(record)
        save(output / f"t{answer['turn_id']:02d}" / "record.json", record)
        spend.add(answer["stats"].get("cost_usd"))
    save(output / "records.json", records)
    print(json.dumps({"job": job_key(job), "turns": len(records), "exit": code,
                      "cost_usd": sum(r["stats"].get("cost_usd") or 0 for r in records)}), flush=True)
    return records, None if code == 0 else f"dsgym_agent.py exited with {code}"


def run(root, arms, models, cases, concurrency, spend_limit, max_steps):
    folder = root / "baseline"
    available = sorted(p.parent.name for p in (root / "prepared").glob("*/manifest.json"))
    cases = [c.replace("/", "__") for c in cases] if cases else available
    missing = set(cases) - set(available)
    if missing:
        raise ValueError(f"Not prepared: {sorted(missing)}")
    if (folder / "protocol.json").exists():
        protocol = json.loads((folder / "protocol.json").read_text())
    else:
        import smolagents
        protocol = {
            "created_at": datetime.now(timezone.utc).isoformat(), "arms": ARMS, "judge": JUDGE,
            "gateway": os.environ.get("LITELLM_BASE_URL", "http://localhost:4000").rstrip("/"),
            "rates_usd_per_million": {}, "smolagents": smolagents.__version__, "smolagents_max_steps": max_steps,
            "dsgym_max_steps": 40, "attempts_per_question": 1,
            "source_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        }
    for model in models:
        protocol["rates_usd_per_million"].setdefault(model, pilot_rates(model))
    save(folder / "protocol.json", protocol)
    jobs = [{"case": case, "model": model, "arm": arm} for case in cases for model in models for arm in arms]
    random.Random(107).shuffle(jobs)
    spend = Spend(spend_limit)
    # Each session keeps its data in memory; two of one dataset at a time.
    turn_of = {case: threading.Semaphore(2) for case in cases}

    def one(job):
        with turn_of[job["case"]]:
            attempt(job)

    def attempt(job):
        output = folder / "runs" / job_key(job)
        if (output / "job.json").exists():
            return
        output.mkdir(parents=True, exist_ok=True)
        if any(output.iterdir()):
            raise RuntimeError(f"{output} holds an unfinished attempt; move it aside before running again")
        arm, prepared = ARMS[job["arm"]], root / "prepared" / job["case"]
        expected = len(json.loads((prepared / "manifest.json").read_text())["turns"])
        records, error, started = [], None, time.monotonic()
        try:
            records, error = (smolagents_job if arm["agent"] == "smolagents" else dsgym_job)(job, arm, prepared, output, protocol, spend)
        except Exception as failure:  # noqa: BLE001
            error = f"{type(failure).__name__}: {failure}"
        save(output / "job.json", {**job, "error": error, "attempted_questions": len(records), "expected_questions": expected,
                                   "seconds": round(time.monotonic() - started, 1)})
        print(json.dumps({"job": job_key(job), "done": len(records), "of": expected, "error": error}), flush=True)

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        list(pool.map(one, jobs))
    print(json.dumps({"spent_usd": round(spend.total, 2)}), flush=True)


def session_runs(root):
    folder = root / "baseline"
    for path in sorted((folder / "runs").glob("*/job.json")):
        job = json.loads(path.read_text())
        records = json.loads((path.parent / "records.json").read_text()) if (path.parent / "records.json").exists() else []
        yield job, path.parent, records


def judge(root, workers):
    from context_state_score import judge_record
    from judge_longds import load_judge_prompt
    folder = root / "baseline"
    protocol = json.loads((folder / "protocol.json").read_text())
    os.environ["JUDGE_BASE_URL"] = protocol["judge"]["endpoint"]
    prompt = load_judge_prompt()
    items = []
    for job, run_folder, records in session_runs(root):
        gold = json.loads((root / "prepared" / job["case"] / "gold.json").read_text())
        items += [(run_folder / f"t{record['turn_id']:02d}", record, gold) for record in records]
    with ThreadPoolExecutor(max_workers=workers) as pool:
        verdicts = list(pool.map(lambda item: judge_record(folder, item[0], item[1], item[2], protocol, prompt), items))
    print(json.dumps({"answers": len(items), "judged": sum(v.get("score") is not None for v in verdicts),
                      "correct": sum(str(v.get("score")) == "1" for v in verdicts)}), flush=True)


def report(root):
    rows = {}
    for job, run_folder, records in session_runs(root):
        row = rows.setdefault((job["arm"], job["model"]), {"sessions": {}, "expected": 0, "attempted": 0, "correct": 0, "judged": 0,
                                                              "cost": 0.0, "calls": 0, "input": 0, "cached": 0, "output": 0, "errors": []})
        correct = 0
        for record in records:
            verdict_file = run_folder / f"t{record['turn_id']:02d}" / "judge.json"
            verdict = json.loads(verdict_file.read_text()) if verdict_file.exists() else {}
            row["judged"] += verdict.get("score") is not None
            correct += str(verdict.get("score")) == "1"
            stats = record["stats"]
            row["cost"] += stats.get("cost_usd") or 0
            row["calls"] += stats.get("llm_calls") or 0
            row["input"] += stats.get("input_tokens") or 0
            row["cached"] += stats.get("cached_tokens") or 0
            row["output"] += stats.get("output_tokens") or 0
        row["sessions"][job["case"].split("__")[1][:18]] = f"{correct}/{job['expected_questions']}"
        row["expected"] += job["expected_questions"]
        row["attempted"] += len(records)
        row["correct"] += correct
        if job["error"]:
            row["errors"].append(f"{job['case'].split('__')[1][:18]}: {job['error'][:120]}")
    for (arm, model), row in sorted(rows.items()):
        calls = max(row["calls"], 1)
        print(f"{arm} {short(model)}: correct {row['correct']}/{row['expected']} ({row['correct'] / max(row['expected'], 1):.1%}), "
              f"attempted {row['attempted']}, judged {row['judged']}, cost ${row['cost']:.2f}, calls {row['calls']}, "
              f"input/call {row['input'] / calls:,.0f}, cached {row['cached'] / max(row['input'], 1):.1%}, "
              f"output/question {row['output'] / max(row['attempted'], 1):,.0f}")
        print("   " + ", ".join(f"{name} {score}" for name, score in row["sessions"].items()))
        for error in row["errors"]:
            print("   stopped: " + error)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["run", "judge", "report"])
    ap.add_argument("--root", type=Path, required=True)
    ap.add_argument("--arms", nargs="+", choices=sorted(ARMS), default=["smolagents", "dsgym"])
    ap.add_argument("--models", nargs="+", default=["gpt-5.6-luna", "gpt-5.6-terra"])
    ap.add_argument("--cases", nargs="*", help="domain/dataset/task; default: every prepared session")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--spend-limit", type=float, default=30.0)
    ap.add_argument("--smolagents-max-steps", type=int, help="default: smolagents' own (20 a request)")
    ap.add_argument("--judge-workers", type=int, default=6)
    args = ap.parse_args()
    if args.command == "run":
        run(args.root.resolve(), args.arms, args.models, args.cases, args.concurrency, args.spend_limit, args.smolagents_max_steps)
    elif args.command == "judge":
        judge(args.root.resolve(), args.judge_workers)
    else:
        report(args.root.resolve())
