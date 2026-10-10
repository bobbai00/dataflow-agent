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
"""Regression checks for measured attempts; these never call a provider."""
import json
import os
from pathlib import Path
import sys
from concurrent.futures import ThreadPoolExecutor

import pytest

from benchmark.runtime import (
    AttemptMetrics,
    CgroupScope,
    PricingSchedule,
    ProcessResourceCollector,
    normalize_usage,
    run_supervised,
)


def test_missing_usage_is_unknown_and_explicit_zero_is_zero():
    assert normalize_usage({}, provider="openai")["input_tokens"] is None
    usage = normalize_usage({"usage": {"prompt_tokens": 0, "completion_tokens": 0}}, provider="openai")
    assert usage["input_tokens"] == usage["output_tokens"] == 0


def test_openai_cached_and_reasoning_tokens_are_subsets():
    response = {
        "usage": {
            "prompt_tokens": 100,
            "completion_tokens": 20,
            "prompt_tokens_details": {"cached_tokens": 60},
            "completion_tokens_details": {"reasoning_tokens": 15},
        }
    }
    usage = normalize_usage(response, provider="openai")
    assert usage["input_tokens"] == 100
    assert usage["uncached_input_tokens"] == 40
    assert usage["output_tokens"] == 20
    assert usage["reasoning_tokens"] == 15


def test_anthropic_input_excludes_cache_counts():
    usage = normalize_usage(
        {
            "usage": {
                "input_tokens": 10,
                "output_tokens": 3,
                "cache_read_input_tokens": 90,
                "cache_creation_input_tokens": 20,
            }
        },
        provider="anthropic",
    )
    assert usage["input_tokens"] == 120
    assert usage["uncached_input_tokens"] == 10


def test_openai_cache_write_is_a_distinct_billing_leg():
    usage = normalize_usage(
        {
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 3,
                "prompt_tokens_details": {"cached_tokens": 40, "cache_write_tokens": 20},
            }
        },
        provider="openai",
    )
    assert usage["cache_creation_tokens"] == 20
    assert usage["uncached_input_tokens"] == 40


def test_gemini_output_includes_separately_reported_thoughts():
    usage = normalize_usage(
        {
            "usageMetadata": {
                "promptTokenCount": 20,
                "candidatesTokenCount": 3,
                "thoughtsTokenCount": 7,
                "cachedContentTokenCount": 8,
            }
        },
        provider="gemini",
    )
    assert usage["output_tokens"] == 10
    assert usage["reasoning_tokens"] == 7


def test_unknown_price_and_failed_requests_remain_unknown(tmp_path):
    attempt = AttemptMetrics("one", benchmark="fixture", system="native", task_id="one")
    attempt.record_usage(
        {"usage": {"prompt_tokens": 10, "completion_tokens": 2, "prompt_tokens_details": {"cached_tokens": 0}}},
        provider="openai",
        model="unpriced",
    )
    attempt.record_usage(None, provider="openai", model="unpriced", status="failed", error="request failed")
    metrics = attempt.finish(status="error")
    assert metrics["model_calls"]["attempted"] == 2
    assert metrics["model_calls"]["failed"] == 1
    assert metrics["usage"]["input_tokens"] is None
    assert metrics["cost"]["cost_usd"] is None
    attempt.write(tmp_path)
    assert json.loads((tmp_path / "model_calls/000002.json").read_text())["response"] is None
    with pytest.raises(FileExistsError):
        attempt.write(tmp_path)


def test_price_uses_cache_discount_without_double_counting_reasoning():
    price = PricingSchedule(
        model="fixture",
        input_per_token=2e-7,
        output_per_token=1.2e-6,
        cache_read_per_token=2e-8,
        cache_write_per_token=2.5e-7,
        source={"kind": "fixture"},
    )
    attempt = AttemptMetrics("one", benchmark="fixture", system="script", task_id="one")
    attempt.record_usage(
        {
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 20,
                "prompt_tokens_details": {"cached_tokens": 60},
                "completion_tokens_details": {"reasoning_tokens": 15},
            }
        },
        provider="openai",
        model="fixture",
        pricing=price,
    )
    assert attempt.finish()["cost"]["cost_usd"] == pytest.approx(40 * 2e-7 + 60 * 2e-8 + 20 * 1.2e-6)


