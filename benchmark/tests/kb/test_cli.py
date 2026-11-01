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
"""bench run: the jobs of the baseline smokes in their recorded order, the manifest, and argument checks."""
import json
from pathlib import Path

import pytest

from bobbench import runner
from bobbench.kramabench import cli
from bobbench.paths import KB

RECORDED = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "jobs.json").read_text())


@pytest.mark.parametrize("recorded", RECORDED, ids=[r["run"] for r in RECORDED])
def test_jobs_are_the_recorded_runs_jobs_in_the_recorded_order(recorded):
    tag = recorded["run"].replace("-", "_")
    assert runner.jobs(recorded["system"], recorded["models"], recorded["arms"], recorded["tasks"],
                       recorded["repetitions"], tag) == recorded["jobs"]


@pytest.fixture
def launched(monkeypatch, tmp_path):
    """bench run up to the run loop: the manifest it wrote and the run it would start."""
    if not (KB / "data" / "legal" / "input").is_dir():
        pytest.skip("no KramaBench data (bench setup)")
    started = []

    class Run:
        def __init__(self, output, manifest, **options):
            started.append((output, manifest, options))

        def run(self):
            return {"status": "complete"}

    monkeypatch.setattr(runner, "Run", Run)
    monkeypatch.setenv("OPENAI_API_KEY", "invalid-test-key")
    monkeypatch.setenv("TEXERA_AGENT_SERVICE_ENDPOINT", "http://localhost:1")
    monkeypatch.setenv("TEXERA_LLM_TRACE_DIR", str(tmp_path / "wire"))

    def launch(*argv):
        cli.main(list(argv))
        return started[-1]
    return launch


def test_a_bobflow_run_records_its_settings_arms_prices_and_judge_cache(launched, tmp_path):
    output, manifest, options = launched("kramabench", "bobflow", "--output", str(tmp_path / "r-1"), "--models", "Haiku55",
                                         "--arms", "evidence_data1_flow0_opt", "--tasks", "legal-easy-25", "--workers", "3")
    assert output == tmp_path / "r-1" and options == {"workers": 3, "large_workers": 1}
    assert json.loads((output / "manifest.json").read_text()) == json.loads(json.dumps(manifest))
    assert manifest["system"] == "bobflow" and manifest["benchmark"] == "kramabench"
    assert manifest["settings"] == {"nativeProfileCollection": True, "maxSteps": 25, "maxOperatorResultCharLimit": 2000,
                                    "maxResultRows": 3, "fullResultCharLimit": 5000, "executionTimeoutMinutes": 10}
    assert set(manifest["arms"]) == {"evidence_data1_flow0_opt"} and manifest["arms"]["evidence_data1_flow0_opt"]["answerOnlyReply"]
    assert manifest["pricing_schedules"]["claude-haiku-5.5"]["rates"]["output"] == 5e-07
    assert manifest["task_timeout_seconds"] == 900 and manifest["large_input_bytes"] == 100_000_000
    assert manifest["judge_cache"]["path"].endswith("benchmark/fixtures/paraphrase_cache.json")
    assert manifest["wire_directory"] == str((tmp_path / "wire").resolve())
    assert manifest["jobs"] == [{"model": "Haiku55", "arm": "evidence_data1_flow0_opt", "task": "legal-easy-25", "rep": 1,
                                 "sut": "DataflowSystemHaiku55_r_1_evidence_data1_flow0_opt_Rep1"}]
    assert (output / "source-snapshot.json").exists()


def test_all_prepbench_cases_keep_the_workload_order(launched, tmp_path):
    if not (KB / "data" / "prepbench" / "input").is_dir():
        pytest.skip("no PrepBench workload (bench setup prepbench)")
    _, manifest, _ = launched("prepbench", "bobflow", "--output", str(tmp_path / "p"), "--models", "Luna",
                              "--arms", "evidence_full_flow0", "--all-tasks")
    workload = [t["id"] for t in json.loads((KB / "workload" / "prepbench.json").read_text())]
    assert manifest["task_ids"] == workload and len(workload) == 306
    assert manifest["large_input_bytes"] == 5_000_000_000 and manifest["task_timeout_seconds"] == 900


@pytest.mark.parametrize("argv, message", [
    (["kramabench", "bobflow", "--models", "Luna", "--tasks", "legal-easy-25"], "needs --arms"),
    (["kramabench", "scriptreact", "--models", "Luna", "--arms", "evidence_full_flow0", "--tasks", "legal-easy-25"],
     "no arms"),
    (["kramabench", "bobflow", "--models", "Luna", "--arms", "evidence_full_flow0", "--tasks", "legal-easy-999"],
     "not tasks of kramabench"),
    (["kramabench", "bobflow", "--models", "Luna", "--arms", "evidence_full_flow0", "--tasks", "a", "a"], "duplicate"),
    (["prepbench", "bobflow", "--models", "Luna", "--arms", "evidence_full_flow0", "--tasks", "legal-easy-25"],
     "not tasks of prepbench"),
])
def test_bad_arguments_stop_before_anything_is_written(launched, tmp_path, capsys, argv, message):
    with pytest.raises(SystemExit):
        launched(*argv, "--output", str(tmp_path / "x"))
    assert message in capsys.readouterr().err and not (tmp_path / "x").exists()
