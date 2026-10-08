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
"""One-attempt DSBench analysis pilot, serial within each selected arm.

The preparation manifest contains public inputs only. The judge runs separately;
this runner never reads evaluator gold or rewrites the returned answer.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import sys
import time
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from benchmark.runtime import run_supervised  # noqa: E402 - direct script entrypoint
from benchmark.runtime.model_limits import (
    DEFAULT_MODEL_REQUEST_TIMEOUT_SECONDS,
    validate_model_request_timeout_seconds,
)  # noqa: E402
from benchmark.dsbench.metrics import normalize_attempt  # noqa: E402
from benchmark.dsbench.accounting import capture_model_accounting  # noqa: E402
from benchmark.retrieval.attempt_runtime import supervise_adapter  # noqa: E402

DEFAULT_MODEL = "gpt-5.6-luna"
ARMS = {
    f"data{data}_flow{flow}": {
        "dataEvidence": bool(data),
        "flowEvidence": bool(flow),
        "retrievalViews": ["sample_stats", "full"] if data else ["sample", "full"],
    }
    for data in (0, 1)
    for flow in (0, 1)
}
NATIVE_SETTINGS = {
    "agentMode": "native",
    "contextMode": "delta",
    "nativeProfileCollection": True,
    "nativeProfileScope": "prefix",
    "maxSteps": 25,
    "maxOperatorResultCharLimit": 2000,
    "maxResultRows": 5,
    "fullResultCharLimit": 5000,
    "dataEvidenceCharLimit": 2000,
    "flowEvidenceCharLimit": 2000,
    "thoughtReplay": False,
    "enableCodeInSnapshot": False,
}
SMOL_SETTINGS = {
    "max_steps": 25,
    "max_print_outputs_length": 5000,
    "use_custom_prompt": True,
    "use_fine_grained_prompt": False,
    "use_pitfalls_prompt": False,
    "use_structured_outputs_internally": True,
}


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False, default=str) + "\n")
    temporary.replace(path)


def load_tasks(prepared_root, task_ids):
    """Verify the exact three public files; do not open evaluator metadata."""
    prepared_root = Path(prepared_root).resolve()
    manifest = json.loads((prepared_root / "manifest.json").read_text())
    selected = {task["task_id"]: task for task in manifest["tasks"]}
    if len(task_ids) != len(set(task_ids)):
        raise ValueError("Duplicate task IDs")
    tasks = []
    for task_id in task_ids:
        if not re.fullmatch(r"\d{8}-question\d+", task_id):
            raise ValueError(f"Invalid task ID: {task_id}")
        if task_id not in selected:
            raise ValueError(f"Unknown task ID: {task_id}")
        task = dict(selected[task_id])
        directory = (prepared_root / task["input_dir"]).resolve()
        if directory != prepared_root / "inputs" / task_id:
            raise ValueError(f"Unexpected input directory: {task_id}")
        allowed = task["allowed_files"]
        expected = [task["introduction_file"], task["question_file"], task["workbook_file"]]
        if len(allowed) != 3 or set(allowed) != set(expected):
            raise ValueError(f"Unexpected input allowlist: {task_id}")
        if any(Path(name).name != name for name in allowed):
            raise ValueError(f"Invalid input basename: {task_id}")
        if {file.name for file in directory.iterdir()} != set(allowed):
            raise ValueError(f"Extra or missing input files: {task_id}")
        recorded = {file["name"]: file for file in task["files"]}
        if set(recorded) != set(allowed):
            raise ValueError(f"Input inventory mismatch: {task_id}")
        for name in allowed:
            file = directory / name
            if file.is_symlink() or not file.is_file():
                raise ValueError(f"Input must be a regular file: {task_id}/{name}")
            if hashlib.sha256(file.read_bytes()).hexdigest() != recorded[name]["sha256"]:
                raise ValueError(f"Input hash mismatch: {task_id}/{name}")
        task["input_path"] = str(directory)
        task["introduction"] = (directory / task["introduction_file"]).read_text()
        task["question"] = (directory / task["question_file"]).read_text()
        tasks.append(task)
    return manifest, tasks


def build_prompt(task, arm):
    """Both agents receive the same background, question and allowed file list."""
    files = "\n".join(f"- data/dsbench/{task['task_id']}/{name}" for name in task["allowed_files"])
    prompt = (
        "You are a data analyst. Answer this DSBench question using the supplied inputs.\n\n"
        f"<introduction>\n{task['introduction']}\n</introduction>\n\n"
        f"<question>\n{task['question']}\n</question>\n\n"
        f"Available input files (read-only):\n{files}\n\n"
        "Return a clear final answer to this question in its requested format.\n"
    )
    if arm == "smol_custom":
        return prompt + "Finish by calling final_answer(<answer>) in your code.\n"
    return prompt + "Finish with the dataflow answer action.\n"


def cost_module():
    """Load the shared cost helper without importing unrelated benchmark SUTs."""
    path = ROOT / "benchmark/Kramabench/systems/cost_utils.py"
    spec = importlib.util.spec_from_file_location("dsbench_cost_utils", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_pricing(model, pricing_json=None):
    """Freeze one matching per-token schedule before starting any attempts."""
    pricing = json.loads(Path(pricing_json).read_text()) if pricing_json else cost_module().price_schedule(model)
    if not pricing:
        raise RuntimeError(f"No recorded model price schedule for {model}; provide --pricing-json")
    if not isinstance(pricing, dict) or pricing.get("model") != model:
        raise ValueError("The pricing model must match --model exactly")
    if pricing.get("unit") != "per_token" or pricing.get("currency") != "USD":
        raise ValueError("The pricing schedule must use USD per_token rates")
    if pricing.get("version") != 1 or pricing.get("kind") != "token_estimate":
        raise ValueError("Unsupported pricing schedule format")
    if pricing.get("input_includes_cached") is not True or pricing.get("output_includes_reasoning") is not True:
        raise ValueError("The pricing schedule must include cached input and reasoning output in token totals")
    rates = pricing.get("rates")
    for name in ("input", "output", "cache_read", "cache_creation"):
        value = rates.get(name) if isinstance(rates, dict) else None
        if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
            raise ValueError(f"The pricing rate {name} must be finite and nonnegative")
    return pricing


def verify_native_inputs(task):
    directory = ROOT / "benchmark/Kramabench/data/dsbench" / task["task_id"]
    if {file.name for file in directory.iterdir()} != set(task["allowed_files"]):
        raise ValueError(f"Native input mount differs: {task['task_id']}")
    for file in task["files"]:
        path = directory / file["name"]
        if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != file["sha256"]:
            raise ValueError(f"Native input hash differs: {task['task_id']}/{file['name']}")


def stop_native(config, destination):
    """Request a stop on an outer timeout; leave uncertain resources intact."""
    path = destination / "resource.json"
    if not path.exists():
        return
    resource = json.loads(path.read_text())
    if not resource.get("agentId"):
        return
    try:
        request = Request(config["endpoint"] + "/api/agents/" + resource["agentId"] + "/stop", method="POST")
        with urlopen(request, timeout=15) as response:
            status = response.status
        save(destination / "watchdog-stop.json", {"status": status})
    except Exception as error:
        save(destination / "watchdog-stop.json", {"error": str(error)})


def run_task(
    task,
    arm,
    *,
    output_root,
    endpoint,
    script_endpoint,
    shared_principles,
    pricing,
    model=DEFAULT_MODEL,
    destination=None,
    benchmark="dsbench",
    prompt=None,
    resource_scope=None,
    model_parameters=None,
    model_capabilities=None,
    expected_service_source_hashes=None,
    model_request_timeout_seconds=DEFAULT_MODEL_REQUEST_TIMEOUT_SECONDS,
):
    if model_request_timeout_seconds is not None:
        model_request_timeout_seconds = validate_model_request_timeout_seconds(model_request_timeout_seconds)
    if arm != "smol_custom" and benchmark == "dsbench":
        verify_native_inputs(task)
    destination = (
        Path(destination) if destination is not None else output_root / "system_scratch" / arm / task["task_id"]
    )
    destination.mkdir(parents=True, exist_ok=False)
    public_inputs = [dict(file) for file in task["files"]]
    config = {
        "task_id": task["task_id"],
        "arm": arm,
        "model": model,
        "reasoning_effort": "medium",
        "max_output_tokens": 8192,
        "task_timeout_seconds": 900,
        "model_sdk_retries": 0,
        "endpoint": endpoint,
        "script_endpoint": script_endpoint,
        "output_dir": str(destination),
        "input_path": task["input_path"],
        "input_relative_path": task.get("input_relative_path", f"dsbench/{task['task_id']}"),
        "allowed_files": task["allowed_files"],
        "input_files": public_inputs,
        "shared_principles": shared_principles,
        "shared_principles_sha256": hashlib.sha256(shared_principles.encode()).hexdigest(),
        "pricing": pricing,
        "settings": SMOL_SETTINGS if arm == "smol_custom" else {**NATIVE_SETTINGS, **ARMS[arm]},
        "prompt": prompt if prompt is not None else build_prompt(task, arm),
        "benchmark": benchmark,
        "resource_scope": resource_scope or {},
    }
    if model_parameters is not None:
        config["model_parameters"] = model_parameters
    if model_request_timeout_seconds is not None:
        config["model_request_timeout_seconds"] = model_request_timeout_seconds
    if model_capabilities is not None:
        config["model_capabilities"] = model_capabilities
    if expected_service_source_hashes is not None:
        config["expected_service_source_hashes"] = expected_service_source_hashes
    save(destination / "config.json", config)
    (destination / "prompt.txt").write_text(config["prompt"])
    save(
        destination / "started.json",
        {"started_at": datetime.now(timezone.utc).isoformat(), "task_id": task["task_id"], "arm": arm},
    )
    command = (
        [sys.executable, str(HERE / "smol_job.py")] if arm == "smol_custom" else ["bun", str(HERE / "native_job.ts")]
    ) + [str(destination / "config.json")]
    scope = resource_scope or {}
    started = time.monotonic()
    supervision_error = None
    try:
        supervised = supervise_adapter(
            command,
            directory=destination,
            timeout_seconds=config["task_timeout_seconds"] + 180,
            cwd=ROOT,
            env=os.environ.copy(),
            stdout_path=destination / "runner.log",
            resource_scope=scope,
            system="smolagents" if arm == "smol_custom" else "native",
            supervisor=run_supervised,
        )
        if supervised.timed_out and arm != "smol_custom":
            stop_native(config, destination)
    except Exception as failure:
        supervision_error = f"{type(failure).__name__}: {failure}"
        from types import SimpleNamespace

        supervised = SimpleNamespace(
            returncode=None, timed_out=False, wall_seconds=time.monotonic() - started, resources={}
        )
        save(destination / "supervision-error.json", {"error": supervision_error})
    stats_file = destination / "stats.json"
    if stats_file.exists():
        stats = json.loads(stats_file.read_text())
        stats["pricing"] = pricing
        try:
            stats["successful_call_cost_usd"] = (
                cost_module().compute_cost(
                    model,
                    pricing=pricing,
                    **{
                        name: stats.get(name, 0)
                        for name in ("input_tokens", "output_tokens", "cached_tokens", "cache_creation_tokens")
                    },
                )
                if pricing is not None and "input_tokens" in stats and "output_tokens" in stats
                else None
            )
        except (TypeError, ValueError, KeyError) as error:
            stats["successful_call_cost_usd"] = None
            stats["pricing_error"] = type(error).__name__
        stats["cost_usd"] = None if stats.get("usage_incomplete") else stats["successful_call_cost_usd"]
        save(stats_file, stats)
    else:
        stats = {"cost_usd": None, "usage_missing": True, "pricing": pricing}
        save(stats_file, stats)
    if not (destination / "response.txt").exists():
        (destination / "response.txt").write_text("")
    if not (destination / "answer.json").exists():
        save(destination / "answer.json", {"answer": (destination / "response.txt").read_text()})
    status_file = destination / "status.json"
    status = (
        json.loads(status_file.read_text())
        if status_file.exists()
        else {"completed": False, "error": "Worker did not save status"}
    )
    status.update(
        {
            "returncode": supervised.returncode,
            "harness_timeout": supervised.timed_out,
            "runner_seconds": supervised.wall_seconds,
            "supervision_error": getattr(supervised, "error", None),
        }
    )
    if supervision_error:
        status.update({"completed": False, "error": supervision_error})
    save(status_file, status)
    try:
        common = capture_model_accounting(
            destination,
            system="smolagents" if arm == "smol_custom" else "native",
            benchmark=benchmark,
            resources=supervised.resources,
        )
    except Exception as error:
        common = None
        save(destination / "accounting-error.json", {"type": type(error).__name__, "error": str(error)})
        stats.update({"usage_incomplete": True, "cost_usd": None})
        save(stats_file, stats)
    if common is not None:
        stats["legacy_observed_totals"] = {
            name: stats.get(name)
            for name in ("input_tokens", "output_tokens", "cached_tokens", "cache_creation_tokens", "reasoning_tokens")
        }
        for name in ("input_tokens", "output_tokens", "cached_tokens", "cache_creation_tokens", "reasoning_tokens"):
            stats[name] = common["usage"].get("cached_input_tokens" if name == "cached_tokens" else name)
        stats["observed_usage"] = common["observed_usage"]
        stats["total_tokens"] = common["usage"]["total_tokens"]
        stats["uncached_input_tokens"] = common["usage"]["uncached_input_tokens"]
        stats["usage_incomplete"] = not common["usage_complete"]
        stats["successful_call_cost_usd"] = common["cost"]["observed_cost_usd"]
        stats["cost_usd"] = common["cost"]["cost_usd"]
        stats["pricing_method"] = "shared runtime per transport request, preserving request tiers and unknown billing"
        save(stats_file, stats)
    elif arm != "smol_custom" and expected_service_source_hashes is not None:
        names = ("input_tokens", "output_tokens", "cached_tokens", "cache_creation_tokens", "reasoning_tokens")
        stats["legacy_observed_totals"] = {name: stats.get(name) for name in names}
        stats.update({name: None for name in (*names, "total_tokens", "uncached_input_tokens")})
        stats.update(
            {
                "usage_incomplete": True,
                "cost_usd": None,
                "model_calls_attempted": None,
                "model_calls_succeeded": None,
                "failed_model_calls": None,
            }
        )
        save(stats_file, stats)
    metrics = normalize_attempt(
        destination,
        system="smolagents" if arm == "smol_custom" else "native",
        task_wall_seconds=supervised.wall_seconds,
        resources=supervised.resources,
        benchmark=benchmark,
    )
    save(destination / "metrics.json", metrics)
    print(
        json.dumps(
            {
                "arm": arm,
                "model": model,
                "task_id": task["task_id"],
                "completed": status["completed"],
                "returncode": supervised.returncode,
                "cost_usd": stats["cost_usd"],
            }
        ),
        flush=True,
    )
    return status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--arm", choices=[*ARMS, "smol_custom"], required=True)
    parser.add_argument("--task-ids", nargs="+", required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--prepared-root", type=Path, required=True)
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Exact gateway model ID; reasoning remains medium")
    parser.add_argument("--pricing-json", type=Path, help="Frozen price_schedule JSON matching --model")
    parser.add_argument("--model-request-timeout-seconds", type=float, default=DEFAULT_MODEL_REQUEST_TIMEOUT_SECONDS)
    parser.add_argument("--endpoint", default=os.environ.get("TEXERA_AGENT_SERVICE_ENDPOINT", "http://localhost:3082"))
    parser.add_argument("--script-endpoint", default=os.environ.get("CODE_AGENT_API_BASE", "http://localhost:18000/v1"))
    parser.add_argument(
        "--shared-principles",
        type=Path,
        default=ROOT / "benchmark/Kramabench/judgment_runs/single_task_prompt_subset_20261008/shared-principles.txt",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Validate public inputs and print the protocol without creating agents"
    )
    args = parser.parse_args()
    args.model_request_timeout_seconds = validate_model_request_timeout_seconds(args.model_request_timeout_seconds)
    if not args.model.strip():
        parser.error("--model must be nonempty")
    pricing = load_pricing(args.model, args.pricing_json)
    _, tasks = load_tasks(args.prepared_root, args.task_ids)
    shared = args.shared_principles.read_text().strip()
    if shared.count("## Analysis principles") != 1:
        raise ValueError("Expected exactly one shared Analysis principles block")
    if args.dry_run:
        print(
            json.dumps(
                {
                    "arm": args.arm,
                    "model": args.model,
                    "task_ids": args.task_ids,
                    "settings": SMOL_SETTINGS if args.arm == "smol_custom" else {**NATIVE_SETTINGS, **ARMS[args.arm]},
                    "pricing": pricing,
                    "model_request_timeout_seconds": args.model_request_timeout_seconds,
                },
                indent=2,
            )
        )
        return
    output = args.output_root.resolve()
    for task in tasks:
        if (output / "system_scratch" / args.arm / task["task_id"]).exists():
            raise FileExistsError(f"Refusing to overwrite {args.arm}/{task['task_id']}")
    for task in tasks:
        status = run_task(
            task,
            args.arm,
            output_root=output,
            endpoint=args.endpoint,
            script_endpoint=args.script_endpoint,
            shared_principles=shared,
            pricing=pricing,
            model=args.model,
            model_request_timeout_seconds=args.model_request_timeout_seconds,
        )
        if status.get("provider_blocked"):
            raise SystemExit(42)
        if status.get("integrity_failure"):
            raise SystemExit(43)


if __name__ == "__main__":
    main()
