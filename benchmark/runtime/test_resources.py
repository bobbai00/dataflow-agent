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
"""CPU counter precision and attribution are separate; no providers or live cgroups."""

import os
import sys

import pytest

from benchmark.runtime import CgroupScope, ProcessResourceCollector, run_supervised


def v1_scope(tmp_path, *, owned=True):
    cpu, memory = tmp_path / "cpu", tmp_path / "memory"
    cpu.mkdir()
    memory.mkdir()
    (cpu / "cpuacct.stat").write_text("user 1000\nsystem 2000\n")
    (cpu / "cpuacct.usage").write_text("500000000000")
    (memory / "memory.usage_in_bytes").write_text("100")
    (memory / "memory.max_usage_in_bytes").write_text("0")
    (memory / "memory.use_hierarchy").write_text("1")
    return CgroupScope(cpu_path=cpu, memory_path=memory, exclusive=owned, ownership_verified=owned, fresh=True)


def test_v1_keeps_original_tick_numbers_and_labels_scheduler_total_separately(tmp_path):
    scope = v1_scope(tmp_path)
    with ProcessResourceCollector(cgroup=scope) as collector:
        (scope.cpu_path / "cpuacct.stat").write_text("user 1465\nsystem 2194\n")
        (scope.cpu_path / "cpuacct.usage").write_text("506857042436")
    result = collector.finish()
    cpu = result["measurement"]["cpu"]
    ticks = os.sysconf("SC_CLK_TCK")
    assert result["cpu_user_seconds"] == pytest.approx(465 / ticks)
    assert result["cpu_system_seconds"] == pytest.approx(194 / ticks)
    assert result["cpu_total_seconds"] == pytest.approx(6.857042436)
    assert result["raw"]["cgroup"]["cpu_raw"] == {"user": 1465, "system": 2194}
    assert cpu["exact"] is True and cpu["complete"] is True
    assert cpu["total_exact"] is True and cpu["user_system_exact"] is False
    assert cpu["user_system_accounting"] == "kernel_tick_cpustat"
    assert cpu["user_system_coherent_partition"] is False
    assert cpu["counter_sources"] == {
        "total": "cpuacct.usage",
        "user": "cpuacct.stat.user",
        "system": "cpuacct.stat.system",
    }
    assert cpu["total_resolution_seconds"] == 1e-9
    assert cpu["user_system_resolution_seconds"] == 1 / ticks
    assert cpu["total_minus_user_system_seconds"] == pytest.approx(
        result["cpu_total_seconds"] - result["cpu_user_seconds"] - result["cpu_system_seconds"]
    )


def test_v2_retains_microsecond_kernel_split_and_counter_exactness(tmp_path):
    (tmp_path / "cpu.stat").write_text("usage_usec 1000000\nuser_usec 600000\nsystem_usec 400000\n")
    (tmp_path / "memory.current").write_text("100")
    (tmp_path / "memory.peak").write_text("0")
    scope = CgroupScope(unified_path=tmp_path, exclusive=True, ownership_verified=True, fresh=True)
    with ProcessResourceCollector(cgroup=scope) as collector:
        (tmp_path / "cpu.stat").write_text("usage_usec 3000000\nuser_usec 1700000\nsystem_usec 1300000\n")
    result = collector.finish()
    cpu = result["measurement"]["cpu"]
    assert result["cpu_total_seconds"] == pytest.approx(2)
    assert cpu["total_exact"] is True and cpu["user_system_exact"] is True
    assert cpu["counter_sources"] == {
        "total": "cpu.stat.usage_usec",
        "user": "cpu.stat.user_usec",
        "system": "cpu.stat.system_usec",
    }
    assert cpu["user_system_accounting"] == "kernel_microsecond_cpu_stat"
    assert cpu["user_system_coherent_partition"] is True
    assert cpu["total_resolution_seconds"] == cpu["user_system_resolution_seconds"] == 1e-6


def test_observed_counter_precision_does_not_claim_unowned_scope_coverage(tmp_path):
    with ProcessResourceCollector(cgroup=v1_scope(tmp_path, owned=False)) as collector:
        pass
    result = collector.finish()
    assert result["measurement"]["cpu"]["total_exact"] is True
    assert result["measurement"]["cpu"]["user_system_exact"] is False
    assert result["measurement"]["cpu"]["complete"] is False
    assert result["scope"]["complete"] is False


@pytest.mark.skipif(sys.platform != "linux", reason="Linux wait4 supervision")
def test_wait4_labels_exact_kernel_reported_rusage_with_separate_scope(tmp_path):
    result = run_supervised([sys.executable, "-c", "sum(range(10000))"], 5)
    cpu = result.resources["measurement"]["cpu"]
    assert cpu["method"] == "wait4_reaped_process_tree"
    assert cpu["total_exact"] is True and cpu["user_system_exact"] is True
    assert cpu["counter_sources"] == {
        "total": "sum(wait4.ru_utime + wait4.ru_stime)",
        "user": "wait4.ru_utime",
        "system": "wait4.ru_stime",
    }
    assert cpu["user_system_accounting"] == "kernel_reported_rusage"
    assert cpu["user_system_coherent_partition"] is True
    assert cpu["user_system_resolution_seconds"] == 1e-6
    assert cpu["scope"] == "adapter_process_tree"
    assert (
        result.resources["cpu_total_seconds"]
        == result.resources["cpu_user_seconds"] + result.resources["cpu_system_seconds"]
    )
