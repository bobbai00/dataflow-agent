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
from pathlib import Path
import pytest

from bounded_pilot_report import strict_answer, job_diagnostics


def test_strict_json_contract_rejects_nonfinite_and_nonobject_answers():
    assert strict_answer('{"x": 1}') == ({"x": 1}, True)
    for text in ['{"x": NaN}', '{"x": Infinity}', 'Answer: {"x": 1}', "[1, 2]"]:
        assert strict_answer(text)[1] is False


def wire_fixture(tmp_path, response):
    folder = tmp_path / "test/runs/dsgym-r1/domain__dataset__task1/agent"
    (folder / "wire").mkdir(parents=True)
    (folder / "calls.jsonl").write_text(json.dumps({"turn_index": 0, "summary": True}) + "\n")
    (folder / "wire/000001-request.json").write_text(json.dumps({"messages": [{"role": "system", "content": "rules"}]}))
    if response is not None:
        (folder / "wire/000001-response.json").write_text(json.dumps(response))
    return {"task": "domain/dataset/task1", "arm": "dsgym", "rep": 1}, {
        "rates_usd_per_million": {"input": 0.2, "cached": 0.02, "output": 1.2},
        "context_budget": 32000,
        "full_input_policy": {"scale": 1},
    }


def test_summary_calls_are_charged_at_the_same_cache_sensitive_rates(tmp_path):
    job, protocol = wire_fixture(
        tmp_path,
        {"usage": {"prompt_tokens": 50, "completion_tokens": 5, "prompt_tokens_details": {"cached_tokens": 10}}},
    )
    result = job_diagnostics(tmp_path, "test", job, protocol)
    assert result["mechanical"]["summary_calls"] == 1
    assert result["wire"]["known_usage_cost_usd"] == pytest.approx(14.2 / 1e6)
    assert result["per_turn_wire"][1]["provider_calls"] == 1
    assert result["input_audit"]["unknown_usage"] == 0


def test_missing_provider_response_keeps_usage_unknown(tmp_path):
    job, protocol = wire_fixture(tmp_path, None)
    result = job_diagnostics(tmp_path, "test", job, protocol)
    assert result["wire"]["unknown_usage_calls"] == 1
    assert result["per_turn_wire"][1]["unknown_usage_calls"] == 1
    assert result["input_audit"]["unknown_usage"] == 1


def test_missing_turn_identity_never_silently_undercounts_paired_cost(tmp_path):
    job, protocol = wire_fixture(tmp_path, {"usage": {"prompt_tokens": 50, "completion_tokens": 5}})
    (tmp_path / "test/runs/dsgym-r1/domain__dataset__task1/agent/calls.jsonl").write_text("")
    with pytest.raises(ValueError, match="turn identity"):
        job_diagnostics(tmp_path, "test", job, protocol)


def test_missing_request_capture_never_turns_recorded_work_into_zero_cost(tmp_path):
    job, protocol = wire_fixture(tmp_path, {"usage": {"prompt_tokens": 50, "completion_tokens": 5}})
    (tmp_path / "test/runs/dsgym-r1/domain__dataset__task1/agent/wire/000001-request.json").unlink()
    with pytest.raises(ValueError, match="request capture"):
        job_diagnostics(tmp_path, "test", job, protocol)
