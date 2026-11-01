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
"""bench compare: the answer-type score, the Venn over run folders and the dataflow profile."""
import json

import pytest

from bobbench.compare import answer_score, billed, compare, dataflow, median, side


def attempt_folder(run, sut, task, evaluation=None, truth=None, stats=None, workflow=None, snapshot=None):
    folder = run / "system_scratch" / sut / task
    folder.mkdir(parents=True)
    for name, value in (("evaluation.json", evaluation), ("ground_truth.json", truth), ("stats.json", stats),
                        ("workflow.json", workflow), ("snapshot.json", snapshot)):
        if value is not None:
            (folder / name).write_text(json.dumps(value))
    return folder


def test_the_answer_type_decides_the_metric_a_failed_judge_is_unscored_and_nan_is_zero(tmp_path):
    def score(name, evaluation, answer_type):
        return answer_score(attempt_folder(tmp_path, "s", name, evaluation, {"answer_type": answer_type}))

    assert score("a", {"success": 0, "rae_score": 1.0}, "numeric_exact") == 0.0
    assert score("b", {"llm_paraphrase": None, "success": 1}, "string_approximate") is None
    assert score("c", {"rae_score": float("nan")}, "numeric_approximate") == 0.0
    assert score("d", {"success": 1, "f1": 0.5}, "unknown") == 1.0  # no known type: the best metric
    assert answer_score(tmp_path / "absent") is None
    assert answer_score(tmp_path / "absent", {"passed": True}) == 1.0  # PrepBench's evaluator decides


def test_a_zero_bill_with_tokens_is_unknown_never_free():
    assert billed({"cost_usd": 0.5}) == 0.5
    assert billed({"cost_usd": 0, "input_tokens": 10}) is None
    assert billed({"cost_usd": 0, "input_tokens": 0}) == 0.0
    assert billed({"cost_usd": None}) is None
    assert billed({"cost_usd": True}) is None


def test_the_dataflow_profile_counts_operators_depth_roots_and_rows(tmp_path):
    workflow = {"workflow": {"operators": [{"operatorID": o} for o in "abcd"],
                             "links": [{"source": {"operatorID": s}, "target": {"operatorID": t}}
                                       for s, t in (("a", "b"), ("b", "c"))]}}
    snapshot = {"results": {"a": {"totalRowCount": 10}, "b": {"totalRowCount": 3}, "c": {"state": "Failed"}}}
    profile = dataflow(attempt_folder(tmp_path, "s", "t", workflow=workflow, snapshot=snapshot))
    assert profile == {"operators": 4, "depth": 2, "sources": 2, "rows": [3, 10]}
    assert dataflow(tmp_path / "absent") == {"operators": 0, "depth": 0, "sources": 0, "rows": []}
    assert median([3, None, 1, 2]) == 2 and median([]) is None


def test_a_snapshot_stands_in_for_a_missing_workflow_file(tmp_path):
    snapshot = {"workflow": {"operators": [{"operatorID": "a"}], "links": []}, "results": {}}
    assert dataflow(attempt_folder(tmp_path, "s", "t", snapshot=snapshot))["operators"] == 1


def record(score, cost):
    return {"score": score, "cost": cost}


def test_the_venn_splits_the_shared_scored_tasks_and_the_cost_gap_is_relative_to_the_dearer_side():
    a = {"both": record(1.0, 0.1), "both2": record(1.0, 0.1), "aonly": record(1.0, 1), "bonly": record(0.0, 1),
         "none": record(0.0, 1), "unscored": record(None, 1), "justa": record(1.0, 1)}
    b = {"both": record(1.0, 0.2), "both2": record(0.95, 0.105), "aonly": record(0.0, 1), "bonly": record(1.0, 1),
         "none": record(0.0, 1), "unscored": record(1.0, 1)}
    c = compare(a, b, th=0.9, gap=0.10)
    assert (c["only_a"], c["only_b"], c["neither"]) == (["aonly"], ["bonly"], ["none"])
    assert c["both"] == ["both", "both2"] and c["unscored"] == ["justa", "unscored"]
    assert c["a_cheaper"] == ["both"] and c["b_cheaper"] == []  # 5% of the dearer side is inside the noise band
    assert c["a_saves"] == pytest.approx(0.105) and c["b_saves"] == 0


def test_a_side_names_one_sut_and_one_repetition(tmp_path):
    run = tmp_path / "run"
    run.mkdir()
    rows = [{"model": "Luna", "arm": arm, "task": "t", "rep": rep, "sut": f"S_{arm}_Rep{rep}"}
            for arm in ("x", "y") for rep in (1, 2)]
    (run / "progress.json").write_text(json.dumps({"completed": rows}))
    (run / "manifest.json").write_text(json.dumps({"input_inventory": [{"task_id": "t", "bytes": 7, "files": [{"path": "d/f.CSV"}]}]}))
    found, name = side(f"{run}:x", 2, {})
    assert name == "S_x_Rep2" and found["t"]["input_bytes"] == 7 and found["t"]["input_formats"] == [".csv"]
    with pytest.raises(SystemExit, match="holds 2 SUTs"):
        side(str(run), 1, {})
    with pytest.raises(SystemExit, match="no attempts"):
        side(f"{run}:z", 1, {})
    with pytest.raises(SystemExit, match="not a run folder"):
        side(str(tmp_path / "missing"), 1, {})
