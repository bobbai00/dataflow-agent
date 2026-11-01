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
"""The benchmarks' tasks: which workload a task belongs to, and the input inventory a run records."""
import glob
import json
from pathlib import Path
import re

from bobbench.paths import KB

WORKLOADS = ("archeology", "astronomy", "biomedical", "environment", "legal", "wildfire")
# PrepBench (clarified mode) is staged as one more KramaBench workload (bench setup prepbench).
BENCHMARKS = {"kramabench": WORKLOADS, "prepbench": ("prepbench",)}
# The evaluator's score metrics; an attempt's score is the best of those present.
SCORE_METRICS = ("success", "llm_paraphrase", "rae_score", "f1", "f1_approximate")


def workload_of(task_id):
    match = re.match(r"^(.*)-(easy|hard)-\d+$", task_id)
    return match.group(1) if match else task_id.split("-")[0]


def benchmark_of(task_id):
    return "prepbench" if workload_of(task_id) == "prepbench" else "kramabench"


def score(evaluation):
    """An evaluation's score: the best of its score metrics, or None when none was scored."""
    scores = [float(evaluation[key]) for key in SCORE_METRICS if evaluation.get(key) is not None]
    return max(scores) if scores else None


def tasks(workload, kb=KB):
    return json.loads((Path(kb) / "workload" / f"{workload}.json").read_text())


def inventory(workloads=WORKLOADS, kb=KB):
    """Every task of the workloads with the files its data sources resolve to and their bytes, largest first.
    No outcome is consulted; the runner limits how many large-input tasks run at once by it."""
    kb = Path(kb)
    found = []
    for workload in workloads:
        for task in tasks(workload, kb):
            paths, missing = set(), []
            for source in task["data_sources"]:
                matches = glob.glob(str(kb / "data" / workload / "input" / source), recursive=True)
                if not matches:
                    missing.append(source)
                for match in matches:
                    path = Path(match)
                    paths.update([path] if path.is_file() else (f for f in path.rglob("*") if f.is_file()))
            files = [{"path": str(p.relative_to(kb)), "bytes": p.stat().st_size} for p in sorted(paths)]
            found.append({"task_id": task["id"], "query": task["query"], "files": files,
                          "bytes": sum(f["bytes"] for f in files), "unresolved_sources": missing})
    return sorted(found, key=lambda t: (-t["bytes"], t["task_id"]))
