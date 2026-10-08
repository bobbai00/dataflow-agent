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
"""Official evaluations retain original parsers and grading availability."""
import json
import os
from pathlib import Path
import subprocess

import pytest

from benchmark import matrix_judge
from benchmark.experiment_matrix import official_score


def test_choice_diagnostic_does_not_guess_implicit_numeric_option():
    assert matrix_judge.diagnostic_ds("B", "b. 650")["correct"] is True
    assert matrix_judge.diagnostic_ds("B", "650")["correct"] is None
    assert matrix_judge.diagnostic_ds(0, "0")["correct"] is True


def test_unavailable_official_judge_is_unscored_not_incorrect(tmp_path, monkeypatch):
    prepared = tmp_path / "prepared"
    (prepared / "evaluation").mkdir(parents=True)
    (prepared / "evaluation/gold.json").write_text(json.dumps([{"task_id": "task", "question": "Q?", "answer": "B"}]))
    job = {"attempt_id": "attempt", "benchmark": "dsbench", "task_id": "task", "arm": "bob_data"}
    (tmp_path / "manifest.json").write_text(json.dumps({"jobs": [job], "ds_prepared_root": str(prepared)}))
    directory = tmp_path / "attempts/attempt"
    directory.mkdir(parents=True)
    (directory / "status.json").write_text('{"completed":true}')
    (directory / "response.txt").write_text("b. 650")

    def unavailable(*args, **kwargs):
        raise RuntimeError("Exact official snapshot unavailable")

    monkeypatch.setattr(matrix_judge, "judge_prediction", unavailable)
    matrix_judge.judge_matrix(tmp_path, cache_dir=tmp_path / "cache")
    evaluation = json.loads((directory / "evaluation.json").read_text())
    assert evaluation["official_correct"] is None
    assert evaluation["incremental_model_calls"] == 0
    assert json.loads((directory / "diagnostic-evaluation.json").read_text())["correct"] is True


@pytest.mark.parametrize("cache_hit", [False, True])
@pytest.mark.parametrize("original_verdict", [False, True])
def test_mismatched_judge_model_is_unscored_and_preserves_verdict(tmp_path, monkeypatch, cache_hit, original_verdict):
    prepared = tmp_path / "prepared"
    (prepared / "evaluation").mkdir(parents=True)
    (prepared / "evaluation/gold.json").write_text(json.dumps([{"task_id": "task", "question": "Q?", "answer": "B"}]))
    job = {"attempt_id": "attempt", "benchmark": "dsbench", "task_id": "task", "arm": "bob_data"}
    (tmp_path / "manifest.json").write_text(json.dumps({"jobs": [job], "ds_prepared_root": str(prepared)}))
    directory = tmp_path / "attempts/attempt"
    directory.mkdir(parents=True)
    (directory / "status.json").write_text('{"completed":true}')
    (directory / "response.txt").write_text("b. 650")
    response = {"model": "gpt-4o", "choices": [{"message": {"content": str(original_verdict)}}]}
    record = {
        "official_correct": original_verdict,
        "judgment": str(original_verdict),
        "model_mismatch": True,
        "response_model": "gpt-4o",
        "response": response,
        "cache_hit": cache_hit,
        "incremental_model_calls": 0 if cache_hit else 1,
        "incremental_cost_usd": 0 if cache_hit else 0.01,
        "original_estimated_cost_usd": 0.01,
    }
    monkeypatch.setattr(matrix_judge, "judge_prediction", lambda *args, **kwargs: record)

    matrix_judge.judge_matrix(tmp_path, cache_dir=tmp_path / "cache")

    evaluation = json.loads((directory / "evaluation.json").read_text())
    assert evaluation["official_correct"] is None
    assert evaluation["state"] == "invalid_judge_model"
    assert evaluation["original_official_verdict"] is original_verdict
    assert evaluation["judgment"] == str(original_verdict)
    assert evaluation["response"] == response
    assert evaluation["cache_hit"] is cache_hit
    assert evaluation["incremental_model_calls"] == record["incremental_model_calls"]
    assert evaluation["incremental_cost_usd"] == record["incremental_cost_usd"]
    assert evaluation["original_estimated_cost_usd"] == 0.01
    assert official_score(evaluation) is None
    # Preserve the upstream/cache record; only this campaign adapter invalidates it.
    assert record["official_correct"] is original_verdict


def test_recorded_kb_original_numeric_evaluator_preserves_raw_response(tmp_path):
    root = Path(__file__).resolve().parents[1]
    raw = "Final Answer: 13.1628"
    (tmp_path / "response.txt").write_text(raw)
    (tmp_path / "status.json").write_text('{"completed":true}')
    result = subprocess.run(
        [
            str(root / "benchmark/Kramabench/.venv/bin/python"),
            str(root / "benchmark/retrieval/score_recorded_task.py"),
            "--attempt",
            str(tmp_path),
            "--task-id",
            "legal-easy-3",
            "--system",
            "native",
        ],
        cwd=root,
        env={**os.environ, "OPENAI_API_KEY": "offline-test-placeholder"},
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    evaluation = json.loads((tmp_path / "evaluation.json").read_text())
    assert evaluation["rae_score"] == 1
    assert evaluation["token_usage_metrics"] == 0
    assert evaluation["provenance"]["answer_parser"] == "parse_answer"
    assert (tmp_path / "response.txt").read_text() == raw
