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

"""The session's Python executor: one sandboxed worker process per chat session.

The agent's code actions and the user's own code (`run_python`) go to the same
worker, so they share one set of variables. The worker runs in the user's files
folder, where uploads land and where code writes, so a script's relative paths
to its data work; its own scratch (temp files, matplotlib cache, log) is in
`.worker/` there.

On macOS the worker runs under a seatbelt profile (`sandbox-exec`) that denies the
whole data directory, which holds every user's files and the trace database,
except the session owner's own folder, denies the secrets files the server reads,
and denies outbound network. Elsewhere the worker is only a separate process in the
user's folder: it keeps sessions apart in memory, not on disk. The worker's
environment is built from scratch, so the gateway key never reaches model code.
"""

import base64
import io
import json
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

from PIL import Image
from smolagents.local_python_executor import CodeOutput, PythonExecutor

WORKER = Path(__file__).with_name("worker.py")
STARTUP_SECONDS = 120
SANDBOX_EXEC = "/usr/bin/sandbox-exec"


class WorkerLost(RuntimeError):
    """The worker died or overran; it is restarted on the next execution, without its variables."""


def resolve_sandbox(requested: str) -> str:
    if requested == "auto":
        return "seatbelt" if sys.platform == "darwin" and Path(SANDBOX_EXEC).exists() else "none"
    if requested == "seatbelt" and not Path(SANDBOX_EXEC).exists():
        raise ValueError(f"sandbox 'seatbelt' needs {SANDBOX_EXEC}")
    return requested


def _quoted(path: Path) -> str:
    return json.dumps(str(path.resolve()))  # an SBPL string literal is a JSON string literal


def seatbelt_profile(data_dir: Path, user_dir: Path, secret_files: list[Path]) -> str:
    denied = [f"(subpath {_quoted(data_dir)})"] + [f"(literal {_quoted(path)})" for path in secret_files]
    # In a seatbelt profile the last matching rule wins, so the owner's folder is carved back out.
    return ("(version 1)(allow default)"
            f"(deny file-read* file-write* {' '.join(denied)})"
            f"(allow file-read* file-write* (subpath {_quoted(user_dir)}))"
            "(deny network-outbound (remote ip))")


