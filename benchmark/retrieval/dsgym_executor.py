#!/usr/bin/env python3
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
"""A local stand-in for DSGym's executor manager, for one KramaBench task.

DSGym runs model-written code in docker containers behind a manager. This
serves the manager's HTTP contract that its `AllocatedCodeEnv` drives
(`POST /allocate`, `POST /session/{id}/execute`, `POST /deallocate/{id}`,
`GET /health`) over DSGym's own `KernelExecutor`, a persistent Jupyter kernel,
so the upstream agent runs unchanged. Only the container differs: the kernel
is this interpreter under bubblewrap, with the task's input directory mounted
read-only at the relative path the prompt names, a private working directory
and no network. Workload files, reference solutions, other runs and the
repository are not mounted.

Run with KramaBench's interpreter, whose packages the kernel then offers:

    benchmark/Kramabench/.venv/bin/python dsgym_executor.py \
        --data-root benchmark/Kramabench/data/legal/input \
        --data-relative data/legal/input --workspace /var/tmp/run/kernels

The first line of stdout is JSON with the manager's URL.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import signal
import sys
import tempfile
import threading
import time

from jupyter_client import KernelManager

from execution_isolation import isolated_command

DSGYM = Path(os.environ.get("DSGYM_HOME") or Path(__file__).resolve().parents[1] / "DSGym")
sys.path.insert(0, str(DSGYM / "executors/container_images/instance"))
from kernel_executor import KernelExecutor  # noqa: E402  (DSGym's own)


class SandboxedKernelExecutor(KernelExecutor):
    """DSGym's kernel executor with the kernel started under bubblewrap."""

    def __init__(self, *, timeout, data_root, data_relative, workspace):
        super().__init__(timeout=timeout)
        self.data_root = Path(data_root).resolve()
        self.data_relative = data_relative
        self.workspace = Path(workspace).resolve()
        self.ipc_directory = None
        self.restart_requested = threading.Event()

    def start(self):
        with self._lock:
            # A Unix socket path is limited to 107 bytes; run directories exceed it.
            self.ipc_directory = tempfile.TemporaryDirectory(prefix="dsgym-ipc-", dir="/tmp")
            ipc = Path(self.ipc_directory.name)
            self.km = KernelManager(
                transport="ipc", ip=str(ipc / "kernel"), connection_file=str(ipc / "connection.json")
            )
            # Recent jupyter_client ignores kernel_cmd; set the kernelspec's argv.
            self.km.kernel_spec.argv = isolated_command(
                [sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
                python=sys.executable,
                data_roots=[],
                workspace=self.workspace,
                read_only=[(self.data_root, str(Path("/workspace") / self.data_relative))],
                read_write=[(ipc, ipc)],
                environment={"HOME": "/workspace"},
            )
            try:
                self.km.start_kernel(cwd=str(self.workspace))
                self.kc = self.km.blocking_client()
                self.kc.wait_for_ready(timeout=120)
            except Exception:
                self._stop_locked()
                raise

    def _stop_locked(self):
        try:
            if self.kc:
                self.kc.stop_channels()
            if self.km and self.km.has_kernel:
                self.km.shutdown_kernel(now=True)
        finally:
            self.kc = self.km = None
            if self.ipc_directory:
                self.ipc_directory.cleanup()
                self.ipc_directory = None

    def stop(self):
        with self._lock:
            self._stop_locked()

    def restart(self):
        # Upstream restarts from a timer thread after a timeout. The sandbox
        # dies with the thread that spawned it, so the kernel's owner thread
        # restarts it before the next execution instead.
        if self.restart_requested.is_set():
            return {"status": "already_restarting"}
        self.restart_requested.set()
        return {"status": "restarting"}

    def execute(self, code):
        if self.restart_requested.is_set():
            self.stop()
            self.start()
            self.restart_requested.clear()
        return super().execute(code)


class Manager:
    def __init__(self, *, timeout, data_root, data_relative, workspace, log):
        self.timeout = timeout
        self.data_root = data_root
        self.data_relative = data_relative
        self.workspace = workspace
        self.log = log
        self.executors = {}
        self.next_id = 0
        self.lock = threading.Lock()
        # bubblewrap's parent-death signal follows the spawning thread, and HTTP
        # request threads end with their response: one persistent thread owns
        # every kernel and its sockets.
        self.owner = ThreadPoolExecutor(max_workers=1, thread_name_prefix="dsgym-kernel")

    def record(self, event, started, **fields):
        if not self.log:
            return
        entry = {
            "event": event,
            "seconds": round(time.monotonic() - started, 4),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            **fields,
        }
        with self.lock, self.log.open("a") as stream:
            stream.write(json.dumps(entry) + "\n")

    def allocate(self):
        started = time.monotonic()
        with self.lock:
            container_id = self.next_id
            self.next_id += 1
        workspace = Path(tempfile.mkdtemp(prefix=f"kernel-{container_id}-", dir=self.workspace))
        executor = SandboxedKernelExecutor(
            timeout=self.timeout, data_root=self.data_root, data_relative=self.data_relative, workspace=workspace
        )
        self.owner.submit(executor.start).result()
        with self.lock:
            self.executors[container_id] = executor
        self.record("allocate", started, container=container_id)
        return container_id

    def execute(self, container_id, code):
        started = time.monotonic()
        outputs = self.owner.submit(self.executors[container_id].execute, code).result()
        errors = [o.get("name") for o in outputs if isinstance(o, dict) and o.get("type") == "error"]
        self.record(
            "execute",
            started,
            container=container_id,
            code_chars=len(code),
            errors=errors,
            timed_out="TimeoutError" in errors,
        )
        return outputs

    def deallocate(self, container_id):
        started = time.monotonic()
        with self.lock:
            executor = self.executors.pop(container_id, None)
        if executor:
            self.owner.submit(executor.stop).result()
            self.record("deallocate", started, container=container_id)

    def close(self):
        for container_id in list(self.executors):
            self.deallocate(container_id)
        self.owner.shutdown(wait=True)


def make_handler(manager):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status, payload):
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            if self.path == "/health":
                return self._send(200, {"status": "ok", "allocated": len(manager.executors)})
            self._send(404, {"detail": "not found"})

        def do_POST(self):  # noqa: N802
            try:
                if self.path == "/allocate":
                    return self._send(200, {"container_id": manager.allocate()})
                if self.path.startswith("/deallocate/"):
                    manager.deallocate(int(self.path.rsplit("/", 1)[1]))
                    return self._send(200, {"status": "deallocated"})
                if self.path.startswith("/session/") and self.path.endswith("/execute"):
                    container_id = int(self.path.split("/")[2])
                    if container_id not in manager.executors:
                        return self._send(404, {"detail": f"Container {container_id} not found"})
                    length = int(self.headers.get("Content-Length") or 0)
                    code = json.loads(self.rfile.read(length) or b"{}")["code"]
                    return self._send(200, {"outputs": manager.execute(container_id, code)})
                self._send(404, {"detail": "not found"})
            except Exception as error:  # the agent turns this into an observation
                self._send(500, {"detail": str(error)})

        def log_message(self, fmt, *args):
            return

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=0, help="0 picks a free port")
    parser.add_argument("--data-root", type=Path, required=True, help="the task's input directory, mounted read-only")
    parser.add_argument(
        "--data-relative", required=True, help="where the kernel sees it, relative to its working directory"
    )
    parser.add_argument("--workspace", type=Path, required=True, help="parent of the private working directories")
    parser.add_argument(
        "--timeout", type=int, default=600, help="seconds one execution may run (DSGym's docker-compose.yml: 600)"
    )
    parser.add_argument("--log", type=Path, help="JSON lines: seconds per allocation and execution")
    args = parser.parse_args()
    args.workspace.mkdir(parents=True, exist_ok=True)
    manager = Manager(
        timeout=args.timeout,
        data_root=args.data_root.resolve(),
        data_relative=args.data_relative,
        workspace=args.workspace.resolve(),
        log=args.log,
    )
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(manager))

    def terminate(signum, frame):
        # A kernel may be mid-execution, its executor locked until the timeout.
        # The sandbox dies with this process, so leave at once.
        for executor in list(manager.executors.values()):
            if executor.ipc_directory:
                shutil.rmtree(executor.ipc_directory.name, ignore_errors=True)
        os._exit(0)

    signal.signal(signal.SIGTERM, terminate)
    print(
        json.dumps({"manager_url": f"http://127.0.0.1:{server.server_address[1]}", "timeout": args.timeout}), flush=True
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        manager.close()
        server.server_close()


if __name__ == "__main__":
    main()