def test_lifecycle_phases_use_monotonic_wall_and_allow_repeated_intervals():
    attempt = AttemptMetrics("one", benchmark="fixture", system="script", task_id="one")
    with attempt.lifecycle_clock("execution"):
        sum(range(1000))
    with attempt.lifecycle_clock("execution"):
        sum(range(1000))
    metric = attempt.finish()["clocks"]["phases"]["execution"]
    assert metric["count"] == 2
    assert metric["wall_seconds"] >= 0


@pytest.mark.skipif(sys.platform != "linux", reason="Linux process supervision")
def test_reaped_fast_children_cpu_is_preserved(tmp_path):
    code = """import subprocess,sys
subprocess.run([sys.executable,'-c','import time; t=time.process_time();\\nwhile time.process_time()-t < .12: pass'],check=True)
print('done')
"""
    result = run_supervised(
        [sys.executable, "-c", code], 5, stdout_path=tmp_path / "stdout.txt", sample_interval_seconds=0.2
    )
    assert result.status == "completed"
    assert result.resources["cpu_total_seconds"] >= 0.1
    assert result.resources["cpu_total_seconds"] < 0.5
    assert result.resources["measurement"]["cpu"]["method"] == "wait4_reaped_process_tree"
    assert result.resources["measurement"]["cpu"]["complete"] is True
    assert (tmp_path / "stdout.txt").read_text().strip() == "done"


@pytest.mark.skipif(sys.platform != "linux", reason="Linux process supervision")
def test_timeout_reaps_descendant_that_changes_session(tmp_path):
    pid_file = tmp_path / "child.pid"
    code = """import os,sys,time
pid=os.fork()
if pid==0:
 os.setsid()
 open(sys.argv[1],'w').write(str(os.getpid()))
 time.sleep(30)
else:
 time.sleep(30)
"""
    result = run_supervised([sys.executable, "-c", code, str(pid_file)], 0.3, terminate_grace_seconds=0.1)
    assert result.timed_out
    assert result.status == "timeout"
    assert not Path("/proc", pid_file.read_text()).exists()
    assert result.resources["measurement"]["cpu"]["complete"] is True


@pytest.mark.skipif(sys.platform != "linux", reason="Linux process supervision")
def test_normal_exit_cleans_background_descendants(tmp_path):
    pid_file = tmp_path / "child.pid"
    code = """import os,sys,time
pid=os.fork()
if pid==0:
 os.setsid()
 open(sys.argv[1],'w').write(str(os.getpid()))
 time.sleep(30)
else:
 while not os.path.exists(sys.argv[1]): time.sleep(.01)
"""
    result = run_supervised([sys.executable, "-c", code, str(pid_file)], 5, terminate_grace_seconds=0.1)
    assert result.returncode == 0
    assert not Path("/proc", pid_file.read_text()).exists()


def test_output_paths_are_not_overwritten(tmp_path):
    output = tmp_path / "stdout.txt"
    output.write_text("keep")
    with pytest.raises(FileExistsError):
        run_supervised([sys.executable, "-c", "print('overwrite')"], 5, stdout_path=output)
    assert output.read_text() == "keep"


def test_supervised_command_error_is_measured():
    result = run_supervised([sys.executable, "-c", "raise RuntimeError('fixture')"], 5)
    assert result.status == "error"
    assert result.returncode != 0
    assert "fixture" in result.stderr
    assert result.resources["cpu_total_seconds"] is not None


def test_supervised_launch_error_is_explicit():
    result = run_supervised(["/nonexistent/benchmark-fixture-command"], 5)
    assert result.status == "error"
    assert "FileNotFoundError" in result.error


def test_concurrent_supervisors_do_not_steal_children():
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda value: run_supervised([sys.executable, "-c", "print(%d)" % value], 5), [1, 2]))
    assert [result.stdout.strip() for result in results] == ["1", "2"]
    assert all(result.returncode == 0 and result.resources["measurement"]["cpu"]["complete"] for result in results)


