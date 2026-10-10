#!/usr/bin/env python3
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.

"""A local stand-in for DSGym's executor manager.

Speaks the manager's HTTP contract that `AllocatedCodeEnv` drives —
`POST /allocate`, `POST /session/{id}/execute`, `POST /deallocate/{id}`,
`GET /health` — over DSGym's own `KernelExecutor` (a persistent Jupyter kernel,
`executors/container_images/longds_image/kernel_executor.py`), so upstream's
`MultiTurnReActDSAgent` runs unchanged. Only the sandbox differs from the paper's
setup: the kernel is this interpreter, on this machine, instead of the docker
container. One kernel per allocation; state persists across every execute of
that allocation, exactly as it does inside the container.

Run under KramaBench's venv (jupyter_client, ipykernel and the data-science
stack live there):

    benchmark/Kramabench/.venv/bin/python dsgym_executor.py --port 5055
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from jupyter_client import KernelManager
from execution_isolation import isolated_command

HERE = Path(__file__).resolve().parent
WORKTREE = HERE.parents[1]
IMAGE = HERE / "DataMind/longds/runners/DSGym/executors/container_images/longds_image"
sys.path.insert(0, str(IMAGE))
from kernel_executor import KernelExecutor  # noqa: E402  (DSGym's own)


class LocalKernelExecutor(KernelExecutor):
    """Persistent kernel with only its source data and private scratch mounted."""

    def __init__(self, *, timeout, data_root, workspace, data_relative=None, extra_read_only=()):
        super().__init__(timeout=timeout)
        self.data_root = Path(data_root).resolve()
        self.workspace = Path(workspace).resolve()
        # Further read-only directories, mounted at their own paths (e.g. the
        # gold-prefix protocol's reference-state folder).
        self.extra_read_only = [Path(p).resolve() for p in extra_read_only]
        # The task prompt names files by paths relative to the repository
        # (`data/longds/<domain>/<dataset>/<task>/data/...`); the kernel's cwd
        # is /workspace, so the same data is also mounted there under that
        # relative path. Our engine resolves those paths the same way.
        self.data_relative = data_relative
        self.ipc_directory = None
        self.restart_requested = threading.Event()

    def start(self):
        with self._lock:
            # Unix socket names have a 107-byte limit on Linux. Benchmark output
            # paths include the SUT and task names and routinely exceed it.
            self.ipc_directory = tempfile.TemporaryDirectory(prefix="longds-ipc-", dir="/tmp")
            ipc = Path(self.ipc_directory.name)
            self.km = KernelManager(transport="ipc", ip=str(ipc / "kernel"),
                                    connection_file=str(ipc / "connection.json"))
            # kernel_cmd is ignored by recent jupyter_client releases. Set the
            # actual kernelspec, including the pinned interpreter and sandbox.
            relative = (
                [(self.data_root, str(Path("/workspace") / self.data_relative))] if self.data_relative else []
            )
            relative += [(path, str(path)) for path in self.extra_read_only]
            self.km.kernel_spec.argv = isolated_command(
                [sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
                python=sys.executable, data_roots=[self.data_root], workspace=self.workspace,
                read_only=relative, read_write=[(ipc, ipc)],
            )
            try:
                self.km.start_kernel(cwd=str(self.workspace))
                self.kc = self.km.blocking_client()
                self.kc.wait_for_ready(timeout=60)
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
        # Upstream requests this from a timeout thread. Perform the actual
        # restart on the persistent owner thread before the next execution.
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
    def __init__(self, timeout: int, data_root: Path, workspace: Path, data_relative: str | None = None,
                 extra_read_only=()):
        self.timeout = timeout
        self.data_root = data_root
        self.workspace = workspace
        self.data_relative = data_relative
        self.extra_read_only = list(extra_read_only)
        self.executors: dict[int, LocalKernelExecutor] = {}
        self.next_id = 0
        self.lock = threading.Lock()
        # bubblewrap's parent-death signal follows the spawning Linux thread.
        # HTTP request threads exit after each response, so kernels and their
        # ZeroMQ sockets must live on a persistent owner thread.
        self.kernel_thread = ThreadPoolExecutor(max_workers=1, thread_name_prefix="longds-kernel")

    def allocate(self) -> int:
        with self.lock:
            container_id = self.next_id
            self.next_id += 1
        workspace = Path(tempfile.mkdtemp(prefix=f"kernel-{container_id}-", dir=self.workspace))
        executor = LocalKernelExecutor(
            timeout=self.timeout, data_root=self.data_root, workspace=workspace, data_relative=self.data_relative,
            extra_read_only=self.extra_read_only,
        )
        self.kernel_thread.submit(executor.start).result()
        with self.lock:
            self.executors[container_id] = executor
        return container_id

    def execute(self, container_id: int, code: str):
        executor = self.executors[container_id]
        return self.kernel_thread.submit(executor.execute, code).result()

    def deallocate(self, container_id: int) -> None:
        with self.lock:
            executor = self.executors.pop(container_id, None)
        if executor:
            self.kernel_thread.submit(executor.stop).result()

    def close(self):
        for container_id in list(self.executors):
            self.deallocate(container_id)
        self.kernel_thread.shutdown(wait=True)


def make_handler(manager: Manager):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, payload) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            length = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(length) or b"{}")

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
                    return self._send(200, {"outputs": manager.execute(container_id, self._body()["code"])})
                self._send(404, {"detail": "not found"})
            except Exception as error:  # the agent turns this into an observation
                self._send(500, {"detail": str(error)})

        def log_message(self, fmt, *args):  # quiet; the runner log carries the trace
            return

    return Handler


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5055)
    ap.add_argument("--data-root", type=Path, required=True, help="Only raw task data is mounted, read-only")
    ap.add_argument("--workspace", type=Path, required=True, help="Private per-run scratch parent")
    ap.add_argument("--data-relative", default=None,
                    help="Also mount the data root at /workspace/<this relative path>, so the task prompt's "
                         "repository-relative file paths resolve from the kernel's cwd")
    ap.add_argument("--extra-ro", type=Path, action="append", default=[],
                    help="additional directory mounted read-only at its own path (repeatable)")
    ap.add_argument("--timeout", type=int, default=int(os.getenv("EXECUTION_TIMEOUT", "600")),
                    help="seconds one execution may run before the kernel is interrupted and restarted")
    args = ap.parse_args()
    args.workspace.mkdir(parents=True, exist_ok=True)
    manager = Manager(args.timeout, args.data_root.resolve(), args.workspace.resolve(), args.data_relative,
                      extra_read_only=args.extra_ro)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(manager))
    print(json.dumps({"executor": f"http://127.0.0.1:{args.port}", "timeout": args.timeout}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        manager.close()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
