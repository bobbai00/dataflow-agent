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

"""Spending survives interrupted sessions and is never counted twice."""
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location("analysis_report", Path(__file__).with_name("analyze-analysis-state.py"))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


def test_partial_python_spending_uses_completed_call_checkpoint(tmp_path):
    (tmp_path / "agent").mkdir()
    call = {"input_tokens": 1000, "cached_tokens": 800, "cache_write_tokens": 100,
            "output_tokens": 50, "reasoning_tokens": 20, "seconds": 2}
    (tmp_path / "agent/calls.jsonl").write_text(json.dumps(call) + "\n")
    usage, source = report.recorded_model_usage(tmp_path, [])
    assert abs(usage["cost_usd"] - 0.000121) < 1e-12
    assert usage["llm_calls"] == 1
    assert source == "agent/calls.jsonl"


def test_complete_records_and_checkpoint_are_not_added_together(tmp_path):
    (tmp_path / "agent").mkdir()
    (tmp_path / "agent/calls.jsonl").write_text(json.dumps({"input_tokens": 1000, "output_tokens": 50}) + "\n")
    usage, _ = report.recorded_model_usage(tmp_path, [{"stats": {"llm_calls": 1, "cost_usd": 0.00026}}])
    assert usage["llm_calls"] == 1
    assert abs(usage["cost_usd"] - 0.00026) < 1e-12


def test_partial_native_spending_survives_missing_final_summary(tmp_path):
    (tmp_path / "turns").mkdir()
    (tmp_path / "turns/answers.json").write_text(json.dumps([{"stats": {"llm_calls": 3, "cost_usd": 0.004}}]))
    usage, source = report.recorded_model_usage(tmp_path, [])
    assert usage["cost_usd"] == 0.004
    assert usage["llm_calls"] == 3
    assert source == "turns/answers.json"


def test_interrupted_native_trace_replaces_overlapping_turn_totals(tmp_path):
    step = {"id": "one", "role": "agent", "usage": {"inputTokens": 1000, "outputTokens": 50}}
    (tmp_path / "interrupted-react-steps.json").write_text(json.dumps({"steps": [step, step]}))
    usage, source = report.recorded_model_usage(tmp_path, [{"stats": {"llm_calls": 2, "cost_usd": 0.00052}}])
    assert usage["llm_calls"] == 1
    assert abs(usage["cost_usd"] - 0.00026) < 1e-12
    assert source == "interrupted-react-steps.json"


def test_budget_scoring_does_not_claim_unreached_turns_were_attempted(tmp_path):
    directory = tmp_path / "LongDS_test_react-analysis_luna_t1" / "task"
    directory.mkdir(parents=True)
    (directory / "protocol.json").write_text(json.dumps({"arm": "react-analysis", "turns": 3}))
    (directory / "summary.json").write_text(json.dumps({"turns_completed": 3, "turns_attempted": 1}))
    (directory / "session-budget.json").write_text(json.dumps({"expired": True, "attempted": 1}))
    (directory / "results_eval.json").write_text(json.dumps([
        {"judge": {"score": 1}}, {"judge": {"score": 0}}, {"judge": {"score": 0}}
    ]))
    row = report.summarize(directory)
    assert row["complete"]
    assert row["expected"] == row["judged"] == 3
    assert row["attempted"] == 1
    assert row["budget_stopped"]


def test_unfinished_run_does_not_invent_attempt_count(tmp_path):
    directory = tmp_path / "LongDS_test_dsgym_luna_t1" / "task"
    directory.mkdir(parents=True)
    (directory / "protocol.json").write_text(json.dumps({"arm": "dsgym", "turns": 3}))
    assert report.summarize(directory)["attempted"] is None


def test_missing_sessions_keep_planned_denominator_without_inventing_failures(tmp_path, monkeypatch):
    directory = tmp_path / "benchmark/longds/system_scratch/LongDS_test_dsgym_luna_t2/first"
    directory.mkdir(parents=True)
    (directory / "protocol.json").write_text(json.dumps({"arm": "dsgym", "turns": 1}))
    (directory / "summary.json").write_text(json.dumps({"turns_completed": 1}))
    (directory / "results_eval.json").write_text(json.dumps([{"judge": {"score": 1}}]))
    selection = tmp_path / "selection.json"
    selection.write_text(json.dumps({"selected_tasks": ["first", "missing"], "inventory": [
        {"task": "first", "turns": 1}, {"task": "missing", "turns": 3}
    ]}))
    out = tmp_path / "report"
    monkeypatch.setattr(report, "ROOT", tmp_path)
    monkeypatch.setattr("sys.argv", ["report", "--prefix", "LongDS_test", "--selection", str(selection), "--out", str(out)])
    report.main()
    group = json.loads(out.with_suffix(".json").read_text())["aggregates"][0]
    assert group["planned_turns"] == 4
    assert group["turns"] == group["judged"] == group["correct"] == 1
    assert group["missing_tasks"] == ["missing"]
    assert not group["complete"]
    assert group["macro_accuracy"] is None
