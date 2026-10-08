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
"""Isolated subreaper supervision, safe for concurrent benchmark runner threads."""
from dataclasses import asdict, dataclass
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from typing import Optional

from .resources import CgroupScope, descendants, process_table


@dataclass
class SupervisedResult:
    returncode: Optional[int]
    status: str
    timed_out: bool
    wall_seconds: float
    resources: dict
    stdout: Optional[str] = None
    stderr: Optional[str] = None
    error: Optional[str] = None
    cleanup: Optional[dict] = None
    wall_interval: Optional[dict] = None

    def as_dict(self):
        return asdict(self)


def _fallback_cleanup(supervisor_pid, launch_file):
    table = process_table()
    owned = descendants(table, [supervisor_pid], include_roots=False)
    try:
        launched = json.loads(Path(launch_file).read_text())
        pid = launched["pid"]
        if pid in table and table[pid]["start_ticks"] == launched["start_ticks"]:
            owned |= descendants(table, [pid])
    except (OSError, ValueError, KeyError):
        pass
    for pid in owned:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def run_supervised(
    command,
    timeout_seconds,
    *,
    cwd=None,
    env=None,
    stdout_path=None,
    stderr_path=None,
    owned_service_pids=None,
    ownership_verified=False,
    scope_kind="process_tree",
    cgroup=None,
    sample_interval_seconds=0.05,
    terminate_grace_seconds=0.5,
    required_service_labels=None,
    require_complete_resources=False,
):
    """Run one command with complete Linux child CPU and measured cleanup.

    A dedicated supervisor becomes a subreaper, so wait4 accounts for short
    children and orphaned descendants without changing the runner's global
    child handling. Existing services are only measured, never terminated.
    """
    if not command or timeout_seconds <= 0 or terminate_grace_seconds < 0:
        raise ValueError("Command and positive timeout are required")
    if sample_interval_seconds <= 0:
        raise ValueError("Sampling interval must be positive")
    cgroup = CgroupScope.from_dict(cgroup)
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="texera-attempt-") as temporary:
        temporary = Path(temporary)
        result_file, launch_file = temporary / "result.json", temporary / "launched.json"
        stdout_target = Path(stdout_path) if stdout_path is not None else temporary / "stdout"
        stderr_target = Path(stderr_path) if stderr_path is not None else temporary / "stderr"
        stdout_target.parent.mkdir(parents=True, exist_ok=True)
        stderr_target.parent.mkdir(parents=True, exist_ok=True)
        process = None
        # Exclusive opens occur before starting any child.
        with stdout_target.open("x", encoding="utf-8") as stdout:
            with stderr_target.open("x", encoding="utf-8") as stderr:
                request = {
                    "command": [str(value) for value in command],
                    "timeout_seconds": timeout_seconds,
                    "cwd": str(cwd) if cwd is not None else None,
                    "result_file": str(result_file),
                    "launch_file": str(launch_file),
                    "owned_service_pids": owned_service_pids or {},
                    "ownership_verified": ownership_verified,
                    "scope_kind": scope_kind,
                    "required_service_labels": list(required_service_labels or ()),
                    "require_complete_resources": require_complete_resources,
                    "cgroup": cgroup.as_dict() if cgroup else None,
                    "sample_interval_seconds": sample_interval_seconds,
                    "terminate_grace_seconds": terminate_grace_seconds,
                }
                process = subprocess.Popen(
                    [sys.executable, str(Path(__file__).with_name("_supervisor.py"))],
                    stdin=subprocess.PIPE,
                    stdout=stdout,
                    stderr=stderr,
                    env=env,
                    start_new_session=True,
                    text=True,
                )
                try:
                    process.communicate(json.dumps(request), timeout=timeout_seconds + terminate_grace_seconds + 15)
                except BaseException:
                    process.terminate()
                    try:
                        process.wait(timeout=terminate_grace_seconds + 3)
                    except subprocess.TimeoutExpired:
                        _fallback_cleanup(process.pid, launch_file)
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
                    raise
        try:
            data = json.loads(result_file.read_text())
        except (OSError, ValueError):
            _fallback_cleanup(process.pid, launch_file)
            data = {
                "returncode": None,
                "status": "error",
                "timed_out": False,
                "wall_seconds": time.monotonic() - started,
                "resources": {"status": "unavailable", "reason": "supervisor_failed_before_metrics"},
                "error": "Supervisor exited without a metrics artifact",
            }
        # Supervisor startup is outside task wall time and reported separately.
        data.setdefault("resources", {}).setdefault("raw", {})["supervision_wall_seconds"] = time.monotonic() - started
        data["stdout"] = stdout_target.read_text(errors="replace") if stdout_path is None else None
        data["stderr"] = stderr_target.read_text(errors="replace") if stderr_path is None else None
        return SupervisedResult(**data)
