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
"""One supervisor and resource policy for matrix and original KB adapters."""
from contextlib import ExitStack
from dataclasses import replace
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
import benchmark  # noqa: E402

# The original harness also owns a package named benchmark. Both package
# roots must remain reachable when a legacy launcher imports the shared runtime.
for package in (ROOT / "benchmark", ROOT / "benchmark/Kramabench/benchmark"):
    if str(package) not in benchmark.__path__:
        benchmark.__path__.append(str(package))

from benchmark.runtime import (  # noqa: E402
    CgroupScope,
    ComponentResourceCollector,
    ProcessResourceCollector,
    provision_cgroup,
    cleanup_cgroup,
    run_supervised,
)
from benchmark.dsbench.accounting import capture_model_accounting  # noqa: E402
from benchmark.dsbench.metrics import normalize_attempt, read_json  # noqa: E402


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, default=str) + "\n")


def validate_resource_scope(scope):
    native_name = scope.get("cgroup", {}).get("name")
    script_parent = scope.get("script_cgroup_parent")
    if native_name and script_parent and (script_parent == native_name or script_parent.startswith(native_name + "/")):
        raise ValueError("Script measurement must use a sibling parent, outside the native service cgroup")


def component_scope(entry):
    return CgroupScope.from_dict(entry.get("cgroup", entry))


def supervise_adapter(
    command,
    *,
    directory,
    stdout_path,
    cwd,
    env,
    timeout_seconds,
    system,
    resource_scope=None,
    terminate_grace_seconds=20,
    supervisor=None,
):
    scope = resource_scope or {}
    validate_resource_scope(scope)
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    cgroup, script_scope = scope.get("cgroup") if system == "native" else None, None
    if system != "native" and scope.get("script_cgroup_parent"):
        key = hashlib.sha256(str(directory.resolve()).encode()).hexdigest()[:24]
        script_scope = provision_cgroup(scope["script_cgroup_parent"] + "/attempt-" + key)
        cgroup = script_scope.as_dict()
    if scope.get("require_complete_resources") and not cgroup:
        raise RuntimeError("Complete resource measurement requires an owned native group or a fresh script group")
    try:
        with ExitStack() as collectors:
            shared = {}
            for label, entry in scope.get("shared_components", {}).items():
                component = component_scope(entry)
                shared[label] = collectors.enter_context(
                    ProcessResourceCollector(
                        root_pids=entry.get(
                            "root_pids", [component.metadata["pid"]] if component.metadata.get("pid") else []
                        ),
                        cgroup=component,
                    )
                )
                if scope.get("require_complete_resources"):
                    shared[label].validate_ready()
            bundle = None
            if system == "native" and scope.get("native_dependencies"):
                components = {label: component_scope(entry) for label, entry in scope["native_dependencies"].items()}
                if cgroup:
                    components["engine"] = replace(CgroupScope.from_dict(cgroup), reset_peak=False, fresh=False)
                bundle = collectors.enter_context(ComponentResourceCollector(components))
                if scope.get("require_complete_resources"):
                    bundle.validate_ready(skip_labels=("engine",))
            result = (supervisor or run_supervised)(
                command,
                timeout_seconds=timeout_seconds,
                cwd=cwd,
                env=env,
                stdout_path=stdout_path,
                stderr_path=Path(stdout_path).with_name(Path(stdout_path).name + ".stderr"),
                owned_service_pids=scope.get("owned_service_pids") if system == "native" else None,
                required_service_labels=scope.get("required_service_labels") if system == "native" else None,
                ownership_verified=scope.get("ownership_verified", False),
                scope_kind=scope.get("kind", "native_system") if system == "native" else "process_tree",
                cgroup=cgroup,
                terminate_grace_seconds=terminate_grace_seconds,
                require_complete_resources=scope.get("require_complete_resources", False),
            )
        result.resources["shared_components"] = {label: collector.finish() for label, collector in shared.items()}
        if bundle:
            total = bundle.finish()
            result.resources["engine_scope"] = dict(result.resources)
            result.resources["sut_components"] = total
            for key in (
                "cpu_user_seconds",
                "cpu_system_seconds",
                "cpu_total_seconds",
                "peak_memory_bytes",
                "scope",
                "measurement",
            ):
                result.resources[key] = total[key]
            result.resources["measurement"]["cpu"]["complete"] = total["measurement"]["cpu"]["exact"]
        save(directory / "supervision.json", result.as_dict())
        return result
    finally:
        if script_scope:
            save(directory / "cgroup-cleanup.json", cleanup_cgroup(script_scope))


