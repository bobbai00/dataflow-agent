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
"""The task prompts are the baseline smokes' prompt.txt byte for byte (fixtures/prompts/<system>/<task>[.<variant>].txt).

BobFlow: KramaBench tasks with and without the answer-only line (smk2-kb), PrepBench cases (smk2-pb) and the Flow
Evidence tasks (smk5-kbflow). Needs the KramaBench data (bench setup kramabench) and the PrepBench workload."""
from pathlib import Path

import pytest

from bobbench.kramabench.bobflow import BobFlowSystem
from bobbench.kramabench.tasks import tasks, workload_of
from bobbench.paths import KB

GOLDEN = Path(__file__).resolve().parents[1] / "fixtures" / "prompts"


def truth_subset(task):
    """The file list KramaBench's Executor gives a system with use_truth_subset ("./" alone means every file)."""
    subset = task.get("data_sources", [])
    if isinstance(subset, str):
        return [] if subset == "./" else [subset]
    return [] if len(subset) == 1 and subset[0] == "./" else subset


def input_folder(workload):
    folder = KB / "data" / workload / "input"
    if not folder.is_dir():
        pytest.skip(f"no KramaBench data at {folder} (bench setup)")
    return folder


@pytest.mark.parametrize("golden", sorted((GOLDEN / "bobflow").glob("*.txt")), ids=lambda p: p.stem)
def test_bobflow_prompt_is_the_recorded_one(golden, tmp_path):
    task_id, _, variant = golden.name[:-len(".txt")].partition(".")
    workload = workload_of(task_id)
    system = BobFlowSystem(model="m", settings={"answerOnlyReply": variant == "answer-only"}, endpoints=None,
                           computing_unit=None, scratch=tmp_path, kb=KB, provenance={})
    system.process_dataset(input_folder(workload))
    task = next(t for t in tasks(workload) if t["id"] == task_id)
    assert system.prompt(task["query"], task_id, truth_subset(task)) == golden.read_text()
