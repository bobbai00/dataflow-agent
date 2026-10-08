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
"""Private per-attempt subreaper. It never reads or serializes environment values."""
import ctypes
from datetime import datetime, timezone
import errno
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

# This file is invoked by absolute path from any task working directory.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from benchmark.runtime.resources import CgroupScope, ProcessResourceCollector, descendants, process_table


def _reap():
    result = []
    while True:
        try:
            pid, status, usage = os.wait4(-1, os.WNOHANG)
            if not pid:
                return result, False
            result.append((pid, status, usage))
        except ChildProcessError:
            return result, True
        except InterruptedError:
            continue


def _signal_owned(signum):
    table = process_table()
    pids = descendants(table, [os.getpid()], include_roots=False)
    for pid in pids:
        try:
            os.kill(pid, signum)
        except ProcessLookupError:
            pass
    return len(pids)


def main():
    request = json.load(sys.stdin)
    finished = None
    collector = None
    process = None
    interrupted = [False]
    signal.signal(signal.SIGTERM, lambda *args: interrupted.__setitem__(0, True))
    signal.signal(signal.SIGINT, lambda *args: interrupted.__setitem__(0, True))
    started = time.monotonic()
    started_at = datetime.now(timezone.utc).isoformat()
    reaped = []
    root_status = None
    timed_out = False
    cleanup_started = None
    sent_term = sent_kill = 0
    no_children = False
    error = None
    try:
        if sys.platform != "linux" or not hasattr(os, "wait4"):
            raise RuntimeError("Complete process-tree supervision requires Linux wait4")
        libc = ctypes.CDLL(None, use_errno=True)
        # PR_SET_CHILD_SUBREAPER: descendants that orphan become our children.
        if libc.prctl(36, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "Cannot enable child subreaper")
        cgroup = CgroupScope.from_dict(request.get("cgroup"))
        collector = ProcessResourceCollector(
            root_pids=[os.getpid()],
            include_roots=False,
            owned_service_pids=request.get("owned_service_pids"),
            ownership_verified=request.get("ownership_verified", False),
            scope_kind=request.get("scope_kind", "process_tree"),
            cgroup=cgroup,
            required_service_labels=request.get("required_service_labels"),
            sample_interval_seconds=request["sample_interval_seconds"],
        )
        with collector:
            if request.get("require_complete_resources"):
                collector.validate_ready()
            # This dedicated supervisor is single-threaded before __enter__
            # starts sampling; use a wrapper instead of preexec in that thread.
            command = request["command"]
            if cgroup is not None:
                command = [
                    sys.executable,
                    str(Path(__file__).with_name("cgroup_exec.py")),
                    "--scope-json",
                    json.dumps(cgroup.as_dict()),
                    "--",
                    *command,
                ]
            process = subprocess.Popen(command, cwd=request.get("cwd"), start_new_session=True)
            table = process_table()
            root_identity = table.get(process.pid, {}).get("start_ticks")
            Path(request["launch_file"]).write_text(json.dumps({"pid": process.pid, "start_ticks": root_identity}))
            while not no_children:
                fresh, no_children = _reap()
                reaped.extend(fresh)
                for pid, status, usage in fresh:
                    if pid == process.pid:
                        root_status = status
                        process.returncode = os.waitstatus_to_exitcode(status)
                now = time.monotonic()
                if not timed_out and root_status is None and now - started >= request["timeout_seconds"]:
                    timed_out = True
                if (timed_out or interrupted[0] or root_status is not None) and not no_children:
                    if cleanup_started is None:
                        cleanup_started = now
                        sent_term += _signal_owned(signal.SIGTERM)
                    elif now - cleanup_started >= request["terminate_grace_seconds"]:
                        sent_kill += _signal_owned(signal.SIGKILL)
                if not no_children:
                    time.sleep(0.01)
            resources = collector.finish()
            # wait4 values for children reaped by this supervisor include any
            # children they themselves waited for. Those cannot also be reaped
            # here, so summing these values does not count descendants twice.
            if cgroup is None:
                user = sum(usage.ru_utime for pid, status, usage in reaped)
                system = sum(usage.ru_stime for pid, status, usage in reaped)
                resources.update(cpu_user_seconds=user, cpu_system_seconds=system, cpu_total_seconds=user + system)
                resources["measurement"]["cpu"] = {
                    "method": "wait4_reaped_process_tree",
                    "complete": no_children,
                    "exact": no_children,
                    "includes_exited_children": True,
                    "scope": "adapter_process_tree",
                    "total_exact": no_children,
                    "user_system_exact": no_children,
                    "counter_sources": {
                        "total": "sum(wait4.ru_utime + wait4.ru_stime)",
                        "user": "wait4.ru_utime",
                        "system": "wait4.ru_stime",
                    },
                    "total_resolution_seconds": 1e-6,
                    "user_system_resolution_seconds": 1e-6,
                    "user_system_accounting": "kernel_reported_rusage",
                    "user_system_coherent_partition": True,
                    "total_minus_user_system_seconds": 0.0,
                    "accounting_note": "Exact denotes complete recorded kernel rusage counters at their reported microsecond resolution. Kernel accounting precision is separate from scope coverage; pre-existing engine services are outside this adapter process tree.",
                }
                if request.get("scope_kind") == "native_system":
                    resources["measurement"]["cpu"]["complete"] = False
                    resources["measurement"]["cpu"]["limitations"] = ["wait4 excludes existing engine services"]
            resources["scope"]["root_pids"] = [process.pid]
            resources["raw"]["reaped"] = [
                {
                    "pid": pid,
                    "returncode": os.waitstatus_to_exitcode(status),
                    "cpu_user_seconds": usage.ru_utime,
                    "cpu_system_seconds": usage.ru_stime,
                    "individual_peak_rss_bytes": usage.ru_maxrss * 1024,
                }
                for pid, status, usage in reaped
            ]
            resources["raw"]["largest_individual_peak_rss_bytes"] = max(
                (usage.ru_maxrss * 1024 for pid, status, usage in reaped), default=None
            )
            resources["raw"]["individual_peaks_are_not_summed"] = True
            wall_seconds = time.monotonic() - started
            finished_at = datetime.now(timezone.utc).isoformat()
            finished = {
                "returncode": process.returncode,
                "status": "timeout" if timed_out else "error" if interrupted[0] or process.returncode else "completed",
                "timed_out": timed_out,
                "wall_seconds": wall_seconds,
                "wall_interval": {
                    "source": "supervision.json.wall_seconds",
                    "boundary": "supervisor timer start before measurement setup through child-tree exit and resource finalization",
                    "started_at": started_at,
                    "finished_at": finished_at,
                    "utc_status": "observed",
                },
                "resources": resources,
                "error": "interrupted" if interrupted[0] else None,
                "cleanup": {
                    "reaped_processes": len(reaped),
                    "remaining_children": not no_children,
                    "term_signals": sent_term,
                    "kill_signals": sent_kill,
                },
            }
    except BaseException as exception:
        error = "%s: %s" % (type(exception).__name__, exception)
    finally:
        if error is not None:
            _signal_owned(signal.SIGKILL)
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                fresh, no_children = _reap()
                reaped.extend(fresh)
                if no_children:
                    break
                time.sleep(0.01)
            wall_seconds = time.monotonic() - started
            finished_at = datetime.now(timezone.utc).isoformat()
            finished = {
                "returncode": process.returncode if process else None,
                "status": "error",
                "timed_out": timed_out,
                "wall_seconds": wall_seconds,
                "wall_interval": {
                    "source": "supervision.json.wall_seconds",
                    "boundary": "supervisor timer start before measurement setup through error cleanup, before final resource capture",
                    "started_at": started_at,
                    "finished_at": finished_at,
                    "utc_status": "observed",
                },
                "resources": collector.finish() if collector else {"status": "unavailable", "reason": error},
                "error": error,
                "cleanup": {"remaining_children": not no_children},
            }
            if request.get("require_complete_resources") and process is None:
                finished["resources"]["status"] = "unavailable"
                finished["resources"]["reason"] = "required_resources_incomplete"
        Path(request["result_file"]).write_text(json.dumps(finished, allow_nan=False))


if __name__ == "__main__":
    main()
