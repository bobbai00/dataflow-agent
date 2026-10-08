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
"""Linux process/cgroup resource measurements with explicit attribution."""
from dataclasses import asdict, dataclass, field
import hashlib
import os
from pathlib import Path
import re
import subprocess
import threading
import time
from typing import Mapping, Optional


def _integer(path):
    try:
        return int(Path(path).read_text().strip())
    except (OSError, ValueError):
        return None


def _pairs(path):
    try:
        return {key: int(value) for key, value in (line.split() for line in Path(path).read_text().splitlines())}
    except (OSError, ValueError):
        return {}


def process_table():
    """Read PID identities, cumulative own/waited CPU, and current RSS."""
    result = {}
    ticks = os.sysconf("SC_CLK_TCK")
    pages = os.sysconf("SC_PAGE_SIZE")
    try:
        entries = list(os.scandir("/proc"))
    except OSError:
        return result
    for entry in entries:
        if not entry.name.isdecimal():
            continue
        try:
            raw = Path(entry.path, "stat").read_text()
            fields = raw[raw.rfind(")") + 2 :].split()
            result[int(entry.name)] = {
                "pid": int(entry.name),
                "ppid": int(fields[1]),
                "state": fields[0],
                "start_ticks": int(fields[19]),
                "user_seconds": int(fields[11]) / ticks,
                "system_seconds": int(fields[12]) / ticks,
                "waited_user_seconds": int(fields[13]) / ticks,
                "waited_system_seconds": int(fields[14]) / ticks,
                "rss_bytes": max(0, int(fields[21]) * pages),
            }
        except (OSError, ValueError, IndexError):
            continue
    return result


def descendants(table, roots, *, include_roots=True):
    selected = set(roots) & table.keys()
    while True:
        found = {pid for pid, value in table.items() if value["ppid"] in selected}
        new = found - selected
        if not new:
            break
        selected.update(new)
    return selected if include_roots else selected - set(roots)