def test_responses_usage_normalizes_cache_writes_and_reasoning():
    usage = normalize_usage(
        {
            "usage": {
                "input_tokens": 100,
                "output_tokens": 20,
                "input_tokens_details": {"cached_tokens": 40, "cache_write_tokens": 10},
                "output_tokens_details": {"reasoning_tokens": 15},
            }
        }
    )
    assert usage["uncached_input_tokens"] == 50
    assert usage["cache_creation_tokens"] == 10
    assert usage["output_tokens"] == 20


def test_invalid_cache_counts_never_create_a_negative_cost():
    usage = normalize_usage(
        {"usage": {"prompt_tokens": 10, "completion_tokens": 1, "prompt_tokens_details": {"cached_tokens": 11}}}
    )
    assert usage["uncached_input_tokens"] is None
    price = PricingSchedule("fixture", 1, 1, 1, 1)
    assert price.estimate(usage) is None


def test_conflicting_usage_aliases_remain_unknown():
    usage = normalize_usage(
        {
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 10,
                "prompt_tokens_details": {"cached_tokens": 20, "cache_write_tokens": 10},
                "cache_read_input_tokens": 21,
                "cache_creation_input_tokens": 10,
            }
        }
    )
    assert usage["cached_input_tokens"] is None
    assert "cached_input_tokens_conflicting_aliases" in usage["issues"]


def test_top_level_creation_and_read_aliases_match_nested():
    usage = normalize_usage(
        {
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 10,
                "cache_read_input_tokens": 20,
                "cache_write_tokens": 10,
                "cache_creation_tokens": 10,
            }
        }
    )
    assert usage["cached_input_tokens"] == 20
    assert usage["cache_creation_tokens"] == 10
    assert usage["uncached_input_tokens"] == 70


def test_anthropic_openai_gateway_shape_does_not_add_cache_twice():
    usage = normalize_usage(
        {
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 10,
                "prompt_tokens_details": {"cached_tokens": 70},
                "cache_read_input_tokens": 70,
            }
        },
        provider="anthropic",
    )
    assert usage["input_tokens"] == 100
    assert usage["uncached_input_tokens"] == 30


def test_native_anthropic_shape_is_detected_even_when_gateway_provider_is_openai():
    usage = normalize_usage(
        {
            "usage": {
                "input_tokens": 10,
                "output_tokens": 3,
                "cache_read_input_tokens": 90,
                "cache_creation_input_tokens": 20,
            }
        }
    )
    assert usage["input_tokens"] == 120


def test_pricing_tier_boundary_uses_total_input_and_preserves_provenance():
    schedule = {
        "model": "fixture",
        "rates": {"input": 1, "output": 2, "cache_read": 0.1, "cache_creation": 1.25},
        "source": {"kind": "fixture"},
        "tiers": [{"min_input_tokens": 101, "input_multiplier": 2, "output_multiplier": 1.5}],
    }
    price = PricingSchedule.from_dict(schedule)
    assert price.as_dict()["tiers"] == schedule["tiers"]
    low = normalize_usage(
        {"usage": {"prompt_tokens": 100, "completion_tokens": 10, "prompt_tokens_details": {"cached_tokens": 90}}},
        model="fixture",
    )
    high = normalize_usage(
        {"usage": {"prompt_tokens": 101, "completion_tokens": 10, "prompt_tokens_details": {"cached_tokens": 90}}},
        model="fixture",
    )
    assert price.estimate(low) == pytest.approx(10 + 9 + 20)
    assert price.estimate(high) == pytest.approx(22 + 18 + 30)


def test_exact_provider_model_alias_is_supported_by_frozen_schedule():
    price = PricingSchedule.from_dict(
        {
            "model": "native-route",
            "provider_model": "exact-provider-model",
            "rates": {"input": 1, "output": 1, "cache_read": 1},
        }
    )
    usage = normalize_usage(
        {"usage": {"prompt_tokens": 10, "completion_tokens": 1, "prompt_tokens_details": {"cached_tokens": 0}}},
        model="exact-provider-model",
    )
    assert price.estimate(usage) == 11


def test_peak_reset_requires_verified_exclusive_ownership(tmp_path):
    with pytest.raises(ValueError, match="verified exclusive"):
        CgroupScope(unified_path=tmp_path, reset_peak=True)


