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

"""Regression: benchmark execution must not see reference answers, reports or other runs."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from benchmark.retrieval import execution_isolation
from benchmark.retrieval.execution_isolation import isolated_command
from benchmark.retrieval import native_isolated_python

REPO = Path(__file__).resolve().parents[2]


class ExecutionIsolationTests(unittest.TestCase):
    def test_native_function_parser_uses_the_real_isolated_compile_only_path(self):
        parser = REPO / "agent-service/src/agent/native/python/function_parser.py"
        wrapper = REPO / "benchmark/retrieval/native_isolated_python.py"
        with tempfile.TemporaryDirectory() as temp:
            env = dict(
                os.environ,
                NATIVE_ISOLATED_PYTHON=sys.executable,
                NATIVE_WORKSPACE=temp,
                NATIVE_SOURCE_DATA=str(REPO / "benchmark/Kramabench/data"),
            )
            # Valid module side effects must be compiled, never evaluated.
            code = "raise RuntimeError('This module must never run')\ndef apply(row):\n    return row['x']\n"
            for request in (
                {"code": code, "entry": None},
                {"code": "lambda row: row['x'] > 3", "entry": None},
                {"code": "def apply(:", "entry": None},
            ):
                with self.subTest(code=request["code"]):
                    result = subprocess.run(
                        [sys.executable, str(wrapper), "-u", str(parser)],
                        input=json.dumps({"pythonFunction": request}),
                        capture_output=True,
                        text=True,
                        env=env,
                        timeout=10,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    parsed = json.loads(result.stdout)
                    if request["code"] == "def apply(:":
                        self.assertFalse(parsed["ok"])
                        self.assertIn("Python syntax error", parsed["error"])
                    else:
                        self.assertTrue(parsed["ok"], parsed)
                        self.assertEqual(parsed["entry"], "apply")

    def test_native_function_parser_keeps_validation_mounts_and_network_disabled(self):
        validator = REPO / "agent-service/src/agent/native/python"
        with (
            tempfile.TemporaryDirectory() as temp,
            mock.patch.dict(
                os.environ,
                {
                    "NATIVE_ISOLATED_PYTHON": sys.executable,
                    "NATIVE_WORKSPACE": temp,
                    "NATIVE_SOURCE_DATA": str(REPO / "benchmark/Kramabench/data"),
                },
            ),
            mock.patch.object(sys, "argv", ["wrapper", str(validator / "function_parser.py")]),
            mock.patch.object(
                native_isolated_python, "isolated_command", return_value=["sandbox", "python"]
            ) as isolated,
            mock.patch.object(native_isolated_python.os, "execv", side_effect=SystemExit(0)),
        ):
            with self.assertRaises(SystemExit):
                native_isolated_python.main()
            self.assertEqual(
                isolated.call_args.args[0], [Path(sys.executable).absolute(), str(validator / "function_parser.py")]
            )
            self.assertEqual(isolated.call_args.kwargs["data_roots"], [])
            self.assertEqual(isolated.call_args.kwargs["read_only"], [(validator, validator)])
            self.assertFalse(isolated.call_args.kwargs["network"])

    def test_native_wrapper_rejects_same_named_parser_outside_the_allowlist(self):
        wrapper = REPO / "benchmark/retrieval/native_isolated_python.py"
        with tempfile.TemporaryDirectory() as temp:
            outside = Path(temp) / "function_parser.py"
            outside.write_text("raise AssertionError('An arbitrary script must not execute')\n")
            env = dict(
                os.environ,
                NATIVE_ISOLATED_PYTHON=sys.executable,
                NATIVE_WORKSPACE=temp,
                NATIVE_SOURCE_DATA=str(REPO / "benchmark/Kramabench/data"),
            )
            result = subprocess.run(
                [sys.executable, str(wrapper), str(outside)], capture_output=True, text=True, env=env, timeout=10
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("only a Texera Python worker", result.stderr)
            self.assertNotIn("An arbitrary script must not execute", result.stderr)

    def test_data_is_read_only_and_repository_and_answers_are_invisible(self):
        with tempfile.TemporaryDirectory() as temp:
            tmp = Path(temp)
            data = tmp / "data"
            data.mkdir()
            (data / "input.csv").write_text("x\n3\n7\n")
            secret = tmp / "prepared" / "gold.json"
            secret.parent.mkdir()
            secret.write_text('{"answer": 1234567}')
            workspace = tmp / "session"
            workspace.mkdir()
            code = f"""
