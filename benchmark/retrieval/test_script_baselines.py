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
"""Script-agent baselines: what their sandboxes expose, and how their runs are accounted."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from contextlib import redirect_stderr
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.request import urlopen

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
KB = REPO / "benchmark/Kramabench"
DSGYM = REPO / "benchmark/DSGym"
sys.path.insert(0, str(HERE))
from evaluate_script_task import discard_workspace  # noqa: E402
import baseline_report  # noqa: E402
import run_baselines  # noqa: E402
from script_sandbox import gateway_socket  # noqa: E402


def harness_module(path):
    """One harness file by path: its packages collide with this repository's `benchmark`."""
    spec = importlib.util.spec_from_file_location(path.stem, KB / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


limit_output, usage_totals = (
    getattr(harness_module(Path("systems/dsgym_runner.py")), name) for name in ("limit_output", "usage_totals")
)
parse_answer, parse_explicit_answer = (
    getattr(harness_module(Path("utils/answer_parser.py")), name) for name in ("parse_answer", "parse_explicit_answer")
)

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

    def test_output_limit_cuts_like_upstream_cuts_tracebacks(self):
        self.assertEqual(limit_output("x" * 5000, 5000), "x" * 5000)
        self.assertEqual(limit_output("x" * 5001, 5000), "x" * 5000 + "\n... (truncated)")

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


class BaselineRunnerTests(unittest.TestCase):
    def test_duplicate_systems_and_invalid_execution_timeout_are_rejected(self):
        for arguments in (["--systems", "smolagents", "smolagents"], ["--execution-timeout", "0"]):
            with self.subTest(arguments=arguments), tempfile.TemporaryDirectory() as temp:
                command = [
                    "run_baselines.py",
                    "--output",
                    str(Path(temp) / "round"),
                    "--tasks",
                    "legal-easy-3",
                    *arguments,
                ]
                with (
                    patch.object(sys, "argv", command),
                    redirect_stderr(io.StringIO()),
                    patch.object(
                        run_baselines,
                        "inventory",
                        side_effect=AssertionError("Invalid arguments must stop before setup"),
                    ),
                ):
                    with self.assertRaises(SystemExit) as error:
                        run_baselines.main()
                self.assertEqual(error.exception.code, 2)

    def test_smol_only_manifest_does_not_require_dsgym(self):
        class ManifestSaved(Exception):
            pass

        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "round"
            command = [
                "run_baselines.py",
                "--output",
                str(output),
                "--systems",
                "smolagents",
                "--tasks",
                "legal-easy-3",
                "--dsgym-home",
                str(Path(temp) / "missing-dsgym"),
            ]
            cost_utils = SimpleNamespace(price_schedule=lambda model: {})
            # Stop after the manifest is written, before any job or gateway call.
            with (
                patch.object(sys, "argv", command),
                patch.object(sys, "path", sys.path.copy()),
                patch.dict(os.environ, {"OPENAI_API_KEY": "offline-test", "LITELLM_MASTER_KEY": "offline-test"}),
                patch.dict(
                    sys.modules,
                    {
                        "kb": SimpleNamespace(),
                        "requests": SimpleNamespace(),
                        "systems": SimpleNamespace(cost_utils=cost_utils),
                    },
                ),
                patch.object(run_baselines, "inventory", return_value=[{"task_id": "legal-easy-3", "bytes": 4}]),
                patch.object(run_baselines, "install_provider_prices", return_value={}),
                patch.object(
                    run_baselines,
                    "revision",
                    side_effect=lambda path: (
                        "offline"
                        if path in (REPO, KB)
                        else self.fail("smolagents must not inspect the missing DSGym checkout")
                    ),
                ),
                patch.object(run_baselines, "prepare_artifacts", side_effect=ManifestSaved),
                patch.object(run_baselines, "script_python", return_value={"path": "/locked/python"}),
            ):
                with self.assertRaises(ManifestSaved):
                    run_baselines.main()
            manifest = json.loads((output / "manifest.json").read_text())
            self.assertEqual({job["arm"] for job in manifest["jobs"]}, {"smolagents"})
            self.assertEqual(manifest["script_python"], {"path": "/locked/python"})
            self.assertNotIn("dsgym_revision", manifest)
            self.assertNotIn("dsgym_packages", manifest)


class ScriptPythonTests(unittest.TestCase):
    """smolagents runs only on script-agent/'s interpreter, on Texera's Python, numpy and pyarrow."""

    LOCKED_VERSION = (run_baselines.SCRIPT_AGENT / ".python-version").read_text().strip()
    LOCKED = run_baselines.pinned((run_baselines.SCRIPT_AGENT / "requirements.txt").read_text().splitlines())

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

    def test_the_locked_interpreter_is_accepted_and_recorded(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {}, clear=False):
            os.environ.pop("NATIVE_ISOLATED_PYTHON", None)
            found = run_baselines.script_python(self.fake(temp, "python"))
        self.assertEqual(found["python"], self.LOCKED_VERSION)
        self.assertEqual(run_baselines.pinned(found["packages"]), self.LOCKED)
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
                    run_baselines.script_python(python)

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
                    run_baselines.script_python(python)
            with patch.dict(os.environ, {"NATIVE_ISOLATED_PYTHON": str(same)}):
                self.assertEqual(run_baselines.script_python(python)["texera_sandbox"], str(same))

    @unittest.skipUnless(
        (run_baselines.SCRIPT_AGENT / ".venv/bin/python").is_file() and os.environ.get("NATIVE_ISOLATED_PYTHON"),
        "needs script-agent/setup.sh and Texera's NATIVE_ISOLATED_PYTHON",
    )
    def test_built_interpreter_matches_the_lock_and_texera(self):
        found = run_baselines.script_python(run_baselines.SCRIPT_AGENT / ".venv/bin/python")
        self.assertEqual(found["texera_sandbox"], os.environ["NATIVE_ISOLATED_PYTHON"])


class BaselineReportTests(unittest.TestCase):
    def test_finished_unscored_tasks_keep_costs_and_render(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            attempts = []
            for index, metric in enumerate((None, float("nan")), 1):
                task = f"legal-easy-{index}"
                scratch = root / "system_scratch" / "offline" / task
                scratch.mkdir(parents=True)
                (scratch / "evaluation.json").write_text(json.dumps({"llm_paraphrase": metric}))
                (scratch / "stats.json").write_text(json.dumps({"cost_usd": 0.01, "input_tokens": 100}))
                row = {
                    "sut": "offline",
                    "task": task,
                    "arm": "smolagents",
                    "rep": 1,
                    "timeout": False,
                    "exit_code": 0,
                    "seconds": 1,
                    "audit": {"violations": [], "warnings": []},
                }
                attempts.append(baseline_report.attempt(root, row))
            summary = baseline_report.summarize(attempts, None)
            self.assertEqual((summary["tasks"], summary["scored"], summary["unscored"]), (2, 0, 2))
            self.assertIsNone(summary["score"])
            self.assertEqual(summary["score_unscored_as_zero"], 0)
            self.assertAlmostEqual(summary["cost_usd"], 0.02)
            self.assertEqual(summary["input_tokens"], 200)
            manifest = {
                "models": {"Luna": "offline"},
                "script_endpoint": "http://offline/v1",
                "task_ids": [attempt["task"] for attempt in attempts],
                "repetitions": 1,
                "script_settings": {"max_steps": 25, "max_print_outputs_length": 5000},
                "task_timeout_seconds": 1200,
            }
            report = baseline_report.render(root, manifest, {"smolagents": summary})
            self.assertIn("| Score, this harness (%) | - |", report)
            self.assertIn("| Cost (USD) | 0.0200 |", report)

    def test_empty_choice_response_is_counted_without_crashing(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            scratch = root / "system_scratch" / "offline" / "legal-easy-1"
            scratch.mkdir(parents=True)
            (scratch / "model-request-trace.jsonl").write_text(
                json.dumps({"phase": "response", "choices": [], "seconds": 1}) + "\n"
            )
            row = {
                "sut": "offline",
                "task": "legal-easy-1",
                "arm": "smolagents",
                "rep": 1,
                "timeout": False,
                "exit_code": 0,
                "seconds": 1,
                "audit": {"violations": [], "warnings": []},
            }
            attempt = baseline_report.attempt(root, row)
            self.assertEqual(attempt["model_calls"], 1)
            self.assertEqual(attempt["empty_responses"], 1)


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
                    patch("script_sandbox.socket.create_connection", side_effect=connect_gateway),
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


@unittest.skipUnless(
    shutil.which("bwrap") and (DSGYM / "executors").is_dir(), "needs bubblewrap and the DSGym checkout"
)
class DSGymExecutorTests(unittest.TestCase):
    def test_kernel_sees_task_data_and_nothing_else(self):
        with tempfile.TemporaryDirectory() as temp:
            tmp = Path(temp)
            data = tmp / "lake" / "input"
            data.mkdir(parents=True)
            (data / "numbers.csv").write_text("x\n3\n7\n")
            (tmp / "lake" / "gold.json").write_text('{"answer": 10}')
            executor = subprocess.Popen(
                [
                    sys.executable,
                    str(HERE / "dsgym_executor.py"),
                    "--data-root",
                    str(data),
                    "--data-relative",
                    "data/demo/input",
                    "--workspace",
                    str(tmp / "work"),
                    "--log",
                    str(tmp / "kernel.jsonl"),
                ],
                stdout=subprocess.PIPE,
                text=True,
            )
            try:
                url = json.loads(executor.stdout.readline())["manager_url"]

                def post(path, payload=None):
                    request = __import__("urllib.request").request.Request(
                        url + path,
                        data=json.dumps(payload or {}).encode(),
                        headers={"Content-Type": "application/json"},
                        method="POST",
                    )
                    return json.loads(urlopen(request, timeout=180).read())

                def run(code):
                    outputs = post(f"/session/{container}/execute", {"code": code})["outputs"]
                    return "".join(o.get("text", "") or o.get("name", "") for o in outputs)

                container = post("/allocate")["container_id"]
                self.assertEqual(
                    run(
                        "import pandas as pd\n"
                        "total = int(pd.read_csv('data/demo/input/numbers.csv').x.sum())\n"
                        "print(total)"
                    ),
                    "10\n",
                )
                # State persists across executions, as in DSGym's containers.
                self.assertEqual(run("print(total + 1)"), "11\n")
                self.assertEqual(
                    run(
                        "import os, socket\n"
                        f"print(os.path.exists({str(tmp / 'lake' / 'gold.json')!r}),"
                        f" os.path.exists({str(REPO / '.git')!r}),"
                        f" os.path.exists({str(KB / 'workload')!r}))\n"
                        "try:\n"
                        "    socket.create_connection(('1.1.1.1', 53), timeout=3)\n"
                        "except OSError as error:\n"
                        "    print('no network')\n"
                        "try:\n"
                        "    open('data/demo/input/new.csv', 'w')\n"
                        "except OSError:\n"
                        "    print('read-only data')\n"
                    ),
                    "False False False\nno network\nread-only data\n",
                )
                self.assertEqual(run("1/0"), "ZeroDivisionError")
                post(f"/deallocate/{container}")
            finally:
                executor.terminate()
                executor.wait()
                executor.stdout.close()
            events = [json.loads(line) for line in (tmp / "kernel.jsonl").read_text().splitlines()]
            self.assertEqual(
                [e["event"] for e in events], ["allocate", "execute", "execute", "execute", "execute", "deallocate"]
            )
            self.assertEqual(events[4]["errors"], ["ZeroDivisionError"])


if __name__ == "__main__":
    unittest.main()
