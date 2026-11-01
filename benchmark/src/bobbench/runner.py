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
"""The run loop shared by every KramaBench and PrepBench run, BobFlow or Script ReAct.

Every job (model, arm, task, repetition; shuffled per repetition with a fixed seed) is one attempt process
(`python -m bobbench.kramabench.attempt`), a few at a time. Tasks whose inputs are large run at most `large_workers` at
once. Each BobFlow worker holds its own computing unit. An attempt over the wall clock is stopped (BobFlow's turn too)
and still scored. After each attempt its cost is reconciled from the exact responses and its traces audited.

A run never overwrites anything and never retries a task. It pauses launches (running attempts finish) while a PAUSE
file exists in the run folder (written by an audit violation, by two consecutive answers the judge could not grade, by a
worker error, or by the memory guard), while a service is down, or while disk is low; removing the file resumes it.

Run folder: manifest.json, progress.json (rows read by score, report, recost and the campaign tools), cu-<slot>.json,
host-resources.jsonl, logs/<sut>-<task>.log, system_scratch/<sut>/<task>/. The runner's log has one "START <job>" and
one "DONE <row>" line per attempt and ends with "complete N / M" or "incomplete N / M" (campaign/alert.py reads them).
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
import os
import random
import shutil
import socket
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit

from bobbench import agent_client
from bobbench.audit import audit_dataflow, audit_script
from bobbench.kramabench.tasks import score
from bobbench.paths import KB, PACKAGE, REPO
from bobbench.profiling.host import HostMonitor
from bobbench.profiling.usage import reconcile_run, reconcile_trace

JUDGE_FAILURE_PAUSE = 2
JUDGE_METRICS = ("llm_paraphrase", "f1_approximate")
# Seconds an attempt gets to finish after the wall clock's SIGTERM (scoring included) before it is killed.
KILL_GRACE = {"bobflow": 20, "scriptreact": 90}
SEEDS = {"bobflow": 101, "scriptreact": 103}


def now():
    return datetime.now(timezone.utc).isoformat()


def save(path, data):
    """Write JSON atomically."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str) + "\n")
    temporary.replace(path)


def load_env(*paths):
    """Variables from .env files that the environment does not set already."""
    for path in paths:
        if path.exists():
            for line in path.read_text().splitlines():
                line = line.removeprefix("export ").strip()
                if "=" in line and not line.startswith("#"):
                    key, value = line.split("=", 1)
                    os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def jobs(system, models, arms, tasks, repetitions, tag):
    """Every attempt of a run, one repetition after another, each repetition in a seeded shuffle. The SUT name
    (<system class><model>_<run>_<arm>_Rep<n>) names the attempt folders; tools read the arm from it."""
    prefix = "DataflowSystem" if system == "bobflow" else "CodeAgentSystem"
    found = []
    for rep in range(1, repetitions + 1):
        round_jobs = [{"model": model, "arm": arm, "task": task, "rep": rep,
                       "sut": f"{prefix}{model}_{tag}_{arm}_Rep{rep}"}
                      for model in models for arm in arms for task in tasks]
        random.Random(SEEDS[system] + rep).shuffle(round_jobs)
        found.extend(round_jobs)
    return found


def judge_unavailable(evaluation, answer):
    """A judged metric is present but empty although the system answered: the LLM judge failed (an outage or an
    unreadable verdict), not the answer."""
    text = str((answer or {}).get("answer") or "").strip()
    answered = bool(text) and not text.startswith("Error:") and text != "No response from agent"
    return answered and any(key in evaluation and evaluation[key] is None for key in JUDGE_METRICS)


class ResourceQueue:
    """Preserve shuffled order where possible, bounding large tasks in flight."""

    def __init__(self, jobs, large_tasks, large_limit):
        self.jobs = list(jobs)
        self.large_tasks = set(large_tasks)
        self.large_limit = large_limit
        self.large_active = 0
        self.condition = threading.Condition()

    def get(self):
        with self.condition:
            while self.jobs:
                for index, job in enumerate(self.jobs):
                    large = job["task"] in self.large_tasks
                    if not large or self.large_active < self.large_limit:
                        self.large_active += int(large)
                        return self.jobs.pop(index)
                self.condition.wait()
            return None

    def done(self, job):
        with self.condition:
            if job["task"] in self.large_tasks:
                self.large_active -= 1
            self.condition.notify_all()


