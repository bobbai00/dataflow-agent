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
"""Bind official labels to predictions and retain the cost of cached waves."""

from copy import deepcopy
import json

import pytest

from benchmark.dsbench import judge, report


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


def write_grades(path, rows):
    path.write_text("".join(json.dumps(row) + "\n" for row in rows))


@pytest.fixture
def campaign(tmp_path):
    prepared, output, cache = tmp_path / "prepared", tmp_path / "runs", tmp_path / "cache"
    task_id = "00000001-question1"
    write_json(
        prepared / "manifest.json",
        {"tasks": [{"task_id": task_id}], "selection": {"pilot": True}, "provenance": {"pinned": True}},
    )
    write_json(
        prepared / "evaluation/gold.json",
        {"tasks": [{"task_id": task_id, "question": "Choose a letter.\n", "answer": "A"}]},
    )
    for arm in report.ARMS:
        directory = output / "system_scratch" / arm / task_id
        write_json(directory / "config.json", {"model": "gpt-5.6-luna"})
        write_json(directory / "status.json", {"completed": True})
        write_json(
            directory / "stats.json",
            {
                "cost_usd": 0.01,
                "pricing": {"model": "gpt-5.6-luna"},
                "model_calls_succeeded": 1,
                "input_tokens": 100,
                "cached_tokens": 20,
                "output_tokens": 10,
                "reasoning_tokens": 3,
                "elapsed_seconds": 2,
            },
        )
        (directory / "response.txt").write_bytes(b"A\n")
    request = judge.official_request("Choose a letter.\n", "A", "A\n")
    key = judge.cache_key(request)
    record = {
        "cache_key": key,
        "request": request,
        "source_revision": judge.SOURCE_REVISION,
        "model": judge.JUDGE_MODEL,
        "response_model": judge.JUDGE_MODEL,
        "judgment": "True",
        "official_correct": True,
        "error": None,
        "incremental_model_calls": 1,
        "original_estimated_cost_usd": 0.00515,
        "input_tokens": 1000,
        "output_tokens": 10,
        "pricing": judge.PRICING,
    }
    write_json(cache / f"{key}.json", record)
    # A final cached wave has zero incremental charges in every grade row.
    rows = [
        {
            **deepcopy(record),
            "task_id": task_id,
            "arm": arm,
            "cache_hit": True,
            "incremental_model_calls": 0,
            "incremental_cost_usd": 0,
        }
        for arm in report.ARMS
    ]
    grades = tmp_path / "grades.jsonl"
    write_grades(grades, rows)
    return {
        "prepared": prepared,
        "output": output,
        "cache": cache,
        "grades": grades,
        "task_id": task_id,
        "key": key,
        "record": record,
        "rows": rows,
    }


def aggregate(campaign):
    return report.summarize(campaign["prepared"], campaign["output"], campaign["grades"], campaign["cache"])


def test_identical_judgments_across_arms_and_cached_waves_count_the_original_charge_once(campaign):
    result = aggregate(campaign)
    assert result["attempt_count"] == 5
    assert result["judging"]["unique_requests"] == 1
    assert result["judging"]["model_calls"] == 1
    assert result["judging"]["identical_prediction_reuses"] == 4
    assert result["judging"]["cost_usd"] == pytest.approx(0.00515)
    assert result["agent_cost_usd"] == pytest.approx(0.05)
    assert result["total_cost_usd"] == pytest.approx(0.05515)


def test_current_prediction_and_gold_must_match_the_grade_request(campaign):
    request = judge.official_request("Choose a letter.\n", "A", "B\n")
    wrong_key = judge.cache_key(request)
    wrong_record = {**campaign["record"], "request": request, "cache_key": wrong_key}
    write_json(campaign["cache"] / f"{wrong_key}.json", wrong_record)
    campaign["rows"][0].update(request=request, cache_key=wrong_key)
    write_grades(campaign["grades"], campaign["rows"])
    with pytest.raises(ValueError, match="request|prediction"):
        aggregate(campaign)


def test_cache_record_must_match_its_key_and_current_prediction(campaign):
    record = deepcopy(campaign["record"])
    record["request"] = judge.official_request("Choose a letter.\n", "B", "A\n")
    write_json(campaign["cache"] / f"{campaign['key']}.json", record)
    with pytest.raises(ValueError, match="request|prediction"):
        aggregate(campaign)


@pytest.mark.parametrize("field,value", [("official_correct", False), ("error", {"type": "SyntheticFailure"})])
def test_grade_verdict_and_error_must_match_the_official_cache(campaign, field, value):
    campaign["rows"][0][field] = value
    write_grades(campaign["grades"], campaign["rows"])
    with pytest.raises(ValueError, match="verdict|error|judgment"):
        aggregate(campaign)


