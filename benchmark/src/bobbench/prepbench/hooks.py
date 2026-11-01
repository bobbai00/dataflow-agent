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
"""How a PrepBench attempt hands its output tables over for scoring.

BobFlow names, in its reply, the operator holding each output table; after the reply each named table is exported from
the engine's stored result (export_result.py, on the engine's Python) to <attempt>/outputs/<file>, and every export's
outcome goes to <attempt>/outputs.json. Script ReAct writes the tables with pandas to result/<file> in its workspace;
before the workspace is discarded they are copied to <attempt>/outputs/.
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

from bobbench.paths import AMBER_PYTHON, ENGINE_PYTHON

HERE = Path(__file__).resolve().parent
EXPORTER = HERE / "export_result.py"
INDEX = json.loads((HERE / "data" / "task-index.json").read_text())
SCRIPT_HINTS = HERE / "data" / "format_hint_script.json"
OUTPUT = re.compile(r"output_\d+\.csv")


def output_map(answer, response):
    """The {file: operator} object the answer format asks for; else file/operator pairs written in the reply. The raw
    reply comes first: KramaBench's answer parser strips Markdown emphasis, which turns output_01.csv into output01.csv."""
    for text in [response, answer]:
        if isinstance(text, dict):
            return {str(k): str(v) for k, v in text.items()}
        for match in reversed(re.findall(r"\{[^{}]*\}", str(text or ""))):
            try:
                value = json.loads(match)
            except ValueError:
                continue
            if isinstance(value, dict) and any(str(k).endswith(".csv") for k in value):
                return {str(k): str(v) for k, v in value.items()}
    return dict(re.findall(r"(output_\d+\.csv)\W+([A-Za-z_][A-Za-z0-9_]*)", str(response or "")))


def files_named_like_operators(expected, mapping, results):
    """Expected output files the reply's mapping leaves out, each mapped to the operator named exactly like the file
    (output_01.csv -> output_01) when that operator has a stored result. Script ReAct's outputs are the files it wrote,
    whatever its last message says; an operator named like the file is BobFlow's equivalent."""
    named = {Path(name).name for name in mapping}
    return {file: Path(file).stem for file in expected if file not in named and Path(file).stem in results}


def export_outputs(attempt):
    """Export every output table the reply names (or that an operator is named like) to <attempt>/outputs/."""
    attempt = Path(attempt)

    def read(name, default):
        return json.loads((attempt / name).read_text()) if (attempt / name).exists() else default

    answer = read("answer.json", {}).get("answer")
    response = (attempt / "response.txt").read_text() if (attempt / "response.txt").exists() else ""
    results = read("snapshot.json", {}).get("results") or {}
    mapping = output_map(answer, response)
    fallback = files_named_like_operators((INDEX.get(attempt.name) or {}).get("outputs") or [], mapping, results)
    record = {"mapping": mapping, "named_like_file": fallback, "files": {}}
    for name, operator in {**mapping, **fallback}.items():
        file = Path(name).name
        if not OUTPUT.fullmatch(file):
            record["files"][name] = {"ok": False, "error": "not an output file name"}
            continue
        result = results.get(operator)
        if not result:
            record["files"][file] = {"ok": False, "operator": operator, "error": "no operator with this ID has a result"}
            continue
        made = result.get("materialization") or {}
        context = result.get("executionContext") or {}
        execution = made.get("executionId") or context.get("executionId")
        if not execution:
            record["files"][file] = {"ok": False, "operator": operator, "error": "the operator's result has no execution",
                                     "state": result.get("state")}
            continue
        command = [str(ENGINE_PYTHON), str(EXPORTER), "--workflow-id", str(context.get("workflowId")),
                   "--execution-id", str(execution), "--operator-id", operator, "--port", str(made.get("outputPort", 0)),
                   "--out", str(attempt / "outputs" / file)]
        done = subprocess.run(command, capture_output=True, text=True, timeout=600, cwd=AMBER_PYTHON,
                              env={**os.environ, "PYTHONPATH": str(AMBER_PYTHON)})
        try:
            outcome = json.loads(done.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            outcome = {"ok": False, "error": (done.stderr or done.stdout)[-2000:]}
        record["files"][file] = {**outcome, "operator": operator, "execution_id": execution,
                                 "snapshot_rows": result.get("totalRowCount"), "state": result.get("state")}
    (attempt / "outputs.json").write_text(json.dumps(record, indent=2) + "\n")


def after_dataflow_reply(attempt):
    """BobFlow's handover; a failure is recorded and never loses the attempt (missing outputs score as a failure)."""
    try:
        export_outputs(attempt)
    except Exception as exc:  # noqa: BLE001
        (Path(attempt) / "outputs.json").write_text(json.dumps({"error": repr(exc)}) + "\n")


def script_format_hints():
    """Script ReAct's format hints: write each table with pandas to result/<file>."""
    return {hint["id"]: hint["format_hint"] for hint in json.loads(SCRIPT_HINTS.read_text())}


def before_script_agent(workspace):
    """result/ exists in the workspace before the agent starts (the format hint says so)."""
    (Path(workspace) / "result").mkdir(parents=True, exist_ok=True)


def collect_script_outputs(workspace, attempt):
    """Copy every output_NN.csv the agent wrote to <attempt>/outputs/ (result/ first; elsewhere in the workspace only
    when result/ lacks it) and record them in <attempt>/outputs.json, before the workspace is discarded."""
    workspace, attempt = Path(workspace), Path(attempt)
    found = {}
    for path in sorted(workspace.rglob("*.csv"), key=lambda p: (p.parent != workspace / "result", str(p))):
        if OUTPUT.fullmatch(path.name) and path.is_file() and not path.is_symlink() and path.name not in found:
            (attempt / "outputs").mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, attempt / "outputs" / path.name)
            found[path.name] = {"ok": True, "from": str(path.relative_to(workspace)), "bytes": path.stat().st_size}
    (attempt / "outputs.json").write_text(json.dumps({"files": found}, indent=2) + "\n")