def test_peak_reset_lock_rejects_overlapping_collectors(tmp_path):
    (tmp_path / "cpu.stat").write_text("usage_usec 0\nuser_usec 0\nsystem_usec 0\n")
    (tmp_path / "memory.current").write_text("100")
    (tmp_path / "memory.peak").write_text("999")
    scope = CgroupScope(unified_path=tmp_path, exclusive=True, ownership_verified=True, reset_peak=True)
    with ProcessResourceCollector(cgroup=scope):
        with pytest.raises(RuntimeError, match="already in use"):
            with ProcessResourceCollector(cgroup=scope):
                pass


def test_missing_pid_does_not_claim_scope_coverage():
    with ProcessResourceCollector(root_pids=[2**30]) as collector:
        pass
    assert collector.finish()["scope"]["complete"] is False
    assert collector.finish()["status"] == "unavailable"


def test_native_scope_never_claims_complete_for_only_adapter_children():
    with ProcessResourceCollector(root_pids=[os.getpid()], scope_kind="native_system") as collector:
        pass
    assert collector.finish()["scope"]["complete"] is False
    assert "owned_service_pids" in collector.finish()["scope"]["limitations"][0]


def test_services_are_separate_and_unverified_ownership_is_explicit():
    with ProcessResourceCollector(owned_service_pids={"agent": os.getpid()}, scope_kind="native_system") as collector:
        pass
    resources = collector.finish()
    assert "agent" in resources["services"]
    assert resources["scope"]["complete"] is False
    assert resources["services"]["agent"]["attribution"] == "unverified"


def test_v2_cgroup_cpu_delta_and_fresh_peak(tmp_path):
    (tmp_path / "cpu.stat").write_text("usage_usec 1000000\nuser_usec 600000\nsystem_usec 400000\n")
    (tmp_path / "memory.current").write_text("0")
    (tmp_path / "memory.peak").write_text("0")
    scope = CgroupScope(unified_path=tmp_path, exclusive=True, ownership_verified=True, fresh=True)
    with ProcessResourceCollector(cgroup=scope) as collector:
        (tmp_path / "cpu.stat").write_text("usage_usec 3000000\nuser_usec 1700000\nsystem_usec 1300000\n")
        (tmp_path / "memory.peak").write_text("123456")
    resources = collector.finish()
    assert resources["cpu_total_seconds"] == pytest.approx(2)
    assert resources["cpu_user_seconds"] == pytest.approx(1.1)
    assert resources["peak_memory_bytes"] == 123456
    assert resources["measurement"]["memory"]["method"] == "cgroup_fresh_peak"


def test_existing_cgroup_peak_is_raw_not_attempt_peak(tmp_path):
    (tmp_path / "cpu.stat").write_text("usage_usec 0\nuser_usec 0\nsystem_usec 0\n")
    (tmp_path / "memory.current").write_text("100")
    (tmp_path / "memory.peak").write_text("999999")
    with ProcessResourceCollector(cgroup=CgroupScope(unified_path=tmp_path)) as collector:
        pass
    resources = collector.finish()
    assert resources["raw"]["cgroup"]["memory_peak_bytes"] == 999999
    assert resources["peak_memory_bytes"] != 999999
    assert resources["measurement"]["memory"]["complete"] is False


def test_v1_separate_cpu_and_memory_controllers(tmp_path):
    cpu, memory = tmp_path / "cpu", tmp_path / "memory"
    cpu.mkdir()
    memory.mkdir()
    (cpu / "cpuacct.usage").write_text("1000000000")
    (cpu / "cpuacct.stat").write_text("user 50\nsystem 50\n")
    (memory / "memory.usage_in_bytes").write_text("100")
    (memory / "memory.max_usage_in_bytes").write_text("200")
    with ProcessResourceCollector(cgroup=CgroupScope(cpu_path=cpu, memory_path=memory)) as collector:
        (cpu / "cpuacct.usage").write_text("2000000000")
    assert collector.finish()["cpu_total_seconds"] == pytest.approx(1)
    assert collector.finish()["raw"]["cgroup"]["version"] == 1


def test_usage_complete_includes_normalization_issues_and_request_indices():
    metric = AttemptMetrics("issue", benchmark="fixture", system="script", task_id="one")
    metric.record_usage(
        {"usage": {"prompt_tokens": 10, "completion_tokens": 1, "cached_tokens": 0, "total_tokens": 99}}
    )
    result = metric.finish()
    assert result["usage_complete"] is False
    assert result["normalization_issues"] == [{"index": 1, "issues": ["total_tokens_mismatch"]}]


