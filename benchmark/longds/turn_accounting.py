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
"""LongDS adapts shared native accounting and serial resource windows."""

from pathlib import Path
from contextlib import contextmanager
from copy import deepcopy
import sys

# KramaBench also owns a package called benchmark; use the runtime package root.
BENCH_ROOT = Path(__file__).resolve().parent.parent
if str(BENCH_ROOT) not in sys.path:
    sys.path.insert(0, str(BENCH_ROOT))
from runtime.resources import CgroupScope  # noqa: E402
from runtime.native_accounting import (  # noqa: E402
    finish_native_metrics as finish_turn_metrics,
    load_pricing_snapshot,
    select_new_requests,
    native_resource_window,
)


__all__ = [
    "finish_turn_metrics",
    "load_pricing_snapshot",
    "select_new_requests",
    "native_resource_window",
    "aggregate_turn_resources",
    "session_resource_window",
]


@contextmanager
def session_resource_window(resource_scope=None):
    """Measure the complete session with separate parent peak counters.

    Child turn counters may reset their own peaks without altering the parent's
    session peak. The caller must own both controller scopes; equal/unrelated
    counters cannot establish a separate session boundary.
    """
    if not resource_scope or not resource_scope.get("session_cgroup"):
        yield None
        return
    scope = deepcopy(resource_scope)
    parent = CgroupScope.from_dict(scope["session_cgroup"])
    child = CgroupScope.from_dict(scope.get("cgroup"))
    if not parent.exclusive or not parent.ownership_verified:
        raise ValueError("Session resource scope requires verified exclusive ownership")
    if child is None:
        raise ValueError(
            "Session resource scope requires a distinct ancestor of turn controllers"
        )
    parent_paths = (
        [parent.unified_path]
        if parent.unified_path
        else [parent.cpu_path, parent.memory_path]
    )
    child_paths = (
        [child.unified_path]
        if child.unified_path
        else [child.cpu_path, child.memory_path]
    )
    if len(parent_paths) != len(child_paths) or any(
        left is None or right is None or left.resolve() not in right.resolve().parents
        for left, right in zip(parent_paths, child_paths)
    ):
        raise ValueError(
            "Session resource scope requires a distinct ancestor of turn controllers"
        )
    scope["cgroup"] = scope.pop("session_cgroup")
    # Shared Docker scopes have one kernel peak counter. Outer readers sample
    # their current charges; inner turn readers own any peak reset.
    scope["shared_components"] = {
        label: {**component, "reset_peak": False, "fresh": False}
        for label, component in scope.get("shared_components", {}).items()
    }
    with native_resource_window(scope) as window:
        yield window


def aggregate_turn_resources(resources, wall_seconds):
    """Describe disjoint turn windows without claiming a whole-session peak."""

    measurements = [row.get("whole_system", row) for row in resources]

    def observed_sum(field):
        known = [row.get(field) for row in measurements if row.get(field) is not None]
        return sum(known) if len(known) == len(resources) and resources else None

    peaks = [
        row.get("peak_memory_bytes")
        for row in measurements
        if row.get("peak_memory_bytes") is not None
    ]
    return {
        "schema_version": 1,
        "status": "partial" if resources else "unavailable",
        "wall_seconds": wall_seconds,
        "turn_windows": len(resources),
        "cpu_user_seconds": observed_sum("cpu_user_seconds"),
        "cpu_system_seconds": observed_sum("cpu_system_seconds"),
        "cpu_total_seconds": observed_sum("cpu_total_seconds"),
        "peak_memory_bytes": max(peaks) if peaks else None,
        "scope": {
            "kind": "native_session_turn_windows",
            "complete": False,
            "limitations": [
                "setup, inter-turn checkpoints and cleanup fall outside resource windows"
            ],
        },
        "measurement": {
            "cpu": {
                "method": "sum_of_disjoint_turn_window_counters",
                "complete": False,
            },
            "memory": {
                "method": "maximum_of_turn_window_peaks",
                "complete": False,
                "whole_session_peak": False,
            },
        },
        "per_turn": resources,
    }
