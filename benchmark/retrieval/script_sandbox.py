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
"""Run the smolagents SUT's agent under bubblewrap, one process per task.

smolagents executes model-written code inside the agent's process, with `open`,
`os` and `glob` available. In the harness process that code can read the
workload's answers, the reference solutions and other runs. Here the agent
runs in a sandbox that mounts the task's input directory read-only at the
relative path the prompt names, a private working directory and its own
artifact directory. It has no network: a Unix socket relays to the model
gateway and nothing else.
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
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit

from execution_isolation import isolated_command

CHILD = Path(__file__).with_name("script_agent_child.py")
STRUCTURED_OUTPUT_HELPER = Path(__file__).resolve().parents[1] / "runtime/structured_output_transport.py"
WRAPPER_SETTINGS = (
    "max_steps",
    "verbosity_level",
    "use_fine_grained_prompt",
    "use_custom_prompt",
    "use_pitfalls_prompt",
    "max_print_outputs_length",
    "no_action_detail",
    "model_parameters",
    "model_capabilities",
    "use_structured_outputs_internally",
)
HARNESS_SOURCES = ("code_agent.py", "code_agent_custom_prompt.py")


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


class SandboxedScriptAgent:
    """Stands in for the SUT's CodeAgentWrapper and runs it in the sandbox."""

    def __init__(self, wrapper, *, harness, data_root, data_relative, artifacts, workspace):
        from code_agent import CodeAgentResult
        from systems.cost_utils import compute_cost
        from systems.dsgym_runner import usage_totals

        self._result, self._cost, self._usage = CodeAgentResult, compute_cost, usage_totals
        self.model_type, self.api_base, self.api_key = wrapper.model_type, wrapper.api_base, wrapper.api_key
        self.settings = {name: getattr(wrapper, name) for name in WRAPPER_SETTINGS}
        self.harness, self.data_root, self.data_relative = Path(harness), Path(data_root), data_relative
        self.artifacts, self.workspace = Path(artifacts), Path(workspace)

    def reset(self):
        pass

    def cleanup(self):
        pass

    def run(self, prompt):
        self.workspace.mkdir(parents=True, exist_ok=True)
        python, error, started = Path(sys.executable).absolute(), None, time.time()
        with gateway_socket(self.api_base) as sockets:
            command = isolated_command(
                [python, "/harness/" + CHILD.name],
                python=python,
                data_roots=[],
                workspace=self.workspace,
                read_only=[
                    (self.data_root, str(Path("/workspace") / self.data_relative)),
                    (CHILD, "/harness/" + CHILD.name),
                    (STRUCTURED_OUTPUT_HELPER, "/harness/structured_output_transport.py"),
                    *((self.harness / name, "/harness/" + name) for name in HARNESS_SOURCES),
                ],
                read_write=[(self.artifacts, "/artifacts"), (sockets, "/gateway")],
                environment={"HOME": "/workspace", "PYTHONPATH": "/harness"},
            )
            process = subprocess.Popen(command, stdin=subprocess.PIPE, text=True)
            try:
                process.communicate(
                    json.dumps(
                        {
                            "model": self.model_type,
                            "api_key": self.api_key,
                            "settings": self.settings,
                            "prompt": prompt,
                            # The Unix transport reaches the relay; preserve the real
                            # HTTP Host header while the relay handles upstream TLS.
                            "api_base": urlsplit(self.api_base)._replace(scheme="http").geturl(),
                            "gateway_socket": "/gateway/gateway.sock",
                            "artifacts": "/artifacts",
                        }
                    )
                )
            except (Exception, SystemExit) as stop:
                # A wall-clock limit ends the wait: the task fails with the usage
                # recorded so far instead of aborting the workload.
                process.kill()
                process.wait()
                error = f"{type(stop).__name__}: {stop}"
        saved = self.artifacts / "result.json"
        if saved.exists():
            result = self._result(**json.loads(saved.read_text()))
        else:
            usage = self._usage(self.artifacts / "model-request-trace.jsonl")
            result = self._result(
                response="",
                reasoning_trace=[],
                elapsed_seconds=time.time() - started,
                error=error or f"Sandboxed agent exited with code {process.returncode}",
                input_tokens=usage["input_tokens"],
                output_tokens=usage["output_tokens"],
                total_tokens=usage["input_tokens"] + usage["output_tokens"],
                reasoning_tokens=usage["reasoning_tokens"],
                cached_tokens=usage["cached_tokens"],
                cache_creation_tokens=usage["cache_creation_tokens"],
                num_steps=usage["model_calls"],
            )
        # The sandbox has no price table; cost is computed out here.
        result.cost_usd = (
            self._cost(
                self.model_type,
                input_tokens=result.input_tokens,
                output_tokens=result.output_tokens,
                cached_tokens=result.cached_tokens,
                cache_creation_tokens=result.cache_creation_tokens,
            )
            or 0.0
        )
        return result