from pathlib import Path
import json, os, subprocess
data = Path({str(data)!r})
assert sum(int(v) for v in (data / 'input.csv').read_text().split()[1:]) == 10
assert not Path({str(secret)!r}).exists()
assert not Path('/proc/{os.getpid()}/root{secret}').exists()
# Mount points create empty parent directories; repository contents stay absent.
assert not Path({str(REPO / 'benchmark/retrieval/results')!r}).exists()
assert not Path({str(REPO / 'benchmark/retrieval/run.py')!r}).exists()
assert not Path({str(REPO / '.git')!r}).exists()
git = subprocess.run(['git', '-C', {str(REPO)!r}, 'log', '-1'], capture_output=True, text=True)
assert git.returncode != 0, git.stdout
try:
    (data / 'new.csv').write_text('bad')
except OSError:
    pass
else:
    raise AssertionError('Source data was writable')
assert os.environ.get('ISOLATION_TEST_SECRET') is None
Path('saved.txt').write_text('persistent')
print(json.dumps({{'isolated': True}}))
"""
            env = dict(os.environ, ISOLATION_TEST_SECRET="must-not-reach-code")
            command = isolated_command(
                [sys.executable, "-c", code], python=sys.executable, data_roots=[data], workspace=workspace
            )
            result = subprocess.run(command, capture_output=True, text=True, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(json.loads(result.stdout)["isolated"])
            self.assertEqual((workspace / "saved.txt").read_text(), "persistent")

    def test_scratch_is_separate_between_sessions(self):
        with tempfile.TemporaryDirectory() as temp:
            a, b = Path(temp) / "a", Path(temp) / "b"
            a.mkdir()
            b.mkdir()
            (a / "previous-result.json").write_text("not a source")
            code = f"from pathlib import Path; assert not Path({str(a / 'previous-result.json')!r}).exists()"
            result = subprocess.run(
                isolated_command([sys.executable, "-c", code], python=sys.executable, data_roots=[], workspace=b),
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_bubblewrap_fails_closed(self):
        with (
            tempfile.TemporaryDirectory() as temp,
            mock.patch.object(execution_isolation.shutil, "which", return_value=None),
        ):
            with self.assertRaisesRegex(RuntimeError, "bubblewrap"):
                isolated_command([sys.executable, "-c", "pass"], python=sys.executable, data_roots=[], workspace=temp)

    def test_native_task_mapping_hides_other_questions_and_gold(self):
        with tempfile.TemporaryDirectory() as temp:
            tmp = Path(temp)
            source = tmp / "source"
            selected = source / "dsbench/task-one"
            selected.mkdir(parents=True)
            (selected / "input.csv").write_text("x\n3\n7\n")
            other = source / "dsbench/task-two"
            other.mkdir()
            (other / "question.txt").write_text("Another question")
            (source / "gold.json").write_text('{"answer": 10}')
            workspace = tmp / "session"
            workspace.mkdir()
            mapping = workspace / "task-inputs.json"
            mapping.write_text(json.dumps({"relative_path": "dsbench/task-one"}))
            roots, mounts = native_isolated_python.worker_data_mounts(source, workspace, REPO)
            code = f"""
from pathlib import Path
assert Path({str(selected / 'input.csv')!r}).exists()
assert Path({str(REPO / 'amber/data/dsbench/task-one/input.csv')!r}).exists()
assert Path({str(REPO / 'data/dsbench/task-one/input.csv')!r}).exists()
assert not Path({str(other / 'question.txt')!r}).exists()
assert not Path({str(source / 'gold.json')!r}).exists()
try:
    Path('/workspace/task-inputs.json').write_text('{{}}')
except OSError:
    pass
else:
    raise AssertionError('Task mapping was writable')
"""
            result = subprocess.run(
                isolated_command(
                    [sys.executable, "-c", code],
                    python=sys.executable,
                    data_roots=roots,
                    workspace=workspace,
                    read_only=mounts,
                ),
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_native_task_mapping_rejects_parent_and_symlink_escape(self):
        with tempfile.TemporaryDirectory() as temp:
            tmp = Path(temp)
            source, workspace, outside = tmp / "source", tmp / "session", tmp / "outside"
            source.mkdir()
            workspace.mkdir()
            outside.mkdir()
            (source / "escape").symlink_to(outside, target_is_directory=True)
            for relative in ("../outside", "escape", str(outside), "", "."):
                (workspace / "task-inputs.json").write_text(json.dumps({"relative_path": relative}))
                with self.subTest(relative=relative), self.assertRaises(ValueError):
                    native_isolated_python.worker_data_mounts(source, workspace, REPO)


if __name__ == "__main__":
    unittest.main()
