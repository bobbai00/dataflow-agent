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
"""bench report's counting rules, on small run folders in both layouts."""
import json

import pytest

from bobbench.report import cells, kind, merged, render, rows


def run_folder(root, name, completed, manifest=None, stats=None):
    run = root / name
    run.mkdir()
    (run / "manifest.json").write_text(json.dumps(manifest if manifest is not None else {
        "benchmark": "kramabench", "system": "bobflow", "models": {"Luna": "gpt-5.6-luna"}, "pass_threshold": 1.0}))
    (run / "progress.json").write_text(json.dumps({"completed": completed}))
    for (sut, task), values in (stats or {}).items():
        folder = run / "system_scratch" / sut / task
        folder.mkdir(parents=True)
        (folder / "stats.json").write_text(json.dumps(values))
    return run


def attempt(task, score=1.0, cost=0.01, rep=1, arm="evidence_full_flow0", model="Luna", **more):
    return {"model": model, "arm": arm, "task": task, "rep": rep, "sut": f"SUT_{arm}_Rep{rep}", "score": score,
            "cost_usd": cost, **more}


def test_accuracy_is_the_share_of_attempts_at_the_threshold_and_cost_scales_to_a_full_pass(tmp_path):
    run = run_folder(tmp_path, "r", [attempt("a-easy-1", 1.0, 0.01), attempt("a-easy-2", 0.5, 0.03),
                                     attempt("a-easy-3", None, 0.02), attempt("a-easy-4", 1.0, 0.02)])
    [cell] = cells(rows([run], {}, set()))
    assert (cell["attempts"], cell["accuracy"], cell["timeouts"]) == (4, 50.0, 0)
    assert cell["mean_score"] == pytest.approx(100 * 2.5 / 3)  # scored attempts only
    assert cell["cost_per_pass"] == pytest.approx(0.02 * 104)


def test_the_last_attempt_of_a_task_counts(tmp_path):
    run = run_folder(tmp_path, "r", [attempt("a-easy-1", 0.0, 0.5), attempt("a-easy-1", 1.0, 0.1)])
    [cell] = cells(rows([run], {}, set()))
    assert (cell["attempts"], cell["accuracy"]) == (1, 100.0) and cell["cost_per_pass"] == pytest.approx(0.1 * 104)


def test_repetitions_all_count_and_arms_are_separate_cells(tmp_path):
    run = run_folder(tmp_path, "r", [attempt("a-easy-1", 1.0, rep=1), attempt("a-easy-1", 0.0, rep=2),
                                     attempt("a-easy-1", 1.0, arm="evidence_data1_flow0")])
    table = {c["arm"]: c for c in cells(rows([run], {}, set()))}
    assert table["evidence_full_flow0"]["accuracy"] == 50.0 and table["evidence_data1_flow0"]["accuracy"] == 100.0


def test_a_killed_attempt_counts_what_its_finished_calls_billed_and_no_bill_counts_zero_and_is_flagged(tmp_path):
    run = run_folder(tmp_path, "r", [attempt("a-easy-1", 0.0, None, timeout=True), attempt("a-easy-2", 0.0, None),
                                     attempt("a-easy-3", 1.0, 0.03)],
                     stats={("SUT_evidence_full_flow0_Rep1", "a-easy-1"): {"cost_usd": None, "partial_provider_reported_cost_usd": 0.03}})
    found = rows([run], {}, set())
    assert [r["cost_usd"] for r in found] == [0.03, None, 0.03]
    [cell] = cells(found)
    assert cell["cost_per_pass"] == pytest.approx(0.02 * 104) and cell["unbilled"] == 1 and cell["timeouts"] == 1
    assert "1 with no bill, counted $0" in render([cell])


def test_prepbench_accuracy_comes_from_the_evaluator_and_needs_its_scores(tmp_path):
    manifest = {"models": {"Luna": "gpt-5.6-luna"}, "task_ids": ["prepbench-hard-1", "prepbench-hard-2"]}
    run = run_folder(tmp_path, "pb", [attempt("prepbench-hard-1", 0.0, 0.2), attempt("prepbench-hard-2", 0.0, None)], manifest)
    [unscored] = cells(rows([run], {}, set()))
    assert unscored["benchmark"] == "prepbench" and unscored["accuracy"] is None and "needs --scores" in render([unscored])
    scores = {("pb", "prepbench-hard-1"): {"passed": True, "cost_usd": 0.1},
              ("pb", "prepbench-hard-2"): {"passed": False, "cost_usd": 0.3}}
    [cell] = cells(rows([run], scores, set()))
    assert cell["accuracy"] == 50.0 and cell["cost_per_pass"] == pytest.approx(0.2 * 306)


def test_a_score_row_of_zero_falls_back_to_the_attempts_own_bill(tmp_path):
    manifest = {"benchmark": "prepbench", "models": {"Luna": "m"}}
    run = run_folder(tmp_path, "pb", [attempt("prepbench-hard-1", 0.0, 0.2)], manifest)
    [row] = rows([run], {("pb", "prepbench-hard-1"): {"passed": False, "cost_usd": 0.0}}, set())
    assert row["cost_usd"] == 0.2


def test_an_integrity_exclusion_counts_as_failed(tmp_path):
    run = run_folder(tmp_path, "r", [attempt("a-easy-1", 1.0), attempt("a-easy-2", 1.0)])
    [cell] = cells(rows([run], {}, {("r", "a-easy-2")}))
    assert cell["accuracy"] == 50.0


def test_merge_lets_a_later_run_replace_earlier_attempts_and_without_it_runs_are_repetitions(tmp_path):
    first = run_folder(tmp_path, "r1", [attempt("a-easy-1", 0.0, 0.5), attempt("a-easy-2", 1.0, 0.1)])
    rerun = run_folder(tmp_path, "r1-rerun", [attempt("a-easy-1", 1.0, 0.1)])
    together = rows([first, rerun], {}, set())
    assert cells(together)[0]["attempts"] == 3
    [cell] = cells(merged(together))
    assert (cell["attempts"], cell["accuracy"]) == (2, 100.0) and cell["runs"] == ["r1", "r1-rerun"]


def test_old_run_folders_say_their_benchmark_and_system_by_their_contents():
    assert kind({"task_ids": ["legal-easy-1"], "arms": {}}) == ("kramabench", "bobflow")
    assert kind({"task_ids": ["prepbench-hard-1"], "script_settings": {}}) == ("prepbench", "scriptreact")
    assert kind({"benchmark": "prepbench", "system": "bobflow"}) == ("prepbench", "bobflow")


def test_script_react_is_one_arm(tmp_path):
    run = run_folder(tmp_path, "s", [attempt("a-easy-1", arm="smolagents")],
                     {"models": {"Luna": "m"}, "script_settings": {}, "task_ids": ["a-easy-1"]})
    assert cells(rows([run], {}, set()))[0]["arm"] == "smolagents"
