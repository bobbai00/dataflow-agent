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
"""Matched KramaBench campaign: retrieval crossed with flow evidence.

Run with benchmark/Kramabench/.venv/bin/python. Records every attempt, including
errors, and never overwrites a run. Uses the benchmark's official evaluator.
"""
import argparse
import hashlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import random
import shutil
import socket
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit

from campaign import ResourceQueue, audit_attempt, prepare_artifacts, install_provider_prices
from catalog import inventory
from configuration import campaign_arms, full_result_char_limit
from metrics import current_price_schedule, reconcile_run

ROOT = Path(__file__).resolve().parents[2]
KB = ROOT / "benchmark/Kramabench"
MODEL_TYPES = {"Luna": "gpt-5.6-luna", "Terra": "gpt-5.6-terra", "Sol": "gpt-5.6-sol",
               "Opus48": "claude-opus-4.8", "Qwen38_27B": "qwen3.8-27b", "DeepSeek41Flash": "deepseek-v4.1-flash",
               "Haiku45": "claude-haiku-4.5", "Sonnet55": "claude-sonnet-5.5"}


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str) + "\n")
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--endpoint", default="http://localhost:3075")
    parser.add_argument("--agent-revision", help="Revision served by the frozen agent; defaults to this checkout")
    parser.add_argument("--engine-revision", help="Revision built into the running backend; record independently of the agent")
    parser.add_argument("--repetitions", type=int, default=2)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--all-tasks", action="store_true", help="All original top-level KramaBench tasks")
    parser.add_argument("--direct-artifacts", action="store_true", help="Write harness scratch directly into output using symlinks")
    parser.add_argument("--wire-dir", type=Path, help="Agent TEXERA_LLM_TRACE_DIR for exact usage and latency auditing")
    parser.add_argument("--large-input-bytes", type=int, default=100_000_000)
    parser.add_argument("--large-workers", type=int, default=1)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--driver", choices=["vercel-tool-use", "text-turn", "turn-tool"], default="vercel-tool-use",
                        help="Agent transport: JSON tool calls, or text turns (native/turn-syntax.ts)")
    parser.add_argument("--full-result-char-limit", type=full_result_char_limit, default=5000,
                        help="Full retrieval display cap, 128..100000 characters (service default: 5000; the 2026-10-08 pilots used 100000)")
    parser.add_argument("--sample-char-limit", type=int, default=1000,
                        help="Record budget per retrieved sample/sample_stats result, characters (service default: 2000)")
    parser.add_argument("--selection", default="Diagnostic pilot selected before runs for large tables, parsing, joins and known sampling mistakes; not a representative full-benchmark estimate.")
    parser.add_argument("--source-manifest", type=Path, help="Frozen input inventory and task-selection rationale")
    parser.add_argument("--tasks", nargs="+", default=["archeology-easy-6", "astronomy-easy-1",
                        "biomedical-hard-3", "environment-hard-9", "legal-easy-25", "legal-hard-30"])
    parser.add_argument("--models", nargs="+", choices=list(MODEL_TYPES), default=["Luna", "Terra"])
    parser.add_argument("--arms", nargs="+", default=[f"{view}_flow{flow}" for view in
                        ["full", "sample", "sample_stats", "adaptive"] for flow in [0, 1]])
    args = parser.parse_args()
    if min(args.workers, args.large_workers, args.repetitions, args.timeout) < 1:
        parser.error("Workers, repetitions and timeout must be positive")
    arms = campaign_arms()
    unknown = sorted(set(args.arms) - set(arms))
    if unknown:
        parser.error(f"Unknown arms: {', '.join(unknown)}")
    source_inventory = inventory()
    if args.all_tasks:
        args.tasks = sorted(t["task_id"] for t in source_inventory)
        args.selection = "All 104 original KramaBench top-level tasks; no task exclusions or outcome-selected retries."
        assert len(args.tasks) == 104
    assert len(set(args.tasks)) == len(args.tasks), "Duplicate task IDs"
    assert set(args.tasks) <= {t["task_id"] for t in source_inventory}, "Unknown task IDs"
    output = args.output.resolve()
    if args.source_manifest:
        args.source_manifest = args.source_manifest.resolve()
    if output.exists():
        raise SystemExit(f"Refusing to overwrite {output}")
    for path in [ROOT / ".env", KB / ".env"]:
        if path.exists():
            for line in path.read_text().splitlines():
                line = line.removeprefix("export ").strip()
                if "=" in line and not line.startswith("#"):
                    key, value = line.split("=", 1)
                    os.environ.setdefault(key.strip(), value.strip().strip("\"'"))
    assert os.environ.get("OPENAI_API_KEY") not in [None, "", "dummy"], "Scorer key is required"
    os.environ.setdefault("TEXERA_API_ENDPOINT", "http://localhost:8080")
    os.environ.setdefault("TEXERA_COMPUTING_UNIT_ENDPOINT", "http://localhost:8888")
    os.environ.setdefault("TEXERA_WORKFLOW_EXECUTION_ENDPOINT", "http://localhost:8085")
    os.environ["KB_EMPTY_TURN_RETRIES"] = "0"
    sys.path.insert(0, str(KB))
    import requests
    from dataflow_agent import login
    # kb installs signal handlers, so import it in the main thread.
    import kb
    from systems import cost_utils
    pricing_overrides = install_provider_prices(cost_utils, [MODEL_TYPES[m] for m in args.models])
    source_hash = hashlib.sha256()
    source_paths = subprocess.check_output(["git", "-C", str(ROOT), "ls-files", "-co", "--exclude-standard", "--",
        "agent-service/src", "amber/src", "benchmark/retrieval", "bin/strict_tools.py"], text=True).splitlines()
    source_files = []
    for name in sorted(set(source_paths)):
        source = ROOT / name
        if source.is_file():
            source_hash.update(name.encode() + b"\0" + source.read_bytes() + b"\0")
            source_files.append({"path": name, "sha256": hashlib.sha256(source.read_bytes()).hexdigest()})
    os.chdir(KB)
    output.mkdir(parents=True)
    save(output / "source-snapshot.json", {"captured_at": datetime.now(timezone.utc).isoformat(),
         "sha256": source_hash.hexdigest(), "matches_launch_manifest": True, "files": source_files})
    tag = output.name.replace("-", "_")
    manifest = {
        "agent_revision": args.agent_revision or subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip(),
        "engine_revision": args.engine_revision,
        "runner_revision": subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip(),
        "harness_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
        "endpoint": args.endpoint, "task_ids": args.tasks, "repetitions": args.repetitions,
        "models": {m: MODEL_TYPES[m] for m in args.models},
        "pricing_overrides": pricing_overrides,
        "pricing_schedules": {MODEL_TYPES[m]: current_price_schedule(MODEL_TYPES[m]) or cost_utils.price_schedule(MODEL_TYPES[m]) for m in args.models},
        "wire_directory": str(args.wire_dir.resolve()) if args.wire_dir else None,
        "working_tree_diff_sha256": hashlib.sha256(subprocess.check_output(
            ["git", "-C", str(ROOT), "diff", "--no-ext-diff", "--", "agent-service", "amber", "benchmark/retrieval", "bin"])).hexdigest(),
        "working_tree_sources_sha256": source_hash.hexdigest(),
        "driver": args.driver, "arms": {k: arms[k] for k in args.arms}, "pass_threshold": 1.0,
        "settings": {"agentMode": "native", "contextMode": "delta", "nativeProfileCollection": True,
                     "maxSteps": 25, "maxOperatorResultCharLimit": args.sample_char_limit, "maxResultRows": 5,
                     "fullResultCharLimit": args.full_result_char_limit, "dataEvidenceCharLimit": 2000, "flowEvidenceCharLimit": 2000,
                     "thoughtReplay": False, "enableCodeInSnapshot": False},
        "selection": args.selection,
        "attempt_policy": "Independent repetitions of every selected task in every arm; no outcome-selected retries.",
        "task_timeout_seconds": args.timeout, "workers": args.workers,
        "input_inventory": source_inventory,
        "large_input_bytes": args.large_input_bytes, "large_workers": args.large_workers,
        "direct_artifacts": args.direct_artifacts,
    }
    if args.source_manifest:
        manifest["source_inventory"] = json.loads(args.source_manifest.resolve().read_text())
    jobs = []
    for rep in range(1, args.repetitions + 1):
        round_jobs = [{"model": model, "arm": arm, "task": task, "rep": rep,
                       "sut": f"DataflowSystem{model}_{tag}_{arm}_Rep{rep}"}
                      for model in args.models for arm in args.arms for task in args.tasks]
        random.Random(101 + rep).shuffle(round_jobs)
        jobs.extend(round_jobs)
    for name in {j["sut"] for j in jobs}:
        assert not (KB / "system_scratch" / name).exists(), f"Would overwrite {name}"
    manifest["jobs"] = jobs
    save(output / "manifest.json", manifest)
    if args.direct_artifacts:
        prepare_artifacts(KB / "system_scratch", output / "system_scratch", [j["sut"] for j in jobs])
    large_tasks = {t["task_id"] for t in source_inventory if t["bytes"] >= args.large_input_bytes}
    pending = ResourceQueue(jobs, large_tasks, args.large_workers)
    lock = threading.Lock()
    launch_lock = threading.Lock()
    progress = {"started_at": datetime.now(timezone.utc).isoformat(), "status": "running", "active": {}, "completed": [], "worker_errors": [], "waiting": {}}
    save(output / "progress.json", progress)
    stop_monitor = threading.Event()

    def monitor_resources():
        """Observe the host without collecting process arguments or credentials."""
        try:
            import psutil
        except ImportError:
            psutil = None
        while True:
            with lock:
                sample = {"at": datetime.now(timezone.utc).isoformat(), "active_attempts": len(progress["active"]),
                          "load_average": list(os.getloadavg()), "logical_cpus": os.cpu_count(),
                          "artifact_disk_free_bytes": shutil.disk_usage(output).free}
            if psutil:
                try:
                    memory = psutil.virtual_memory()
                    sample.update(memory_total_bytes=memory.total, memory_available_bytes=memory.available,
                                  memory_percent_used=memory.percent)
                    sample["swap_used_bytes"] = psutil.swap_memory().used
                except (OSError, PermissionError):
                    sample["memory_metrics_restricted"] = True
            if sys.platform == "darwin":
                try:
                    pressure = subprocess.check_output(["/usr/bin/memory_pressure", "-Q"], text=True, timeout=3)
                    line = next(line for line in pressure.splitlines() if "System-wide memory free percentage:" in line)
                    sample["mac_memory_free_percent"] = int(line.split(":")[-1].strip().rstrip("%"))
                except (OSError, ValueError, StopIteration, subprocess.SubprocessError):
                    sample["mac_memory_free_percent"] = None
            with (output / "host-resources.jsonl").open("a") as stream:
                stream.write(json.dumps(sample) + "\n")
            if stop_monitor.wait(15):
                return

    monitor = threading.Thread(target=monitor_resources, daemon=True)
    monitor.start()

    def wait_until_ready(slot):
        """Pause launches during outages or integrity investigations; keep attempts intact."""
        while True:
            problem = None
            try:
                if (output / "PAUSE").exists():
                    raise RuntimeError((output / "PAUSE").read_text()[:300])
                for base in [args.endpoint, os.environ["TEXERA_API_ENDPOINT"]]:
                    requests.get(base + "/api/healthcheck", timeout=5).raise_for_status()
                for base in [os.environ["TEXERA_COMPUTING_UNIT_ENDPOINT"], os.environ["TEXERA_WORKFLOW_EXECUTION_ENDPOINT"]]:
                    url = urlsplit(base)
                    with socket.create_connection((url.hostname, url.port), timeout=5):
                        pass
                if shutil.disk_usage(output).free < 5_000_000_000 or shutil.disk_usage(ROOT).free < 2_000_000_000:
                    raise RuntimeError("Artifact or backend disk is low on space")
            except Exception as exc:
                problem = f"{type(exc).__name__}: {exc}"
            with lock:
                if problem:
                    progress["waiting"][slot] = problem
                else:
                    progress["waiting"].pop(slot, None)
                save(output / "progress.json", progress)
            if not problem:
                return
            print("WAIT", slot, problem, flush=True)
            time.sleep(15)

    def worker(slot):
        wait_until_ready(slot)
        token = login(api_endpoint=os.environ["TEXERA_API_ENDPOINT"])
        headers = {"Authorization": "Bearer " + token}
        cu_base = os.environ["TEXERA_COMPUTING_UNIT_ENDPOINT"]
        response = requests.post(cu_base + "/api/computing-unit/create", headers=headers, timeout=30,
            json={"name": f"retrieval-{tag}-{slot}", "unitType": "local", "cpuLimit": "NaN", "memoryLimit": "NaN",
                  "gpuLimit": "NaN", "jvmMemorySize": "NaN", "shmSize": "NaN", "uri": os.environ["TEXERA_WORKFLOW_EXECUTION_ENDPOINT"]})
        response.raise_for_status()
        body = response.json()
        cuid = body.get("computingUnit", body)["cuid"]
        save(output / f"cu-{slot}.json", {"cuid": cuid, "status": "created"})
        job = None
        try:
            while True:
                job = pending.get()
                if job is None:
                    return
                wait_until_ready(slot)
                destination = KB / "system_scratch" / job["sut"] / job["task"]
                log = output / "logs" / f'{job["sut"]}-{job["task"]}.log'
                log.parent.mkdir(exist_ok=True)
                env = dict(os.environ, RETRIEVAL_MANIFEST=str(output / "manifest.json"),
                           RETRIEVAL_JOB=json.dumps(job), RETRIEVAL_CUID=str(cuid), PYTHONUNBUFFERED="1")
                started = time.monotonic()
                timeout = False
                with log.open("x") as stream:
                    with launch_lock:
                        proc = subprocess.Popen([sys.executable, str(Path(__file__).with_name("evaluate_task.py")),
                            "--sut", job["sut"], "--workload", kb.workload_of(job["task"]), "--task_id", job["task"],
                            "--use_truth_subset", "--no_pipeline_eval", "--verbose"], cwd=KB, env=env, stdout=stream, stderr=subprocess.STDOUT)
                        time.sleep(1)
                    with lock:
                        progress["active"][slot] = {**job, "pid": proc.pid, "started_at": datetime.now(timezone.utc).isoformat()}
                        save(output / "progress.json", progress)
                    print("START", job, flush=True)
                    try:
                        proc.wait(timeout=args.timeout)
                    except subprocess.TimeoutExpired:
                        timeout = True
                        resource = destination / "resources.json"
                        if resource.exists():
                            try:
                                agent_id = json.loads(resource.read_text())["agent_id"]
                                endpoint = args.endpoint + "/api/agents/" + agent_id
                                requests.post(endpoint + "/stop", timeout=30)
                                trace = requests.get(endpoint + "/react-steps", timeout=30)
                                if trace.ok:
                                    save(destination / "watchdog-react_steps.json", trace.json())
                            except Exception as exc:
                                save(destination / "watchdog-error.json", {"error": str(exc)})
                        proc.terminate()
                        try:
                            proc.wait(timeout=20)
                        except subprocess.TimeoutExpired:
                            proc.kill()
                            proc.wait()
                archive = output / "system_scratch" / job["sut"] / job["task"]
                if destination.exists() and destination.resolve() != archive.resolve():
                    shutil.copytree(destination, archive)
                def read_json(name):
                    """A harness killed at the wall clock can leave a truncated file; treat it as absent."""
                    file = archive / name
                    try:
                        return json.loads(file.read_text()) if file.exists() else {}
                    except ValueError:
                        print("WARN", job, f"unreadable {name}", flush=True)
                        return {}
                evaluation = read_json("evaluation.json")
                stats = read_json("stats.json")
                if args.wire_dir:
                    stats, metrics_audit = reconcile_run(archive, MODEL_TYPES[job["model"]],
                        manifest["pricing_schedules"][MODEL_TYPES[job["model"]]], args.wire_dir)
                elif manifest["pricing_schedules"][MODEL_TYPES[job["model"]]] is None:
                    stats["cost_usd"] = None
                    if archive.exists():
                        save(archive / "stats.json", stats)
                scores = [float(evaluation[k]) for k in kb.SCORE_METRICS if evaluation.get(k) is not None]
                row = {**job, "exit_code": proc.returncode, "timeout": timeout, "score": max(scores) if scores else None,
                       "cost_usd": stats.get("cost_usd"), "seconds": time.monotonic() - started}
                checks = audit_attempt(archive, {**manifest["settings"], **manifest["arms"][job["arm"]]})
                save(archive / "attempt-audit.json", checks)
                row["audit"] = checks
                if checks["violations"]:
                    (output / "PAUSE").write_text(f"Trace integrity check failed: {job}: {checks['violations']}\n")
                with lock:
                    progress["completed"].append(row)
                    progress["active"].pop(slot, None)
                    save(output / "progress.json", progress)
                print("DONE", row, flush=True)
                pending.done(job)
                job = None
        finally:
            if job is not None:
                pending.done(job)
            response = requests.delete(cu_base + f"/api/computing-unit/{cuid}/terminate", headers=headers, timeout=30)
            save(output / f"cu-{slot}.json", {"cuid": cuid, "status": "terminated" if response.ok else "cleanup_error"})

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(worker, slot) for slot in range(args.workers)]
        for future in as_completed(futures):
            try:
                future.result()
            except Exception as exc:
                with lock:
                    progress["worker_errors"].append(str(exc))
                    save(output / "progress.json", progress)
                    (output / "PAUSE").write_text(f"Worker error requires investigation: {exc}\n")
    progress["status"] = "complete" if len(progress["completed"]) == len(jobs) else "incomplete"
    progress["finished_at"] = datetime.now(timezone.utc).isoformat()
    stop_monitor.set()
    monitor.join(timeout=5)
    save(output / "progress.json", progress)
    print(progress["status"], len(progress["completed"]), "/", len(jobs), flush=True)


if __name__ == "__main__":
    main()
