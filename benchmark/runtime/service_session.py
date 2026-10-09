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
"""Retain a supported launcher and its services under one explicit lifetime.

Keep this command's host execution session running. SIGTERM/SIGINT stops only
its descendants, including services that changed sessions or orphaned.
"""
import argparse
import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

from .metrics import write_json_exclusive
from .resources import CgroupScope
from ._supervisor import _reap, _signal_owned


def run_service_session(
    command, *, ready_file=None, result_file=None, cgroup=None, terminate_grace_seconds=0.5, cwd=None, env=None
):
    if sys.platform != "linux":
        raise RuntimeError("Service lifetime supervision requires Linux")
    if not command or terminate_grace_seconds < 0:
        raise ValueError("A launcher command and nonnegative grace period are required")
    # Refuse existing artifacts before starting any owned processes.
    for artifact in (ready_file, result_file):
        if artifact is not None and Path(artifact).exists():
            raise FileExistsError(str(artifact))
    stopping = [False]
    old_handlers = {kind: signal.getsignal(kind) for kind in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
    for kind in old_handlers:
        signal.signal(kind, lambda *args: stopping.__setitem__(0, True))
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "Cannot enable child subreaper")
    # A lost calling session stops its explicitly owned service tree.
    parent_pid = os.getppid()
    if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "Cannot bind service session to parent lifetime")
    if os.getppid() != parent_pid:
        stopping[0] = True
    scope = CgroupScope.from_dict(cgroup)
    if scope:
        scope.attach_self()
    launcher = None
    launcher_code = None
    cleanup_started = None
    announced = False
    started = time.monotonic()
    reaped_count = 0
    no_children = False
    try:
        launcher = subprocess.Popen([str(value) for value in command], cwd=cwd, env=env)
        while True:
            reaped, no_children = _reap()
            reaped_count += len(reaped)
            for pid, status, usage in reaped:
                if pid == launcher.pid:
                    launcher_code = os.waitstatus_to_exitcode(status)
                    launcher.returncode = launcher_code
            if launcher_code == 0 and not announced and not stopping[0]:
                announced = True
                if ready_file:
                    write_json_exclusive(
                        ready_file,
                        {
                            "schema_version": 1,
                            "status": "launcher_completed",
                            "session_pid": os.getpid(),
                            "launcher_pid": launcher.pid,
                            "launcher_returncode": 0,
                            "cgroup": scope.as_dict() if scope else None,
                            "readiness_semantics": "launcher success; application health requires separate checks",
                        },
                    )
            if launcher_code is not None and launcher_code != 0:
                stopping[0] = True
            if stopping[0]:
                if no_children:
                    break
                now = time.monotonic()
                if cleanup_started is None:
                    cleanup_started = now
                    _signal_owned(signal.SIGTERM)
                elif now - cleanup_started >= terminate_grace_seconds:
                    _signal_owned(signal.SIGKILL)
            time.sleep(0.02)
        code = launcher_code if launcher_code not in (None, 0) and not announced else 0
        if result_file:
            write_json_exclusive(
                result_file,
                {
                    "schema_version": 1,
                    "status": "stopped" if announced else "launcher_failed",
                    "returncode": code,
                    "wall_seconds": time.monotonic() - started,
                    "cleanup": {"reaped_processes": reaped_count, "remaining_children": not no_children},
                },
            )
        return code
    finally:
        _signal_owned(signal.SIGKILL)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            reaped, done = _reap()
            if done:
                break
            time.sleep(0.01)
        for kind, handler in old_handlers.items():
            signal.signal(kind, handler)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ready-file")
    parser.add_argument("--result-file")
    parser.add_argument("--scope-file")
    parser.add_argument("--terminate-grace-seconds", type=float, default=0.5)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    scope = json.loads(Path(args.scope_file).read_text()) if args.scope_file else None
    return run_service_session(
        command,
        ready_file=args.ready_file,
        result_file=args.result_file,
        cgroup=scope,
        terminate_grace_seconds=args.terminate_grace_seconds,
    )


if __name__ == "__main__":
    sys.exit(main())
