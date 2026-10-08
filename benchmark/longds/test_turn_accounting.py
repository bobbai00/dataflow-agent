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
"""Per-turn metrics keep shared-session accounting and unknown costs honest."""

import json
import pytest

from turn_accounting import (
    finish_turn_metrics,
    load_pricing_snapshot,
    select_new_requests,
)
from runtime.metrics import AttemptMetrics


def attempt():
    return AttemptMetrics(
        "turn1", benchmark="longds", system="native", task_id="session/t1"
    )


def ledger():
    return {
        "version": 1,
        "source": "transport",
        "messageId": "m1",
        "usageStatus": "complete",
        "requests": [
            {
                "requestId": "r1",
                "messageId": "m1",
                "requestedModel": "route",
                "status": "succeeded",
                "usage": {
                    "inputTokens": 100,
                    "outputTokens": 20,
                    "totalTokens": 120,
                    "cachedInputTokens": 40,
                    "cacheCreationInputTokens": 20,
                    "reasoningTokens": 10,
                },
                "rawUsage": {},
            }
        ],
    }


def test_transport_accounting_yields_observed_totals_with_unknown_unpriced_cost():
    result = finish_turn_metrics(attempt(), ledger(), usage={"input_tokens": 999})
    assert result["observed_usage"]["input_tokens"] == 100
    assert result["cost"]["cost_usd"] is None
    assert result["model_calls"]["attempted"] == 1
    assert result["resources"]["status"] == "unavailable"


def test_old_service_step_usage_is_observed_but_not_complete_request_accounting():
    result = finish_turn_metrics(
        attempt(),
        None,
        usage={"input_tokens": 100, "output_tokens": 20, "cached_input_tokens": 40},
    )
    assert result["usage"]["input_tokens"] is None
    assert result["observed_usage"]["input_tokens"] == 100
    assert result["model_calls"]["attempted"] is None
    assert result["cost"]["cost_usd"] is None
    assert result["model_accounting"]["status"] == "unavailable"


def test_shared_session_snapshot_excludes_prior_turn_requests_without_mutating_source():
    source = ledger()
    source["requests"].append(
        {"requestId": "r2", "messageId": "m2", "status": "pending", "usage": None}
    )
    selected = select_new_requests(source, {"r1"})
    assert [r["requestId"] for r in selected["requests"]] == ["r2"]
    assert selected["usageStatus"] == "unknown"
    assert selected["messageId"] == "m2"
    assert len(source["requests"]) == 2


def test_loads_only_exact_model_from_frozen_registry_and_hashes_snapshot(tmp_path):
    path = tmp_path / "prices.json"
    pricing = {
        "model": "route",
        "rates": {
            "input": 1e-6,
            "output": 2e-6,
            "cache_read": 0.1e-6,
            "cache_creation": 1.25e-6,
        },
        "source": {"url": "https://example.test"},
    }
    path.write_text(
        json.dumps({"models": [{"native_model_id": "route", "pricing": pricing}]})
    )
    frozen = load_pricing_snapshot(path, "route")
    assert len(frozen.source["snapshot_sha256"]) == 64
    assert frozen.model == "route"
    assert load_pricing_snapshot(path, "other") is None
    result = finish_turn_metrics(attempt(), ledger(), pricing=frozen)
    assert result["cost"]["cost_usd"] == pytest.approx(109e-6)


def test_duplicate_price_records_are_rejected(tmp_path):
    path = tmp_path / "prices.json"
    path.write_text(
        json.dumps({"models": [{"native_model_id": "route", "pricing": None}] * 2})
    )
    with pytest.raises(ValueError, match="ambiguous"):
        load_pricing_snapshot(path, "route")


