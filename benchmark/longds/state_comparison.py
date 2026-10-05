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
"""Matched state-management experiments; freeze inputs before launching solvers.

Use the repository Python venv. Solver artifacts, judgments, retries and costs
are retained separately. No failed solver attempt is silently overwritten.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import gzip
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import random
import socket
import subprocess
import sys
import threading
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
MODEL = "gpt-5.6-luna"
# Same frozen fallback rates as systems/cost_utils.py, not a provider invoice.
RATES = {"input": .20, "cached": .02, "write": .25, "output": 1.20}
COMMON_SETTINGS = {
    "agentMode": "native", "contextMode": "delta", "messageLayout": "native",
    "multiTask": True, "nativeProfileCollection": True, "dataEvidence": True,
    "flowEvidence": False, "maxSteps": 40, "maxOperatorResultCharLimit": 2000,
    "maxResultRows": 0, "fullResultCharLimit": 5000, "dataEvidenceCharLimit": 2000,
    "flowEvidenceCharLimit": 2000, "catalogRecords": 0, "thoughtReplay": False,
    "enableCodeInSnapshot": True, "contextWindowTokens": 0,
    "parallelToolCalls": False, "stateHistory": False, "stateLedger": False,
    "retrievalViews": ["sample_stats", "full"],
}


def arm_settings(arm, views="stats", context_budget=0):
    if arm not in {"baseline", "history", "ledger", "sample", "stats"}:
        raise ValueError(f"Unknown dataflow arm: {arm}")
    settings = {**COMMON_SETTINGS, "retrievalViews": ["sample_stats" if views == "stats" else "sample", "full"],
                "stateHistory": arm in {"history", "ledger"}, "stateLedger": arm == "ledger",
                "contextWindowTokens": context_budget}
    if arm in {"sample", "stats"}:
        settings["retrievalViews"] = ["sample" if arm == "sample" else "sample_stats", "full"]
    return settings


def build_prompts(manifest):
    turns = manifest["turns"]
    if any(type(t["turn_id"]) is not int for t in turns) or [t["turn_id"] for t in turns] != list(range(1, len(turns) + 1)):
        raise ValueError("Turns must be unique, contiguous and start at one")
    first = (
        "You are an expert data scientist working through a long analysis with me. "
        "I will send requests one at a time about the same data.\n\n"
        "Data files available (use these paths verbatim; never modify input files):\n"
        + "\n".join(" - " + f for f in manifest["files"])
        + "\n\nYour analytical state persists across requests. Name reusable calculations and working tables "
        "meaningfully. Keep complete working tables separately from ranked answer selections. "
        "Preserve rules and historical results when later requests need them.\n"
        "Use code for every calculation. Do not use plotting libraries. Answer after checking the computed evidence. "
        "Return a single-line JSON object containing exactly the requested quantities, following the task's "
        "rounding and scale rules.\n\n"
    )
    return [{"turn_id": t["turn_id"], "prompt": (first if i == 0 else "") +
             f"[Task {t['turn_id']}]\n{t['context']}\nQuestion: {t['question']}"}
            for i, t in enumerate(turns)]


def make_jobs(tasks, arms, reps, phase="holdout", limit=None):
    if reps < 1:
        raise ValueError("Repetitions must be positive")
    jobs = [{"phase": phase, "task": task, "arm": arm, "rep": rep, "turn_limit": limit}
            for task in tasks for rep in range(1, reps + 1) for arm in arms]
    random.Random(103).shuffle(jobs)
    return jobs


def cost_of(stats):
    if any(stats.get(k) is None for k in ["input_tokens", "output_tokens", "cached_tokens"]):
        return None
    inp, out, cached = (stats[k] for k in ["input_tokens", "output_tokens", "cached_tokens"])
    written = stats.get("cache_write_tokens") or 0
    if min(inp, out, cached, written) < 0 or cached + written > inp:
        raise ValueError("Inconsistent provider token usage")
    return ((inp-cached-written)*RATES["input"] + cached*RATES["cached"] +
            written*RATES["write"] + out*RATES["output"])/1e6


def summarize(jobs, rows):
    summaries = {}
    for arm in sorted({j["arm"] for j in jobs}):
        selected = [r for r in rows if r["arm"] == arm]
        expected = sum(j["turns_total"] for j in jobs if j["arm"] == arm)
        judged = [r for r in selected if r.get("score") is not None]
        complete = len(judged) == len(selected) == expected
        summaries[arm] = {
            "expected_turns": expected, "observed_turns": len(selected), "judged_turns": len(judged),
            "missing_turns": expected-len(selected), "unjudged_turns": len(selected)-len(judged),
            "complete": complete, "correct": sum(r["score"] == 1 for r in judged),
            "accuracy": sum(r["score"] == 1 for r in judged)/expected if complete and expected else None,
            "cost_usd": sum((r.get("stats") or {}).get("cost_usd") or 0 for r in selected),
            "unknown_cost_turns": sum((r.get("stats") or {}).get("cost_usd") is None for r in selected),
        }
    return summaries


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    tmp.replace(path)


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def prepare(output, task, data_snapshot=None):
    from prepare import _norm_turn_ids
    from _paths import DATAMIND
    domain, dataset, tid = task.split("/")
    source = DATAMIND / "task/longds" / task
    data = DATAMIND / "data/longds" / task / "data"
    turns = json.loads((source / "task.json").read_text())
    meta = {m["turn"]: m for m in json.loads((source / "metadata.json").read_text())}
    key = task.replace("/", "__")
    folder = output / "prepared" / key
    files = (list(data_snapshot["files"]) if data_snapshot is not None else
             ["data/longds/" + task + "/data/" + str(p.relative_to(data))
              for p in sorted(data.rglob("*")) if p.is_file()])
    if not files:
        raise ValueError(f"No input data: {task}")
    manifest = {"key": key, "domain": domain, "dataset_name": dataset, "task_id": tid,
                "data_dir": data_snapshot["data_dir"] if data_snapshot is not None else "data/longds/" + task + "/data", "files": files,
                "turns": [{k: t[k] for k in ["turn_id", "context", "question"]} for t in turns]}
    gold = {"key": key, "turns": [{**t, "state_type": meta.get(t["turn_id"], {}).get("state_type", []),
            "depends_tasks": _norm_turn_ids(meta.get(t["turn_id"], {}).get("depends_tasks", [])),
            "depends_span": meta.get(t["turn_id"], {}).get("depends_span", [])}
            for t in turns]}
    # The reference code remains outside every solver prompt and kernel mount.
    for t in gold["turns"]:
        t.pop("code", None)
    save(folder / "manifest.json", manifest)
    save(folder / "gold.json", gold)
    save(folder / "prompts.json", build_prompts(manifest))
    return manifest


def select_tasks(phase, selection, gate_rows):
    if phase in {"holdout", "bounded"}:
        gates = {g["task"]: g for g in gate_rows}
        tasks = [r["task"] for r in selection["sessions"] if gates.get(r["task"], {}).get("exit_code") == 0]
    elif phase == "ablation":
        tasks = [selection["development_sessions"][0], selection["development_sessions"][-1]]
    elif phase == "controlled":
        tasks = ["synthetic/operator_history/task1"]
    else:
        tasks = selection["development_sessions"]
    return tasks


def freeze(args):
    output = args.output.resolve()
    target = output / args.phase / "manifest.json"
    if target.exists():
        raise FileExistsError(target)
    if args.phase == "bounded" and args.context_budget <= 0:
        raise ValueError("The bounded phase requires a positive context budget")
    if args.phase != "bounded" and args.context_budget != 0:
        raise ValueError("Keep context compaction in the separately labeled bounded phase")
    selection = json.loads((output / "selection.json").read_text())
    gate_rows = json.loads((output / "gates-engine.json").read_text())
    tasks = select_tasks(args.phase, selection, gate_rows)
    arms = ["sample", "stats"] if args.phase == "ablation" else ["dsgym", "baseline", "history"]
    if args.phase == "ledger":
        arms = ["history", "ledger"]
    prepared = {}
    for task in tasks:
        folder = output / "prepared" / task.replace("/", "__")
        prepared[task] = json.loads((folder / "manifest.json").read_text()) if folder.exists() else prepare(output, task)
    jobs = make_jobs(tasks, arms, args.reps, args.phase, 8 if args.phase == "ablation" else None)
    files = [HERE / n for n in ["state_comparison.py", "comparison_job.py", "comparison_capture.py",
                               "dsgym_agent.py", "dsgym_executor.py", "judge_longds.py", "numeric_gate.py"]]
    files += [ROOT / "agent-service/benchmark/multiturn/run-comparison-session.ts"]
    files += [ROOT / "agent-service/benchmark/multiturn/comparison-answer.ts"]
    files += [p for p in (ROOT / "agent-service/src").rglob("*") if p.is_file()
              and p.suffix in {".ts", ".md"} and not p.name.endswith(".test.ts")]
    files += [p for p in (HERE / "DataMind/longds/runners/DSGym/dsgym/agents").rglob("*.py")]
    files += [HERE / "DataMind/longds/runners/DSGym/scripts/prompt.py"]
    input_files = {name: {"bytes": (ROOT / name).stat().st_size,
                          "mtime_ns": (ROOT / name).stat().st_mtime_ns,
                          "sha256": digest(ROOT / name)}
                   for name in sorted({f for m in prepared.values() for f in m["files"]})}
    prepared_hashes = {t: {name: digest(output / "prepared" / t.replace("/", "__") / name)
                          for name in ["manifest.json", "gold.json", "prompts.json"]} for t in tasks}
    for j in jobs:
        j["turns_total"] = min(len(prepared[j["task"]]["turns"]), j["turn_limit"] or 10000)
        j["settings"] = None if j["arm"] == "dsgym" else arm_settings(j["arm"], args.views, args.context_budget)
    frozen = {"phase": args.phase, "created_at": datetime.now(timezone.utc).isoformat(), "model": MODEL,
              "reasoning_effort": "medium", "max_model_calls_per_turn": 40, "max_output_tokens_per_call": 8192,
              "context_budget": args.context_budget, "endpoint": args.endpoint, "api_base": args.api_base,
              "views": args.views, "rates_usd_per_million": RATES,
              "pricing_source": "benchmark/Kramabench/systems/cost_utils.py frozen fallback; estimates, not invoices",
              "repetitions": args.reps, "solver_attempt_policy": "All independent repetitions retained; no best-of or score-selected retries",
              "judge": "deepseek/deepseek-v4-pro", "judge_prompt_sha256": digest(HERE / "DataMind/longds/runners/DSGym/scripts/prompt.py"),
              "source_hashes": {str(f.relative_to(ROOT)): digest(f) for f in files},
              "prompt_hashes": {t: digest(output / "prepared" / t.replace("/", "__") / "prompts.json") for t in tasks},
              "prepared_hashes": prepared_hashes, "input_files": input_files,
              "runtime": {"python": sys.version, "executable": sys.executable,
                          "packages": {n: metadata.version(n) for n in ["numpy", "pandas", "scipy", "scikit-learn", "statsmodels", "ipykernel", "jupyter-client"]}},
              "jobs": jobs, "excluded_preflight_sessions": [r for r in selection["sessions"] if r["task"] not in tasks] if args.phase in {"holdout", "bounded"} else []}
    if not jobs:
        raise ValueError("No eligible sessions")
    for name, sha in frozen["source_hashes"].items():
        archive = target.parent / "source" / name
        archive.parent.mkdir(parents=True, exist_ok=True)
        with archive.open("xb") as stream:
            stream.write((ROOT / name).read_bytes())
        if digest(archive) != sha:
            raise RuntimeError(f"Source changed while freezing: {name}")
    save(target, frozen)
    print(f"Frozen {args.phase}: {len(tasks)} sessions, {len(jobs)} jobs, {sum(j['turns_total'] for j in jobs)} solver turns")


def verify_sources(protocol):
    for name, sha in protocol["source_hashes"].items():
        if digest(ROOT / name) != sha:
            raise RuntimeError(f"Frozen source changed: {name}")


def verify_inputs(protocol, task, prepared):
    if protocol.get("input_snapshot"):
        from input_snapshot import verify_snapshot
        verify_snapshot(protocol["input_snapshot"])
    for name, sha in protocol.get("prepared_hashes", {}).get(task, {}).items():
        if digest(prepared / name) != sha:
            raise RuntimeError(f"Frozen solver input changed: {task}/{name}")
    if digest(prepared / "prompts.json") != protocol["prompt_hashes"][task]:
        raise RuntimeError(f"Frozen prompts changed: {task}")
    manifest = json.loads((prepared / "manifest.json").read_text())
    for name in manifest["files"]:
        original = protocol.get("input_files", {}).get(name)
        if original:
            current = (ROOT / name).stat()
            if (current.st_size, current.st_mtime_ns) != (original["bytes"], original["mtime_ns"]):
                raise RuntimeError(f"Frozen data file changed: {name}")


def run(args):
    output = args.output.resolve()
    folder = output / args.phase
    protocol = json.loads((folder / "manifest.json").read_text())
    verify_sources(protocol)
    progress_path = folder / "progress.json"
    if progress_path.exists():
        raise FileExistsError("Campaign already launched; preserve attempts instead of rerunning")
    jobs = protocol["jobs"]
    progress = {"status": "running", "active": {}, "completed": [], "started_at": datetime.now(timezone.utc).isoformat()}
    save(progress_path, progress)
    lock = threading.Lock()

    def execute(job):
        verify_sources(protocol)
        verify_inputs(protocol, job["task"], output / "prepared" / job["task"].replace("/", "__"))
        key = f"{job['arm']}-r{job['rep']}/{job['task'].replace('/', '__')}"
        dest = folder / "runs" / key
        dest.mkdir(parents=True, exist_ok=False)
        save(dest / "job.json", job)
        log = dest / "runner.log"
        started = time.monotonic()
        with log.open("x") as stream:
            proc = subprocess.Popen([str(ROOT / ".venv/bin/python"), str(HERE / "comparison_job.py"),
                "--protocol", str(folder / "manifest.json"), "--prepared", str(output / "prepared" / job["task"].replace("/", "__")),
                "--output", str(dest)], env=dict(os.environ, PYTHONUNBUFFERED="1", OPENBLAS_NUM_THREADS="1", OMP_NUM_THREADS="1", MKL_NUM_THREADS="1"),
                cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT)
            with lock:
                progress["active"][key] = {"pid": proc.pid, "started_at": datetime.now(timezone.utc).isoformat()}
                save(progress_path, progress)
            code = proc.wait()
        row = {**job, "path": str(dest), "exit_code": code, "elapsed_seconds": round(time.monotonic()-started, 2)}
        with lock:
            progress["active"].pop(key, None)
            progress["completed"].append(row)
            save(progress_path, progress)
        print("DONE", key, code, row["elapsed_seconds"], flush=True)
        return row

    native = [j for j in jobs if j["arm"] != "dsgym"]
    script = [j for j in jobs if j["arm"] == "dsgym"]
    # Independent pools keep pending native jobs from occupying script slots.
    with ThreadPoolExecutor(max_workers=args.native_workers) as a, ThreadPoolExecutor(max_workers=args.script_workers) as b:
        futures = [a.submit(execute, j) for j in native] + [b.submit(execute, j) for j in script]
        for future in as_completed(futures):
            future.result()
    progress["status"] = "complete" if all(r["exit_code"] == 0 for r in progress["completed"]) else "completed_with_failures"
    save(progress_path, progress)


def analyze(args):
    folder = args.output.resolve() / args.phase
    protocol = json.loads((folder / "manifest.json").read_text())
    rows = []
    for job in protocol["jobs"]:
        dest = folder / "runs" / f"{job['arm']}-r{job['rep']}" / job["task"].replace("/", "__")
        source = dest / ("results_eval.json" if (dest / "results_eval.json").exists() else "results_with_ground_truth.json")
        if not source.exists():
            continue
        for turn in json.loads(source.read_text()):
            rows.append({**turn, "phase": args.phase, "task": job["task"], "arm": job["arm"], "rep": job["rep"],
                         "score": (turn.get("judge") or {}).get("score")})
    result = {"summary": summarize(protocol["jobs"], rows), "turns": rows}
    save(folder / "analysis.json", result)
    print(json.dumps(result["summary"], indent=2))


def main():
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env", override=False)
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("command", choices=["freeze", "run", "analyze"])
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--phase", choices=["ablation", "controlled", "development", "holdout", "bounded", "ledger"], required=True)
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--views", choices=["sample", "stats"], default="stats")
    ap.add_argument("--context-budget", type=int, default=0)
    ap.add_argument("--endpoint", default="http://localhost:3040")
    ap.add_argument("--api-base", default="http://localhost:34000/v1")
    ap.add_argument("--native-workers", type=int, default=2)
    ap.add_argument("--script-workers", type=int, default=2)
    args = ap.parse_args()
    {"freeze": freeze, "run": run, "analyze": analyze}[args.command](args)


if __name__ == "__main__":
    main()
