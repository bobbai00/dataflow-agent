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
"""KramaBench round for the script-agent baselines: plain smolagents and DSGym.

Both agents write Python against the task's files and get the same model,
step limit and output limit. Every task runs once per system in its own
process, sandboxed on the task's input directory, and is scored by the
unchanged official evaluator. One queue limits large-input tasks across both
systems; attempts are never retried or overwritten. Use the KramaBench venv.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import random
import shutil
import subprocess
import sys
import threading
import time

from campaign import ResourceQueue, install_provider_prices, prepare_artifacts
from catalog import inventory
from run import KB, MODEL_TYPES, ROOT, save
from run_comparison import audit_script
from attempt_runtime import supervise_adapter, record_adapter_metrics, validate_resource_scope, record_provider_block

SYSTEMS = {
    "smolagents": {"prefix": "CodeAgentSystem", "adapter": "evaluate_script_task.py"},
    "dsgym": {"prefix": "DSGymSystem", "adapter": "evaluate_dsgym_task.py"},
}


def revision(repository):
    """HEAD, marked when the working tree has changes the commit does not hold."""

    def git(*command):
        return subprocess.check_output(["git", "-C", str(repository), *command], text=True).strip()

    return git("rev-parse", "HEAD") + ("+dirty" if git("status", "--porcelain") else "")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--script-endpoint", default="http://localhost:18000/v1", help="OpenAI-compatible model gateway"
    )
    parser.add_argument("--model", default="Luna", help="Known model name or arbitrary exact gateway model ID")
    parser.add_argument("--model-facts", type=Path, help="Frozen exact model capability/pricing facts")
    parser.add_argument(
        "--resource-scope",
        type=Path,
        help="Optional owned service/component scope; shared components require serial workers",
    )
    parser.add_argument("--systems", nargs="+", choices=list(SYSTEMS), default=list(SYSTEMS))
    parser.add_argument("--max-steps", type=int, default=25)
    parser.add_argument("--output-chars", type=int, default=5000, help="Characters of execution output shown per step")
    parser.add_argument(
        "--execution-timeout",
        type=int,
        default=600,
        help="Seconds one DSGym execution may run; smolagents has no such limit",
    )
    parser.add_argument("--dsgym-home", type=Path, default=ROOT / "benchmark/DSGym")
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--large-input-bytes", type=int, default=100_000_000)
    parser.add_argument("--large-workers", type=int, default=1)
    parser.add_argument("--timeout", type=int, default=1200, help="Wall-clock seconds per task")
    parser.add_argument("--all-tasks", action="store_true", help="All original top-level KramaBench tasks")
    parser.add_argument("--tasks", nargs="+", default=[])
    args = parser.parse_args()
    resource_scope = json.loads(args.resource_scope.read_text()) if args.resource_scope else {}
    validate_resource_scope(resource_scope)
    if resource_scope and args.workers != 1:
        parser.error("An owned shared resource scope requires --workers 1 for attributable measurements")
    if (
        min(
            args.workers,
            args.large_workers,
            args.repetitions,
            args.timeout,
            args.execution_timeout,
            args.max_steps,
            args.output_chars,
        )
        < 1
    ):
        parser.error("Workers, repetitions, limits and timeouts must be positive")
    if len(set(args.systems)) != len(args.systems):
        parser.error("Give distinct --systems; each task must run once per system and repetition")
    sources = inventory()
    if args.all_tasks:
        args.tasks = sorted(t["task_id"] for t in sources)
        assert len(args.tasks) == 104
    if (
        not args.tasks
        or len(set(args.tasks)) != len(args.tasks)
        or not set(args.tasks) <= {t["task_id"] for t in sources}
    ):
        parser.error("Give --all-tasks or distinct known --tasks")
    output = args.output.resolve()
    if output.exists():
        parser.error("Refusing to overwrite existing output")
    for path in [ROOT / ".env", KB / ".env"]:
        if path.exists():
            for line in path.read_text().splitlines():
                line = line.removeprefix("export ").strip()
                if "=" in line and not line.startswith("#"):
                    key, value = line.split("=", 1)
                    os.environ.setdefault(key.strip(), value.strip().strip("\"'"))
    assert os.environ.get("OPENAI_API_KEY") not in [None, "", "dummy"], "Scorer key is required"
    assert os.environ.get("LITELLM_MASTER_KEY") or os.environ.get("CODE_AGENT_API_KEY"), "Gateway key is required"
    sys.path.insert(0, str(KB))
    # kb installs signal handlers, so import it in the main thread.
    import kb
    import requests
    from systems import cost_utils

    model = MODEL_TYPES.get(args.model, args.model)
    model_fact = None
    if args.model_facts:
        facts = json.loads(args.model_facts.read_text())
        rows = facts["models"] if isinstance(facts, dict) else facts
        model_fact = next(row for row in rows if args.model in {row["requested_model"], row["native_model_id"]})
        model = model_fact["native_model_id"]
        if type(model_fact.get("available")) is not bool:
            parser.error("Frozen model facts must include a boolean provider-access result")
    dsgym_home = args.dsgym_home.resolve()
    tag = output.name.replace("-", "_")
    model_tag = "".join(character if character.isalnum() else "_" for character in args.model)
    jobs = []
    for rep in range(1, args.repetitions + 1):
        round_jobs = [
            {
                "model": args.model,
                "arm": name,
                "task": task,
                "rep": rep,
                "sut": f"{SYSTEMS[name]['prefix']}{model_tag}_{tag}_{name}_Rep{rep}",
            }
            for name in args.systems
            for task in args.tasks
        ]
        random.Random(103 + rep).shuffle(round_jobs)
        jobs.extend(round_jobs)
    manifest = {
        "runner_revision": revision(ROOT),
        "harness_revision": revision(KB),
        "script_endpoint": args.script_endpoint,
        "models": {args.model: model},
        "pricing_overrides": install_provider_prices(cost_utils, [model]),
        "price_schedule": cost_utils.price_schedule(model),
        "model_fact": model_fact,
        "resource_scope": resource_scope,
        "task_ids": args.tasks,
        "repetitions": args.repetitions,
        "script_settings": {
            "max_steps": args.max_steps,
            "max_print_outputs_length": args.output_chars,
            "use_custom_prompt": False,
            "use_fine_grained_prompt": False,
            "use_pitfalls_prompt": False,
            "no_action_detail": False,
            "final_answer_tool_prompt": True,
        },
        "dsgym_settings": {"max_turns": args.max_steps, "max_output_length": args.output_chars},
        "dsgym_execution_timeout": args.execution_timeout,
        "selection": ("All 104 original top-level KramaBench tasks" if args.all_tasks else "Selected tasks")
        + "; each system once per repetition; no task exclusions or outcome-selected retries.",
        "attempt_policy": "One attempt per task and system; no recovery rounds or best-of selection.",
        "isolation": "bubblewrap: the task's input directory read-only at its relative path, a private working "
        "directory, no network. smolagents runs whole in the sandbox and reaches the gateway through "
        "a Unix socket; DSGym's agent loop runs outside and its Jupyter kernel inside.",
        "pass_threshold": 1.0,
        "workers": args.workers,
        "large_workers": args.large_workers,
        "large_input_bytes": args.large_input_bytes,
        "task_timeout_seconds": args.timeout,
        "workspaces": str(output / "workspaces"),
        "input_inventory": sources,
        "jobs": jobs,
    }
    if "dsgym" in args.systems:
        manifest.update(
            {
                "dsgym_revision": revision(dsgym_home),
                "dsgym_home": str(dsgym_home),
                "dsgym_packages": subprocess.check_output(
                    ["uv", "pip", "freeze", "--python", str(dsgym_home / ".venv/bin/python")], text=True
                ).split(),
            }
        )
    output.mkdir(parents=True)
    save(output / "manifest.json", manifest)
    prepare_artifacts(KB / "system_scratch", output / "system_scratch", [j["sut"] for j in jobs])
    os.chdir(KB)
    pending = ResourceQueue(
        jobs, {t["task_id"] for t in sources if t["bytes"] >= args.large_input_bytes}, args.large_workers
    )
    lock = threading.Lock()
    progress = {
        "started_at": datetime.now(timezone.utc).isoformat(),
        "status": "running",
        "active": {},
        "completed": [],
        "worker_errors": [],
        "waiting": {},
    }
    save(output / "progress.json", progress)
    gateway = args.script_endpoint.removesuffix("/v1")

    def ready(slot):
        """Pause launches during outages or integrity investigations; keep attempts intact."""
        while True:
            problem = None
            try:
                if (output / "PAUSE").exists():
                    raise RuntimeError((output / "PAUSE").read_text()[:300])
                if shutil.disk_usage(output).free < 5_000_000_000:
                    raise RuntimeError("Artifact disk is low on space")
                requests.get(gateway + "/health/liveliness", timeout=5).raise_for_status()
            except Exception as exc:
                problem = f"{type(exc).__name__}: {exc}"
            with lock:
                if problem:
                    progress["waiting"][slot] = problem
                else:
                    progress["waiting"].pop(slot, None)
                save(output / "progress.json", progress)
            if problem is None:
                return
            print("WAIT", slot, problem, flush=True)
            time.sleep(15)

    def execute(job, slot):
        path = output / "system_scratch" / job["sut"] / job["task"]
        if model_fact and not model_fact["available"]:
            row = {**job, **record_provider_block(path, fact=model_fact, task_id=job["task"], system=job["arm"])}
            with lock:
                progress["completed"].append(row)
                save(output / "progress.json", progress)
            return
        ready(slot)
        log = output / "logs" / f"{job['sut']}-{job['task']}.log"
        log.parent.mkdir(exist_ok=True)
        env = dict(
            os.environ,
            RETRIEVAL_MANIFEST=str(output / "manifest.json"),
            RETRIEVAL_JOB=json.dumps(job),
            PYTHONUNBUFFERED="1",
        )
        with lock:
            progress["active"][slot] = {**job, "started_at": datetime.now(timezone.utc).isoformat()}
            save(output / "progress.json", progress)
        print("START", job, flush=True)
        supervised = supervise_adapter(
            [
                sys.executable,
                str(Path(__file__).with_name(SYSTEMS[job["arm"]]["adapter"])),
                "--sut",
                job["sut"],
                "--workload",
                kb.workload_of(job["task"]),
                "--task_id",
                job["task"],
                "--use_truth_subset",
                "--no_pipeline_eval",
                "--verbose",
            ],
            directory=path,
            stdout_path=log,
            cwd=KB,
            env=env,
            timeout_seconds=args.timeout,
            system=job["arm"],
            resource_scope=resource_scope,
            terminate_grace_seconds=90,
        )
        evaluation = json.loads((path / "evaluation.json").read_text()) if (path / "evaluation.json").exists() else {}
        stats = json.loads((path / "stats.json").read_text()) if (path / "stats.json").exists() else {}
        scores = [float(evaluation[k]) for k in kb.SCORE_METRICS if evaluation.get(k) is not None]
        checks = audit_script(path)
        metrics = record_adapter_metrics(
            path,
            supervised,
            system=job["arm"],
            model=model,
            task_id=job["task"],
            pricing=model_fact.get("pricing") if model_fact else manifest["price_schedule"],
            resource_scope=resource_scope,
        )
        save(path / "attempt-audit.json", checks)
        row = {
            **job,
            "exit_code": supervised.returncode,
            "timeout": supervised.timed_out,
            "score": max(scores) if scores else None,
            "cost_usd": metrics["cost"]["total_usd"],
            "steps": stats.get("num_steps"),
            "seconds": supervised.wall_seconds,
            "normalized_metrics": metrics,
            "audit": checks,
        }
        with lock:
            progress["completed"].append(row)
            progress["active"].pop(slot, None)
            save(output / "progress.json", progress)
        if checks["violations"]:
            (output / "PAUSE").write_text(f"Integrity check requires investigation: {job}: {checks['violations']}\n")
        print("DONE", row, flush=True)

    def worker(slot):
        while True:
            job = pending.get()
            if job is None:
                return
            try:
                execute(job, slot)
            finally:
                pending.done(job)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for future in as_completed([pool.submit(worker, slot) for slot in range(args.workers)]):
            try:
                future.result()
            except Exception as exc:
                with lock:
                    progress["worker_errors"].append(str(exc))
                    save(output / "progress.json", progress)
                (output / "PAUSE").write_text(f"Worker error requires investigation: {exc}\n")
    progress["status"] = "complete" if len(progress["completed"]) == len(jobs) else "incomplete"
    progress["finished_at"] = datetime.now(timezone.utc).isoformat()
    save(output / "progress.json", progress)
    print(progress["status"], len(progress["completed"]), "/", len(jobs), flush=True)


if __name__ == "__main__":
    main()
