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
"""Reject provider-filtered output before stock CodeAgent can execute partial code."""

from copy import deepcopy
import json
import multiprocessing
import sys
from types import SimpleNamespace

from openai.types.chat import ChatCompletion
import pytest
from smolagents import CodeAgent, OpenAIModel
from smolagents.agents import CODEAGENT_RESPONSE_FORMAT
from smolagents.memory import ActionStep
from smolagents.monitoring import Timing
from smolagents.utils import AgentGenerationError

from benchmark.runtime import structured_output_transport as transport


CAPABILITIES = {"structured_output_transport": "auto_tool", "forced_tool_choice": False}


def bridge():
    _, result = transport.prepare_completion_request(
        {"model": "claude-sonnet-5.5", "response_format": deepcopy(CODEAGENT_RESPONSE_FORMAT)}, CAPABILITIES
    )
    return result


def response(*, finish_reason="tool_calls", calls=1, refusal=None, choices=1, arguments=None, content=None):
    arguments = arguments or json.dumps({"thought": "Read the count.", "code": "d"})
    return ChatCompletion.model_validate({
        "id": "offline-captured-shape", "object": "chat.completion", "created": 1, "model": "claude-sonnet-5.5",
        "choices": [{"index": n, "finish_reason": finish_reason, "message": {
            "role": "assistant", "content": content, "refusal": refusal,
            "tool_calls": [{"id": "tool-captured", "type": "function", "function": {
                "name": "ThoughtAndCodeAnswer", "arguments": arguments
            }} for _ in range(calls)]
        }} for n in range(choices)],
        "usage": {"prompt_tokens": 4399, "completion_tokens": 96 if calls else 0, "total_tokens": 4495 if calls else 4399,
                  "cache_creation_input_tokens": 4395, "cache_read_input_tokens": 0}
    })


@pytest.mark.parametrize("calls", [0, 1])
@pytest.mark.parametrize("adaptation", [None, "auto_tool"])
def test_captured_content_filter_is_rejected_even_when_partial_tool_is_schema_valid(calls, adaptation):
    raw = response(finish_reason="content_filter", calls=calls)
    before = raw.model_dump()
    with pytest.raises(ValueError, match="provider_content_filter") as caught:
        transport.unwrap_structured_response(raw, bridge() if adaptation else None)
    error = caught.value
    assert isinstance(error, transport.StructuredOutputResponseError)
    assert error.metadata["reason"] == "provider_content_filter"
    assert error.metadata["finish_reason"] == "content_filter"
    assert error.metadata["tool_call_count"] == calls
    assert error.metadata["content_present"] is False
    assert error.metadata["response_model"] == "claude-sonnet-5.5"
    assert error.raw_response is raw
    assert raw.model_dump() == before
    assert error.raw_response.usage.model_dump()["cache_creation_input_tokens"] == 4395
    assert json.loads(json.dumps(error.as_dict())) == error.metadata


def test_explicit_refusal_is_rejected_before_adapting_schema_valid_tool():
    raw = response(refusal="I cannot provide this output.")
    with pytest.raises(ValueError, match="provider_refusal") as caught:
        transport.unwrap_structured_response(raw, bridge())
    assert caught.value.metadata["refusal"] == raw.choices[0].message.refusal
    assert caught.value.metadata["finish_reason"] == "tool_calls"
    assert caught.value.metadata["tool_call_count"] == 1


@pytest.mark.parametrize("adaptation", [None, "auto_tool"])
def test_missing_choices_are_classified_without_synthesizing_response(adaptation):
    raw = response(choices=0)
    with pytest.raises(ValueError, match="missing_response_choices") as caught:
        transport.unwrap_structured_response(raw, bridge() if adaptation else None)
    assert caught.value.metadata["choice_count"] == 0
    assert caught.value.metadata["finish_reason"] is None
    assert caught.value.metadata["refusal"] is None
    assert caught.value.raw_response is raw


@pytest.mark.parametrize("override,reason", [
    ({"choices": 2}, "ambiguous_response_choices"),
    ({"calls": 0}, "missing_schema_tool"),
    ({"arguments": "not JSON"}, "invalid_schema_arguments"),
])
def test_schema_errors_keep_provider_terminal_metadata(override, reason):
    raw = response(**override)
    with pytest.raises(ValueError, match=reason) as caught:
        transport.unwrap_structured_response(raw, bridge())
    assert caught.value.metadata["finish_reason"] == "tool_calls"
    assert caught.value.metadata["reason"] == reason
    assert caught.value.metadata["choice_count"] == len(raw.choices)


def test_content_json_without_original_schema_tool_remains_rejected():
    raw = response(finish_reason="stop", calls=0, content=json.dumps({"thought": "Compute.", "code": "final_answer(7)"}))
    with pytest.raises(ValueError, match="missing_schema_tool"):
        transport.unwrap_structured_response(raw, bridge())


