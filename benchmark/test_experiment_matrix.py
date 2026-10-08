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
"""A frozen matrix keeps unavailable models, failures and immutable attempts."""

import json
from pathlib import Path

import pytest

from benchmark.experiment_matrix import build_jobs, freeze_manifest, pending_jobs, blocked_attempt, stage_task


def test_matrix_declares_240_attempts_without_model_substitution():
    models = [
        {"requested_model": f"provider/model-{n}", "native_model_id": f"alias-{n}", "available": n != 5}
        for n in range(6)
    ]
    tasks = [
        {"benchmark": benchmark, "task_id": f"task-{n}"} for benchmark in ("kramabench", "dsbench") for n in range(5)
    ]
    jobs = build_jobs(models, tasks)
    assert len(jobs) == 240
    assert len({j["attempt_id"] for j in jobs}) == 240
    assert {j["requested_model"] for j in jobs} == {m["requested_model"] for m in models}
    assert sum(j["requested_model"] == "provider/model-5" for j in jobs) == 40
    assert jobs == build_jobs(models, tasks)


def test_resume_never_overwrites_completed_or_interrupted_attempt(tmp_path):
    job = build_jobs(
        [{"requested_model": "exact", "native_model_id": "exact", "available": True}],
        [{"benchmark": "dsbench", "task_id": "task"}],
    )[0]
    manifest = {"jobs": [job], "protocol": "unchanged"}
    freeze_manifest(tmp_path, manifest)
    freeze_manifest(tmp_path, manifest)
    with pytest.raises(ValueError, match="differs"):
        freeze_manifest(tmp_path, {**manifest, "protocol": "changed"})
    directory = tmp_path / "attempts" / job["attempt_id"]
    directory.mkdir(parents=True)
    (directory / "started.json").write_text("{}")
    assert pending_jobs(tmp_path, [job]) == []
    assert json.loads((directory / "status.json").read_text())["state"] == "interrupted"
    assert pending_jobs(tmp_path, [job]) == []


def test_unavailable_model_is_explicit_preflight_block_not_fake_request(tmp_path):
    job = build_jobs(
        [{"requested_model": "unavailable", "native_model_id": "unavailable", "available": False}],
        [{"benchmark": "dsbench", "task_id": "task"}],
    )[0]
    directory = tmp_path / job["attempt_id"]
    blocked_attempt(directory, job, {"available": False, "blocked_reason": "missing provider credential"})
    metrics = json.loads((directory / "metrics.json").read_text())
    status = json.loads((directory / "status.json").read_text())
    assert status["provider_blocked"] is True
    assert status["state"] == "preflight_blocked"
    assert metrics["requests"]["attempted"] == 0
    assert metrics["cost"]["total_usd"] == 0
    assert (directory / "model-request-trace.jsonl").is_file()


def test_original_selected_files_staged_identically_without_sibling_inputs(tmp_path):
    import hashlib

    source = tmp_path / "original"
    (source / "nested").mkdir(parents=True)
    original = source / "nested/book.xlsx"
    original.write_bytes(b"original workbook bytes")
    (source / "answer.json").write_text("must remain outside input mount")
    task = {
        "task_id": "domain-easy-1",
        "input_path": str(source),
        "files": [{"name": "nested/book.xlsx", "sha256": hashlib.sha256(original.read_bytes()).hexdigest()}],
    }
    staged = stage_task(task, tmp_path / "native-data")
    target = Path(staged["input_path"])
    assert (target / "nested/book.xlsx").read_bytes() == original.read_bytes()
    assert not (target / "answer.json").exists()
    assert {str(path.relative_to(target)) for path in target.rglob("*") if path.is_file()} == {"nested/book.xlsx"}
    assert stage_task(task, tmp_path / "native-data") == staged


def test_freeze_inventory_covers_loaded_agent_and_executor_dependencies():
    from benchmark.experiment_matrix import source_inventory

    sources = source_inventory()
    assert "agent-service/src/agent/prompts/single-task-principles.md" in sources
    assert "agent-service/src/agent/native/python/runtime.py" in sources
    assert "benchmark/runtime/resources.py" in sources
    assert "benchmark/retrieval/native_isolated_python.py" in sources
    assert "benchmark/model_registry.py" in sources
    assert "agent-service/bun.lock" in sources
    assert "uv.lock" in sources
    assert "bin/single-node/litellm-config.yaml" in sources


def test_report_keeps_unscored_and_unmeasured_attempts_unknown(tmp_path):
    from benchmark.experiment_matrix import report_matrix

    jobs = build_jobs(
        [{"requested_model": "exact", "native_model_id": "exact"}], [{"benchmark": "dsbench", "task_id": "task"}]
    )
    freeze_manifest(tmp_path, {"jobs": jobs, "selection": "diagnostic", "attempt_policy": "one"})
    report = report_matrix(tmp_path)
    assert len(report["attempts"]) == 4
    assert all(row["mean_official_score"] is None and row["agent_cost_usd"] is None for row in report["summary"])
    assert all(row["wall_seconds"]["total"] is None for row in report["summary"])
    assert all(row["tokens"]["input_tokens"]["total"] is None for row in report["summary"])


