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
"""Collect disjoint owned controller components without summing their peaks."""
from contextlib import ExitStack
import threading
import time

from .resources import CgroupScope, ProcessResourceCollector


class ComponentResourceCollector:
    def __init__(self, scopes, *, sample_interval_seconds=0.05):
        if sample_interval_seconds <= 0:
            raise ValueError("Sampling interval must be positive")
        self.scopes = {label: CgroupScope.from_dict(scope) for label, scope in scopes.items()}
        if any(not (scope.unified_path or (scope.cpu_path and scope.memory_path)) for scope in self.scopes.values()):
            raise ValueError("Components require CPU and memory controllers")
        identities = [
            (
                str((scope.unified_path or scope.cpu_path).resolve()),
                str((scope.unified_path or scope.memory_path).resolve()),
            )
            for scope in self.scopes.values()
        ]
        if len(set(identities)) != len(identities):
            raise ValueError("Components must use disjoint controller scopes")
        # An ancestor includes its descendants' counters. Reject that overlap too.
        for index, left in enumerate(identities):
            for right in identities[index + 1 :]:
                if any(a == b for a, b in zip(left, right)):
                    raise ValueError("Components must use disjoint controller scopes")
                if any(a.startswith(b + "/") or b.startswith(a + "/") for a, b in zip(left, right)):
                    raise ValueError("Parent and child cgroups cannot be additive components")
        self.interval = sample_interval_seconds
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._peak = None
        self._samples = 0
        self._collectors = {}
        self._finished = None

    def __enter__(self):
        self._started = time.monotonic()
        self._stack = ExitStack()
        try:
            for label, scope in self.scopes.items():
                self._collectors[label] = self._stack.enter_context(
                    ProcessResourceCollector(cgroup=scope, sample_interval_seconds=self.interval)
                )
            self._sample()
            self._thread = threading.Thread(target=self._loop, daemon=True)
            self._thread.start()
            return self
        except BaseException:
            self._stack.close()
            raise

    def _sample(self):
        readings = [scope.read()["memory_current_bytes"] for scope in self.scopes.values()]
        with self._lock:
            if readings and all(value is not None for value in readings):
                self._peak = max(self._peak or 0, sum(readings))
                self._samples += 1

    def _loop(self):
        while not self._stop.wait(self.interval):
            self._sample()

    def finish(self):
        if self._finished is not None:
            return self._finished
        self._stop.set()
        self._thread.join()
        self._sample()
        self._stack.close()
        components = {label: collector.finish() for label, collector in self._collectors.items()}
        self._finished = self._result(components)
        return self._finished

    def snapshot(self):
        if self._finished is not None:
            return self._finished
        self._sample()
        return self._result({label: collector.snapshot() for label, collector in self._collectors.items()})

    def validate_ready(self, *, require_exact_component_peaks=True, skip_labels=()):
        result = self.snapshot()
        missing = []
        for label, component in result["components"].items():
            if label in skip_labels:
                continue
            if require_exact_component_peaks:
                try:
                    self._collectors[label].validate_ready()
                except RuntimeError as error:
                    missing.append(label + ": " + str(error))
                continue
            if not component["scope"]["complete"] or not component["measurement"]["cpu"]["exact"]:
                missing.append(label + ": owned scope or CPU counters unavailable")
        if not result["components"]:
            missing.append("no components configured")
        if missing:
            raise RuntimeError("Complete resources unavailable: " + "; ".join(missing))
        return result

    def _result(self, components):
        cpu = {}
        for field in ("cpu_user_seconds", "cpu_system_seconds", "cpu_total_seconds"):
            known = [component[field] for component in components.values() if component.get(field) is not None]
            cpu[field] = sum(known) if len(known) == len(components) and known else None
        cpu_complete = bool(components) and all(
            component["measurement"]["cpu"]["exact"] for component in components.values()
        )
        return {
            "schema_version": 1,
            "status": "available" if components else "unavailable",
            **cpu,
            "peak_memory_bytes": self._peak,
            "components": components,
            "wall_seconds": time.monotonic() - self._started,
            "scope": {
                "kind": "disjoint_cgroup_components",
                "complete": bool(components)
                and all(component["scope"]["complete"] for component in components.values()),
                "labels": list(components),
            },
            "measurement": {
                "cpu": {
                    "method": "sum_disjoint_cgroup_counter_deltas",
                    "exact": cpu_complete,
                    "complete": cpu_complete,
                    "component_windows": "recorded separately; sequential boundary reads",
                },
                "memory": {
                    "method": "sampled_sum_current_cgroup_charges",
                    "exact": False,
                    "complete": False,
                    "sample_interval_seconds": self.interval,
                    "sample_count": self._samples,
                    "may_miss_between_samples": True,
                    "component_peaks_are_not_summed": True,
                    "includes_page_cache": True,
                },
            },
        }

    def __exit__(self, *exception):
        self.finish()
