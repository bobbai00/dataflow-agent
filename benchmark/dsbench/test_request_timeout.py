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
"""Common limits reach the exact worker client without provider calls."""

from types import SimpleNamespace
import json
import math
import sys
import time

from openai import OpenAI
import pytest

from benchmark.dsbench import smol_job
from benchmark.runtime.model_deadline import ModelRequestTimeoutError
from benchmark.runtime.model_limits import validate_model_request_timeout_seconds


@pytest.mark.parametrize("value", [None, True, "240", 0, -1, float("nan"), float("inf"), 0.00001, 2_147_484, 10**1000])
def test_invalid_common_timeout_is_rejected(value):
    with pytest.raises(ValueError, match="positive seconds"):
        validate_model_request_timeout_seconds(value)


@pytest.mark.parametrize("value", [1.001, 4.001, 2_147_483.647])
def test_exact_millisecond_timeouts_are_accepted_despite_binary_float_product(value):
    assert validate_model_request_timeout_seconds(value) == value


@pytest.mark.parametrize("value", [1.0005, math.nextafter(1.001, math.inf), 1e308])
def test_fractional_milliseconds_and_finite_out_of_range_float_are_rejected(value):
    with pytest.raises(ValueError, match="positive seconds"):
        validate_model_request_timeout_seconds(value)


def test_smol_sdk_client_uses_common_numeric_timeout_and_zero_retries_without_inference():
    for config, expected in [({}, 240), ({"model_request_timeout_seconds": 0.125}, 0.125)]:
        options = smol_job.model_client_kwargs(config)
        client = OpenAI(api_key="offline-only", base_url="http://127.0.0.1:1/v1", **options)
        try:
            assert client.timeout == expected
            assert client.max_retries == 0
            assert client._client.timeout.read == expected
            assert client._client.timeout.connect == expected
        finally:
            client.close()


def test_actual_smol_completion_wrapper_enforces_absolute_deadline_on_activity():
    started = time.monotonic()

    def dribble(**kwargs):
        while time.monotonic() - started < 0.3:
            time.sleep(0.01)
        return "would pass an inactivity limit"

    with pytest.raises(ModelRequestTimeoutError):
        smol_job.completion_with_deadline(dribble, 0.04, model="exact-route")


@pytest.mark.parametrize("seconds", [240, 125])
def test_future_manifest_locks_common_deadline_without_outputs_or_provider_calls(tmp_path, monkeypatch, seconds):
    from benchmark import experiment_matrix as matrix

    facts = tmp_path / "facts.json"
    facts.write_text(
        json.dumps({"models": [{"requested_model": "exact", "native_model_id": "exact", "available": True}]})
    )
    principles = tmp_path / "principles.txt"
    principles.write_text("## Analysis principles\nOriginal frozen instructions")
    monkeypatch.setattr(matrix.ds_runner, "load_tasks", lambda *args: ({}, []))
    monkeypatch.setattr(matrix, "kb_tasks", lambda *args: [])
    monkeypatch.setattr(matrix, "source_inventory", lambda: {"source": "offline"})
    monkeypatch.setattr(matrix.subprocess, "check_output", lambda *args, **kwargs: "offline-ref\n")
    args = SimpleNamespace(
        model_facts=facts,
        models=None,
        ds_prepared_root=tmp_path,
        ds_tasks=[],
        kb_tasks=[],
        native_source_data=tmp_path,
        dry_run=True,
        shared_principles=principles,
        owned_services=None,
        component_scopes=None,
        endpoint="offline",
        script_endpoint="offline",
        scorer_python=tmp_path,
        model_request_timeout_seconds=seconds,
    )
    manifest = matrix.make_manifest(args)
    assert manifest["model_request_timeout_seconds"] == seconds
    matrix.freeze_manifest(tmp_path / "future", manifest)
    assert json.loads((tmp_path / "future/manifest.json").read_text())["model_request_timeout_seconds"] == seconds


@pytest.mark.parametrize("seconds", [None, "125"])
def test_matrix_prepare_cli_passes_common_timeout_to_manifest_builder(tmp_path, monkeypatch, capsys, seconds):
    from benchmark import experiment_matrix as matrix

    captured = []

    def manifest(args):
        captured.append(args.model_request_timeout_seconds)
        return {"jobs": [], "models": [], "tasks": []}

    monkeypatch.setattr(matrix, "make_manifest", manifest)
    argv = [
        "matrix",
        "prepare",
        "--output",
        str(tmp_path),
        "--model-facts",
        "offline.json",
        "--ds-prepared-root",
        str(tmp_path),
        "--dry-run",
    ]
    if seconds is not None:
        argv += ["--model-request-timeout-seconds", seconds]
    monkeypatch.setattr(sys, "argv", argv)
    matrix.main()
    capsys.readouterr()
    assert captured == [240 if seconds is None else 125]


@pytest.mark.parametrize("seconds", [None, 125])
def test_locked_matrix_forwards_explicit_timeout_and_preserves_legacy_omission(tmp_path, monkeypatch, seconds):
    from benchmark import experiment_matrix as matrix

    job = {
        "benchmark": "dsbench",
        "task_id": "offline",
        "requested_model": "exact",
        "model": "exact",
        "arm": "smol_custom",
        "attempt_id": "offline",
    }
    manifest = {
        "native_settings": matrix.ds_runner.NATIVE_SETTINGS,
        "smol_settings": matrix.ds_runner.SMOL_SETTINGS,
        "source_hashes": {},
        "models": [{"requested_model": "exact", "available": True}],
        "tasks": [{"benchmark": "dsbench", "task_id": "offline"}],
        "jobs": [job],
        "endpoint": "offline",
        "script_endpoint": "offline",
        "shared_principles": "Original prompt",
        "resource_scope": None,
    }
    if seconds is not None:
        manifest["model_request_timeout_seconds"] = seconds
    (tmp_path / "manifest.json").write_text(json.dumps(manifest))
    monkeypatch.setattr(matrix, "verify_frozen_sources", lambda *args: None)
    monkeypatch.setattr(matrix, "verify_task", lambda *args: None)
    monkeypatch.setattr(matrix, "pending_jobs", lambda *args: [job])
    monkeypatch.setattr(matrix, "build_prompt", lambda *args: "Original prompt")
    captured = []

    def capture_before_inference(task, arm, **kwargs):
        captured.append(kwargs)

    monkeypatch.setattr(matrix.ds_runner, "run_task", capture_before_inference)
    matrix._run_matrix_locked(tmp_path)
    assert len(captured) == 1
    assert captured[0]["model_request_timeout_seconds"] == seconds
    assert captured[0]["model"] == "exact"
    assert captured[0]["prompt"] == "Original prompt"
