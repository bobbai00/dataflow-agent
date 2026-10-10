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

REPO = Path(__file__).resolve().parents[2]


class ExecutionIsolationTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "linux", "bubblewrap mount isolation requires Linux")
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
            command = isolated_command([sys.executable, "-c", code], python=sys.executable,
                                       data_roots=[data], workspace=workspace)
            result = subprocess.run(command, capture_output=True, text=True, env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(json.loads(result.stdout)["isolated"])
            self.assertEqual((workspace / "saved.txt").read_text(), "persistent")

    @unittest.skipUnless(sys.platform == "linux", "bubblewrap mount isolation requires Linux")
    def test_scratch_is_separate_between_sessions(self):
        with tempfile.TemporaryDirectory() as temp:
            a, b = Path(temp) / "a", Path(temp) / "b"
            a.mkdir()
            b.mkdir()
            (a / "previous-result.json").write_text("not a source")
            code = f"from pathlib import Path; assert not Path({str(a / 'previous-result.json')!r}).exists()"
            result = subprocess.run(isolated_command([sys.executable, "-c", code], python=sys.executable,
                                                     data_roots=[], workspace=b), capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_guard_limits_model_code_to_task_data_and_keeps_the_warehouse_private(self):
        guard = Path(__file__).resolve().parent / "sandbox_site"
        probe_source = """
import json, os, subprocess, sys
DATA, WAREHOUSE, ROOT = sys.argv[1:4]
model = compile(
    "def list_root(): return os.listdir(ROOT)\\n"
    "def list_data(): return os.listdir(DATA)\\n"
    "def read_data(): return open(os.path.join(DATA, 'a.csv')).read()\\n"
    "def read_warehouse(): return open(os.path.join(WAREHOUSE, 't.parquet')).read()\\n"
    "def spawn(): return subprocess.run(['true']).returncode\\n"
    "def imports():\\n"
    "    import email.mime.text\\n"
    "    return 'ok'\\n",
    "<definitions:1>", "exec")
scope = {"os": os, "subprocess": subprocess, "DATA": DATA, "WAREHOUSE": WAREHOUSE, "ROOT": ROOT}
exec(model, scope)
out = {}
for name in ["list_root", "list_data", "read_data", "read_warehouse", "spawn", "imports"]:
    try:
        scope[name]()
        out[name] = "allowed"
    except PermissionError:
        out[name] = "denied"
out["engine_reads_warehouse"] = open(os.path.join(WAREHOUSE, "t.parquet")).read() == "another attempt"
out["engine_lists_root"] = bool(os.listdir(ROOT))
print(json.dumps(out))
"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data, warehouse = root / "data", root / "warehouse"
            data.mkdir()
            warehouse.mkdir()
            (data / "a.csv").write_text("x\n1\n")
            (warehouse / "t.parquet").write_text("another attempt")
            probe = root / "probe.py"
            probe.write_text(probe_source)
            env = dict(os.environ, PYTHONPATH=str(guard), NATIVE_GUARD_LIST_ROOTS=str(data),
                       NATIVE_GUARD_DENY_ROOTS=str(warehouse))
            result = subprocess.run([sys.executable, str(probe), str(data), str(warehouse), str(root)],
                                    capture_output=True, text=True, env=env, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {
                "list_root": "denied", "list_data": "allowed", "read_data": "allowed",
                "read_warehouse": "denied", "spawn": "denied", "imports": "allowed",
                "engine_reads_warehouse": True, "engine_lists_root": True,
            })

    def test_worker_memory_cap_raises_memory_error_instead_of_taking_the_machine(self):
        from benchmark.retrieval.native_isolated_python import worker_memory_limit
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("NATIVE_WORKER_MEMORY_GB", None)
            self.assertEqual(worker_memory_limit(), 10 * 1024**3)
        with mock.patch.dict(os.environ, {"NATIVE_WORKER_MEMORY_GB": "0"}):
            self.assertIsNone(worker_memory_limit())
        with mock.patch.dict(os.environ, {"NATIVE_WORKER_MEMORY_GB": "0.5"}):
            limit = worker_memory_limit()
        code = (
            "import resource, sys\n"
            f"resource.setrlimit(resource.RLIMIT_DATA, ({limit}, {limit}))\n"
            "small = bytearray(64 * 1024**2)\n"
            "try:\n"
            "    bytearray(1024**3)\n"
            "except MemoryError:\n"
            "    print('MemoryError')\n"
        )
        result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60)
        self.assertEqual(result.stdout.strip(), "MemoryError", result.stderr)

    def test_missing_bubblewrap_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp, \
                mock.patch.object(execution_isolation.shutil, "which", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "bubblewrap"):
                isolated_command([sys.executable, "-c", "pass"], python=sys.executable,
                                 data_roots=[], workspace=temp)


if __name__ == "__main__":
    unittest.main()