def test_ordinary_valid_response_keeps_stock_contract_and_preserves_raw_usage():
    raw = response(arguments=json.dumps({"thought": "Compute.", "code": "final_answer(7)"}))
    adapted = transport.unwrap_structured_response(raw, bridge())
    assert json.loads(adapted.choices[0].message.content)["code"] == "final_answer(7)"
    assert adapted.usage == raw.usage
    assert raw.choices[0].message.tool_calls is not None
    assert transport.unwrap_structured_response(raw, None) is raw


def test_stock_codeagent_never_executes_filtered_schema_valid_partial_code(monkeypatch):
    raw = response(finish_reason="content_filter", calls=1)
    model = OpenAIModel(model_id="claude-sonnet-5.5", api_key="offline")
    monkeypatch.setattr(model.client.chat.completions, "create", lambda **kwargs: raw)
    transport.install_structured_output_transport(model, CAPABILITIES)
    agent = CodeAgent(tools=[], model=model, use_structured_outputs_internally=True, verbosity_level=0)
    executed = []
    monkeypatch.setattr(agent, "python_executor", lambda code: executed.append(code))
    try:
        with pytest.raises(AgentGenerationError, match="provider_content_filter") as caught:
            list(agent._step_stream(ActionStep(step_number=1, timing=Timing(start_time=1))))
        assert isinstance(caught.value.__cause__, transport.StructuredOutputResponseError)
        assert executed == []
        assert raw.choices[0].message.tool_calls[0].function.arguments.endswith('"d"}')
    finally:
        model.client.close()


@pytest.mark.skipif(sys.platform != "linux", reason="The standalone worker fixture uses fork isolation")
def test_ds_worker_journals_provider_error_after_raw_response_and_preserves_paid_usage(tmp_path, monkeypatch):
    import smolagents

    raw = response(finish_reason="content_filter", calls=0)
    closed = []

    class Model:
        def __init__(self, **kwargs):
            self.usage_acc = {}
            self.client = SimpleNamespace(
                chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kwargs: raw)),
                close=lambda: closed.append("model"),
            )

    class Agent:
        def __init__(self, *, model, instructions, **kwargs):
            self.model = model
            self.system_prompt = instructions
            self.memory = SimpleNamespace(steps=[], get_full_steps=lambda: [])

        def run(self, prompt):
            return self.model.client.chat.completions.create(
                model="claude-sonnet-5.5",
                messages=[{"role": "user", "content": prompt}],
                response_format=deepcopy(CODEAGENT_RESPONSE_FORMAT),
            )

    monkeypatch.setitem(sys.modules, "code_agent", SimpleNamespace(
        AUTHORIZED_IMPORTS=[], UsageTrackingOpenAIModel=Model, extract_reasoning_trace=lambda agent: []
    ))
    monkeypatch.setattr(smolagents, "CodeAgent", Agent)
    monkeypatch.setenv("CODE_AGENT_API_KEY", "offline-test-only")
    config = {
        "model": "claude-sonnet-5.5", "script_endpoint": "https://offline.invalid",
        "reasoning_effort": None, "model_parameters": {}, "max_output_tokens": 8192,
        "task_id": "fixture", "output_dir": str(tmp_path), "prompt": "Read the supplied table.",
        "model_capabilities": CAPABILITIES, "task_timeout_seconds": 5,
        "shared_principles": "## Analysis principles\nCompute directly.",
        "settings": {"max_steps": 1, "max_print_outputs_length": 100, "use_structured_outputs_internally": True},
    }
    path = tmp_path / "config.json"
    path.write_text(json.dumps(config))
    def invoke_worker():
        from benchmark.dsbench import smol_job

        monkeypatch.setattr(smol_job, "isolated_executor", lambda *args: SimpleNamespace(
            proc=SimpleNamespace(poll=lambda: 0), close=lambda: closed.append("executor")
        ))
        smol_job.main(path)
        assert closed == ["executor", "model"]

    # This entry point adjusts import paths and signal handlers. Match its
    # process boundary while the SDK and executor remain fully mocked.
    worker = multiprocessing.get_context("fork").Process(target=invoke_worker)
    worker.start()
    worker.join(10)
    if worker.is_alive():
        worker.kill()
        worker.join()
        pytest.fail("Offline worker fixture exceeded its deadline")
    assert worker.exitcode == 0
    events = list(map(json.loads, (tmp_path / "model-request-trace.jsonl").read_text().splitlines()))
    assert [event["phase"] for event in events] == ["request", "response", "structured_output_error"]
    assert events[1]["choices"] == [choice.model_dump() for choice in raw.choices]
    metadata = events[2]["provider_response_error"]
    assert metadata["reason"] == "provider_content_filter"
    assert metadata["finish_reason"] == "content_filter"
    stats = json.loads((tmp_path / "stats.json").read_text())
    assert stats["model_calls_attempted"] == stats["model_calls_succeeded"] == 1
    assert stats["failed_model_calls"] == 0
    assert stats["input_tokens"] == 4399 and stats["cache_creation_tokens"] == 4395
    status = json.loads((tmp_path / "status.json").read_text())
    assert status["completed"] is False
    assert status["provider_blocked"] is False  # Access capability is separate from moderation.
    assert "provider_content_filter" in status["error"]