def test_session_resource_summary_keeps_window_coverage_distinct_from_wall():
    from turn_accounting import aggregate_turn_resources

    value = aggregate_turn_resources(
        [
            {
                "cpu_user_seconds": 1,
                "cpu_system_seconds": 2,
                "cpu_total_seconds": 3,
                "peak_memory_bytes": 10,
            },
            {
                "cpu_user_seconds": 4,
                "cpu_system_seconds": 5,
                "cpu_total_seconds": 9,
                "peak_memory_bytes": 20,
            },
        ],
        wall_seconds=100,
    )
    assert value["cpu_total_seconds"] == 12
    assert value["peak_memory_bytes"] == 20
    assert value["wall_seconds"] == 100
    assert not value["measurement"]["cpu"]["complete"]
    assert not value["measurement"]["memory"]["whole_session_peak"]


@pytest.mark.parametrize("full_scope", [False, True])
def test_runner_preserves_one_session_and_writes_receipts_for_every_turn(
    tmp_path, monkeypatch, full_scope
):
    import importlib
    from types import SimpleNamespace
    from unittest.mock import Mock

    monkeypatch.setattr("os.chdir", lambda _: None)
    run = importlib.import_module("run_longds")
    from contextlib import contextmanager

    active = {"session": False}
    full_resources = {
        "status": "available",
        "cpu_total_seconds": 12,
        "peak_memory_bytes": 999,
        "scope": {"complete": True},
        "measurement": {"cpu": {"complete": True}, "memory": {"complete": True}},
    }

    @contextmanager
    def session_window(scope):
        active["session"] = full_scope
        try:
            yield (
                SimpleNamespace(resources=full_resources.copy()) if full_scope else None
            )
        finally:
            active["session"] = False

    @contextmanager
    def turn_window(scope):
        yield SimpleNamespace(
            resources={"status": "unavailable", "reason": "mocked_scope"}
        )

    monkeypatch.setattr(run, "session_resource_window", session_window)
    monkeypatch.setattr(run, "native_resource_window", turn_window)
    from dataflow_agent import MessageResult
    import arms
    import dataflow_agent
    import requests

    prepared, scratch = tmp_path / "prepared", tmp_path / "scratch"
    task_dir = prepared / "task"
    task_dir.mkdir(parents=True)
    turns = [
        {"turn_id": 1, "context": "Context1", "question": "Q1"},
        {"turn_id": 2, "context": "Context2", "question": "Q2"},
    ]
    (task_dir / "manifest.json").write_text(
        json.dumps({"files": [], "data_dir": "data/mock", "turns": turns})
    )
    (task_dir / "gold.json").write_text(json.dumps({"turns": []}))
    usage = {
        "input_tokens": 100,
        "output_tokens": 20,
        "cached_input_tokens": 40,
        "cache_creation_input_tokens": 20,
    }
    first, second = ledger(), ledger()
    second["messageId"] = "m2"
    second["requests"][0].update(requestId="r2", messageId="m2")
    client = SimpleNamespace(
        agent_id="a",
        _workflow_id=1,
        agent_service_endpoint="http://mock",
        cleanup=Mock(),
        run=Mock(
            side_effect=[
                MessageResult(
                    "42",
                    [],
                    usage,
                    {"steps": 1},
                    False,
                    completed=True,
                    model_accounting=first,
                ),
                MessageResult(
                    "43",
                    [],
                    usage,
                    {"steps": 1},
                    False,
                    completed=True,
                    model_accounting=second,
                ),
            ]
        ),
    )

    class Arm:
        _NAME = "Mock"

        def __init__(self, **kwargs):
            if full_scope:
                assert active["session"]
            self.agent = client
            self.model_type, self.context_mode, self.agent_mode = (
                "route",
                "delta",
                "native",
            )
            (
                self.max_operator_result_char_limit,
                self.max_steps,
                self.context_window_tokens,
            ) = 2000, 100, 0
            self.enable_code_in_snapshot = True

        def process_dataset(self, _):
            pass

    def cleanup():
        if full_scope:
            assert active["session"]

    client.cleanup.side_effect = cleanup
    settings = Mock()
    settings.json.return_value = {"agentMode": "native", "multiTask": True}
    monkeypatch.setattr(requests, "get", Mock(return_value=settings))
    monkeypatch.setattr(
        dataflow_agent, "get_agent_react_steps", Mock(return_value={"steps": []})
    )
    monkeypatch.setattr(dataflow_agent, "get_agent_workflow", Mock(return_value={}))
    monkeypatch.setattr(arms, "ARMS", {"mock": Arm})
    monkeypatch.setattr(run, "PREPARED", prepared)
    monkeypatch.setattr(run, "SCRATCH", scratch)
    monkeypatch.setattr(run, "service_provenance", lambda _: {})
    monkeypatch.setattr(
        "sys.argv", ["run_longds.py", "--task", "task", "--arm", "mock"]
    )
    monkeypatch.delenv("TEXERA_BENCH_PRICING_SNAPSHOT", raising=False)
    monkeypatch.delenv("TEXERA_BENCH_RESOURCE_SCOPE", raising=False)
    assert run.main() == 0
    assert client.run.call_count == 2
    assert all(
        call.kwargs["empty_turn_retries"] == 0 for call in client.run.call_args_list
    )
    client.cleanup.assert_called_once()
    folder = scratch / "LongDS_Mock" / "task"
    summaries = json.loads((folder / "summary.json").read_text())
    assert summaries["totals"]["cost_usd"] is None
    assert summaries["totals"]["input"] == 200
    if full_scope:
        assert summaries["resources"]["peak_memory_bytes"] == 999
        assert summaries["resources"]["measurement"]["memory"]["complete"]
        assert summaries["turn_window_resources"]["turn_windows"] == 2
        assert (folder / summaries["session_resources_path"]).is_file()
    else:
        assert summaries["resources"]["turn_windows"] == 2
    for tid in (1, 2):
        stats = json.loads((folder / f"t{tid:02d}" / "stats.json").read_text())
        metric = json.loads((folder / stats["metrics_path"]).read_text())
        assert metric["model_calls"]["attempted"] == 1
        assert metric["resources"]["status"] == "unavailable"
        assert metric["clocks"]["phases"]["solve"]["count"] == 1


