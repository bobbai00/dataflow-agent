#!/usr/bin/env python3
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
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from jupyter_client import KernelManager

HERE = Path(__file__).resolve().parent
WORKTREE = HERE.parents[1]
IMAGE = HERE / "DataMind/longds/runners/DSGym/executors/container_images/longds_image"
sys.path.insert(0, str(IMAGE))
from kernel_executor import KernelExecutor  # noqa: E402  (DSGym's own)


class LocalKernelExecutor(KernelExecutor):
    """DSGym's executor with the kernel pinned to this interpreter and started
    from the repository root, so the data paths the prompt names resolve."""

    def start(self):
        with self._lock:
            self.km = KernelManager(
                kernel_cmd=[sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"]
            )
            self.km.start_kernel(cwd=str(WORKTREE))
            self.kc = self.km.blocking_client()
            self.kc.wait_for_ready(timeout=60)


class Manager:
    def __init__(self, timeout: int):
        self.timeout = timeout
        self.executors: dict[int, LocalKernelExecutor] = {}
        self.next_id = 0
        self.lock = threading.Lock()

    def allocate(self) -> int:
        with self.lock:
            container_id = self.next_id
            self.next_id += 1
        executor = LocalKernelExecutor(timeout=self.timeout)
        executor.start()
        with self.lock:
            self.executors[container_id] = executor
        return container_id

    def execute(self, container_id: int, code: str):
        executor = self.executors[container_id]
        return executor.execute(code)

    def deallocate(self, container_id: int) -> None:
        with self.lock:
            executor = self.executors.pop(container_id, None)
        if executor:
            executor.stop()


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
    ap.add_argument("--timeout", type=int, default=int(os.getenv("EXECUTION_TIMEOUT", "600")),
                    help="seconds one execution may run before the kernel is interrupted and restarted")
    args = ap.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(Manager(args.timeout)))
    print(json.dumps({"executor": f"http://127.0.0.1:{args.port}", "timeout": args.timeout}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
