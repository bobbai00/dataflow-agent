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
from benchmark.retrieval.native_isolated_python import data_roots

REPO = Path(__file__).resolve().parents[2]


class ExecutionIsolationTests(unittest.TestCase):
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

    def test_linked_data_directory_resolves_without_its_neighbours(self):
        with tempfile.TemporaryDirectory() as temp:
            tmp = Path(temp)
            sessions = tmp / "reference" / "dataset" / "sessions"
            sessions.mkdir(parents=True)
            (sessions / "input.csv").write_text("x\n3\n")
            secret = tmp / "reference" / "gold.json"
            secret.write_text('{"answer": 1234567}')
            data = tmp / "data"
            data.mkdir()
            (data / "sessions").symlink_to(sessions)
            workspace = tmp / "session"
            workspace.mkdir()
            code = f"""
from pathlib import Path
assert (Path({str(data)!r}) / 'sessions' / 'input.csv').read_text() == 'x\\n3\\n'
assert not Path({str(secret)!r}).exists()
"""
            command = isolated_command([sys.executable, "-c", code], python=sys.executable,
                                       data_roots=data_roots(data), workspace=workspace)
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)

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

    def test_missing_bubblewrap_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp, \
                mock.patch.object(execution_isolation.shutil, "which", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "bubblewrap"):
                isolated_command([sys.executable, "-c", "pass"], python=sys.executable,
                                 data_roots=[], workspace=temp)


if __name__ == "__main__":
    unittest.main()
