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
"""Capability-driven structured-output transport for stock CodeAgent.

Some gateways implement response_format by forcing a synthetic tool, which
models supporting only automatic tool choice reject. The explicit auto_tool
capability transports the same schema as a single tool and restores its JSON
arguments to the content shape CodeAgent expects. Original prompts, schema,
generation settings and raw provider responses remain untouched.
"""

from copy import deepcopy
import json

from jsonschema import ValidationError, validate


class StructuredOutputResponseError(ValueError):
    """A rejected provider response retains its terminal metadata and billing."""

    def __init__(self, reason, response, *, validation_message=None):
        choices = getattr(response, "choices", None) or []
        summaries = []
        for choice in choices:
            message = getattr(choice, "message", None)
            summaries.append(
                {
                    "finish_reason": getattr(choice, "finish_reason", None),
                    "refusal": getattr(message, "refusal", None),
                    "tool_call_count": len(getattr(message, "tool_calls", None) or []),
                    "content_present": bool(getattr(message, "content", None)),
                }
            )
        first = summaries[0] if summaries else {}
        self.metadata = {
            "reason": reason,
            "response_id": getattr(response, "id", None),
            "response_model": getattr(response, "model", None),
            "choice_count": len(choices),
            "finish_reason": first.get("finish_reason"),
            "refusal": first.get("refusal"),
            "tool_call_count": first.get("tool_call_count", 0),
            "content_present": first.get("content_present", False),
            "choices": summaries,
        }
        if validation_message is not None:
            self.metadata["validation_message"] = validation_message
        self.raw_response = response
        super().__init__(
            "Invalid structured output: "
            + json.dumps(self.metadata, sort_keys=True, ensure_ascii=False)
        )

    def as_dict(self):
        return deepcopy(self.metadata)


def prepare_completion_request(request, capabilities):
    transport = (capabilities or {}).get("structured_output_transport", "response_format")
    if transport not in {"response_format", "auto_tool"}:
        raise ValueError(f"Unknown structured output transport: {transport}")
    if transport == "response_format" or request.get("response_format") is None:
        return request, None
    if request.get("tools"):
        raise ValueError("Auto-tool structured output cannot replace existing tools")
    response_format = request["response_format"]
    if response_format.get("type") != "json_schema":
        raise ValueError("Auto-tool structured output requires the original JSON schema")
    function = deepcopy(response_format["json_schema"])
    function["parameters"] = function.pop("schema")
    if not function.get("name"):
        raise ValueError("Auto-tool structured output requires a named schema")
    actual = {key: value for key, value in request.items() if key != "response_format"}
    actual.update(
        tools=[{"type": "function", "function": function}],
        tool_choice="auto",
        parallel_tool_calls=False,
    )
    bridge = {"version": 1, "transport": transport, "response_format": deepcopy(response_format)}
    return actual, bridge


def unwrap_structured_response(response, bridge):
    choices = getattr(response, "choices", None) or []
    if not choices:
        raise StructuredOutputResponseError("missing_response_choices", response)
    # A filtered tool's arguments can still pass JSON schema validation while
    # containing truncated, executable code. Check the provider terminal state
    # before stock CodeAgent receives any adapted content.
    if any(choice.finish_reason == "content_filter" for choice in choices):
        raise StructuredOutputResponseError("provider_content_filter", response)
    if any(getattr(choice.message, "refusal", None) for choice in choices):
        raise StructuredOutputResponseError("provider_refusal", response)
    if bridge is None:
        return response
    schema = bridge["response_format"]["json_schema"]
    if len(choices) != 1:
        raise StructuredOutputResponseError("ambiguous_response_choices", response)
    message = choices[0].message
    calls = message.tool_calls or []
    if len(calls) != 1 or calls[0].type != "function" or calls[0].function.name != schema["name"]:
        raise StructuredOutputResponseError("missing_schema_tool", response)
    arguments = calls[0].function.arguments
    try:
        parsed = json.loads(arguments)
        validate(instance=parsed, schema=schema["schema"])
    except (TypeError, json.JSONDecodeError, ValidationError) as error:
        raise StructuredOutputResponseError(
            "invalid_schema_arguments", response, validation_message=getattr(error, "message", str(error))
        ) from error
    adapted = response.model_copy(deep=True)
    adapted.choices[0].message.content = arguments
    adapted.choices[0].message.tool_calls = None
    # This private reference lets model wrappers retain the actual provider
    # response in memory while stock CodeAgent consumes the adapted content.
    object.__setattr__(adapted, "_structured_output_raw_response", response)
    return adapted


def install_structured_output_transport(model, capabilities):
    """Adapt one SDK client; capability defaults keep its requests unchanged.

    Observers needing an actual wire journal should call the two pure helpers
    around their own recording wrapper instead, recording the response first.
    """
    prepare_completion_request({}, capabilities)
    create = model.client.chat.completions.create

    def adapted_create(*args, **kwargs):
        actual, bridge = prepare_completion_request(kwargs, capabilities)
        response = create(*args, **actual)
        return unwrap_structured_response(response, bridge)

    model.client.chat.completions.create = adapted_create
