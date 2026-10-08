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
"""Legacy adapters have honest boundaries and preserve supervised failures."""
import json
import sys
from pathlib import Path
import subprocess
import os

import pytest

from benchmark.retrieval.attempt_runtime import supervise_adapter, record_adapter_metrics, validate_resource_scope


def test_legacy_adapter_failure_is_durable_and_distinguishes_grading_boundary(tmp_path):
    path = tmp_path / "attempt"
    result = supervise_adapter(
        [sys.executable, "-c", "raise SystemExit(3)"],
        directory=path,
        stdout_path=tmp_path / "stdout",
        cwd=tmp_path,
        env=None,
        timeout_seconds=10,
        system="smolagents",
        resource_scope={},
    )
    metrics = record_adapter_metrics(path, result, system="smolagents", model="exact", task_id="task", pricing=None)
    assert result.returncode == 3
    assert json.loads((path / "status.json").read_text())["completed"] is False
    assert metrics["cost"]["total_usd"] is None
    assert "includes official grading" in metrics["wall"]["boundary"]
    assert metrics["resources"]["cpu_total_seconds"] is not None


def test_script_measurement_parent_cannot_be_native_descendant():
    with pytest.raises(ValueError, match="sibling"):
        validate_resource_scope({"cgroup": {"name": "native"}, "script_cgroup_parent": "native/scripts"})


@pytest.mark.parametrize("official_first", [False, True])
def test_original_kb_evaluator_and_shared_runtime_coexist_in_original_python(official_first):
    root = Path(__file__).resolve().parents[2]
    code = f"""
import sys
sys.path.insert(0, {str(root / 'benchmark/Kramabench')!r})
if {official_first!r}:
    from benchmark.benchmark import Evaluator
sys.path.insert(0, {str(root / 'benchmark/retrieval')!r})
import attempt_runtime
from benchmark.benchmark import Evaluator
from benchmark.runtime import AttemptMetrics
print(Evaluator.__module__, AttemptMetrics.__module__)
"""
    result = subprocess.run(
        [str(root / "benchmark/Kramabench/.venv/bin/python"), "-c", code],
        cwd=root,
        env={**os.environ, "OPENAI_API_KEY": "offline-test-placeholder"},
        text=True,
        capture_output=True,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "benchmark.benchmark benchmark.runtime.metrics"


def test_namespace_bridge_resolves_official_module_in_root_python():
    root = Path(__file__).resolve().parents[2]
    code = f"""
import sys, importlib.util
sys.path.insert(0, {str(root / 'benchmark/retrieval')!r})
import attempt_runtime
print(importlib.util.find_spec('benchmark.benchmark').origin)
"""
    result = subprocess.run([sys.executable, "-c", code], cwd=root, text=True, capture_output=True)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == str(root / "benchmark/Kramabench/benchmark/benchmark.py")


def test_native_ledger_and_journal_are_captured_before_cleanup(tmp_path, monkeypatch):
    from benchmark.retrieval.attempt_runtime import capture_agent_ledger

    ledger = {"version": 1, "source": "transport", "requests": [{"requestId": "retry", "status": "http_error"}]}

    class Response:
        def raise_for_status(self):
            pass

        def json(self):
            return ledger

    import requests

    monkeypatch.setattr(requests, "get", lambda *args, **kwargs: Response())
    journal = tmp_path / "journal/agent/model-requests.jsonl"
    journal.parent.mkdir(parents=True)
    journal.write_text('{"requestId":"retry","status":"pending"}\n')
    monkeypatch.setenv("MODEL_REQUEST_JOURNAL_DIR", str(tmp_path / "journal"))
    directory = tmp_path / "attempt"
    capture_agent_ledger(directory, "http://local-service", "agent")
    assert json.loads((directory / "model-accounting.json").read_text()) == ledger
    assert (directory / "model-request-journal.jsonl").read_text() == journal.read_text()


def test_legacy_native_timeout_keeps_exact_raw_window_but_lifecycle_incomplete(tmp_path):
    from types import SimpleNamespace

    resources = {
        "scope": {"complete": True},
        "measurement": {"cpu": {"complete": True, "exact": True}, "memory": {"complete": True, "exact": True}},
        "cpu_total_seconds": 3,
        "peak_memory_bytes": 1000,
    }
    result = SimpleNamespace(returncode=-15, timed_out=True, wall_seconds=10, resources=resources)
    metric = record_adapter_metrics(
        tmp_path,
        result,
        system="native",
        model="exact",
        task_id="task",
        pricing=None,
        resource_scope={"ownership_verified": True, "owned_service_pids": {"agent-service": 1}},
    )
    assert metric["resource_completeness"]["complete"] is False
    assert "watchdog" in metric["resource_completeness"]["reason"]
    assert metric["resources"]["measurement"]["cpu"]["exact"] is True
