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
"""Freeze, resume and report a matched original-input benchmark matrix.

Preparation performs no model calls. Execution is a separate explicit command.
Every declared identity gets one immutable attempt, including blocked models.
Official grading remains a separate benchmark-specific operation.
"""

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from benchmark.dsbench import run as ds_runner  # noqa: E402 - direct script entrypoint
from benchmark.dsbench.metrics import normalize_attempt, read_json  # noqa: E402
from benchmark.retrieval.catalog import inventory  # noqa: E402
from benchmark.retrieval.attempt_runtime import validate_resource_scope  # noqa: E402
from benchmark.runtime.model_limits import (
    DEFAULT_MODEL_REQUEST_TIMEOUT_SECONDS,
    validate_model_request_timeout_seconds,
)  # noqa: E402

ARMS = {"smol_custom": "smol_custom", "bob_data": "data1_flow0", "bob_flow": "data0_flow1", "bob_both": "data1_flow1"}
KB_TASKS = ["legal-easy-3", "wildfire-hard-16", "biomedical-hard-7", "environment-easy-3", "astronomy-hard-10"]
DS_TASKS = [
    "00000034-question5",
    "00000032-question1",
    "00000032-question4",
    "00000006-question25",
    "00000010-question9",
]
SELECTION = "Chosen before this matrix for scalar aggregation, category-code eligibility, Excel parsing, composite grain, scientific files, distinct invoices, headerless observations, time windows, sparse lookup cardinality and literal marker counting; diagnostic selection, not a full-benchmark estimate."


