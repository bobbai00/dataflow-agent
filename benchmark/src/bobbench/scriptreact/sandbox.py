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
"""Run Script ReAct whole in the sandbox, one process per task.

smolagents executes model-written code inside the agent's process, with `open`, `os` and `glob` available. In the
harness process that code could read the workload's answers, the reference solutions and other runs. Here the agent
runs under bubblewrap with the task's input folder read-only at the relative path the prompt names, a private working
folder and its own artifact folder. It has no network: a Unix socket relays to the model gateway and nothing else.
"""
from contextlib import contextmanager, ExitStack
import json
import os
from pathlib import Path
import shutil
import socket
import socketserver
import ssl
import subprocess
import tempfile
import threading
import time
from urllib.parse import urlsplit

from bobbench.sandbox.isolation import isolated_command

HERE = Path(__file__).resolve().parent
CHILD = HERE / "child.py"
AGENT = HERE / "code_agent.py"


@contextmanager
def gateway_socket(endpoint):
    """Directory holding `gateway.sock`, a byte relay to the gateway's TCP port."""
    url = urlsplit(endpoint)
    if url.scheme not in ("http", "https") or not url.hostname:
        raise ValueError("Gateway endpoint must be an HTTP or HTTPS URL with a host")
    address = (url.hostname, url.port or (443 if url.scheme == "https" else 80))
    tls_context = ssl.create_default_context() if url.scheme == "https" else None
    # A Unix socket path is limited to 107 bytes; run directories exceed it.
    directory = tempfile.mkdtemp(prefix="kb-gateway-", dir="/tmp")

    class Relay(socketserver.BaseRequestHandler):
        def handle(self):
            def pump(source, sink):
                try:
                    while data := source.recv(65536):
                        sink.sendall(data)
                except OSError:
                    pass
                finally:
                    try:
                        sink.shutdown(socket.SHUT_WR)
                    except OSError:
                        pass

            with ExitStack() as stack:
                upstream = stack.enter_context(socket.create_connection(address))
                if tls_context:
                    upstream = stack.enter_context(tls_context.wrap_socket(upstream, server_hostname=url.hostname))
                back = threading.Thread(target=pump, args=(upstream, self.request), daemon=True)
                back.start()
                pump(self.request, upstream)
                back.join()

    class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
        daemon_threads = True

    server = Server(os.path.join(directory, "gateway.sock"), Relay)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield Path(directory)
    finally:
        server.shutdown()
        server.server_close()
        shutil.rmtree(directory, ignore_errors=True)


def usage_totals(trace):
    """Tokens and seconds over the model calls a request trace records."""
    totals = {"input_tokens": 0, "output_tokens": 0, "cached_tokens": 0, "cache_creation_tokens": 0,
              "reasoning_tokens": 0, "model_calls": 0, "failed_model_calls": 0, "model_seconds": 0.0}
    if not trace.exists():
        return totals
    for line in trace.read_text().splitlines():
        event = json.loads(line)
        if event["phase"] not in ("response", "error"):
            continue
        totals["model_seconds"] += event["seconds"]
        if event["phase"] == "error":
            totals["failed_model_calls"] += 1
            continue
        usage = event["usage"]
        prompt_details = usage.get("prompt_tokens_details") or {}
        totals["model_calls"] += 1
        totals["input_tokens"] += usage.get("prompt_tokens") or 0
        totals["output_tokens"] += usage.get("completion_tokens") or 0
        totals["cached_tokens"] += prompt_details.get("cached_tokens") or 0
        totals["cache_creation_tokens"] += prompt_details.get("cache_creation_tokens") or 0
        totals["reasoning_tokens"] += (usage.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0
    return totals


def run_sandboxed(prompt, *, python, model, api_base, api_key, settings, data_root, data_relative, artifacts, workspace):
    """Run the agent on `prompt` in the sandbox; its result (child.py's result.json), or, when the child left none (a
    crash, or the wall clock stopped it), a failed result with the usage the request trace recorded."""
    artifacts, workspace = Path(artifacts), Path(workspace)
    workspace.mkdir(parents=True, exist_ok=True)
    error, started, process = None, time.time(), None
    with gateway_socket(api_base) as sockets:
        command = isolated_command(
            [python, "/harness/" + CHILD.name], python=python, data_roots=[], workspace=workspace,
            read_only=[(Path(data_root), str(Path("/workspace") / data_relative)), (CHILD, "/harness/" + CHILD.name),
                       (AGENT, "/harness/" + AGENT.name)],
            read_write=[(artifacts, "/artifacts"), (sockets, "/gateway")],
            environment={"HOME": "/workspace", "PYTHONPATH": "/harness"},
        )
        process = subprocess.Popen(command, stdin=subprocess.PIPE, text=True)
        try:
            # The gateway key goes over stdin: no copy in the environment or on disk for model-written code to read.
            process.communicate(json.dumps({
                "model": model, "api_key": api_key, "settings": settings, "prompt": prompt,
                # The Unix transport reaches the relay; keep the real HTTP Host header while the relay does upstream TLS.
                "api_base": urlsplit(api_base)._replace(scheme="http").geturl(),
                "gateway_socket": "/gateway/gateway.sock", "artifacts": "/artifacts"}))
        except (Exception, SystemExit) as stop:
            # A wall-clock limit ends the wait: the task fails with the usage recorded so far instead of aborting.
            process.kill()
            process.wait()
            error = f"{type(stop).__name__}: {stop}"
    saved = artifacts / "result.json"
    if saved.exists():
        return json.loads(saved.read_text())
    usage = usage_totals(artifacts / "model-request-trace.jsonl")
    return {"response": "", "reasoning_trace": [], "elapsed_seconds": time.time() - started,
            "error": error or f"Sandboxed agent exited with code {process.returncode}",
            "input_tokens": usage["input_tokens"], "output_tokens": usage["output_tokens"],
            "total_tokens": usage["input_tokens"] + usage["output_tokens"], "reasoning_tokens": usage["reasoning_tokens"],
            "cached_tokens": usage["cached_tokens"], "cache_creation_tokens": usage["cache_creation_tokens"],
            "cost_usd": 0.0, "num_steps": usage["model_calls"], "state": ""}


def discard_workspace(workspace, artifacts):
    """Keep the names and sizes of what the agent wrote (workspace-files.json), not the files."""
    workspace = Path(workspace)
    files = [{"path": str(path.relative_to(workspace)), "bytes": path.stat().st_size}
             for path in sorted(workspace.rglob("*")) if path.is_file() and not path.is_symlink()]
    Path(artifacts).mkdir(parents=True, exist_ok=True)
    (Path(artifacts) / "workspace-files.json").write_text(json.dumps(files, indent=2, ensure_ascii=False, default=str) + "\n")
    shutil.rmtree(workspace, ignore_errors=True)
