#!/usr/bin/env python3
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

"""UDF_PYTHON_PATH for an isolated KramaBench engine deployment.

Model-written Python runs inside the engine's Python workers. Without this
wrapper it can read the repository, its git history and committed reports,
which contain gold answers. Set NATIVE_ISOLATED_PYTHON to the real venv
interpreter, NATIVE_WORKSPACE to a private scratch parent and
NATIVE_SOURCE_DATA to the KramaBench data tree. Each worker then sees the
interpreter, the engine's Python sources, read-only task data (at amber/data,
the workers' relative data path) and the result warehouse it writes. A data
directory that is a symbolic link (LongDS links its session data out of the
reference checkout) is mounted at its target too, so it resolves without
exposing the target's neighbours. Use only on the experiment's own engine.

The agent service reads the same variable for its own interpreter: it runs
the native runtime script with a JSON request on stdin to parse and validate
edits (nothing is executed). That one invocation runs sandboxed as well, with
only the runtime's directory mounted and no network.
"""
import base64
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from execution_isolation import isolated_command  # noqa: E402


def data_roots(source_data):
    """The data tree and the targets of directory links directly inside it."""
    return [source_data, *(child.resolve() for child in sorted(source_data.iterdir())
                           if child.is_symlink() and child.is_dir())]


def main():
    python = Path(os.environ["NATIVE_ISOLATED_PYTHON"]).absolute()
    root = Path(__file__).resolve().parents[2]
    source_data = Path(os.environ["NATIVE_SOURCE_DATA"]).resolve()
    args = sys.argv[1:]
    if args[:1] == ["-u"]:
        args = args[1:]
    validator = root / "agent-service/src/agent/native/python"
    if len(args) == 1 and Path(args[0]).resolve() == validator / "runtime.py":
        workspace = Path(os.environ["NATIVE_WORKSPACE"]) / "validation"
        workspace.mkdir(parents=True, exist_ok=True)
        command = isolated_command([python, str(validator / "runtime.py")], python=python, data_roots=[],
                                   workspace=workspace, read_only=[(validator, validator)], network=False)
        os.execv(command[0], command)
    if len(args) != 2 or Path(args[0]).name != "texera_run_python_worker.py":
        raise RuntimeError("This benchmark wrapper accepts only a Texera Python worker")
    config = json.loads(base64.b64decode(args[1]))
    match = re.search(r"\bWF(\d+)-", config["workerId"])
    if not match:
        raise RuntimeError("Cannot identify the worker's workflow")
    workspace = Path(os.environ["NATIVE_WORKSPACE"]) / match[1]
    workspace.mkdir(parents=True, exist_ok=True)
    amber = root / "amber"
    python_source = amber / "src/main/python"
    warehouse = Path(config["icebergFileStorageDirectoryPath"])
    # The data root is also mounted at its real path, read-only, so absolute
    # paths a receipt showed still open.
    command = isolated_command(
        [python, "-u", *args], python=python, data_roots=data_roots(source_data), workspace=workspace,
        read_only=[(python_source, python_source), (source_data, amber / "data"), (source_data, root / "data")],
        read_write=[(warehouse, warehouse)], cwd=amber, network=True,
        environment={"PYTHONPATH": str(python_source), "HOME": "/workspace"},
    )
    os.execv(command[0], command)


if __name__ == "__main__":
    main()