def test_cache_read_tokens_alias_is_known_and_conflicts_are_unknown():
    usage = normalize_usage({"usage": {"prompt_tokens": 10, "completion_tokens": 1, "cache_read_tokens": 6}})
    assert usage["uncached_input_tokens"] == 4
    conflict = normalize_usage(
        {"usage": {"prompt_tokens": 10, "completion_tokens": 1, "cache_read_tokens": 6, "cached_tokens": 5}}
    )
    assert conflict["cached_input_tokens"] is None
    assert "cached_input_tokens_conflicting_aliases" in conflict["issues"]


def test_provider_reported_charge_and_token_estimate_remain_separate():
    metric = AttemptMetrics("cost", benchmark="fixture", system="script", task_id="one")
    price = PricingSchedule("fixture", 1, 1, cache_read_per_token=1)
    metric.record_usage(
        {
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 1,
                "cached_tokens": 0,
                "cost": 0.2,
                "cost_details": {"discount": True},
            }
        },
        model="fixture",
        pricing=price,
    )
    metric.record_usage(None, model="fixture", status="failed", pricing=price)
    result = metric.finish()
    assert result["cost"]["observed_cost_usd"] == 11
    assert result["provider_reported_cost"]["observed_cost_usd"] == 0.2
    assert result["provider_reported_cost"]["cost_usd"] is None


def test_component_peaks_are_not_summed_and_cpu_is_additive(tmp_path):
    from benchmark.runtime import ComponentResourceCollector

    scopes = {}
    for index in range(2):
        path = tmp_path / str(index)
        path.mkdir()
        (path / "cpu.stat").write_text("usage_usec 0\nuser_usec 0\nsystem_usec 0\n")
        (path / "memory.current").write_text("100")
        (path / "memory.peak").write_text("0")
        scopes[str(index)] = CgroupScope(unified_path=path, exclusive=True, ownership_verified=True, fresh=True)
    with ComponentResourceCollector(scopes, sample_interval_seconds=10) as collector:
        for scope in scopes.values():
            (scope.unified_path / "cpu.stat").write_text("usage_usec 1000000\nuser_usec 800000\nsystem_usec 200000\n")
            (scope.unified_path / "memory.peak").write_text("1000")
    result = collector.finish()
    assert result["cpu_total_seconds"] == 2
    assert result["peak_memory_bytes"] == 200
    assert all(value["peak_memory_bytes"] == 1000 for value in result["components"].values())
    assert result["measurement"]["memory"]["exact"] is False


def test_component_overlap_is_rejected(tmp_path):
    from benchmark.runtime import ComponentResourceCollector

    with pytest.raises(ValueError, match="Parent and child"):
        ComponentResourceCollector(
            {"a": CgroupScope(unified_path=tmp_path), "b": CgroupScope(unified_path=tmp_path / "child")}
        )


def test_cleanup_refuses_existing_or_busy_scope(tmp_path):
    from benchmark.runtime import cleanup_cgroup

    with pytest.raises(ValueError, match="newly provisioned"):
        cleanup_cgroup(CgroupScope(unified_path=tmp_path, exclusive=True, ownership_verified=True))
    (tmp_path / "cgroup.procs").write_text(str(os.getpid()))
    scope = CgroupScope(
        unified_path=tmp_path,
        exclusive=True,
        ownership_verified=True,
        fresh=True,
        metadata={"kind": "runtime_provisioned", "created_by_uid": os.getuid()},
    )
    result = cleanup_cgroup(scope)
    assert result["removed"] is False
    assert result["reason"] == "scope_not_empty"


def test_required_resources_fail_before_command_launch(tmp_path):
    marker = tmp_path / "launched"
    scope = CgroupScope(unified_path=tmp_path / "missing", exclusive=True, ownership_verified=True, fresh=True)
    result = run_supervised(
        [sys.executable, "-c", "import pathlib,sys;pathlib.Path(sys.argv[1]).touch()", str(marker)],
        3,
        cgroup=scope,
        require_complete_resources=True,
    )
    assert result.status == "error"
    assert not marker.exists()
    assert result.resources["status"] == "unavailable"
    assert "Complete resources unavailable" in result.error