def record_adapter_metrics(directory, result, *, system, model, task_id, pricing, resource_scope=None):
    """The original adapter runs evaluation inside its supervised process."""
    directory = Path(directory)
    stats = read_json(directory / "stats.json", {})
    status = read_json(directory / "status.json", {})
    status.update(
        {
            "completed": result.returncode == 0 and not result.timed_out and stats.get("state", "success") == "success",
            "returncode": result.returncode,
            "harness_timeout": result.timed_out,
            "runner_seconds": result.wall_seconds,
        }
    )
    save(directory / "status.json", status)
    if not (directory / "response.txt").exists():
        (directory / "response.txt").write_text("")
    config = read_json(directory / "config.json", {})
    try:
        common = capture_model_accounting(
            directory,
            system=system,
            benchmark="kramabench",
            resources=result.resources,
            config_override={**config, "model": model, "task_id": task_id, "pricing": pricing},
            wall_boundary="legacy adapter launch through exit; includes official grading",
        )
    except Exception as error:
        common = None
        save(directory / "accounting-error.json", {"type": type(error).__name__})
    metric = normalize_attempt(
        directory,
        system=system,
        task_wall_seconds=result.wall_seconds,
        resources=result.resources,
        benchmark="kramabench",
    )
    metric["wall"][
        "boundary"
    ] = "legacy adapter launch through exit; includes official grading; not comparable to solve-only or matrix agent wall"
    metric["wall"]["agent_solve_seconds"] = stats.get("elapsed_seconds")
    metric["resources"]["boundary"] = metric["wall"]["boundary"]
    if common:
        metric["cost"]["scope"] += "; model request ledger excludes evaluator calls"
        canonical = {
            "legacy_stats": stats,
            "pricing": pricing,
            "observed_usage": common["observed_usage"],
            "cost_usd": common["cost"]["cost_usd"],
            "successful_call_cost_usd": common["cost"]["observed_cost_usd"],
            "usage_incomplete": not common["usage_complete"],
            "num_steps": stats.get("num_steps"),
            "elapsed_seconds": stats.get("elapsed_seconds"),
            "state": stats.get("state"),
            "total_tokens": common["usage"]["total_tokens"],
            "uncached_input_tokens": common["usage"]["uncached_input_tokens"],
        }
        for name in ("input_tokens", "output_tokens", "cached_tokens", "cache_creation_tokens", "reasoning_tokens"):
            canonical[name] = common["usage"].get("cached_input_tokens" if name == "cached_tokens" else name)
        save(directory / "stats.json", canonical)
    if system == "native" and resource_scope:
        metric["resource_completeness"]["scope_declared"] = resource_scope
        resource = result.resources
        metric["resource_completeness"]["scope_complete"] = bool(resource.get("scope", {}).get("complete"))
        metric["resource_completeness"]["complete"] = all(
            (metric["resource_completeness"][name] for name in ("scope_complete", "cpu_complete", "memory_complete"))
        )
        if metric["resource_completeness"]["complete"]:
            metric["resource_completeness"]["reason"] = None
    if system == "native" and common is None:
        metric.update({"usage_complete": False, "request_accounting_source": "unknown_required_transport_ledger"})
        metric["requests"] = {name: None for name in metric["requests"]}
        metric["tokens"] = {name: None for name in metric["tokens"]}
        metric["cost"].update({"complete": False, "total_usd": None})
        incomplete = {
            **stats,
            "legacy_observed_totals": stats,
            "usage_incomplete": True,
            "cost_usd": None,
            "model_calls_attempted": None,
            "model_calls_succeeded": None,
            "failed_model_calls": None,
        }
        incomplete.update({name: None for name in metric["tokens"]})
        save(directory / "stats.json", incomplete)
    if system == "native" and result.timed_out:
        metric["resource_completeness"].update(
            {
                "complete": False,
                "reason": "Native watchdog stop/cleanup occurs outside the supervised measurement window; full lifecycle coverage is incomplete.",
            }
        )
    if (directory / "accounting-error.json").exists():
        metric["usage_complete"] = False
        metric["cost"].update({"complete": False, "total_usd": None})
    save(directory / "metrics.json", metric)
    return metric


def capture_agent_ledger(directory, endpoint, agent_id):
    """Capture before the original harness destroys this task's native agent."""
    import requests

    directory = Path(directory)
    try:
        response = requests.get(endpoint.rstrip("/") + "/api/agents/" + agent_id + "/model-metrics", timeout=30)
        response.raise_for_status()
        ledger = response.json()
        save(directory / "model-accounting.json", ledger)
        (directory / "model-requests.jsonl").write_text("".join(json.dumps(row) + "\n" for row in ledger["requests"]))
    except Exception as error:
        save(directory / "model-accounting-fetch-error.json", {"type": type(error).__name__})
    journal_root = (
        os.environ.get("MODEL_REQUEST_JOURNAL_DIR")
        or os.environ.get("TEXERA_LLM_TRACE_DIR")
        or str(Path(tempfile.gettempdir()) / "texera-agent-model-requests")
    )
    journal = Path(journal_root) / agent_id / "model-requests.jsonl"
    if journal.is_file():
        shutil.copyfile(journal, directory / "model-request-journal.jsonl")


def record_provider_block(directory, *, fact, task_id, system):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    save(directory / "preflight.json", fact)
    save(
        directory / "status.json",
        {
            "completed": False,
            "state": "preflight_blocked",
            "provider_blocked": True,
            "error": fact.get("blocked_reason"),
            "inference_requests_attempted": 0,
        },
    )
    save(
        directory / "stats.json",
        {
            "input_tokens": 0,
            "output_tokens": 0,
            "cached_tokens": 0,
            "cache_creation_tokens": 0,
            "reasoning_tokens": 0,
            "cost_usd": 0,
        },
    )
    (directory / "response.txt").write_text("")
    (directory / "model-request-trace.jsonl").write_text("")
    save(directory / "react_steps.json", [])
    metric = normalize_attempt(directory, system=system, task_wall_seconds=0, benchmark="kramabench")
    metric["wall"][
        "boundary"
    ] = "Frozen provider preflight blocked this declared attempt; no child or inference launched"
    save(directory / "metrics.json", metric)
    return {
        "task": task_id,
        "exit_code": None,
        "timeout": False,
        "provider_blocked": True,
        "score": None,
        "cost_usd": 0,
        "seconds": 0,
        "normalized_metrics": metric,
    }
