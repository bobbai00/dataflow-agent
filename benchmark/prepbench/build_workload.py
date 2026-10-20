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
"""Stage PrepBench (clarified mode) as a KramaBench domain, `prepbench`, for our dataflow runner and smolagents harness.

Each PrepBench case becomes task `prepbench-hard-<n>`:
- data:   KramaBench data/prepbench/input/case_<nnn>/input_*.csv (copies of the case's inputs);
- query:  the case's clarified request (query_full.md, what PrepBench's clarified mode gives an agent), verbatim;
- answer: none (scored by PrepBench's own evaluator on the output tables, not by KramaBench); answer_type string_exact
          so KramaBench's evaluator makes no LLM judge calls.
Format hints, one file per system (same requirements; only the handover of the tables differs):
- format_hint/prepbench.json:        dataflow agent names the operator holding each output table; the runner exports it;
- prepbench/format_hint_script.json: smolagents writes each table with pandas to result/<file>.
The PrepBench runs used TsinghuaDatabaseGroup/prepbench at 993a313 (git clone https://github.com/TsinghuaDatabaseGroup/prepbench).
Usage: build_workload.py <prepbench repo> [<kramabench root> [<out dir>]]
       (defaults: this checkout's benchmark/Kramabench, and this directory for format_hint_script.json and task-index.json)"""
import json, shutil, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
repo = Path(sys.argv[1])
kb = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE.parents[1] / "benchmark/Kramabench"
out = Path(sys.argv[3]) if len(sys.argv) > 3 else HERE
cases = sorted(p for p in (repo / "data").iterdir() if p.is_dir() and p.name.startswith("case_"))
workload, dataflow_hints, script_hints, index = [], [], [], {}
for case in cases:
    n = int(case.name.split("_")[1]); task = f"prepbench-hard-{n}"
    inputs = sorted(p.name for p in (case / "inputs").glob("*.csv"))
    target = kb / "data" / "prepbench" / "input" / case.name
    target.mkdir(parents=True, exist_ok=True)
    for name in inputs:
        shutil.copy2(case / "inputs" / name, target / name)
    outputs = sorted(json.loads((repo / "src/evaluate/gt" / case.name / "config.json").read_text())["files"])
    query = (case / "query_full.md").read_text().strip()
    workload.append({"id": task, "query": query, "answer": "scored by the PrepBench evaluator", "answer_type": "string_exact",
                     "runtime": 1, "data_sources": [f"{case.name}/{name}" for name in inputs], "subtasks": []})
    example_map = json.dumps({name: f"<operator ID>" for name in outputs})
    dataflow_hints.append({"id": task, "query": query, "format_hint": (
        "Build each output table listed under Output as an operator in the Dataflow: its columns are exactly the listed "
        "fields, with those names and in that order, and nothing else. Do not write files: when you finish, each output "
        "file is saved from the full result of the operator you name for it. The answer is a JSON object that maps each "
        f"output file to the ID of the operator holding its table: {example_map}")})
    example_files = json.dumps([f"result/{name}" for name in outputs])
    script_hints.append({"id": task, "query": query, "format_hint": (
        "Write each output table listed under Output with pandas into the folder result/ (it exists) under the listed "
        "file name, for example df.to_csv(\"result/output_01.csv\", index=False): its columns are exactly the listed "
        "fields, with those names and in that order, and nothing else. The answer is the list of files you wrote: "
        f"{example_files}")})
    index[task] = {"case": case.name, "inputs": inputs, "outputs": outputs}
(kb / "workload" / "prepbench.json").write_text(json.dumps(workload, indent=1, ensure_ascii=False) + "\n")
(kb / "format_hint" / "prepbench.json").write_text(json.dumps(dataflow_hints, indent=1, ensure_ascii=False) + "\n")
out.mkdir(parents=True, exist_ok=True)
(out / "format_hint_script.json").write_text(json.dumps(script_hints, indent=1, ensure_ascii=False) + "\n")
(out / "task-index.json").write_text(json.dumps(index, indent=1) + "\n")
print(f"{len(workload)} tasks; {sum(len(v['inputs']) for v in index.values())} input files; "
      f"{sum(len(v['outputs']) for v in index.values())} output tables")