@dataclass(frozen=True)
class CgroupScope:
    """Read a caller-owned controller scope; no ambient session is inferred."""

    unified_path: Optional[Path] = None
    cpu_path: Optional[Path] = None
    memory_path: Optional[Path] = None
    exclusive: bool = False
    ownership_verified: bool = False
    fresh: bool = False
    reset_peak: bool = False
    name: Optional[str] = None
    sudo_reset: bool = False
    metadata: Mapping = field(default_factory=dict)

    def __post_init__(self):
        for field in ("unified_path", "cpu_path", "memory_path"):
            value = getattr(self, field)
            if value is not None:
                object.__setattr__(self, field, Path(value))
        if self.unified_path is not None and (self.cpu_path is not None or self.memory_path is not None):
            raise ValueError("Use a unified v2 scope or separate v1 controllers")
        if self.reset_peak and not (self.exclusive and self.ownership_verified):
            raise ValueError("Peak reset requires verified exclusive ownership")

    @classmethod
    def from_dict(cls, value):
        return cls(**value) if isinstance(value, Mapping) else value

    def as_dict(self):
        return {key: str(value) if isinstance(value, Path) else value for key, value in asdict(self).items()}

    def read(self, *, memory_peak_handle=None):
        if self.unified_path is not None:
            cpu = _pairs(self.unified_path / "cpu.stat")
            memory = self.unified_path
            version = 2
            total = cpu.get("usage_usec")
            user = cpu.get("user_usec")
            system = cpu.get("system_usec")
            divisor = 1e6
            current = _integer(memory / "memory.current")
            peak = _integer(memory / "memory.peak")
            if memory_peak_handle is not None:
                try:
                    memory_peak_handle.seek(0)
                    peak = int(memory_peak_handle.read().strip())
                except (OSError, ValueError):
                    peak = None
            memory_hierarchy = True
        else:
            cpu = _pairs(self.cpu_path / "cpuacct.stat") if self.cpu_path else {}
            total_ns = _integer(self.cpu_path / "cpuacct.usage") if self.cpu_path else None
            total = total_ns / 1e9 if total_ns is not None else None
            user = cpu.get("user")
            system = cpu.get("system")
            divisor = os.sysconf("SC_CLK_TCK")
            version = 1
            current = _integer(self.memory_path / "memory.usage_in_bytes") if self.memory_path else None
            peak = _integer(self.memory_path / "memory.max_usage_in_bytes") if self.memory_path else None
            hierarchy = _integer(self.memory_path / "memory.use_hierarchy") if self.memory_path else None
            memory_hierarchy = bool(hierarchy) if hierarchy is not None else None
        return {
            "version": version,
            "cpu_total_seconds": total / divisor if version == 2 and total is not None else total,
            "cpu_user_seconds": user / divisor if user is not None else None,
            "cpu_system_seconds": system / divisor if system is not None else None,
            "memory_current_bytes": current,
            "memory_peak_bytes": peak,
            "memory_hierarchy_enabled": memory_hierarchy,
            "cpu_raw": cpu,
            "cpu_total_raw": cpu.get("usage_usec") if version == 2 else total_ns,
            "cpu_total_raw_unit": "microseconds" if version == 2 else "nanoseconds",
            "scope": self.as_dict(),
        }

    def contains_pid(self, pid):
        """Verify membership in both controllers, including owned subgroups."""
        directories = [self.unified_path] if self.unified_path else [self.cpu_path, self.memory_path]
        for directory in directories:
            if directory is None:
                return False
            members = set()
            try:
                for path in directory.rglob("cgroup.procs"):
                    members.update(int(value) for value in path.read_text().split())
            except (OSError, ValueError):
                return False
            if pid not in members:
                return False
        return True

    def reset_memory_peak(self):
        path = (
            self.unified_path / "memory.peak" if self.unified_path else self.memory_path / "memory.max_usage_in_bytes"
        )
        if not (self.exclusive and self.ownership_verified):
            raise ValueError("Peak reset requires verified exclusive ownership")
        if self.unified_path is not None:
            # v2 resets are local to the open file description. Reads through
            # a new descriptor would return its lifetime peak. Delegate this
            # file before use; sudo tee cannot supply a retained descriptor.
            handle = path.open("r+", encoding="utf-8")
            try:
                handle.write("0")
                handle.flush()
                handle.seek(0)
                return handle
            except BaseException:
                handle.close()
                raise
        if self.sudo_reset:
            subprocess.run(
                ["sudo", "-n", "tee", "--", str(path)],
                input="0",
                text=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                check=True,
            )
        else:
            path.write_text("0")

    def attach_self(self):
        if self.metadata.get("kind") == "docker_component":
            raise ValueError("Docker component scopes are measurement-only")
        if not (self.exclusive and self.ownership_verified):
            raise ValueError("Attaching requires verified exclusive ownership")
        directories = [self.unified_path] if self.unified_path else [self.cpu_path, self.memory_path]
        for directory in directories:
            if directory is None:
                raise ValueError("Both CPU and memory controllers are required")
            target = directory / "cgroup.procs"
            if not target.exists():
                target = directory / "tasks"
            target.write_text(str(os.getpid()))


def cgroup_scope_from_pid(
    pid, *, exclusive=False, ownership_verified=False, reset_peak=False, sudo_reset=False, metadata=None
):
    """Resolve an explicitly selected PID's actual controller membership."""
    if not isinstance(pid, int) or pid <= 0:
        raise ValueError("A positive PID is required")
    membership = {}
    for line in Path("/proc", str(pid), "cgroup").read_text().splitlines():
        hierarchy, controllers, relative = line.split(":", 2)
        for controller in controllers.split(","):
            membership[controller] = relative.lstrip("/")
    common = {
        "exclusive": exclusive,
        "ownership_verified": ownership_verified,
        "reset_peak": reset_peak,
        "sudo_reset": sudo_reset,
        "metadata": dict(metadata or {}),
    }
    if "cpuacct" in membership and "memory" in membership:
        return CgroupScope(
            cpu_path=Path("/sys/fs/cgroup/cpuacct") / membership["cpuacct"],
            memory_path=Path("/sys/fs/cgroup/memory") / membership["memory"],
            **common,
        )
    if "" in membership:
        root = Path("/sys/fs/cgroup")
        if (root / "unified").is_dir():
            root /= "unified"
        return CgroupScope(unified_path=root / membership[""], **common)
    raise RuntimeError("Selected process has no supported CPU+memory controller scope")


