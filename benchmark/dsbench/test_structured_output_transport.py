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
"""Structured CodeAgent outputs work on transports that forbid forced tools."""

from copy import deepcopy
import json

from openai.types.chat import ChatCompletion
import pytest
from smolagents import CodeAgent, OpenAIModel
from smolagents.agents import CODEAGENT_RESPONSE_FORMAT

from benchmark.dsbench.structured_output_transport import prepare_completion_request, unwrap_structured_response

CAPABILITIES = {"forced_tool_choice": False, "structured_output_transport": "auto_tool"}


def response(*, arguments=None, name="ThoughtAndCodeAnswer", calls=1, content=None):
    arguments = arguments if arguments is not None else json.dumps({"thought": "Compute.", "code": "final_answer(7)"})
    return ChatCompletion.model_validate(
        {
            "id": "offline-response",
            "object": "chat.completion",
            "created": 1,
            "model": "claude-sonnet-5.5",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "content": content,
                        "tool_calls": [
                            {"id": f"tool-{n}", "type": "function", "function": {"name": name, "arguments": arguments}}
                            for n in range(calls)
                        ],
                    },
                }
            ],
            "usage": {"prompt_tokens": 123, "completion_tokens": 12, "total_tokens": 135},
        }
    )


def request():
    return {
        "model": "claude-sonnet-5.5",
        "messages": [{"role": "user", "content": "Original question"}],
        "response_format": deepcopy(CODEAGENT_RESPONSE_FORMAT),
        "max_completion_tokens": 8192,
        "stop": ["Observation:", "Calling tools:", "</code>"],
    }


def test_auto_transport_preserves_original_schema_prompt_and_generation_settings():
    original = request()
    actual, bridge = prepare_completion_request(original, CAPABILITIES)
    assert original == request()
    assert "response_format" not in actual
    assert actual["tool_choice"] == "auto"
    assert actual["parallel_tool_calls"] is False
    function = deepcopy(CODEAGENT_RESPONSE_FORMAT["json_schema"])
    function["parameters"] = function.pop("schema")
    assert actual["tools"] == [{"type": "function", "function": function}]
    assert actual["tools"][0]["function"]["parameters"] == original["response_format"]["json_schema"]["schema"]
    assert {k: actual[k] for k in original if k != "response_format"} == {
        k: original[k] for k in original if k != "response_format"
    }
    assert bridge["response_format"] == original["response_format"]


def test_other_models_keep_the_original_response_format():
    original = request()
    for capabilities in ({}, {"structured_output_transport": "response_format"}):
        actual, bridge = prepare_completion_request(original, capabilities)
        assert actual == original
        assert bridge is None


def test_response_unwrap_preserves_raw_sdk_response_and_billing_fields():
    _, bridge = prepare_completion_request(request(), CAPABILITIES)
    raw = response()
    before = raw.model_dump()
    adapted = unwrap_structured_response(raw, bridge)
    assert raw.model_dump() == before
    assert json.loads(adapted.choices[0].message.content) == {"thought": "Compute.", "code": "final_answer(7)"}
    assert adapted.choices[0].message.tool_calls is None
    assert adapted.usage == raw.usage and adapted.model == raw.model


@pytest.mark.parametrize(
    "override",
    [
        {"calls": 0},
        {"calls": 2},
        {"name": "unexpected"},
        {"arguments": "not JSON"},
        {"arguments": '{"thought":"Only thought"}'},
        {"arguments": '{"thought":"Compute.","code":7}'},
        {"arguments": '{"thought":"Compute.","code":"final_answer(7)","extra":true}'},
    ],
)
def test_missing_ambiguous_or_invalid_structured_tool_output_is_rejected(override):
    _, bridge = prepare_completion_request(request(), CAPABILITIES)
    with pytest.raises(ValueError, match="structured output"):
        unwrap_structured_response(response(**override), bridge)


def test_stock_codeagent_executes_original_structured_code_from_auto_tool(monkeypatch):
    model = OpenAIModel(model_id="claude-sonnet-5.5", api_key="offline", max_completion_tokens=8192)
    seen = []

    def create(**kwargs):
        actual, bridge = prepare_completion_request(kwargs, CAPABILITIES)
        seen.append(actual)
        return unwrap_structured_response(response(), bridge)

    monkeypatch.setattr(model.client.chat.completions, "create", create)
    agent = CodeAgent(tools=[], model=model, use_structured_outputs_internally=True, verbosity_level=0)
    try:
        assert agent.run("Compute seven.") == 7
        assert len(seen) == 1
        assert seen[0]["tool_choice"] == "auto"
        assert "response_format" not in seen[0]
    finally:
        model.client.close()