def test_official_verdict_must_follow_the_frozen_substring_rule(campaign):
    record = {**campaign["record"], "judgment": "not true", "official_correct": False}
    write_json(campaign["cache"] / f"{campaign['key']}.json", record)
    for row in campaign["rows"]:
        row.update(judgment="not true", official_correct=False)
    write_grades(campaign["grades"], campaign["rows"])
    with pytest.raises(ValueError, match="verdict|judgment"):
        aggregate(campaign)


def test_consistent_false_grade_cannot_remove_a_cached_judge_error(campaign):
    record = {
        **campaign["record"],
        "judgment": "False",
        "official_correct": False,
        "error": {"type": "IndexError", "status_code": None},
    }
    write_json(campaign["cache"] / f"{campaign['key']}.json", record)
    for row in campaign["rows"]:
        row.update(judgment="False", official_correct=False, error=None)
    write_grades(campaign["grades"], campaign["rows"])
    with pytest.raises(ValueError, match="error differs from its cache record"):
        aggregate(campaign)


def test_pending_cache_files_do_not_duplicate_or_replace_completed_records(campaign):
    write_json(campaign["cache"] / f"{campaign['key']}.pending.json", {"cache_key": campaign["key"]})
    write_json(campaign["cache"] / "unrelated.pending.json", {"unfinished": True})
    result = aggregate(campaign)
    assert result["judging"]["unique_requests"] == 1
    assert result["judging"]["cost_usd"] == pytest.approx(0.00515)


@pytest.mark.parametrize("change", ["missing", "duplicate", "unknown"])
def test_final_report_requires_each_declared_identity_once(campaign, change):
    rows = campaign["rows"]
    if change == "missing":
        rows.pop()
    elif change == "duplicate":
        rows[-1] = deepcopy(rows[0])
    else:
        rows[-1]["task_id"] = "00000099-question99"
    write_grades(campaign["grades"], rows)
    with pytest.raises(ValueError, match="each declared task and arm exactly once"):
        aggregate(campaign)


def test_unknown_agent_cost_cannot_be_reported_as_zero(campaign):
    path = campaign["output"] / "system_scratch" / report.ARMS[0] / campaign["task_id"] / "stats.json"
    stats = json.loads(path.read_text())
    stats["cost_usd"] = None
    write_json(path, stats)
    with pytest.raises(ValueError, match="Incomplete agent usage"):
        aggregate(campaign)


def test_unknown_judge_cost_cannot_be_reported_as_zero(campaign):
    record = {**campaign["record"], "original_estimated_cost_usd": None}
    write_json(campaign["cache"] / f"{campaign['key']}.json", record)
    with pytest.raises(ValueError, match="judge.*cost|judge.*usage"):
        aggregate(campaign)


def test_judge_inputs_retain_carriage_returns_in_raw_predictions(campaign):
    path = campaign["output"] / "system_scratch" / report.ARMS[0] / campaign["task_id"] / "response.txt"
    path.write_bytes(b"A\r\n")
    rows = report.judge_inputs(campaign["prepared"], campaign["output"])
    assert rows[0]["prediction"] == "A\r\n"


def change_model(campaign, arm, model, *, change_config=True, change_pricing=True):
    directory = campaign["output"] / "system_scratch" / arm / campaign["task_id"]
    if change_config:
        write_json(directory / "config.json", {"model": model})
    if change_pricing:
        path = directory / "stats.json"
        stats = json.loads(path.read_text())
        stats["pricing"]["model"] = model
        write_json(path, stats)


def test_report_records_homogeneous_terra_model_without_changing_official_judge(campaign):
    for arm in report.ARMS:
        change_model(campaign, arm, "gpt-5.6-terra")
    result = aggregate(campaign)
    assert result["agent_model"] == "gpt-5.6-terra"
    assert all(arm["model"] == "gpt-5.6-terra" for arm in result["arms"])
    assert all(attempt["model"] == "gpt-5.6-terra" for attempt in result["attempts"])
    assert result["judging"]["model"] == judge.JUDGE_MODEL


def test_report_rejects_mixed_models_even_when_each_attempt_pricing_matches(campaign):
    change_model(campaign, report.ARMS[0], "gpt-5.6-terra")
    with pytest.raises(ValueError, match="model"):
        aggregate(campaign)


def test_report_rejects_pricing_from_a_different_model(campaign):
    change_model(campaign, report.ARMS[0], "gpt-5.6-terra", change_config=False)
    with pytest.raises(ValueError, match="pricing.*model|model.*pricing"):
        aggregate(campaign)


@pytest.mark.parametrize("model", [None, "", 17, []])
def test_report_requires_nonempty_string_model_metadata(campaign, model):
    change_model(campaign, report.ARMS[0], model)
    with pytest.raises(ValueError, match="model"):
        aggregate(campaign)
