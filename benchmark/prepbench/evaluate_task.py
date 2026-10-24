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
"""One PrepBench attempt of the dataflow agent: the runner's per-attempt script (benchmark/retrieval/evaluate_task.py,
unchanged) plus the output step. After the agent's final reply, each output file it names is exported from the full
stored result of the operator it names (export_result.py reads the engine's own result storage), into
<attempt>/outputs/<file>. The outcome of every export is recorded in <attempt>/outputs.json. Scoring is PrepBench's
evaluator (score.py), run afterwards on outputs/."""
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from handover import files_named_like_operators  # noqa: E402
REPO = HERE.parents[1]
BASE = REPO / "benchmark/retrieval/evaluate_task.py"
ENGINE_PYTHON = os.environ.get("NATIVE_ISOLATED_PYTHON") or str(REPO / ".venv/bin/python")
AMBER_PYTHON = str(REPO / "amber/src/main/python")
EXPORTER = str(HERE / "export_result.py")
INDEX = json.loads((HERE / "task-index.json").read_text())

base = runpy.run_path(str(BASE), run_name="prepbench_attempt")  # defines and registers RetrievalSystem, does not score
job = base["job"]
import systems  # noqa: E402  (the module the base script registered the system in)
Retrieval = getattr(systems, job["sut"])


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
    pairs = re.findall(r"(output_\d+\.csv)\W+([A-Za-z_][A-Za-z0-9_]*)", str(response or ""))
    return dict(pairs)


def export(base_dir):
    answer = json.loads((base_dir / "answer.json").read_text()).get("answer") if (base_dir / "answer.json").exists() else None
    response = (base_dir / "response.txt").read_text() if (base_dir / "response.txt").exists() else ""
    snapshot = json.loads((base_dir / "snapshot.json").read_text()) if (base_dir / "snapshot.json").exists() else {}
    results = snapshot.get("results") or {}
    mapping = output_map(answer, response)
    # A file the reply leaves out is exported from the operator named like it, if that one has a result.
    fallback = files_named_like_operators((INDEX.get(base_dir.name) or {}).get("outputs") or [], mapping, results)
    record = {"mapping": mapping, "named_like_file": fallback, "files": {}}
    for name, operator in {**mapping, **fallback}.items():
        file = Path(name).name
        if not re.fullmatch(r"output_\d+\.csv", file):
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
        command = [ENGINE_PYTHON, EXPORTER, "--workflow-id", str(context.get("workflowId")), "--execution-id", str(execution),
                   "--operator-id", operator, "--port", str(made.get("outputPort", 0)), "--out", str(base_dir / "outputs" / file)]
        done = subprocess.run(command, capture_output=True, text=True, timeout=600, cwd=AMBER_PYTHON,
                              env={**os.environ, "PYTHONPATH": AMBER_PYTHON})
        try:
            outcome = json.loads(done.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            outcome = {"ok": False, "error": (done.stderr or done.stdout)[-2000:]}
        record["files"][file] = {**outcome, "operator": operator, "execution_id": execution,
                                 "snapshot_rows": result.get("totalRowCount"), "state": result.get("state")}
    (base_dir / "outputs.json").write_text(json.dumps(record, indent=2) + "\n")


class PrepBenchSystem(Retrieval):
    def serve_query(self, query, query_id="default-0", subset_files=None):
        answer = super().serve_query(query, query_id, subset_files)  # also saves snapshot.json
        try:
            export(Path(self.output_dir) / query_id)
        except Exception as exc:  # never lose the attempt; the missing outputs score as a failure
            (Path(self.output_dir) / query_id / "outputs.json").write_text(json.dumps({"error": repr(exc)}) + "\n")
        return answer


setattr(systems, job["sut"], PrepBenchSystem)
if __name__ == "__main__":
    runpy.run_path("evaluate.py", run_name="__main__")