class Run:
    def __init__(self, output, manifest, *, workers, large_workers):
        self.output, self.manifest, self.system = output, manifest, manifest["system"]
        self.workers, self.timeout = workers, manifest["task_timeout_seconds"]
        large = {t["task_id"] for t in manifest["input_inventory"] if t["bytes"] >= manifest["large_input_bytes"]}
        self.pending = ResourceQueue(manifest["jobs"], large, large_workers)
        self.lock, self.launch_lock = threading.Lock(), threading.Lock()
        self.judge_failures = 0
        self.progress = {"started_at": now(), "status": "running", "active": {}, "completed": [], "worker_errors": [],
                         "waiting": {}}
        if self.system == "bobflow":
            self.endpoints = agent_client.Endpoints.from_env(agent=manifest["endpoint"])

    def save_progress(self):
        save(self.output / "progress.json", self.progress)

    # Readiness: pause launches during outages, low disk or a PAUSE file; attempts already running go on.

    def problem(self):
        if (self.output / "PAUSE").exists():
            return (self.output / "PAUSE").read_text()[:300]
        if shutil.disk_usage(self.output).free < 5_000_000_000:
            return "Artifact disk is low on space"
        import requests
        if self.system == "scriptreact":
            requests.get(self.manifest["script_endpoint"].removesuffix("/v1") + "/health/liveliness",
                         timeout=5).raise_for_status()
            return None
        for base in [self.endpoints.agent, self.endpoints.web]:
            requests.get(base + "/api/healthcheck", timeout=5).raise_for_status()
        for base in [self.endpoints.units, self.endpoints.engine]:
            url = urlsplit(base)
            with socket.create_connection((url.hostname, url.port), timeout=5):
                pass
        if shutil.disk_usage(REPO).free < 2_000_000_000:
            return "Backend disk is low on space"
        return None

    def ready(self, slot):
        while True:
            try:
                problem = self.problem()
            except Exception as exc:  # noqa: BLE001 - any failed check is a reason to wait
                problem = f"{type(exc).__name__}: {exc}"
            with self.lock:
                if problem:
                    self.progress["waiting"][slot] = problem
                else:
                    self.progress["waiting"].pop(slot, None)
                self.save_progress()
            if not problem:
                return
            print("WAIT", slot, problem, flush=True)
            time.sleep(15)

    # One attempt

    def attempt(self, job, slot, cuid):
        path = self.output / "system_scratch" / job["sut"] / job["task"]
        log = self.output / "logs" / f"{job['sut']}-{job['task']}.log"
        log.parent.mkdir(exist_ok=True)
        command = [sys.executable, "-m", "bobbench.kramabench.attempt", "--manifest", str(self.output / "manifest.json"),
                   "--job", json.dumps(job), *(["--cuid", str(cuid)] if cuid is not None else [])]
        env = dict(os.environ, PYTHONPATH=f"{PACKAGE.parent}:{KB}", PYTHONUNBUFFERED="1")
        started, timed_out = time.monotonic(), False
        with log.open("x") as stream:
            with self.launch_lock:
                process = subprocess.Popen(command, cwd=KB, env=env, stdout=stream, stderr=subprocess.STDOUT)
                time.sleep(1)
            with self.lock:
                self.progress["active"][slot] = {**job, "pid": process.pid, "started_at": now()}
                self.save_progress()
            print("START", job, flush=True)
            try:
                process.wait(timeout=self.timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                if self.system == "bobflow":
                    self.stop_turn(path)
                process.terminate()
                try:
                    process.wait(timeout=KILL_GRACE[self.system])
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        row = {**job, "exit_code": process.returncode, "timeout": timed_out}
        self.finish(path, job, row, started, slot)

    def stop_turn(self, path):
        """BobFlow at the wall clock: stop the agent's turn and keep the trace it has."""
        resource = path / "resources.json"
        if not resource.exists():
            return
        try:
            agent = json.loads(resource.read_text())["agent_id"]
            agent_client.stop(self.endpoints, agent)
            save(path / "watchdog-react_steps.json", agent_client.get(self.endpoints, agent, "react-steps"))
        except Exception as exc:  # noqa: BLE001
            save(path / "watchdog-error.json", {"error": str(exc)})

    def finish(self, path, job, row, started, slot):
        def read(name):
            """A harness killed at the wall clock can leave a truncated file; treat it as absent."""
            try:
                return json.loads((path / name).read_text()) if (path / name).exists() else {}
            except ValueError:
                print("WARN", job, f"unreadable {name}", flush=True)
                return {}

        evaluation = read("evaluation.json")
        model = self.manifest["models"][job["model"]]
        pricing = self.manifest["pricing_schedules"][model]
        if self.system == "scriptreact":
            stats = reconcile_trace(path, model, pricing)
        elif self.manifest.get("wire_directory"):
            stats, _ = reconcile_run(path, model, pricing, self.manifest["wire_directory"])
        else:
            stats = read("stats.json")
            if pricing is None and path.exists():
                stats["cost_usd"] = None
                save(path / "stats.json", stats)
        row.update(score=score(evaluation), cost_usd=stats.get("cost_usd"))
        if self.system == "scriptreact":
            row["steps"] = stats.get("num_steps")
        row["seconds"] = time.monotonic() - started
        unscored = judge_unavailable(evaluation, read("answer.json"))
        if unscored:
            row["unscored"] = True
        if self.system == "bobflow":
            checks = audit_dataflow(path, {**self.manifest["settings"], **self.manifest["arms"][job["arm"]]})
        else:
            checks = audit_script(path)
        save(path / "attempt-audit.json", checks)
        row["audit"] = checks
        if checks["violations"]:
            (self.output / "PAUSE").write_text(f"Trace integrity check failed: {job}: {checks['violations']}\n")
        with self.lock:
            # An answer the judge could not grade is not a wrong answer. On 2026-10-10 the judge's credit ran out
            # mid-run and four answers were silently scored as failures; stop instead.
            self.judge_failures = self.judge_failures + 1 if unscored else 0
            if self.judge_failures >= JUDGE_FAILURE_PAUSE:
                (self.output / "PAUSE").write_text(
                    f"Judge unavailable: {self.judge_failures} consecutive answers got no verdict (last {job['task']}); "
                    "check the judge key, rescore the unscored rows, then remove PAUSE.\n")
            self.progress["completed"].append(row)
            self.progress["active"].pop(slot, None)
            self.save_progress()
        print("DONE", row, flush=True)

    # A worker: its computing unit (BobFlow), then jobs until none is left.

    def open_unit(self, slot):
        token = agent_client.login(self.endpoints.web)
        tag = self.output.name.replace("-", "_")
        cuid = agent_client.create_computing_unit(self.endpoints, token, f"bench-{tag}-{slot}")
        save(self.output / f"cu-{slot}.json", {"cuid": cuid, "status": "created"})
        return token, cuid

    def close_unit(self, slot, unit):
        token, cuid = unit
        response = agent_client.terminate_computing_unit(self.endpoints, token, cuid)
        save(self.output / f"cu-{slot}.json", {"cuid": cuid, "status": "terminated" if response.ok else "cleanup_error"})

    def worker(self, slot):
        self.ready(slot)
        unit = self.open_unit(slot) if self.system == "bobflow" else None
        job = None
        try:
            while True:
                job = self.pending.get()
                if job is None:
                    return
                self.ready(slot)
                self.attempt(job, slot, unit[1] if unit else None)
                self.pending.done(job)
                job = None
        finally:
            if job is not None:
                self.pending.done(job)
            if unit:
                self.close_unit(slot, unit)

    def run(self):
        self.save_progress()
        monitor = HostMonitor(self.output, lambda: len(self.progress["active"])).start()
        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            for future in as_completed([pool.submit(self.worker, slot) for slot in range(self.workers)]):
                try:
                    future.result()
                except Exception as exc:  # noqa: BLE001 - a worker error pauses the run for investigation
                    with self.lock:
                        self.progress["worker_errors"].append(str(exc))
                        self.save_progress()
                        (self.output / "PAUSE").write_text(f"Worker error requires investigation: {exc}\n")
        total = len(self.manifest["jobs"])
        self.progress["status"] = "complete" if len(self.progress["completed"]) == total else "incomplete"
        self.progress["finished_at"] = now()
        monitor.stop()
        self.save_progress()
        print(self.progress["status"], len(self.progress["completed"]), "/", total, flush=True)
        return self.progress
