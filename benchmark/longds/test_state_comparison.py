# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.
import json

import pytest

from state_comparison import arm_settings, build_prompts, cost_of, summarize, make_jobs, select_tasks


def manifest():
    return {"key": "domain__dataset__task1", "files": ["data/input.csv"], "turns": [
        {"turn_id": 1, "context": "Keep scores unrounded.", "question": "Compute the score."},
        {"turn_id": 2, "context": "Restore the earlier rule.", "question": "Compare both versions."},
    ]}


def test_identical_task_text_and_no_reference_answer_or_analysis_labels():
    m = manifest()
    m["turns"][0].update(answer="secret", state_type=["Rollback"], depends_tasks=[9])
    prompts = build_prompts(m)
    assert "data/input.csv" in prompts[0]["prompt"]
    assert "Keep scores unrounded." in prompts[0]["prompt"]
    assert "Restore the earlier rule." in prompts[1]["prompt"]
    assert "secret" not in json.dumps(prompts)
    assert "depends_tasks" not in json.dumps(prompts)
    assert "state_type" not in json.dumps(prompts)
    assert "answer.content" not in prompts[0]["prompt"]
    assert "<answer>" not in prompts[0]["prompt"]


@pytest.mark.parametrize("turn_ids", [[1, 1], [1, 3], [2, 3], [True, 2], [1.0, 2]])
def test_invalid_turn_sequence_rejected_before_solver_calls(turn_ids):
    m = manifest()
    for t, tid in zip(m["turns"], turn_ids):
        t["turn_id"] = tid
    with pytest.raises(ValueError):
        build_prompts(m)


def test_history_arm_changes_only_history_capability():
    base, history = arm_settings("baseline"), arm_settings("history")
    assert {k for k in base if base[k] != history[k]} == {"stateHistory"}
    assert base["multiTask"] and history["multiTask"]
    assert not base["stateLedger"] and not history["stateLedger"]
    assert arm_settings("ledger")["stateLedger"]


def test_statistics_ablation_keeps_collection_and_sample_budgets_identical():
    a, b = arm_settings("sample"), arm_settings("stats")
    assert {k for k in a if a[k] != b[k]} == {"retrievalViews"}
    assert a["nativeProfileCollection"] and b["nativeProfileCollection"]
    assert a["retrievalViews"] == ["sample", "full"]
    assert b["retrievalViews"] == ["sample_stats", "full"]


def test_repetitions_are_preserved_and_order_is_reproducible():
    jobs = make_jobs(["a", "b"], ["baseline", "history", "dsgym"], 3)
    assert len(jobs) == 18
    assert len({(j["task"], j["arm"], j["rep"]) for j in jobs}) == 18
    assert jobs == make_jobs(["a", "b"], ["baseline", "history", "dsgym"], 3)


def test_cost_retains_unknown_usage_and_prices_cache_consistently():
    assert cost_of({"input_tokens": 100, "output_tokens": None, "cached_tokens": 50}) is None
    assert cost_of({"input_tokens": 100, "output_tokens": 10, "cached_tokens": 50,
                    "cache_write_tokens": 20}) == pytest.approx((30*.2 + 50*.02 + 20*.25 + 10*1.2)/1e6)
    with pytest.raises(ValueError):
        cost_of({"input_tokens": 10, "output_tokens": 0, "cached_tokens": 11})


def test_summary_does_not_drop_failed_missing_or_unjudged_turns():
    jobs = [{"task": "a", "arm": "history", "rep": 1, "turns_total": 2},
            {"task": "b", "arm": "history", "rep": 1, "turns_total": 1}]
    rows = [{"task": "a", "arm": "history", "rep": 1, "turn_id": 1,
             "score": 1, "stats": {"cost_usd": .01}},
            {"task": "a", "arm": "history", "rep": 1, "turn_id": 2,
             "score": None, "stats": {"cost_usd": .02}}]
    s = summarize(jobs, rows)["history"]
    assert s["expected_turns"] == 3
    assert s["observed_turns"] == 2
    assert s["judged_turns"] == 1
    assert s["missing_turns"] == 1
    assert s["unjudged_turns"] == 1
    assert s["complete"] is False
    assert s["cost_usd"] == pytest.approx(.03)
    assert s["accuracy"] is None


def test_bounded_comparison_keeps_the_same_preflight_cohort():
    selection = {"sessions": [{"task": "a"}, {"task": "b"}], "development_sessions": ["dev"]}
    gates = [{"task": "a", "exit_code": 0}, {"task": "b", "exit_code": 1}]
    assert select_tasks("holdout", selection, gates) == ["a"]
    assert select_tasks("bounded", selection, gates) == ["a"]
    assert select_tasks("development", selection, gates) == ["dev"]


def test_prepare_uses_snapshot_inventory_without_exposing_gold(tmp_path, monkeypatch):
    import _paths
    from state_comparison import prepare

    task = "domain/dataset/task1"
    source = tmp_path / "upstream/task/longds" / task
    source.mkdir(parents=True)
    (source / "task.json").write_text(json.dumps([
        {"turn_id": 1, "context": "Use the original records.", "question": "Count rows.",
         "answer": "secret-answer", "code": "secret-reference"}]))
    (source / "metadata.json").write_text(json.dumps([
        {"turn": 1, "depends_tasks": [9], "state_type": ["Rollback"]}]))
    monkeypatch.setattr(_paths, "DATAMIND", tmp_path / "upstream")
    raw = tmp_path / "inputs/data"
    raw.mkdir(parents=True)
    selected = raw / "published.csv"
    selected.write_text("value\n1\n")
    (raw / "previous-output.csv").write_text("secret-output")
    snapshot = {"data_dir": str(raw), "files": [str(selected)]}
    prepared = prepare(tmp_path / "run", task, data_snapshot=snapshot)
    assert prepared["files"] == [str(selected)]
    assert prepared["data_dir"] == str(raw)
    for name in ["manifest.json", "prompts.json"]:
        text = (tmp_path / "run/prepared/domain__dataset__task1" / name).read_text()
        assert str(selected) in text
        for secret in ["previous-output", "secret-answer", "secret-reference", "depends_tasks", "Rollback"]:
            assert secret not in text


def test_executor_mounts_absolute_inputs_at_their_own_path():
    from comparison_job import executor_command
    from pathlib import Path

    relative = executor_command({"data_dir": "data/input"}, Path("/tmp/private"), 5055)
    assert relative[relative.index("--data-relative") + 1] == "data/input"
    absolute = executor_command({"data_dir": "/tmp/raw-inputs"}, Path("/tmp/private"), 5055)
    assert "--data-relative" not in absolute
    assert absolute[absolute.index("--data-root") + 1] == "/tmp/raw-inputs"
