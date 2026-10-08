#!/usr/bin/env python
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

"""The smoke arm records one real REST turn without retrying paid work."""

import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
import pytest
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from observation_format_smoke import LongDSObservationFormatLuna


def response(value):
    result = Mock()
    result.json.return_value = value
    return result


def arm():
    instance = object.__new__(LongDSObservationFormatLuna)
    instance.verbose = False
    instance.agent = SimpleNamespace(
        agent_service_endpoint="http://local",
        agent_id="owned",
        max_turn_seconds=1200,
        cleanup=Mock(),
    )
    return instance


def trace(answer=True, content="Compute the result"):
    steps = [
        {"id": "new", "role": "user", "content": content},
        {
            "id": "a",
            "role": "agent",
            "isEnd": answer,
            "content": "42" if answer else "",
            "usage": {
                "inputTokens": 100,
                "outputTokens": 8,
                "cachedInputTokens": 90,
                "reasoningTokens": 3,
            },
        },
    ]
    return {"steps": steps}


def test_completed_turn_records_usage_once(monkeypatch):
    post = Mock(return_value=response({"answer": "42"}))
    monkeypatch.setattr(requests, "post", post)
    monkeypatch.setattr(
        requests, "get", Mock(side_effect=[response({"steps": []}), response(trace())])
    )
    instance = arm()
    result = instance._run_rest("Compute the result")
    assert result.response == "42" and result.completed
    assert result.usage["input_tokens"] == 100
    assert result.usage["cached_input_tokens"] == 90
    assert result.stats["steps"] == 1
    assert instance.agent._last_result is result
    assert post.call_count == 1


def test_disconnected_response_uses_actual_completion_without_resubmission(monkeypatch):
    post = Mock(side_effect=requests.ConnectionError("connection closed"))
    monkeypatch.setattr(requests, "post", post)
    monkeypatch.setattr(
        requests,
        "get",
        Mock(
            side_effect=[
                response({"steps": []}),
                response({"state": "AVAILABLE"}),
                response(trace()),
            ]
        ),
    )
    assert arm()._run_rest("Compute the result").response == "42"
    assert post.call_count == 1


@pytest.mark.parametrize(
    "value", [trace(False), trace(content="A different task"), {"steps": []}]
)
def test_partial_or_unrelated_trace_is_never_a_completed_answer(monkeypatch, value):
    monkeypatch.setattr(requests, "post", Mock(return_value=response({})))
    monkeypatch.setattr(
        requests, "get", Mock(side_effect=[response({"steps": []}), response(value)])
    )
    with pytest.raises(RuntimeError):
        arm()._run_rest("Compute the result")


def test_rest_uses_authoritative_usage_from_grounding_and_retries(monkeypatch):
    accounting = {
        "usageStatus": "complete",
        "requests": [{"requestId": "first"}, {"requestId": "correction"}],
    }
    payload = {
        "answer": "42",
        "usage": {
            "inputTokens": 150,
            "outputTokens": 20,
            "cachedInputTokens": 90,
            "cacheCreationInputTokens": 10,
        },
        "modelAccounting": accounting,
    }
    monkeypatch.setattr(requests, "post", Mock(return_value=response(payload)))
    monkeypatch.setattr(
        requests, "get", Mock(side_effect=[response({"steps": []}), response(trace())])
    )
    result = arm()._run_rest("Compute the result")
    assert result.usage["input_tokens"] == 150
    assert result.usage["cache_creation_input_tokens"] == 10
    assert result.model_accounting == accounting


def test_rest_completed_error_preserves_paid_usage_and_unknown_billing(monkeypatch):
    accounting = {"usageStatus": "partial", "unknownUsageRequestIds": ["failed"]}
    payload = {
        "answer": "",
        "usage": {"inputTokens": 100},
        "modelAccounting": accounting,
        "stopped": True,
        "error": "provider failed",
    }
    monkeypatch.setattr(requests, "post", Mock(return_value=response(payload)))
    monkeypatch.setattr(
        requests,
        "get",
        Mock(side_effect=[response({"steps": []}), response(trace(False))]),
    )
    result = arm()._run_rest("Compute the result")
    assert result.completed and result.stopped
    assert result.error == "provider failed"
    assert result.usage["input_tokens"] == 100
    assert result.model_accounting == accounting