def digest(path):
    hasher = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def source_inventory():
    """Hash code, prompts, gateways and locks that can affect either executor."""
    sources = set()
    for directory in (
        "agent-service/src",
        "agent-service/benchmark/e2e",
        "native-mode",
        "benchmark/runtime",
        "benchmark/dsbench",
        "benchmark/retrieval",
        "benchmark/Kramabench/systems",
        "benchmark/Kramabench/utils",
        "benchmark/Kramabench/benchmark",
    ):
        base = ROOT / directory
        for path in base.rglob("*"):
            relative = path.relative_to(ROOT)
            if (
                path.is_file()
                and not path.is_symlink()
                and path.name != "paraphrase_cache.json"
                and path.suffix.lower()
                in {".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".txt", ".yaml", ".yml"}
                and not any(
                    part in {"reports", "results", "__pycache__", "node_modules", ".venv"} for part in relative.parts
                )
            ):
                sources.add(path)
    for relative in (
        "benchmark/experiment_matrix.py",
        "benchmark/matrix_judge.py",
        "benchmark/model_registry.py",
        "agent-service/package.json",
        "agent-service/bun.lock",
        "pyproject.toml",
        "uv.lock",
        "benchmark/Kramabench/pyproject.toml",
        "benchmark/Kramabench/uv.lock",
        "benchmark/Kramabench/requirements.txt",
        "benchmark/Kramabench/code_agent.py",
        "bin/litellm-config.yaml",
        "bin/single-node/litellm-config.yaml",
        "bin/single-node/docker-compose.yml",
        "bin/strict_tools.py",
    ):
        if (ROOT / relative).is_file():
            sources.add(ROOT / relative)
    for directory in (
        "benchmark/Kramabench/workload",
        "benchmark/Kramabench/format_hint",
        "benchmark/Kramabench/benchmark/fixtures",
    ):
        sources.update(path for path in (ROOT / directory).glob("*.json") if path.name != "paraphrase_cache.json")
    return {str(path.relative_to(ROOT)): digest(path) for path in sorted(sources)}


def complete_sum(values, expected):
    known = [value for value in values if value is not None]
    return {
        "total": sum(known) if len(known) == expected else None,
        "observed_total": sum(known),
        "known_attempts": len(known),
        "declared_attempts": expected,
        "mean": sum(known) / len(known) if known else None,
        "maximum": max(known) if known else None,
    }


def native_cleanup_safe(directory):
    resource = read_json(Path(directory) / "resource.json", {})
    return not resource or read_json(Path(directory) / "cleanup.json", {}).get("removed") is True


def verify_frozen_sources(manifest):
    for relative, expected in manifest["source_hashes"].items():
        if not (ROOT / relative).is_file() or digest(ROOT / relative) != expected:
            raise ValueError(f"Frozen runner source changed: {relative}")


def write_new(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x") as stream:
        json.dump(value, stream, indent=2, ensure_ascii=False)
        stream.write("\n")


def build_jobs(models, tasks, *, seed=61008):
    if len({m["requested_model"] for m in models}) != len(models):
        raise ValueError("Duplicate requested model")
    if len({(t["benchmark"], t["task_id"]) for t in tasks}) != len(tasks):
        raise ValueError("Duplicate benchmark/task identity")
    jobs = []
    for model_index, model in enumerate(models):
        for task in tasks:
            for arm in ARMS:
                identity = [model["requested_model"], task["benchmark"], task["task_id"], arm]
                key = hashlib.sha256(json.dumps(identity, separators=(",", ":")).encode()).hexdigest()[:16]
                jobs.append(
                    {
                        "attempt_id": f"m{model_index:02d}-{task['benchmark']}-{task['task_id']}-{arm}-{key}",
                        "requested_model": model["requested_model"],
                        "model": model["native_model_id"],
                        "benchmark": task["benchmark"],
                        "task_id": task["task_id"],
                        "arm": arm,
                    }
                )
    random.Random(seed).shuffle(jobs)
    return jobs


def freeze_manifest(output, manifest):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    path = output / "manifest.json"
    if path.exists():
        if json.loads(path.read_text()) != manifest:
            raise ValueError("Existing frozen manifest differs; use a fresh output directory")
    else:
        write_new(path, manifest)


def pending_jobs(output, jobs):
    """Resume only never-started identities; interrupted attempts are failures."""
    pending = []
    for job in jobs:
        directory = Path(output) / "attempts" / job["attempt_id"]
        if not directory.exists():
            pending.append(job)
        elif not (directory / "status.json").exists():
            write_new(
                directory / "status.json",
                {
                    "completed": False,
                    "state": "interrupted",
                    "error": "Attempt directory exists without final status; preserved without retry.",
                },
            )
            if not (directory / "response.txt").exists():
                (directory / "response.txt").write_text("")
            if not (directory / "metrics.json").exists():
                write_new(
                    directory / "metrics.json",
                    normalize_attempt(
                        directory,
                        system="smolagents" if job["arm"] == "smol_custom" else "native",
                        task_wall_seconds=None,
                        benchmark=job["benchmark"],
                    ),
                )
    return pending


def blocked_attempt(directory, job, fact, *, task=None, prompt=None):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    reason = fact.get("blocked_reason") or "Exact requested model is unavailable in the frozen provider preflight."
    write_new(
        directory / "config.json",
        {"job": job, "model_fact": fact, "input_files": (task or {}).get("files", []), "prompt": prompt},
    )
    write_new(directory / "started.json", {"started_at": datetime.now(timezone.utc).isoformat(), "phase": "preflight"})
    write_new(
        directory / "status.json",
        {
            "completed": False,
            "state": "preflight_blocked",
            "provider_blocked": True,
            "error": reason,
            "inference_requests_attempted": 0,
        },
    )
    write_new(
        directory / "stats.json",
        {
            "input_tokens": 0,
            "output_tokens": 0,
            "cached_tokens": 0,
            "cache_creation_tokens": 0,
            "reasoning_tokens": 0,
            "cost_usd": 0,
            "model_calls_attempted": 0,
            "model_calls_succeeded": 0,
        },
    )
    (directory / "response.txt").write_text("")
    (directory / "model-request-trace.jsonl").write_text("")
    write_new(directory / "react_steps.json", [])
    write_new(directory / "preflight.json", fact)
    metrics = normalize_attempt(
        directory,
        system="smolagents" if job["arm"] == "smol_custom" else "native",
        task_wall_seconds=0,
        benchmark=job["benchmark"],
    )
    metrics["wall"]["boundary"] = "No child/inference request launched; frozen preflight blocked this attempt."
    write_new(directory / "metrics.json", metrics)


def kb_tasks(ids):
    indexed = {task["task_id"]: task for task in inventory()}
    tasks = []
    for task_id in ids:
        source = indexed[task_id]
        if source["unresolved_sources"]:
            raise ValueError(f"Missing original source files for {task_id}: {source['unresolved_sources']}")
        workload = task_id.split("-", 1)[0]
        hints = json.loads((ds_runner.ROOT / f"benchmark/Kramabench/format_hint/{workload}.json").read_text())
        format_hint = next((hint.get("format_hint", "") for hint in hints if hint["id"] == task_id), "")
        relative = f"{workload}/input"
        input_path = ds_runner.ROOT / "benchmark/Kramabench/data" / relative
        files = []
        for item in source["files"]:
            path = ds_runner.ROOT / "benchmark/Kramabench" / item["path"]
            files.append(
                {"name": str(path.relative_to(input_path)), "sha256": digest(path), "bytes": path.stat().st_size}
            )
        tasks.append(
            {
                "benchmark": "kramabench",
                "task_id": task_id,
                "question": source["query"],
                "introduction": "",
                "format_hint": format_hint,
                "input_path": str(input_path),
                "input_relative_path": relative,
                "allowed_files": [file["name"] for file in files],
                "files": files,
            }
        )
    return tasks


def build_prompt(task, arm):
    if task["benchmark"] == "dsbench":
        return ds_runner.build_prompt(task, ARMS[arm])
    files = "\n".join(f"- data/{task['input_relative_path']}/{name}" for name in task["allowed_files"])
    prompt = f"You are a data analyst. Answer this KramaBench question using the supplied inputs.\n\n<question>\n{task['question']}\n</question>\n\nAvailable input files (read-only):\n{files}\n\nAnswer format: {task.get('format_hint', '')}\n\nReturn a clear final answer to this question in its requested format.\n"
    return prompt + (
        "Finish by calling final_answer(<answer>) in your code.\n"
        if arm == "smol_custom"
        else "Finish with the dataflow answer action.\n"
    )


def verify_task(task):
    root = Path(task["input_path"]).resolve()
    for item in task["files"]:
        path = root / item["name"]
        if (
            (path.is_symlink() and "original_input_path" in task)
            or not path.resolve().is_relative_to(root)
            or digest(path) != item["sha256"]
        ):
            raise ValueError(f"Original input changed or escaped task tree: {task['task_id']}/{item['name']}")


def stage_task(task, native_source_root, *, dry_run=False):
    """Copy selected original bytes to one identical task-only mount per agent."""
    verify_task(task)
    fingerprint = hashlib.sha256(json.dumps(task["files"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()[
        :16
    ]
    relative = f"matrix_inputs/{task['task_id']}-{fingerprint}"
    target = Path(native_source_root).resolve() / relative
    if not dry_run:
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(target.name + f".tmp-{os.getpid()}")
            temporary.mkdir(exist_ok=False)
            try:
                for item in task["files"]:
                    destination = temporary / item["name"]
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(Path(task["input_path"]) / item["name"], destination)
                temporary.rename(target)
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)
        actual = {str(path.relative_to(target)) for path in target.rglob("*") if path.is_file()}
        if actual != {item["name"] for item in task["files"]}:
            raise ValueError(f"Staged task directory contains extra or missing files: {task['task_id']}")
    staged = {
        **task,
        "original_input_path": task["input_path"],
        "input_path": str(target),
        "input_relative_path": relative,
    }
    if not dry_run:
        verify_task(staged)
    return staged


def make_manifest(args):
    request_timeout = validate_model_request_timeout_seconds(
        getattr(args, "model_request_timeout_seconds", DEFAULT_MODEL_REQUEST_TIMEOUT_SECONDS)
    )
    facts = json.loads(args.model_facts.read_text())
    models = facts["models"] if isinstance(facts, dict) else facts
    if args.models:
        indexed = {fact["requested_model"]: fact for fact in models}
        models = [indexed[model] for model in args.models]
    for fact in models:
        if (
            not fact.get("requested_model")
            or not fact.get("native_model_id")
            or type(fact.get("available")) is not bool
        ):
            raise ValueError("Each model fact needs exact requested_model, native_model_id and boolean available")
    _, selected = ds_runner.load_tasks(args.ds_prepared_root, args.ds_tasks)
    tasks = [stage_task(task, args.native_source_data, dry_run=args.dry_run) for task in kb_tasks(args.kb_tasks)] + [
        {**task, "benchmark": "dsbench", "input_relative_path": f"dsbench/{task['task_id']}"} for task in selected
    ]
    principles = args.shared_principles.read_text().strip()
    if principles.count("## Analysis principles") != 1:
        raise ValueError("Expected exactly one shared Analysis principles block")
    resource_scope = json.loads(args.owned_services.read_text()) if args.owned_services else {}
    if args.component_scopes:
        resource_scope.update(json.loads(args.component_scopes.read_text()))
    validate_resource_scope(resource_scope)
    return {
        "schema_version": 1,
        "selection": SELECTION,
        "models": models,
        "tasks": tasks,
        "jobs": build_jobs(models, tasks),
        "arms": ARMS,
        "native_settings": ds_runner.NATIVE_SETTINGS,
        "smol_settings": ds_runner.SMOL_SETTINGS,
        "shared_principles": principles,
        "shared_principles_sha256": hashlib.sha256(principles.encode()).hexdigest(),
        "model_facts_sha256": digest(args.model_facts),
        "ds_prepared_root": str(args.ds_prepared_root.resolve()),
        "native_source_data": str(args.native_source_data.resolve()),
        "endpoint": args.endpoint,
        "script_endpoint": args.script_endpoint,
        "scorer_python": str(args.scorer_python.absolute()),
        "resource_scope": resource_scope,
        "model_request_timeout_seconds": request_timeout,
        "model_request_timeout_policy": "Common elapsed model-call deadline for native fetch and Linux-main-thread smol create; smol HTTPX phase timeouts also use the same numeric seconds; earlier task deadline wins.",
        "attempt_policy": "One immutable attempt per declared model/task/arm. Resume never retries completed, failed, blocked or interrupted identities. No model substitution.",
        "execution_policy": "Serial attempts; original task input mounts; current prompts/settings; zero model SDK retries; grading excluded from agent resources.",
        "token_accounting": "Shared runtime v1; input totals include cache read/write, output includes reasoning. Explicit provider cache-write usage priced separately for new attempts. Historical reports remain frozen.",
        "source_revision": subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip(),
        "source_hashes": source_inventory(),
    }


def run_matrix(output, *, limit=None):
    output = Path(output).resolve()
    with (output / "execution.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("This immutable matrix already has an active runner") from None
        _run_matrix_locked(output, limit=limit)


def _run_matrix_locked(output, *, limit=None):
    output = Path(output).resolve()
    manifest = json.loads((output / "manifest.json").read_text())
    if manifest["native_settings"] != ds_runner.NATIVE_SETTINGS or manifest["smol_settings"] != ds_runner.SMOL_SETTINGS:
        raise ValueError("Current executor settings differ from the locked manifest")
    verify_frozen_sources(manifest)
    expected_service = {
        relative.removeprefix("agent-service/"): value
        for relative, value in manifest["source_hashes"].items()
        if (relative.startswith("agent-service/src/") and not relative.endswith(".test.ts"))
        or relative in {"agent-service/package.json", "agent-service/bun.lock"}
    }
    models = {fact["requested_model"]: fact for fact in manifest["models"]}
    tasks = {(task["benchmark"], task["task_id"]): task for task in manifest["tasks"]}
    jobs = pending_jobs(output, manifest["jobs"])
    for prior in manifest["jobs"]:
        directory = output / "attempts" / prior["attempt_id"]
        if prior["arm"] != "smol_custom" and directory.exists() and not native_cleanup_safe(directory):
            (output / "PAUSE").write_text(
                f"Native cleanup remains uncertain for {prior['attempt_id']}; inspect retained resources before any new inference.\n"
            )
            raise RuntimeError("Unsafe native cleanup prevents further serial launches")
    for job in jobs[:limit] if limit is not None else jobs:
        if (output / "PAUSE").exists():
            break
        verify_frozen_sources(manifest)
        task, fact = tasks[job["benchmark"], job["task_id"]], models[job["requested_model"]]
        verify_task(task)
        directory = output / "attempts" / job["attempt_id"]
        prompt = build_prompt(task, job["arm"])
        if not fact["available"]:
            blocked_attempt(directory, job, fact, task=task, prompt=prompt)
            continue
        ds_runner.run_task(
            task,
            ARMS[job["arm"]],
            output_root=output,
            destination=directory,
            endpoint=manifest["endpoint"],
            script_endpoint=manifest["script_endpoint"],
            shared_principles=manifest["shared_principles"],
            pricing=fact.get("pricing"),
            model=job["model"],
            benchmark=job["benchmark"],
            prompt=prompt,
            resource_scope=manifest["resource_scope"],
            model_parameters=fact.get("model_parameters", {"reasoning_effort": fact.get("reasoning_effort", "medium")}),
            model_capabilities=fact.get("model_capabilities", {}),
            expected_service_source_hashes=expected_service,
            # Legacy manifests omit the native override and retain their recorded defaults.
            model_request_timeout_seconds=manifest.get("model_request_timeout_seconds"),
        )
        if job["arm"] != "smol_custom" and not native_cleanup_safe(directory):
            (output / "PAUSE").write_text(
                f"Native cleanup remains uncertain for {job['attempt_id']}; inspect retained resources before any new inference.\n"
            )
            raise RuntimeError("Unsafe native cleanup prevents further serial launches")


def report_matrix(output):
    output = Path(output)
    manifest = json.loads((output / "manifest.json").read_text())
    rows, groups = [], defaultdict(list)
    for job in manifest["jobs"]:
        directory = output / "attempts" / job["attempt_id"]
        row = {
            **job,
            "directory": str(directory),
            "status": read_json(directory / "status.json", {"state": "not_started"}),
            "metrics": read_json(directory / "metrics.json", None),
            "official_evaluation": read_json(directory / "evaluation.json", None),
            "diagnostic_evaluation": read_json(directory / "diagnostic-evaluation.json", None),
        }
        rows.append(row)
        groups[job["requested_model"], job["benchmark"], job["arm"]].append(row)
    summary = []
    for identity, entries in groups.items():
        metrics = [entry["metrics"] for entry in entries if entry["metrics"] is not None]
        costs = [metric["cost"]["total_usd"] for metric in metrics]
        scores = [official_score(row["official_evaluation"]) for row in entries]
        known_scores = [score for score in scores if score is not None]
        diagnostics = [row["diagnostic_evaluation"] for row in entries if row["diagnostic_evaluation"] is not None]
        summary.append(
            {
                "requested_model": identity[0],
                "benchmark": identity[1],
                "arm": identity[2],
                "declared": len(entries),
                "finished": sum((output / "attempts" / row["attempt_id"] / "status.json").exists() for row in entries),
                "completed": sum(row["status"].get("completed", False) for row in entries),
                "provider_blocked": sum(row["status"].get("provider_blocked", False) for row in entries),
                "requests_attempted": complete_sum(
                    [metric["requests"]["attempted"] for metric in metrics], len(entries)
                )["total"],
                "requests_succeeded": complete_sum(
                    [metric["requests"]["succeeded"] for metric in metrics], len(entries)
                )["total"],
                "requests_failed": complete_sum([metric["requests"]["failed"] for metric in metrics], len(entries))[
                    "total"
                ],
                "requests_observed": {
                    name: sum(metric["requests"][name] or 0 for metric in metrics)
                    for name in ("attempted", "succeeded", "failed")
                },
                "actions": complete_sum(
                    [
                        (
                            metric.get("actions", {}).get("total")
                            if metric.get("actions", {}).get("complete", True)
                            else None
                        )
                        for metric in metrics
                    ],
                    len(entries),
                )["total"],
                "actions_observed": sum(metric.get("actions", {}).get("total") or 0 for metric in metrics),
                "actions_complete_attempts": sum(
                    metric.get("actions", {}).get("complete", True)
                    and metric.get("actions", {}).get("total") is not None
                    for metric in metrics
                ),
                "usage_complete_attempts": sum(metric["usage_complete"] for metric in metrics),
                "provider_reported_cost_usd": complete_sum(
                    [(metric.get("provider_reported_cost") or {}).get("cost_usd") for metric in metrics], len(entries)
                ),
                "tokens": {
                    name: complete_sum([metric["tokens"].get(name) for metric in metrics], len(entries))
                    for name in (
                        "input_tokens",
                        "output_tokens",
                        "cached_tokens",
                        "cache_creation_tokens",
                        "reasoning_tokens",
                        "uncached_input_tokens",
                        "total_tokens",
                    )
                },
                "wall_seconds": complete_sum([metric["wall"]["task_seconds"] for metric in metrics], len(entries)),
                "cpu_seconds": complete_sum(
                    [metric["resources"].get("cpu_total_seconds") for metric in metrics], len(entries)
                ),
                "cpu_user_seconds": complete_sum(
                    [metric["resources"].get("cpu_user_seconds") for metric in metrics], len(entries)
                ),
                "cpu_system_seconds": complete_sum(
                    [metric["resources"].get("cpu_system_seconds") for metric in metrics], len(entries)
                ),
                "peak_memory_bytes": complete_sum(
                    [
                        metric["resources"].get("peak_memory_bytes", metric["resources"].get("peak_rss_bytes"))
                        for metric in metrics
                    ],
                    len(entries),
                ),
                "known_agent_cost_usd": sum(metric["cost"]["known_usd"] or 0 for metric in metrics),
                "agent_cost_usd": (
                    sum(costs) if len(metrics) == len(entries) and all(cost is not None for cost in costs) else None
                ),
                "resource_metrics_complete": sum(metric["resource_completeness"]["complete"] for metric in metrics),
                "official_scored": len(known_scores),
                "mean_official_score": sum(known_scores) / len(known_scores) if known_scores else None,
                "official_passes": sum(score >= 1.0 for score in known_scores),
                "official_unscored": len(entries) - len(known_scores),
                "diagnostic_scored": sum(row.get("correct") is not None for row in diagnostics),
                "diagnostic_correct": sum(row.get("correct") is True for row in diagnostics),
                "judge_requests_incremental": sum(
                    (row["official_evaluation"] or {}).get("incremental_model_calls") or 0 for row in entries
                ),
                "judge_cost_incremental_usd": complete_sum(
                    [(row["official_evaluation"] or {}).get("incremental_cost_usd") for row in entries], len(entries)
                ),
            }
        )
    return {
        "schema_version": 1,
        "attempt_policy": manifest["attempt_policy"],
        "selection": manifest["selection"],
        "summary": summary,
        "attempts": rows,
        "accuracy_note": "Official benchmark evaluations and diagnostic labels are distinct; pending judgments are not zero scores.",
        "resource_note": "Per-attempt wall sums are serial task totals, not campaign duration. Peak memory has meaningful per-attempt mean/maximum; its sum is not campaign peak. Shared gateway raw resources are separately scoped for both arms.",
    }


def official_score(evaluation):
    if not evaluation:
        return None
    if "official_correct" in evaluation:
        return float(evaluation["official_correct"]) if evaluation["official_correct"] is not None else None
    values = [
        evaluation[name]
        for name in ("success", "llm_paraphrase", "rae_score", "f1", "f1_approximate")
        if evaluation.get(name) is not None
    ]
    return max(float(value) for value in values) if values else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare", help="Validate and freeze protocol; no provider calls")
    prepare.add_argument("--output", type=Path, required=True)
    prepare.add_argument("--model-facts", type=Path, required=True)
    prepare.add_argument("--models", nargs="+")
    prepare.add_argument("--model-request-timeout-seconds", type=float, default=DEFAULT_MODEL_REQUEST_TIMEOUT_SECONDS)
    prepare.add_argument("--ds-prepared-root", type=Path, required=True)
    prepare.add_argument(
        "--native-source-data",
        type=Path,
        default=Path(os.environ.get("NATIVE_SOURCE_DATA", str(ROOT / "benchmark/Kramabench/data"))),
    )
    prepare.add_argument("--kb-tasks", nargs="+", default=KB_TASKS)
    prepare.add_argument("--ds-tasks", nargs="+", default=DS_TASKS)
    prepare.add_argument(
        "--shared-principles",
        type=Path,
        default=ROOT / "benchmark/Kramabench/judgment_runs/single_task_prompt_subset_20261008/shared-principles.txt",
    )
    prepare.add_argument("--endpoint", default=os.environ.get("TEXERA_AGENT_SERVICE_ENDPOINT", "http://localhost:3082"))
    prepare.add_argument(
        "--script-endpoint", default=os.environ.get("CODE_AGENT_API_BASE", "http://localhost:18000/v1")
    )
    prepare.add_argument(
        "--owned-services",
        type=Path,
        help="Explicit owned_service_pids mapping plus ownership_verified=true; native resources remain incomplete without it",
    )
    prepare.add_argument(
        "--scorer-python",
        type=Path,
        default=ROOT / "benchmark/Kramabench/.venv/bin/python",
        help="Existing original KramaBench environment; grading runs separately from tested agents",
    )
    prepare.add_argument("--dry-run", action="store_true")
    prepare.add_argument(
        "--component-scopes", type=Path, help="Owned shared gateway and native dependency cgroup inventory"
    )
    execute = commands.add_parser("run", help="Explicit paid execution of locked protocol; resumes never-started jobs")
    execute.add_argument("--output", type=Path, required=True)
    execute.add_argument("--limit", type=int)
    reporting = commands.add_parser(
        "report", help="Read-only aggregation of metrics and existing official/diagnostic scores"
    )
    reporting.add_argument("--output", type=Path, required=True)
    reporting.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.command == "prepare":
        manifest = make_manifest(args)
        if not args.dry_run:
            freeze_manifest(args.output, manifest)
        print(
            json.dumps(
                {
                    "declared_attempts": len(manifest["jobs"]),
                    "models": [fact["requested_model"] for fact in manifest["models"]],
                    "tasks": [task["task_id"] for task in manifest["tasks"]],
                },
                indent=2,
            )
        )
    elif args.command == "run":
        if args.limit is not None and args.limit < 1:
            parser.error("--limit must be positive")
        run_matrix(args.output, limit=args.limit)
    else:
        report = report_matrix(args.output)
        if args.report:
            write_new(args.report, report)
        else:
            print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
