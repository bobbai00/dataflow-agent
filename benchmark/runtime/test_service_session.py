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
"""Checks for explicit lifetime ownership of launched services."""
import json
from pathlib import Path
import signal
import subprocess
import sys
import time

import pytest


def wait_for(path, process, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and not path.exists():
        if process.poll() is not None:
            raise AssertionError("Session exited before ready")
        time.sleep(0.01)
    assert path.exists()
    return json.loads(path.read_text())


@pytest.mark.skipif(sys.platform != "linux", reason="Linux subreaper lifecycle")
def test_successful_launcher_retains_services_until_explicit_stop(tmp_path):
    ready, child_file = tmp_path / "ready.json", tmp_path / "child.json"
    code = """import os,sys,time,json
pid=os.fork()
if pid==0:
 os.setsid()
 open(sys.argv[1],'w').write(json.dumps({'pid':os.getpid()}))
 time.sleep(30)
else:
 while not os.path.exists(sys.argv[1]): time.sleep(.01)
"""
    command = [
        sys.executable,
        "-m",
        "benchmark.runtime.service_session",
        "--ready-file",
        str(ready),
        "--terminate-grace-seconds",
        ".1",
        "--",
        sys.executable,
        "-c",
        code,
        str(child_file),
    ]
    process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        status = wait_for(ready, process)
        child = json.loads(child_file.read_text())["pid"]
        assert status["status"] == "launcher_completed"
        assert process.poll() is None
        assert Path("/proc", str(child)).exists()
        process.send_signal(signal.SIGTERM)
        assert process.wait(timeout=5) == 0
        assert not Path("/proc", str(child)).exists()
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)


@pytest.mark.skipif(sys.platform != "linux", reason="Linux subreaper lifecycle")
def test_launcher_failure_does_not_publish_ready_and_cleans_services(tmp_path):
    ready, child_file = tmp_path / "ready.json", tmp_path / "child.json"
    code = """import os,sys,time,json
pid=os.fork()
if pid==0:
 os.setsid()
 open(sys.argv[1],'w').write(json.dumps({'pid':os.getpid()}))
 time.sleep(30)
else:
 while not os.path.exists(sys.argv[1]): time.sleep(.01)
 sys.exit(3)
"""
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "benchmark.runtime.service_session",
            "--ready-file",
            str(ready),
            "--terminate-grace-seconds",
            ".1",
            "--",
            sys.executable,
            "-c",
            code,
            str(child_file),
        ],
        timeout=5,
        capture_output=True,
    )
    assert result.returncode == 3
    assert not ready.exists()
    child = json.loads(child_file.read_text())["pid"]
    assert not Path("/proc", str(child)).exists()


@pytest.mark.skipif(sys.platform != "linux", reason="Linux parent lifecycle")
def test_calling_parent_exit_stops_session_and_services(tmp_path):
    ready, child_file = tmp_path / "ready.json", tmp_path / "child.json"
    service = """import os,sys,time,json
pid=os.fork()
if pid==0:
 os.setsid()
 open(sys.argv[1],'w').write(json.dumps({'pid':os.getpid()}))
 time.sleep(30)
else:
 while not os.path.exists(sys.argv[1]): time.sleep(.01)
"""
    command = [
        sys.executable,
        "-m",
        "benchmark.runtime.service_session",
        "--ready-file",
        str(ready),
        "--terminate-grace-seconds",
        ".1",
        "--",
        sys.executable,
        "-c",
        service,
        str(child_file),
    ]
    parent = """import subprocess,time,pathlib,json,sys
command=json.loads(sys.argv[1])
process=subprocess.Popen(command,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
deadline=time.monotonic()+5
while not pathlib.Path(sys.argv[2]).exists():
 if process.poll() is not None or time.monotonic()>deadline: sys.exit(2)
 time.sleep(.01)
"""
    result = subprocess.run([sys.executable, "-c", parent, json.dumps(command), str(ready)], timeout=6)
    assert result.returncode == 0
    child = json.loads(child_file.read_text())["pid"]
    deadline = time.monotonic() + 5
    while Path("/proc", str(child)).exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not Path("/proc", str(child)).exists()
