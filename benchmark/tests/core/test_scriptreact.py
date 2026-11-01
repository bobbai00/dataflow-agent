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
"""Script ReAct's harness pieces: usage from the request trace, the explicit answer, the workspace record, the locked
interpreter and the gateway relay."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from bobbench.kramabench.prompt import parse_answer, parse_explicit_answer
from bobbench.scriptreact import interpreter
from bobbench.scriptreact.sandbox import discard_workspace, gateway_socket, usage_totals

try:
    import httpx
except ImportError:  # the relay test needs a Unix-socket HTTP client
    httpx = None


class AccountingTests(unittest.TestCase):
    def test_usage_counts_returned_responses_once(self):
        usage = {
            "prompt_tokens": 1000,
            "completion_tokens": 50,
            "prompt_tokens_details": {"cached_tokens": 800, "cache_creation_tokens": 0},
            "completion_tokens_details": {"reasoning_tokens": 30},
        }
        events = [
            {"phase": "request", "call": 1},
            {"phase": "transport_request", "call": 1},
            {"phase": "transport_headers", "call": 1, "status": 429, "seconds": 0.5},
            {"phase": "error", "call": 1, "exception": "RateLimitError", "seconds": 0.6},
            {"phase": "request", "call": 2},
            {"phase": "response", "call": 2, "usage": usage, "seconds": 4.0},
            {"phase": "response", "call": 3, "usage": usage, "seconds": 2.0},
        ]
        with tempfile.TemporaryDirectory() as temp:
            trace = Path(temp) / "model-request-trace.jsonl"
            trace.write_text("\n".join(json.dumps(event) for event in events) + "\n")
            totals = usage_totals(trace)
            self.assertEqual(usage_totals(Path(temp) / "absent.jsonl")["model_calls"], 0)
        self.assertEqual((totals["model_calls"], totals["failed_model_calls"]), (2, 1))
        self.assertEqual(
            (totals["input_tokens"], totals["cached_tokens"], totals["output_tokens"], totals["reasoning_tokens"]),
            (2000, 1600, 100, 60),
        )
        self.assertAlmostEqual(totals["model_seconds"], 6.6)


    def test_explicit_answer_is_kept_whole(self):
        listed = "['Proton_flux_>30_Mev', -0.193]"
        self.assertEqual(parse_explicit_answer(listed), listed)
        # The free-text search is what an explicit answer must not go through.
        self.assertEqual(parse_answer(listed), "['Protonflux>30Mev', -0.193]")
        self.assertEqual(parse_explicit_answer("\n 42 \n"), "42")
        self.assertEqual(parse_explicit_answer(0), "0")
        self.assertEqual(parse_explicit_answer(-0.008003975), "-0.008003975")
        self.assertEqual(parse_explicit_answer("**Final Answer: 42**"), "42")
        self.assertEqual(parse_explicit_answer(""), "No response from agent")

    def test_workspace_listing_survives_its_removal(self):
        with tempfile.TemporaryDirectory() as temp:
            workspace, scratch = Path(temp) / "work", Path(temp) / "scratch"
            (workspace / "kernel-0").mkdir(parents=True)
            (workspace / "kernel-0" / "table.csv").write_text("a\n1\n")
            discard_workspace(workspace, scratch)
            self.assertFalse(workspace.exists())
            self.assertEqual(
                json.loads((scratch / "workspace-files.json").read_text()), [{"path": "kernel-0/table.csv", "bytes": 4}]
            )


class ScriptPythonTests(unittest.TestCase):
    """Script ReAct runs only on envs/scriptreact's interpreter, on Texera's Python, numpy and pyarrow."""

    LOCKED_VERSION = (interpreter.LOCK / ".python-version").read_text().strip()
    LOCKED = interpreter.pinned((interpreter.LOCK / "requirements.txt").read_text().splitlines())

    def fake(self, directory, name, version=None, **changes):
        """An executable that answers the interpreter probe like a Python with these packages."""
        packages = {**self.LOCKED, **changes}
        path = Path(directory) / name
        reply = json.dumps(
            {"python": version or self.LOCKED_VERSION, "packages": [f"{k}=={v}" for k, v in packages.items()]}
        )
        path.write_text(f"#!/bin/sh\ncat <<'JSON'\n{reply}\nJSON\n")
        path.chmod(0o755)
        return path

    def test_an_egg_info_in_the_current_folder_is_not_an_installed_package(self):
        before = os.getcwd()
        with tempfile.TemporaryDirectory() as temp:
            egg = Path(temp) / "zz_only_here.egg-info"
            egg.mkdir()
            (egg / "PKG-INFO").write_text("Metadata-Version: 2.1\nName: zz-only-here\nVersion: 0.1.0\n")
            os.chdir(temp)
            try:
                _, packages = interpreter.interpreter(sys.executable)
            finally:
                os.chdir(before)
        self.assertNotIn("zz-only-here", packages)

    def test_the_locked_interpreter_is_accepted_and_recorded(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {}, clear=False):
            os.environ.pop("NATIVE_ISOLATED_PYTHON", None)
            found = interpreter.locked(self.fake(temp, "python"))
        self.assertEqual(found["python"], self.LOCKED_VERSION)
        self.assertEqual(interpreter.pinned(found["packages"]), self.LOCKED)
        self.assertIsNone(found["texera_sandbox"])

    def test_missing_or_drifted_interpreters_are_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            for python in (
                Path(temp) / "absent",
                self.fake(temp, "old-python", version="3.10.9"),
                self.fake(temp, "other-numpy", numpy="2.2.4"),
                self.fake(temp, "extra-package", **{"left-pad": "1.0"}),
            ):
                with self.subTest(python=python.name), self.assertRaisesRegex(ValueError, "setup.sh"):
                    interpreter.locked(python)

    def test_texera_sandbox_must_share_python_numpy_and_pyarrow(self):
        with tempfile.TemporaryDirectory() as temp:
            python = self.fake(temp, "python")
            same = self.fake(temp, "texera-same", other="1.0")  # unrelated packages may differ
            for texera in (
                self.fake(temp, "texera-numpy", numpy="2.2.4"),
                self.fake(temp, "texera-pyarrow", pyarrow="19.0.1"),
                self.fake(temp, "texera-python", version="3.10.9"),
            ):
                with (
                    self.subTest(texera=texera.name),
                    patch.dict(os.environ, {"NATIVE_ISOLATED_PYTHON": str(texera)}),
                    self.assertRaisesRegex(ValueError, "Texera's operator sandbox"),
                ):
                    interpreter.locked(python)
            with patch.dict(os.environ, {"NATIVE_ISOLATED_PYTHON": str(same)}):
                self.assertEqual(interpreter.locked(python)["texera_sandbox"], str(same))

    @unittest.skipUnless(
        (interpreter.LOCK / ".venv/bin/python").is_file() and os.environ.get("NATIVE_ISOLATED_PYTHON"),
        "needs envs/scriptreact/setup.sh and Texera's NATIVE_ISOLATED_PYTHON",
    )
    def test_built_interpreter_matches_the_lock_and_texera(self):
        found = interpreter.locked(interpreter.LOCK / ".venv/bin/python")
        self.assertEqual(found["texera_sandbox"], os.environ["NATIVE_ISOLATED_PYTHON"])


@unittest.skipUnless(httpx, "needs httpx")
class GatewayRelayTests(unittest.TestCase):
    def test_socket_reaches_the_gateway_and_only_it(self):
        class Gateway(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                body = self.rfile.read(int(self.headers["Content-Length"]))
                reply = json.dumps({"echo": json.loads(body), "path": self.path}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(reply)))
                self.end_headers()
                self.wfile.write(reply)

            def log_message(self, fmt, *args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        connect = __import__("socket").create_connection
        try:
            for endpoint, port, tls in [
                (f"http://127.0.0.1:{server.server_address[1]}/v1", server.server_address[1], False),
                ("http://127.0.0.1/v1", 80, False),
                ("https://127.0.0.1/v1", 443, True),
            ]:

                def connect_gateway(address):
                    self.assertEqual(address, ("127.0.0.1", port))
                    return connect(server.server_address)

                with (
                    self.subTest(endpoint=endpoint),
                    patch("bobbench.scriptreact.sandbox.socket.create_connection", side_effect=connect_gateway),
                    patch("ssl.create_default_context") as context,
                ):
                    # Verify HTTPS selects a validated TLS context; the local mock
                    # gateway speaks HTTP, so this wrapper returns its socket.
                    context.return_value.wrap_socket.side_effect = lambda sock, **kwargs: sock
                    with gateway_socket(endpoint) as directory:
                        transport = httpx.HTTPTransport(uds=str(directory / "gateway.sock"))
                        with httpx.Client(transport=transport) as client:
                            for number in range(3):  # one kept-alive connection, several requests
                                reply = client.post("http://gateway/v1/chat/completions", json={"n": number}).json()
                                self.assertEqual(reply, {"echo": {"n": number}, "path": "/v1/chat/completions"})
                    self.assertFalse(directory.exists())
                    self.assertEqual(context.return_value.wrap_socket.called, tls)
                    if tls:
                        self.assertEqual(
                            context.return_value.wrap_socket.call_args.kwargs, {"server_hostname": "127.0.0.1"}
                        )
        finally:
            server.shutdown()
            server.server_close()

    def test_invalid_gateway_is_rejected_before_starting_relay(self):
        for endpoint in ("ftp://localhost/v1", "http:///v1", "http://localhost:invalid/v1"):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                with gateway_socket(endpoint):
                    self.fail("An invalid gateway must not create a relay")
