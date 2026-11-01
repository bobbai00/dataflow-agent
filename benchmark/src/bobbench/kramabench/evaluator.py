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
"""KramaBench's own evaluator for one task: its Executor runs the system on the task and its Evaluator scores the reply.

This is KramaBench's evaluate.py for one task id with the flags every run used (the task's data sources as the file
list, no subtasks, no pipeline judge, verbose), minus its CSV files and response cache. Run with the KramaBench venv and
`benchmark/Kramabench` on PYTHONPATH, so that `benchmark` is KramaBench's package. The judge's verdict cache is
KramaBench's default (benchmark/fixtures/paraphrase_cache.json, or KRAMABENCH_PARAPHRASE_CACHE); OPENAI_API_KEY is read
when the package is imported.
"""
import json
from pathlib import Path
import time


def run_task(system, *, kb, workload, task_id, sut, attempt_dir):
    """Run `system` on one task and score it; writes and returns the task's evaluation (evaluation.json)."""
    from benchmark import Evaluator, Executor  # KramaBench's package

    kb, attempt_dir = Path(kb), Path(attempt_dir)
    workload_path = kb / "workload" / f"{workload}.json"
    started = time.time()
    system.process_dataset(str(kb / "data" / workload / "input"))
    processing = time.time() - started
    results = Executor(system=system, system_name=sut, workload_path=workload_path, results_directory=attempt_dir,
                       verbose=True, run_subtasks=False, use_deepresearch_subset=False, use_truth_subset=True,
                       task_id_filter=[task_id]).run_workload(use_system_cache=False, cache_system_output=False)
    if len(results) != 1:
        raise SystemExit(f"{task_id} is not a task of the {workload} workload")
    results[0]["runtime"] += processing  # the dataset processing time, shared over the workload's one task
    [evaluation] = Evaluator(workload_path=workload_path, task_fixture_directory=kb / "benchmark" / "fixtures",
                             results_directory=attempt_dir, run_subtasks=False, evaluate_pipeline=False,
                             task_id_filter=[task_id]).evaluate_results(results)
    record = {key: value for key, value in evaluation.items() if key != "subresponses"}
    attempt_dir.mkdir(parents=True, exist_ok=True)
    with open(attempt_dir / "evaluation.json", "w") as stream:
        json.dump(record, stream, indent=2, default=str)
    return record