class WorkerExecutor(PythonExecutor):
    """smolagents' interpreter in a worker process, reporting each execution to `on_exec`."""

    def __init__(self, *, user_dir: Path, data_dir: Path, authorized_imports: list[str], timeout: float,
                 sandbox: str, secret_files: list[Path], on_exec, max_print_outputs_length: int | None = None):
        self.user_dir = Path(user_dir)
        self.workspace = self.user_dir / "files"
        self.data_dir = Path(data_dir)
        self.authorized_imports = authorized_imports
        self.timeout = timeout
        self.sandbox = resolve_sandbox(sandbox)
        self.secret_files = [Path(p) for p in secret_files if Path(p).exists()]
        self.on_exec = on_exec
        self.max_print_outputs_length = max_print_outputs_length
        self.process: subprocess.Popen | None = None
        self.replies: queue.Queue = queue.Queue()
        # CodeAgent reads `_print_outputs` from here when an execution fails.
        self.state: dict = {}
        self._io = threading.Lock()
        self._closed = False

    def send_tools(self, tools):
        # The worker defines `final_answer` itself; the agent has no other tool.
        extra = set(tools) - {"final_answer"}
        if extra:
            raise NotImplementedError(f"Tools are not forwarded to the worker: {sorted(extra)}")

    def send_variables(self, variables):
        if variables:
            raise NotImplementedError("Variables are not forwarded to the worker")

    def _command(self) -> list[str]:
        settings = {"authorized_imports": self.authorized_imports,
                    "max_print_outputs_length": self.max_print_outputs_length,
                    # Plain Python for the user's own code only where a sandbox contains it.
                    "plain_user_code": self.sandbox != "none"}
        command = [sys.executable, "-I", str(WORKER), json.dumps(settings)]
        if self.sandbox == "seatbelt":
            profile = seatbelt_profile(self.data_dir, self.user_dir, self.secret_files)
            command = [SANDBOX_EXEC, "-p", profile, *command]
        return command

    def warm(self) -> None:
        """Start the worker ahead of the first execution; a failure is reported by that execution instead."""
        with self._io:
            if not self._closed and (self.process is None or self.process.poll() is not None):
                try:
                    self._start()
                except Exception:  # noqa: BLE001
                    self._kill()

    def _start(self) -> None:
        if self._closed:
            raise WorkerLost("This chat session has ended")
        scratch = self.workspace / ".worker"
        for folder in (scratch / "tmp", scratch / "matplotlib"):
            folder.mkdir(parents=True, exist_ok=True)
        environment = {"PATH": "/usr/bin:/bin", "HOME": str(scratch), "TMPDIR": str(scratch / "tmp"),
                       "MPLCONFIGDIR": str(scratch / "matplotlib"), "PYTHONUNBUFFERED": "1",
                       "LANG": "C.UTF-8", "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1",
                       "MKL_NUM_THREADS": "1"}
        self.process = subprocess.Popen(self._command(), cwd=self.workspace, env=environment, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, text=True, bufsize=1)
        self.replies = queue.Queue()
        threading.Thread(target=self._read, args=(self.process, self.replies), daemon=True).start()
        if not self._reply(STARTUP_SECONDS).get("ready"):
            raise WorkerLost("The Python worker did not start")

    @staticmethod
    def _read(process, replies) -> None:
        for line in process.stdout:
            replies.put(line)
        replies.put(None)

    def _reply(self, timeout: float) -> dict:
        try:
            line = self.replies.get(timeout=timeout)
        except queue.Empty:
            self._kill()
            raise WorkerLost(f"The code ran for more than {timeout:.0f} s and was stopped. The interpreter "
                             "was restarted, so variables from earlier steps are gone.") from None
        if line is None:
            code = self.process.poll() if self.process else None
            self._kill()
            raise WorkerLost(f"The Python worker exited (code {code}). It restarts on the next step, "
                             "without variables from earlier steps.")
        return json.loads(line)

    def _kill(self) -> None:
        if self.process is not None and self.process.poll() is None:
            self.process.kill()
            self.process.wait()
        self.process = None

    def _execute(self, request: dict) -> tuple[dict, list]:
        """Send one request to the worker, starting it if needed; report the execution to `on_exec`."""
        with self._io:
            started, pid = time.time(), None
            try:
                if self.process is None or self.process.poll() is not None:
                    self._start()
                pid = self.process.pid
                self.process.stdin.write(json.dumps(request) + "\n")
                self.process.stdin.flush()
                reply = self._reply(self.timeout)
            except (WorkerLost, OSError, ValueError) as lost:
                if not isinstance(lost, WorkerLost):
                    self._kill()
                reply = {"error": str(lost), "logs": "", "lost": True}
            ended = time.time()
        figures = [Image.open(io.BytesIO(base64.b64decode(data))).convert("RGB") for data in reply.get("figures", [])]
        self.on_exec(started=started, ended=ended, code=request["code"], reply=reply, figures=figures, pid=pid)
        return reply, figures

    def __call__(self, code_action: str) -> CodeOutput:
        reply, _ = self._execute({"code": code_action})
        self.state = {"_print_outputs": reply.get("logs", "")}
        if "error" in reply:
            raise RuntimeError(reply["error"])
        return CodeOutput(output=reply["output"], logs=reply["logs"], is_final_answer=reply["is_final_answer"])

    def run_python(self, code: str, name: str) -> tuple[dict, list]:
        """Run the user's own code in the shared namespace: plain Python under a sandbox, else through
        smolagents' interpreter. Returns the reply and its figures."""
        return self._execute({"code": code, "mode": "python", "name": name})

    def cleanup(self) -> None:
        """End the worker, even mid-execution: that execution then fails as a lost worker."""
        self._closed = True
        process = self.process
        if process is not None and process.poll() is None:
            try:
                process.stdin.close()
                process.wait(timeout=5)
            except (OSError, ValueError, subprocess.TimeoutExpired):
                process.kill()
                process.wait()