@pytest.mark.parametrize("coverage", ["partial", "missing", "legacy"])
def test_report_distinguishes_observed_actions_from_complete_counts(tmp_path, coverage):
    from benchmark.dsbench.metrics import normalize_attempt
    from benchmark.experiment_matrix import report_matrix

    jobs = [
        job
        for job in build_jobs(
            [{"requested_model": "exact", "native_model_id": "exact"}],
            [{"benchmark": "dsbench", "task_id": f"task-{n}"} for n in range(2)],
        )
        if job["arm"] == "bob_both"
    ]
    freeze_manifest(tmp_path, {"jobs": jobs, "selection": "diagnostic", "attempt_policy": "one"})
    for index, job in enumerate(jobs):
        if index == 0 and coverage == "missing":
            continue
        directory = tmp_path / "attempts" / job["attempt_id"]
        directory.mkdir(parents=True)
        call_input = "invalid JSON input" if index == 0 and coverage == "partial" else {"actions": [{"type": "edit"}]}
        # A complete native action trace records the result as well as the request.
        step = {"toolCalls": [{"toolCallId": "fixture", "input": call_input}]}
        if isinstance(call_input, dict):
            step["toolResults"] = [
                {
                    "toolCallId": "fixture",
                    "isError": False,
                    "output": {
                        "status": "completed",
                        "actions": [{"index": 1, "status": "ok", "action": {"type": "edit"}}],
                    },
                }
            ]
        (directory / "react_steps.json").write_text(json.dumps([step]))
        metrics = normalize_attempt(directory, system="native", task_wall_seconds=1)
        if coverage == "legacy":
            metrics["actions"].pop("complete")
        (directory / "metrics.json").write_text(json.dumps(metrics))
    summary = report_matrix(tmp_path)["summary"][0]
    assert summary["actions"] == (2 if coverage == "legacy" else None)
    assert summary["actions_observed"] == (2 if coverage == "legacy" else 1)
    assert summary["actions_complete_attempts"] == (2 if coverage == "legacy" else 1)


def test_original_local_symlink_keeps_logical_basename_and_stages_bytes(tmp_path):
    import hashlib

    source = tmp_path / "input"
    (source / "archive").mkdir(parents=True)
    original = source / "archive/book.csv"
    original.write_bytes(b"original bytes")
    (source / "book.csv").symlink_to("archive/book.csv")
    task = {
        "task_id": "legal-easy-3",
        "input_path": str(source),
        "files": [{"name": "book.csv", "sha256": hashlib.sha256(original.read_bytes()).hexdigest()}],
    }
    staged = stage_task(task, tmp_path / "native")
    target = Path(staged["input_path"]) / "book.csv"
    assert not target.is_symlink()
    assert target.read_bytes() == original.read_bytes()


def test_uncertain_native_cleanup_stops_future_serial_launches(tmp_path):
    from benchmark.experiment_matrix import native_cleanup_safe

    (tmp_path / "resource.json").write_text('{"agentId":"live","wid":123}')
    (tmp_path / "cleanup.json").write_text('{"removed":false,"reason":"active execution"}')
    assert native_cleanup_safe(tmp_path) is False
    (tmp_path / "cleanup.json").write_text('{"removed":true}')
    assert native_cleanup_safe(tmp_path) is True


def test_startup_source_inventory_matches_server_exact_rule():
    from benchmark.experiment_matrix import source_inventory, ROOT

    frozen = source_inventory()
    actual = {
        str(path.relative_to(ROOT)): frozen[str(path.relative_to(ROOT))]
        for path in (ROOT / "agent-service/src").rglob("*")
        if path.is_file()
        and not path.is_symlink()
        and path.suffix.lower() in {".ts", ".tsx", ".js", ".jsx", ".py", ".json", ".md", ".txt", ".yaml", ".yml"}
        and not path.name.endswith(".test.ts")
    }
    expected = {
        relative: value
        for relative, value in frozen.items()
        if relative.startswith("agent-service/src/") and not relative.endswith(".test.ts")
    }
    assert expected == actual
    assert "agent-service/package.json" in frozen and "agent-service/bun.lock" in frozen


def test_source_drift_is_checked_before_the_next_job(tmp_path, monkeypatch):
    import benchmark.experiment_matrix as matrix
    from benchmark.dsbench import run as ds_runner

    source = tmp_path / "source.py"
    source.write_text("frozen")
    model = {"requested_model": "blocked", "native_model_id": "exact", "available": False}
    task = {
        "benchmark": "kramabench",
        "task_id": "task",
        "input_path": str(tmp_path),
        "input_relative_path": "task",
        "files": [],
        "allowed_files": [],
        "question": "Q",
    }
    jobs = build_jobs([model], [task])
    freeze_manifest(
        tmp_path,
        {
            "jobs": jobs,
            "models": [model],
            "tasks": [task],
            "native_settings": ds_runner.NATIVE_SETTINGS,
            "smol_settings": ds_runner.SMOL_SETTINGS,
            "source_hashes": {"source.py": matrix.digest(source)},
        },
    )
    monkeypatch.setattr(matrix, "ROOT", tmp_path)
    calls = []

    def block(*args, **kwargs):
        calls.append(args)
        source.write_text("changed")

    monkeypatch.setattr(matrix, "blocked_attempt", block)
    with pytest.raises(ValueError, match="source changed"):
        matrix.run_matrix(tmp_path)
    assert len(calls) == 1