@pytest.mark.parametrize(
    "cpu_parent,memory_parent",
    [("/fake/cpu/task", "/fake/memory/task"), ("/unrelated/cpu", "/unrelated/memory")],
)
def test_session_scope_must_be_a_distinct_owned_ancestor(cpu_parent, memory_parent):
    from turn_accounting import session_resource_window

    scope = {
        "cgroup": {"cpu_path": "/fake/cpu/task", "memory_path": "/fake/memory/task"},
        "session_cgroup": {
            "cpu_path": cpu_parent,
            "memory_path": memory_parent,
            "exclusive": True,
            "ownership_verified": True,
        },
    }
    with pytest.raises(ValueError, match="distinct ancestor"):
        with session_resource_window(scope):
            pass


def test_session_scope_uses_parent_counter_and_readonly_gateway_scope(monkeypatch):
    from contextlib import contextmanager
    import turn_accounting

    captured = []

    @contextmanager
    def fake_window(scope):
        captured.append(scope)
        yield {"measured": True}

    monkeypatch.setattr(turn_accounting, "native_resource_window", fake_window)
    scope = {
        "cgroup": {"cpu_path": "/fake/cpu/task", "memory_path": "/fake/memory/task"},
        "session_cgroup": {
            "cpu_path": "/fake/cpu",
            "memory_path": "/fake/memory",
            "exclusive": True,
            "ownership_verified": True,
            "reset_peak": True,
        },
        "shared_components": {"gateway": {"reset_peak": True, "fresh": True}},
    }
    with turn_accounting.session_resource_window(scope):
        pass
    assert captured[0]["cgroup"]["cpu_path"] == "/fake/cpu"
    assert captured[0]["cgroup"]["reset_peak"]
    assert captured[0]["shared_components"]["gateway"]["reset_peak"] is False
    assert scope["shared_components"]["gateway"]["reset_peak"] is True
