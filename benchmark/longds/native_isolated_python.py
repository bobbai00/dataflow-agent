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

"""Optional UDF_PYTHON_PATH for an isolated local LongDS engine deployment.

Set LONGDS_NATIVE_PYTHON to the real venv interpreter, LONGDS_NATIVE_WORKSPACE
to a private scratch parent, and LONGDS_SOURCE_DATA to the raw data/longds tree.
Only use on the experiment's own engine. Normal development is unaffected.
"""
import base64
import json
import os
from pathlib import Path
import re
import sys

from execution_isolation import isolated_command


def main():
    python = Path(os.environ["LONGDS_NATIVE_PYTHON"]).absolute()
    root = Path(__file__).resolve().parents[2]
    source_data = Path(os.environ["LONGDS_SOURCE_DATA"]).resolve()
    args = sys.argv[1:]
    if args[:1] == ["-u"]:
        args = args[1:]
    if len(args) != 2 or Path(args[0]).name != "texera_run_python_worker.py":
        raise RuntimeError("This benchmark wrapper accepts only a Texera Python worker")
    config = json.loads(base64.b64decode(args[1]))
    match = re.search(r"\bWF(\d+)-", config["workerId"])
    if not match:
        raise RuntimeError("Cannot identify the worker's workflow")
    workspace = Path(os.environ["LONGDS_NATIVE_WORKSPACE"]) / match[1]
    workspace.mkdir(parents=True, exist_ok=True)
    amber = root / "amber"
    python_source = amber / "src/main/python"
    warehouse = Path(config["icebergFileStorageDirectoryPath"])
    retained = Path(os.environ["TEXERA_TASK_RESULT_DIR"]) / match[1]
    retained.mkdir(parents=True, exist_ok=True)
    command = isolated_command(
        [python, "-u", *args], python=python, data_roots=[], workspace=workspace,
        read_only=[(python_source, python_source), (source_data, amber / "data/longds"),
                   (source_data, root / "data/longds"), (retained, retained)],
        read_write=[(warehouse, warehouse)], cwd=amber, network=True,
        environment={"PYTHONPATH": str(python_source)},
    )
    os.execv(command[0], command)


if __name__ == "__main__":
    main()
