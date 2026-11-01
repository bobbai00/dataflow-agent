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
"""KramaBench's evaluator, driven for one task, scores a recorded reply as the baseline smokes' evaluate.py did.

fixtures/evaluations.json: 26 attempts of the baseline smokes (BobFlow on KramaBench, Flow Evidence and PrepBench;
Script ReAct on KramaBench), each with the reply its system returned and the evaluation.json it got. Judged metrics
come from KramaBench's verdict cache; the judge key is invalid here, so a cache miss fails the test instead of paying."""
import json
import os
from pathlib import Path

import pytest

os.environ["OPENAI_API_KEY"] = "invalid-test-key"  # read when KramaBench's package is imported
pytest.importorskip("benchmark.benchmark", reason="needs KramaBench's evaluator (KramaBench venv, PYTHONPATH)")

from bobbench.kramabench.evaluator import run_task  # noqa: E402
from bobbench.kramabench.tasks import tasks, workload_of  # noqa: E402
from bobbench.paths import KB  # noqa: E402

CASES = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "evaluations.json").read_text())


class RecordedSystem:
    """A system that answers with a recorded reply, and checks what KramaBench's Executor sent it."""

    def __init__(self, reply, task):
        self.reply, self.task, self.dataset_directory, self.queries = reply, task, None, []

    def process_dataset(self, dataset_directory):
        self.dataset_directory = dataset_directory

    def serve_query(self, query, query_id, subset_files):
        self.queries.append((query, query_id, subset_files))
        return self.reply


@pytest.mark.parametrize("case", CASES, ids=[f"{c['run']}:{c['sut'].split('_Rep')[0][-30:]}:{c['task']}" for c in CASES])
def test_recorded_reply_gets_the_recorded_evaluation(case, tmp_path):
    workload = workload_of(case["task"])
    if not (KB / "data" / workload / "input").is_dir():
        pytest.skip("no KramaBench data (bench setup)")
    task = next(t for t in tasks(workload) if t["id"] == case["task"])
    system = RecordedSystem(case["reply"], task)
    record = run_task(system, kb=KB, workload=workload, task_id=case["task"], sut=case["sut"], attempt_dir=tmp_path)
    assert system.queries == [(task["query"], task["id"], task["data_sources"])]
    assert system.dataset_directory == str(KB / "data" / workload / "input")
    assert {k: v for k, v in record.items() if k != "runtime"} == case["evaluation"]
    assert json.loads((tmp_path / "evaluation.json").read_text()) == json.loads(json.dumps(record, default=str))
    assert record["runtime"] >= 0


def test_an_unknown_task_ends_the_attempt(tmp_path):
    with pytest.raises(SystemExit):
        run_task(RecordedSystem({}, None), kb=KB, workload="legal", task_id="legal-easy-999", sut="x", attempt_dir=tmp_path)
