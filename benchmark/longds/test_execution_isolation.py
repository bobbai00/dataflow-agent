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

"""Regression: benchmark execution must not see reference answers or other runs."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from execution_isolation import isolated_command


def test_data_is_read_only_and_host_answers_are_invisible(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    (data / "input.csv").write_text("x\n3\n7\n")
    secret = tmp_path / "prepared" / "gold.json"
    secret.parent.mkdir()
    secret.write_text('{"answer": 1234567}')
    workspace = tmp_path / "session"
    workspace.mkdir()
    code = f"""
from pathlib import Path
import json, os
import pandas as pd
data = Path({str(data)!r})
assert pd.read_csv(data / 'input.csv')['x'].sum() == 10
assert not Path({str(secret)!r}).exists()
assert not Path('/proc/{os.getpid()}/root{secret}').exists()
try:
    (data / 'new.csv').write_text('bad')
except OSError:
    pass
else:
    raise AssertionError('Source data was writable')
assert os.environ.get('LONGDS_TEST_SECRET') is None
Path('saved.txt').write_text('persistent')
print(json.dumps({{'source': True, 'isolated': True}}))
"""
    env = dict(os.environ, LONGDS_TEST_SECRET="must-not-reach-code")
    command = isolated_command([sys.executable, "-c", code], python=sys.executable,
                               data_roots=[data], workspace=workspace)
    result = subprocess.run(command, capture_output=True, text=True, env=env)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["isolated"]
    assert (workspace / "saved.txt").read_text() == "persistent"


def test_scratch_is_separate_between_sessions(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir()
    b.mkdir()
    (a / "previous-result.json").write_text("not a source")
    code = f"from pathlib import Path; assert not Path({str(a / 'previous-result.json')!r}).exists()"
    result = subprocess.run(isolated_command([sys.executable, "-c", code], python=sys.executable,
                                            data_roots=[], workspace=b), capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_missing_bubblewrap_fails_closed(monkeypatch, tmp_path):
    monkeypatch.setattr("execution_isolation.shutil.which", lambda name: None)
    with pytest.raises(RuntimeError, match="bubblewrap"):
        isolated_command([sys.executable, "-c", "pass"], python=sys.executable,
                         data_roots=[], workspace=tmp_path)


@pytest.mark.parametrize("workspace_name", ["session", "long-task-and-system-name-" * 8])
def test_persistent_jupyter_keeps_state_without_host_answers(tmp_path, workspace_name):
    from dsgym_executor import LocalKernelExecutor
    data, work = tmp_path / "data", tmp_path / workspace_name
    data.mkdir()
    work.mkdir()
    (data / "values.csv").write_text("x\n3\n7\n")
    secret = tmp_path / "gold.json"
    secret.write_text("REFERENCE_MUST_NOT_BE_VISIBLE")
    executor = LocalKernelExecutor(timeout=20, data_root=data, workspace=work)
    try:
        executor.start()
        first = executor.execute(f"import pandas as pd; values = pd.read_csv({str(data / 'values.csv')!r}); print(values.x.sum())")
        assert "10" in str(first), first
        second = executor.execute(f"from pathlib import Path; assert not Path({str(secret)!r}).exists(); values['y'] = values.x * 2; print(values.y.sum())")
        assert "20" in str(second), second
        network = executor.execute("import socket; print([s[1] for s in socket.if_nameindex()])")
        assert "lo" in str(network) and "eth" not in str(network), network
    finally:
        executor.stop()


def test_failed_kernel_allocation_stops_before_any_model_call(tmp_path):
    # The model harness and executor deliberately use separate environments.
    harness = Path(__file__).parent
    code = """
import sys
from unittest.mock import patch
from dsgym_agent import TurnMarkingEnv
environment = TurnMarkingEnv(output_dir=sys.argv[1])
with patch.object(environment.tool_group, 'allocate_container', side_effect=RuntimeError('Kernel could not start')):
    try:
        environment.init([{'role': 'user', 'content': 'Analyze the data'}])
    except RuntimeError as error:
        assert 'kernel allocation failed' in str(error)
    else:
        raise AssertionError('Allocation failure allowed model execution')
environment.tool_group.allocated_container = 0
with patch.object(environment.tool_group, 'allocate_container', return_value=0):
    environment.init([{'role': 'user', 'content': 'Analyze the data'}])
"""
    result = subprocess.run([str(harness / ".dsgym-venv/bin/python"), "-c", code, str(tmp_path)],
                            cwd=harness, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr


def test_kernel_survives_allocation_request_thread_exit(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from dsgym_executor import Manager

    data, work = tmp_path / "data", tmp_path / "work"
    data.mkdir()
    work.mkdir()
    manager = Manager(10, data, work)
    identity = None
    try:
        # Each HTTP request runs on a short-lived thread. The sandbox must be
        # owned by a persistent thread, including its ZeroMQ client sockets.
        with ThreadPoolExecutor(1) as request:
            identity = request.submit(manager.allocate).result()
        with ThreadPoolExecutor(1) as request:
            outputs = request.submit(manager.execute, identity, "saved = 21; print(saved * 2)").result()
        assert "42" in str(outputs), outputs
        with ThreadPoolExecutor(1) as request:
            outputs = request.submit(manager.execute, identity, "print(saved + 1)").result()
        assert "22" in str(outputs), outputs
        with ThreadPoolExecutor(1) as request:
            request.submit(manager.executors[identity].restart).result()
        outputs = manager.execute(identity, "assert 'saved' not in globals(); print('restart-ready')")
        assert "restart-ready" in str(outputs), outputs
    finally:
        manager.close()
