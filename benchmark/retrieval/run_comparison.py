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
"""One matched full KramaBench round for smolagents and native Dataflows.

Both delegate to the unchanged official evaluator. A shared queue limits large
input tasks across both systems, preserves all attempts, and never retries or
overwrites a model task. Use the KramaBench venv from the repository root.
"""
import argparse
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

from campaign import ResourceQueue, audit_attempt, install_provider_prices, prepare_artifacts
from catalog import inventory
from run import ROOT, KB, MODEL_TYPES, save
from attempt_runtime import supervise_adapter, record_adapter_metrics, validate_resource_scope, record_provider_block


def audit_script(path):
    violations, warnings = [], []
    stats_file, trace_file = path / "stats.json", path / "model-request-trace.jsonl"
    if not stats_file.exists() or not trace_file.exists():
        return {"violations": [], "warnings": ["missing_script_stats_or_trace"]}
    stats = json.loads(stats_file.read_text())
    events = [json.loads(line) for line in trace_file.read_text().splitlines()]
    responses = [e for e in events if e["phase"] == "response"]
    totals = {"input_tokens": 0, "output_tokens": 0, "cached_tokens": 0, "cache_creation_tokens": 0}
    for response in responses:
        usage = response["usage"]
        details = usage.get("prompt_tokens_details") or {}
        totals["input_tokens"] += usage["prompt_tokens"]
        totals["output_tokens"] += usage["completion_tokens"]
        totals["cached_tokens"] += details.get("cached_tokens", 0) or 0
        totals["cache_creation_tokens"] += details.get("cache_creation_tokens", 0) or 0
    for key, value in totals.items():
        if value != stats[key]:
            violations.append("script_usage_mismatch:" + key)
    if (path / "wall-clock-stop.json").exists():
        warnings.append("task_timeout_usage_incomplete")
    elif not responses:
        violations.append("no_successful_provider_calls")
    if any(e["phase"] == "error" for e in events):
        warnings.append("provider_request_error")
    return {"violations": violations, "warnings": warnings, "provider_calls": len(responses), **totals}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--endpoint", default="http://localhost:3079")
    parser.add_argument("--script-endpoint", default="http://localhost:4001/v1")
    parser.add_argument("--script-chars", type=int, default=5000)
    parser.add_argument("--model", default="Sonnet55", help="Known model name or arbitrary exact gateway model ID")
    parser.add_argument("--model-facts", type=Path, help="Frozen exact model capability/pricing facts")
    parser.add_argument("--resource-scope", type=Path, help="Owned service/components for serial comparable collection")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout", type=int, default=1200)
    parser.add_argument("--agent-revision", required=True)
    parser.add_argument("--engine-revision", required=True)
    args = parser.parse_args()
    resource_scope = json.loads(args.resource_scope.read_text()) if args.resource_scope else {}
    validate_resource_scope(resource_scope)
    if resource_scope and args.workers != 1:
        parser.error("An owned shared resource scope requires --workers 1 for attributable measurements")
    if args.output.exists():
        parser.error("Refusing to overwrite existing output")
    if min(args.workers, args.timeout, args.script_chars) < 1:
        parser.error("Workers, timeout and preview limit must be positive")
    for path in [ROOT / ".env", KB / ".env"]:
        if path.exists():
            for line in path.read_text().splitlines():
                line = line.removeprefix("export ").strip()
                if "=" in line and not line.startswith("#"):
                    key, value = line.split("=", 1)
                    os.environ.setdefault(key.strip(), value.strip().strip("\"'"))
    assert os.environ.get("OPENAI_API_KEY") not in [None, "", "dummy"]
    assert os.environ.get("LITELLM_MASTER_KEY") or os.environ.get("CODE_AGENT_API_KEY")
    os.environ.setdefault("TEXERA_API_ENDPOINT", "http://localhost:8080")
    os.environ.setdefault("TEXERA_COMPUTING_UNIT_ENDPOINT", "http://localhost:8888")
    os.environ.setdefault("TEXERA_WORKFLOW_EXECUTION_ENDPOINT", "http://localhost:8085")
    os.environ["KB_EMPTY_TURN_RETRIES"] = "0"
    sys.path.insert(0, str(KB))
    import kb
    import requests
    from dataflow_agent import login
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

    output = args.output.resolve()
    sources = inventory()
    tasks = sorted(t["task_id"] for t in sources)
    assert len(tasks) == 104
    tag = output.name.replace("-", "_")
    model_tag = "".join(character if character.isalnum() else "_" for character in args.model)
    jobs = [
        {"model": args.model, "arm": arm, "task": task, "rep": 1, "sut": f"{prefix}{model_tag}_{tag}_{arm}_Rep1"}
        for prefix, arm in [("CodeAgentSystem", "guided_script"), ("DataflowSystem", "adaptive_flow1")]
        for task in tasks
    ]
    random.Random(102).shuffle(jobs)
    # First production attempt checks the new script routing/instrumentation.
    # It remains part of the full round, whatever its official score is.
    first = next(j for j in jobs if j["arm"] == "guided_script" and j["task"] == "legal-easy-26")
    jobs.remove(first)
    jobs.insert(0, first)
    manifest = {
        "agent_revision": args.agent_revision,
        "engine_revision": args.engine_revision,
        "runner_revision": subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip(),
        "harness_revision": subprocess.check_output(["git", "-C", str(KB), "rev-parse", "HEAD"], text=True).strip(),
        "endpoint": args.endpoint,
        "script_endpoint": args.script_endpoint,
        "task_ids": tasks,
        "repetitions": 1,
        "models": {args.model: model},
        "model_fact": model_fact,
        "resource_scope": resource_scope,
        "price_schedule": model_fact.get("pricing") if model_fact else cost_utils.price_schedule(model),
        "pricing_overrides": install_provider_prices(cost_utils, [model]),
        "arms": {
            "adaptive_flow1": {
                "retrievalViews": ["full", "sample", "sample_stats"],
                "flowEvidence": True,
                "dataEvidence": True,
            }
        },
        "settings": {
            "agentMode": "native",
            "contextMode": "delta",
            "nativeProfileCollection": True,
            "maxSteps": 25,
            "maxOperatorResultCharLimit": 2000,
            "maxResultRows": 5,
            "fullResultCharLimit": 100000,
            "dataEvidenceCharLimit": 2000,
            "flowEvidenceCharLimit": 2000,
            "thoughtReplay": False,
            "enableCodeInSnapshot": False,
        },
        "script_settings": {
            "max_steps": 25,
            "max_print_outputs_length": args.script_chars,
            "use_custom_prompt": True,
            "use_fine_grained_prompt": False,
            "use_pitfalls_prompt": False,
            "no_action_detail": False,
            "final_answer_tool_prompt": True,
        },
        "selection": "All 104 original top-level KramaBench tasks, both systems, one attempt each. User-selected guided 5K script preview; Dataflows retains current adaptive views with 2K samples plus statistics and flow. No task exclusions or outcome-selected retries.",
        "attempt_policy": "One attempt per task and system, as requested; no recovery rounds or best-of selection.",
        "pass_threshold": 1.0,
        "workers": args.workers,
        "large_workers": 1,
        "large_input_bytes": 100000000,
        "task_timeout_seconds": args.timeout,
        "workspaces": str(args.output.resolve() / "workspaces"),
        "input_inventory": sources,
        "jobs": jobs,
    }
    output.mkdir(parents=True)
    save(output / "manifest.json", manifest)
    prepare_artifacts(KB / "system_scratch", output / "system_scratch", [j["sut"] for j in jobs])
    os.chdir(KB)
    pending = ResourceQueue(jobs[1:], {t["task_id"] for t in sources if t["bytes"] >= 100000000}, 1)
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
    units = {}

    def ready(slot, dataflow):
        while True:
            problem = None
            try:
                if (output / "PAUSE").exists():
                    raise RuntimeError((output / "PAUSE").read_text()[:300])
                if shutil.disk_usage(output).free < 5000000000 or shutil.disk_usage(ROOT).free < 2000000000:
                    raise RuntimeError("Artifact or backend disk low on space")
                if dataflow:
                    for endpoint in [args.endpoint, os.environ["TEXERA_API_ENDPOINT"]]:
                        requests.get(endpoint + "/api/healthcheck", timeout=5).raise_for_status()
                    for key in ["TEXERA_COMPUTING_UNIT_ENDPOINT", "TEXERA_WORKFLOW_EXECUTION_ENDPOINT"]:
                        url = urlsplit(os.environ[key])
                        with socket.create_connection((url.hostname, url.port), timeout=5):
                            pass
            except Exception as exc:
                problem = str(exc)
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
        dataflow = job["arm"] == "adaptive_flow1"
        if model_fact and not model_fact["available"]:
            path = output / "system_scratch" / job["sut"] / job["task"]
            row = {
                **job,
                **record_provider_block(
                    path, fact=model_fact, task_id=job["task"], system="native" if dataflow else "smolagents"
                ),
            }
            with lock:
                progress["completed"].append(row)
                save(output / "progress.json", progress)
            return
        ready(slot, dataflow)
        if dataflow and slot not in units:
            token = login(api_endpoint=os.environ["TEXERA_API_ENDPOINT"])
            headers = {"Authorization": "Bearer " + token}
            response = requests.post(
                os.environ["TEXERA_COMPUTING_UNIT_ENDPOINT"] + "/api/computing-unit/create",
                headers=headers,
                timeout=30,
                json={
                    "name": f"comparison-{tag}-{slot}",
                    "unitType": "local",
                    "cpuLimit": "NaN",
                    "memoryLimit": "NaN",
                    "gpuLimit": "NaN",
                    "jvmMemorySize": "NaN",
                    "shmSize": "NaN",
                    "uri": os.environ["TEXERA_WORKFLOW_EXECUTION_ENDPOINT"],
                },
            )
            response.raise_for_status()
            body = response.json()
            units[slot] = (body.get("computingUnit", body)["cuid"], headers)
            save(output / f"cu-{slot}.json", {"cuid": units[slot][0], "status": "created"})
        path = output / "system_scratch" / job["sut"] / job["task"]
        log = output / "logs" / f"{job['sut']}-{job['task']}.log"
        log.parent.mkdir(exist_ok=True)
        env = dict(
            os.environ,
            RETRIEVAL_MANIFEST=str(output / "manifest.json"),
            RETRIEVAL_JOB=json.dumps(job),
            PYTHONUNBUFFERED="1",
        )
        if dataflow:
            env["RETRIEVAL_CUID"] = str(units[slot][0])
        adapter = "evaluate_task.py" if dataflow else "evaluate_script_task.py"
        with lock:
            progress["active"][slot] = {**job, "started_at": datetime.now(timezone.utc).isoformat()}
            save(output / "progress.json", progress)
        print("START", job, flush=True)
        supervised = supervise_adapter(
            [
                sys.executable,
                str(Path(__file__).with_name(adapter)),
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
            system="native" if dataflow else "smolagents",
            resource_scope=resource_scope,
        )
        if supervised.timed_out and dataflow and (path / "resources.json").exists():
            endpoint = args.endpoint + "/api/agents/" + json.loads((path / "resources.json").read_text())["agent_id"]
            try:
                requests.post(endpoint + "/stop", timeout=20)
                trace = requests.get(endpoint + "/react-steps", timeout=20)
                if trace.ok:
                    save(path / "watchdog-react_steps.json", trace.json())
            except Exception as exc:
                save(path / "watchdog-error.json", {"error": str(exc)})
        evaluation = json.loads((path / "evaluation.json").read_text()) if (path / "evaluation.json").exists() else {}
        scores = [float(evaluation[k]) for k in kb.SCORE_METRICS if evaluation.get(k) is not None]
        checks = (
            audit_attempt(path, {**manifest["settings"], **manifest["arms"][job["arm"]]})
            if dataflow
            else audit_script(path)
        )
        metrics = record_adapter_metrics(
            path,
            supervised,
            system="native" if dataflow else "smolagents",
            model=model,
            task_id=job["task"],
            pricing=manifest["price_schedule"],
            resource_scope=resource_scope,
        )
        save(path / "attempt-audit.json", checks)
        row = {
            **job,
            "exit_code": supervised.returncode,
            "timeout": supervised.timed_out,
            "score": max(scores) if scores else None,
            "cost_usd": metrics["cost"]["total_usd"],
            "seconds": supervised.wall_seconds,
            "audit": checks,
            "normalized_metrics": metrics,
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

    try:
        execute(first, 0)
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            for future in as_completed([pool.submit(worker, slot) for slot in range(args.workers)]):
                try:
                    future.result()
                except Exception as exc:
                    with lock:
                        progress["worker_errors"].append(str(exc))
                        save(output / "progress.json", progress)
                    (output / "PAUSE").write_text(f"Worker error requires investigation: {exc}\n")
    finally:
        for slot, (cuid, headers) in units.items():
            response = requests.delete(
                os.environ["TEXERA_COMPUTING_UNIT_ENDPOINT"] + f"/api/computing-unit/{cuid}/terminate",
                headers=headers,
                timeout=30,
            )
            save(output / f"cu-{slot}.json", {"cuid": cuid, "status": "terminated" if response.ok else "cleanup_error"})
        progress["status"] = "complete" if len(progress["completed"]) == len(jobs) else "incomplete"
        progress["finished_at"] = datetime.now(timezone.utc).isoformat()
        save(output / "progress.json", progress)
        print(progress["status"], len(progress["completed"]), "/", len(jobs), flush=True)


if __name__ == "__main__":
    main()