def docker_cgroup_scope(container, *, exclusive=False, ownership_verified=False, reset_peak=False, sudo_reset=False):
    """Inspect only identity fields; never serialize Docker's secret environment."""
    info = subprocess.run(
        [
            "docker",
            "inspect",
            "--format",
            "{{json .Id}} {{json .Name}} {{json .State.Pid}} {{json .State.StartedAt}}",
            str(container),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    # JSON strings may contain spaces, so decode four JSON values sequentially.
    values, decoder, remaining = [], __import__("json").JSONDecoder(), info.stdout.strip()
    while remaining:
        value, end = decoder.raw_decode(remaining)
        values.append(value)
        remaining = remaining[end:].lstrip()
    if len(values) != 4 or not isinstance(values[2], int) or values[2] <= 0:
        raise RuntimeError("Selected Docker container is not running")
    metadata = {
        "kind": "docker_component",
        "container_id": values[0],
        "container_name": values[1],
        "pid": values[2],
        "container_started_at": values[3],
    }
    return cgroup_scope_from_pid(
        values[2],
        exclusive=exclusive,
        ownership_verified=ownership_verified,
        reset_peak=reset_peak,
        sudo_reset=sudo_reset,
        metadata=metadata,
    )


def cgroup_capabilities():
    """Report host capability, never silently reuse a user/session cgroup."""
    paths = {
        "v2": Path("/sys/fs/cgroup/unified"),
        "v1_cpu": Path("/sys/fs/cgroup/cpuacct"),
        "v1_memory": Path("/sys/fs/cgroup/memory"),
    }
    result = {}
    for key, path in paths.items():
        result[key] = {
            "path": str(path),
            "exists": path.is_dir(),
            "readable": os.access(path, os.R_OK),
            "can_create_child": os.access(path, os.W_OK),
        }
    try:
        result["process_membership"] = Path("/proc/self/cgroup").read_text().splitlines()
    except OSError:
        result["process_membership"] = None
    return result


def provision_cgroup(name, *, sudo=False):
    """Create a new dedicated v1 CPU+memory scope, optionally delegate with sudo.

    Names are relative to controller roots; existing groups are refused. This
    only provisions the named scope and does not attach or terminate services.
    """
    parts = name.split("/")
    if not parts or any(not re.fullmatch(r"[A-Za-z0-9_.-]+", part) or part in (".", "..") for part in parts):
        raise ValueError("Cgroup name must contain safe relative path components")
    cpu = Path("/sys/fs/cgroup/cpuacct") / name
    memory = Path("/sys/fs/cgroup/memory") / name
    if not cpu.parent.is_dir() or not memory.parent.is_dir():
        raise ValueError("Parent measurement scopes must already exist")
    if cpu.exists() or memory.exists():
        raise FileExistsError("Refusing to reuse an existing measurement scope")
    command = ["mkdir", "--", str(cpu), str(memory)]
    if sudo:
        command = ["sudo", "-n"] + command
    subprocess.run(command, check=True, capture_output=True, text=True)
    if sudo:
        paths = [cpu, memory]
        for directory in (cpu, memory):
            paths += [directory / filename for filename in ("cgroup.procs", "tasks") if (directory / filename).exists()]
        paths.append(memory / "memory.max_usage_in_bytes")
        subprocess.run(
            ["sudo", "-n", "chown", "--", "%s:%s" % (os.getuid(), os.getgid()), *map(str, paths)],
            check=True,
            capture_output=True,
            text=True,
        )
    return CgroupScope(
        cpu_path=cpu,
        memory_path=memory,
        exclusive=True,
        ownership_verified=True,
        fresh=True,
        name=name,
        metadata={"kind": "runtime_provisioned", "created_by_uid": os.getuid()},
    )


def cleanup_cgroup(scope, *, sudo=False):
    """Remove only a newly provisioned empty scope; never signal its members."""
    scope = CgroupScope.from_dict(scope)
    if not (
        scope.fresh
        and scope.exclusive
        and scope.ownership_verified
        and scope.metadata.get("kind") == "runtime_provisioned"
        and scope.metadata.get("created_by_uid") == os.getuid()
    ):
        raise ValueError("Cleanup requires a newly provisioned owned measurement scope")
    directories = [scope.unified_path] if scope.unified_path else [scope.cpu_path, scope.memory_path]
    if any(directory is None for directory in directories):
        raise ValueError("Both controllers are required")
    for directory in directories:
        if not directory.exists():
            continue
        members = list(directory.rglob("cgroup.procs")) or list(directory.rglob("tasks"))
        if any(path.read_text().strip() for path in members):
            return {"removed": False, "reason": "scope_not_empty", "scope": scope.as_dict()}
    removed, errors = [], []
    for directory in directories:
        if not directory.exists():
            continue
        try:
            if sudo:
                subprocess.run(
                    ["sudo", "-n", "rmdir", "--", str(directory)], check=True, capture_output=True, text=True
                )
            else:
                directory.rmdir()
            removed.append(str(directory))
        except (OSError, subprocess.CalledProcessError) as error:
            errors.append(str(error))
    return {"removed": not errors, "removed_paths": removed, "errors": errors, "scope": scope.as_dict()}


class _ProcessSamples:
    def __init__(self, roots, include_roots=True):
        self.roots = tuple(int(pid) for pid in roots)
        self.include_roots = include_roots
        self.root_identities = {}
        self.seen = {}
        self.baseline_cpu = None
        self.cpu_max = [0.0, 0.0]
        self.peak_rss = None
        self.baseline_rss = None
        self.samples = 0
        self.current = set()
        self.initialized = False

    def sample(self, table):
        if not self.initialized:
            self.root_identities = {pid: table[pid]["start_ticks"] for pid in self.roots if pid in table}
            self.initialized = True
        roots = [
            pid for pid, start in self.root_identities.items() if pid in table and table[pid]["start_ticks"] == start
        ]
        found = descendants(table, roots, include_roots=self.include_roots)
        # Keep already discovered descendants after they are reparented.
        known = {pid for pid, start in self.seen.items() if pid in table and table[pid]["start_ticks"] == start}
        found |= known
        self.current = found
        for pid in found:
            self.seen[pid] = table[pid]["start_ticks"]
        if not found:
            return
        user = sum(table[pid]["user_seconds"] + table[pid]["waited_user_seconds"] for pid in found)
        system = sum(table[pid]["system_seconds"] + table[pid]["waited_system_seconds"] for pid in found)
        rss = sum(table[pid]["rss_bytes"] for pid in found)
        if self.baseline_cpu is None:
            self.baseline_cpu = (user, system)
            self.baseline_rss = rss
        self.cpu_max[0] = max(self.cpu_max[0], user - self.baseline_cpu[0])
        self.cpu_max[1] = max(self.cpu_max[1], system - self.baseline_cpu[1])
        self.peak_rss = max(self.peak_rss or 0, rss)
        self.samples += 1

    def result(self):
        available = self.samples > 0
        user, system = self.cpu_max if available else (None, None)
        return {
            "cpu_user_seconds": user,
            "cpu_system_seconds": system,
            "cpu_total_seconds": user + system if available else None,
            "peak_rss_bytes": self.peak_rss,
            "baseline_rss_bytes": self.baseline_rss,
            "sample_count": self.samples,
            "process_count_observed": len(self.seen),
            "identities": [{"pid": pid, "start_ticks": start} for pid, start in self.seen.items()],
        }


class ProcessResourceCollector:
    def __init__(
        self,
        root_pids=(),
        *,
        owned_service_pids=None,
        ownership_verified=False,
        scope_kind="process_tree",
        cgroup=None,
        sample_interval_seconds=0.05,
        include_roots=True,
        required_service_labels=None,
    ):
        if sample_interval_seconds <= 0:
            raise ValueError("Sampling interval must be positive")
        if scope_kind not in ("process_tree", "native_system"):
            raise ValueError("Scope must be process_tree or native_system")
        self.root_pids = tuple(root_pids)
        self.owned_service_pids = dict(owned_service_pids or {})
        self.ownership_verified = ownership_verified
        self.scope_kind = scope_kind
        self.required_service_labels = tuple(required_service_labels or ())
        self.cgroup = CgroupScope.from_dict(cgroup)
        self.sample_interval_seconds = sample_interval_seconds
        self._tree = _ProcessSamples(self.root_pids, include_roots=include_roots)
        self._services = {label: _ProcessSamples([pid]) for label, pid in self.owned_service_pids.items()}
        self._service_union = _ProcessSamples(self.owned_service_pids.values())
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._thread = None
        self._finished = None
        self._cgroup_initial = None
        self._cgroup_last = None
        self._cgroup_sampled_peak = None
        self._peak_reset = False
        self._peak_handle = None
        self._errors = []
        self._scope_lock = None

    def __enter__(self):
        if self._thread is not None:
            raise RuntimeError("Collector already started")
        self._started = time.monotonic()
        if self.cgroup:
            if self.cgroup.reset_peak:
                # Do not allow concurrent peak resets on the same scope.
                import fcntl

                memory_scope = self.cgroup.unified_path or self.cgroup.memory_path
                name = hashlib.sha256(str(memory_scope.resolve()).encode()).hexdigest()
                self._scope_lock = open(Path(tempfile_directory(), "texera-cgroup-" + name + ".lock"), "a")
                try:
                    fcntl.flock(self._scope_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    self._scope_lock.close()
                    self._scope_lock = None
                    raise RuntimeError("Measurement scope is already in use")
            self._cgroup_initial = self.cgroup.read()
            if self.cgroup.reset_peak:
                try:
                    self._peak_handle = self.cgroup.reset_memory_peak()
                    self._peak_reset = True
                except (OSError, subprocess.CalledProcessError) as error:
                    self._errors.append("cgroup_peak_reset_failed: " + str(error))
        self.sample()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return self

    def _loop(self):
        while not self._stop.wait(self.sample_interval_seconds):
            self.sample()

    def sample(self):
        table = process_table() if self.root_pids or self.owned_service_pids else {}
        with self._lock:
            self._tree.sample(table)
            for collector in self._services.values():
                collector.sample(table)
            self._service_union.sample(table)
            if self.cgroup:
                self._cgroup_last = self.cgroup.read(memory_peak_handle=self._peak_handle)
                current = self._cgroup_last["memory_current_bytes"]
                if current is not None:
                    self._cgroup_sampled_peak = max(self._cgroup_sampled_peak or 0, current)

    def snapshot(self):
        self.sample()
        return self._result()

    def validate_ready(self):
        """Fail before paid work if owned scope or exact counters are absent."""
        resource = self.snapshot()
        missing = []
        if not resource["scope"]["complete"]:
            missing.extend(resource["scope"]["limitations"] or ["scope coverage unverified"])
        if not resource["measurement"]["cpu"]["exact"]:
            missing.append("exact CPU counters unavailable")
        if not resource["measurement"]["memory"]["exact"]:
            missing.append("exact attempt memory peak unavailable")
        if self.cgroup and self.cgroup.metadata.get("kind") == "docker_component":
            pid = self.cgroup.metadata.get("pid")
            if not isinstance(pid, int) or not self.cgroup.contains_pid(pid):
                missing.append("owned Docker identity is no longer present in its controllers")
        if missing:
            raise RuntimeError("Complete resources unavailable: " + "; ".join(missing))
        return resource

    def _result(self):
        with self._lock:
            tree = self._tree.result()
            services = {
                label: value.result() | {"attribution": "owned" if self.ownership_verified else "unverified"}
                for label, value in self._services.items()
            }
            limits = []
            scope_complete = bool(self.root_pids) and len(self._tree.root_identities) == len(set(self.root_pids))
            if self.scope_kind == "native_system":
                if not self.owned_service_pids:
                    limits.append(
                        "native_system requires explicit owned_service_pids; adapter children omit engine services"
                    )
                if not self.ownership_verified:
                    limits.append("service ownership or exclusive attribution is unverified")
                if not self.required_service_labels:
                    limits.append("native_system requires explicit required_service_labels for full component coverage")
                undeclared = set(self.required_service_labels) - self.owned_service_pids.keys()
                if undeclared:
                    limits.append("required service PIDs missing: " + ", ".join(sorted(undeclared)))
                missing = [label for label, value in self._services.items() if not value.root_identities]
                if missing:
                    limits.append("service processes unavailable: " + ", ".join(missing))
                scope_complete = bool(services) and self.ownership_verified and not limits
            resource = {
                "schema_version": 1,
                "status": "available" if tree["sample_count"] or services or self._cgroup_last else "unavailable",
                **{
                    key: tree[key]
                    for key in ("cpu_user_seconds", "cpu_system_seconds", "cpu_total_seconds", "peak_rss_bytes")
                },
                "peak_memory_bytes": tree["peak_rss_bytes"],
                "scope": {
                    "kind": self.scope_kind,
                    "complete": scope_complete,
                    "limitations": limits,
                    "root_pids": list(self.root_pids),
                    "owned_service_pids": self.owned_service_pids,
                    "required_service_labels": list(self.required_service_labels),
                    "ownership_verified": self.ownership_verified,
                },
                "measurement": {
                    "cpu": {"method": "proc_sampled_cumulative_counters", "complete": False, "exact": False},
                    "memory": {
                        "method": "proc_sampled_rss_sum",
                        "complete": False,
                        "exact": False,
                        "sample_interval_seconds": self.sample_interval_seconds,
                        "may_miss_between_samples": True,
                        "includes_shared_pages_per_process": True,
                    },
                },
                "services": services,
                "services_combined": self._service_union.result(),
                "raw": {
                    "process_samples": tree,
                    "cgroup": self._cgroup_last,
                    "cgroup_initial": self._cgroup_initial,
                    "errors": list(self._errors),
                },
            }
            if resource["status"] == "unavailable":
                resource["reason"] = "no_readable_processes_or_controllers"
            if self._cgroup_initial and self._cgroup_last:
                for field in ("cpu_user_seconds", "cpu_system_seconds", "cpu_total_seconds"):
                    first, last = self._cgroup_initial[field], self._cgroup_last[field]
                    resource[field] = last - first if first is not None and last is not None and last >= first else None
                attributed = self.cgroup.exclusive and self.cgroup.ownership_verified
                cpu_complete = attributed and all(
                    resource[field] is not None
                    for field in ("cpu_user_seconds", "cpu_system_seconds", "cpu_total_seconds")
                )
                resource["measurement"]["cpu"] = {
                    "method": "cgroup_counter_delta",
                    "complete": cpu_complete,
                    "exact": cpu_complete,
                    "includes_exited_children": True,
                    "user_system_resolution_seconds": (
                        1e-6 if self._cgroup_last["version"] == 2 else 1 / os.sysconf("SC_CLK_TCK")
                    ),
                    "scope": "cgroup",
                    # Exact counter deltas and full scope coverage do not make
                    # independently accounted v1 user/system ticks an exact
                    # partition of scheduler runtime. Keep all values intact.
                    "total_exact": resource["cpu_total_seconds"] is not None,
                    "user_system_exact": self._cgroup_last["version"] == 2
                    and all(resource[field] is not None for field in ("cpu_user_seconds", "cpu_system_seconds")),
                    "counter_sources": (
                        {"total": "cpu.stat.usage_usec", "user": "cpu.stat.user_usec", "system": "cpu.stat.system_usec"}
                        if self._cgroup_last["version"] == 2
                        else {"total": "cpuacct.usage", "user": "cpuacct.stat.user", "system": "cpuacct.stat.system"}
                    ),
                    "total_resolution_seconds": 1e-6 if self._cgroup_last["version"] == 2 else 1e-9,
                    "user_system_accounting": (
                        "kernel_microsecond_cpu_stat" if self._cgroup_last["version"] == 2 else "kernel_tick_cpustat"
                    ),
                    "user_system_coherent_partition": self._cgroup_last["version"] == 2,
                    "total_minus_user_system_seconds": (
                        resource["cpu_total_seconds"] - resource["cpu_user_seconds"] - resource["cpu_system_seconds"]
                        if all(
                            resource[field] is not None
                            for field in ("cpu_user_seconds", "cpu_system_seconds", "cpu_total_seconds")
                        )
                        else None
                    ),
                    "accounting_note": (
                        "Exact denotes the recorded kernel counter delta at its reported resolution, with scope coverage recorded separately."
                        if self._cgroup_last["version"] == 2
                        else "Total is scheduler-runtime accounting; user/system are independent kernel tick cpustat estimates reported in USER_HZ. Their sum need not equal total, and USER_HZ rounding is not a bound on tick-accounting error."
                    ),
                }
                initial_peak = self._cgroup_initial["memory_peak_bytes"]
                fresh_peak = self.cgroup.fresh and initial_peak == 0
                hierarchy_complete = self._cgroup_last["memory_hierarchy_enabled"] is True
                peak_exact = attributed and (fresh_peak or self._peak_reset) and hierarchy_complete
                measured_peak = self._cgroup_last["memory_peak_bytes"] if peak_exact else self._cgroup_sampled_peak
                resource["peak_memory_bytes"] = measured_peak
                resource["measurement"]["memory"] = {
                    "method": (
                        "cgroup_fresh_peak"
                        if fresh_peak and peak_exact
                        else "cgroup_reset_peak" if peak_exact else "cgroup_sampled_current_peak"
                    ),
                    "complete": peak_exact and measured_peak is not None,
                    "exact": peak_exact and measured_peak is not None,
                    "includes_page_cache": True,
                    "baseline_memory_bytes": self._cgroup_initial["memory_current_bytes"],
                    "sample_interval_seconds": self.sample_interval_seconds,
                    "peak_reset": self._peak_reset,
                    "includes_descendant_cgroups": hierarchy_complete,
                }
                resource["scope"]["cgroup"] = self.cgroup.as_dict()
                if self.scope_kind == "process_tree":
                    covered_roots = True
                    if self.root_pids and self._tree.include_roots:
                        covered_roots = len(self._tree.root_identities) == len(set(self.root_pids)) and all(
                            self.cgroup.contains_pid(pid) for pid in self.root_pids
                        )
                        if not covered_roots:
                            resource["scope"]["limitations"].append(
                                "explicit root PIDs unavailable or outside controllers"
                            )
                    resource["scope"]["complete"] = attributed and covered_roots
                elif not attributed:
                    resource["scope"]["complete"] = False
                    resource["scope"]["limitations"].append("cgroup includes unverified or concurrent workloads")
                elif self.scope_kind == "native_system":
                    excluded = [
                        label for label, pid in self.owned_service_pids.items() if not self.cgroup.contains_pid(pid)
                    ]
                    if excluded:
                        resource["scope"]["complete"] = False
                        resource["scope"]["limitations"].append(
                            "service PIDs outside controllers: " + ", ".join(excluded)
                        )
            return resource

    def finish(self):
        if self._finished is not None:
            return self._finished
        if self._thread is None:
            return {"schema_version": 1, "status": "unavailable", "reason": "collector_not_started"}
        self._stop.set()
        self._thread.join()
        self.sample()
        self._finished = self._result()
        self._finished["wall_seconds"] = time.monotonic() - self._started
        if self._peak_handle is not None:
            self._peak_handle.close()
            self._peak_handle = None
        if self._scope_lock is not None:
            self._scope_lock.close()
            self._scope_lock = None
        return self._finished

    def __exit__(self, *exception):
        self.finish()


def tempfile_directory():
    import tempfile

    return tempfile.gettempdir()