def test_collector_readiness_checks_exact_memory_and_coverage(tmp_path):
    (tmp_path / "cpu.stat").write_text("usage_usec 0\nuser_usec 0\nsystem_usec 0\n")
    (tmp_path / "memory.current").write_text("100")
    (tmp_path / "memory.peak").write_text("9000")
    with ProcessResourceCollector(
        cgroup=CgroupScope(unified_path=tmp_path, exclusive=True, ownership_verified=True)
    ) as collector:
        with pytest.raises(RuntimeError, match="Complete resources unavailable"):
            collector.validate_ready()


def test_cgroup_does_not_make_a_missing_explicit_root_complete(tmp_path):
    (tmp_path / "cpu.stat").write_text("usage_usec 0\nuser_usec 0\nsystem_usec 0\n")
    (tmp_path / "memory.current").write_text("0")
    (tmp_path / "memory.peak").write_text("0")
    scope = CgroupScope(unified_path=tmp_path, exclusive=True, ownership_verified=True, fresh=True)
    with ProcessResourceCollector(root_pids=[2**30], cgroup=scope) as collector:
        with pytest.raises(RuntimeError, match="Complete resources unavailable"):
            collector.validate_ready()


def test_reported_invalid_total_prevents_complete_usage():
    usage = normalize_usage(
        {"usage": {"prompt_tokens": 10, "completion_tokens": 1, "cached_tokens": 0, "total_tokens": False}}
    )
    assert usage["input_tokens"] == 10
    assert usage["complete"] is False
    assert "total_tokens_invalid" in usage["issues"]


def test_non_usd_schedule_cannot_be_reported_as_usd_cost():
    price = PricingSchedule("fixture", 1, 1, cache_read_per_token=1, currency="EUR")
    usage = normalize_usage(
        {"usage": {"prompt_tokens": 10, "completion_tokens": 1, "cached_tokens": 0}}, model="fixture"
    )
    assert price.estimate(usage) is None


def test_shared_single_controller_is_not_an_additive_component(tmp_path):
    from benchmark.runtime import ComponentResourceCollector

    with pytest.raises(ValueError, match="disjoint"):
        ComponentResourceCollector(
            {
                "a": CgroupScope(cpu_path=tmp_path / "cpu", memory_path=tmp_path / "memory-a"),
                "b": CgroupScope(cpu_path=tmp_path / "cpu", memory_path=tmp_path / "memory-b"),
            }
        )


def test_nonhierarchical_v1_memory_cannot_claim_descendant_peak(tmp_path):
    cpu, memory = tmp_path / "cpu", tmp_path / "memory"
    cpu.mkdir()
    memory.mkdir()
    (cpu / "cpuacct.usage").write_text("0")
    (cpu / "cpuacct.stat").write_text("user 0\nsystem 0\n")
    (memory / "memory.usage_in_bytes").write_text("0")
    (memory / "memory.max_usage_in_bytes").write_text("0")
    (memory / "memory.use_hierarchy").write_text("0")
    scope = CgroupScope(cpu_path=cpu, memory_path=memory, exclusive=True, ownership_verified=True, fresh=True)
    with ProcessResourceCollector(cgroup=scope) as collector:
        with pytest.raises(RuntimeError, match="memory peak"):
            collector.validate_ready()


def test_v2_peak_reset_reads_retained_descriptor_and_closes_it(tmp_path, monkeypatch):
    import io

    (tmp_path / "cpu.stat").write_text("usage_usec 0\nuser_usec 0\nsystem_usec 0\n")
    (tmp_path / "memory.current").write_text("100")
    (tmp_path / "memory.peak").write_text("999")
    peak_descriptor = io.StringIO("123")
    monkeypatch.setattr(CgroupScope, "reset_memory_peak", lambda scope: peak_descriptor)
    scope = CgroupScope(unified_path=tmp_path, exclusive=True, ownership_verified=True, reset_peak=True)
    with ProcessResourceCollector(cgroup=scope) as collector:
        assert collector.validate_ready()["peak_memory_bytes"] == 123
    assert collector.finish()["peak_memory_bytes"] == 123
    assert peak_descriptor.closed
