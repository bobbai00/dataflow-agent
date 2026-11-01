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

"""Adapt tool schemas to provider limits on LiteLLM's OpenAI-compatible route.

LiteLLM 1.83.10 drops function.strict when building an Anthropic tool. Native
input_schema tools bypass that mapper. Adapt only explicitly strict tools on
our configured supported Claude aliases.

Gemini forced function calling (tool_choice required, mode ANY) rejects a
bounded array nested in a bounded array's items with INVALID_ARGUMENT, even
for maxItems 8; automatic calls accept it. Move maxItems out of every Gemini
tool schema. LiteLLM's Gemini mapper also drops const, which leaves anyOf
variants without their discriminator; a one-value string enum survives it.
A request served from an explicit Gemini cache may not set tool_config, so
tool_choice "auto", the Gemini default, is removed. Other routes are unchanged.

On the routes in GEMINI_TASK_CACHE, a short request also gets a cache
breakpoint on its task message, which OpenRouter turns into a Gemini context
cache of the system prompt, tools and task. Gemini's implicit cache reuses an
earlier request's prefix only in ~4,096-token blocks, so a call's first ~8k
tokens are rarely cached; an explicit entry needs 4,096 tokens, more than the
system prompt alone. A request served from the entry gets no implicit cache on
top, so longer requests, where implicit caching reuses more, carry none.

The provider schema retains types, discriminators and required properties.
Unsupported cardinality/range constraints move into descriptions, following
Anthropic's SDK convention. Callers must still validate their original schema.
"""

import copy
import json

from litellm.integrations.custom_logger import CustomLogger

STRICT_MODELS = {
    "claude-haiku-4.5", "claude-haiku-4-5-20251001",
    "claude-sonnet-5", "claude-opus-5", "claude-sonnet-5.5", "claude-sonnet-5-5",
    "claude-opus-5.5", "claude-opus-5-5",
}
UNSUPPORTED_CONSTRAINTS = {
    "minLength", "maxLength", "maxItems", "uniqueItems", "contains",
    "minContains", "maxContains", "minimum", "maximum", "exclusiveMinimum",
    "exclusiveMaximum", "multipleOf", "minProperties", "maxProperties",
    # Repeated non-whitespace regexes in the action union exceed Haiku's
    # grammar complexity limit. The original local schema still enforces them.
    "pattern",
}


GEMINI_UNSUPPORTED_CONSTRAINTS = {"maxItems"}
# Route -> request size (messages and tools as JSON characters) under which the task message carries a breakpoint.
# 33,000 characters is about 9,000 tokens: below it the implicit cache reuses at most one block, the same as the entry.
GEMINI_TASK_CACHE = {"gemini-3.8-flash-vertex-cached": 33_000}


def anthropic_unsupported(key, value):
    return key in UNSUPPORTED_CONSTRAINTS or (key == "minItems" and value not in (0, 1))


def gemini_unsupported(key, value):
    return key in GEMINI_UNSUPPORTED_CONSTRAINTS


def provider_schema(schema, unsupported=anthropic_unsupported, const_enum=False):
    """Copy schema nodes, without interpreting literal values as schemas."""
    result = copy.deepcopy(schema)
    if const_enum and isinstance(result.get("const"), str) and "enum" not in result:
        result["enum"] = [result.pop("const")]
    constraints = {}
    for key in list(result):
        if unsupported(key, result[key]):
            constraints[key] = result.pop(key)
    if constraints:
        note = "{" + ", ".join(f"{key}: {json.dumps(value)}" for key, value in constraints.items()) + "}"
        result["description"] = (result.get("description", "") + "\n\n" + note).strip()
    for key in ("properties", "$defs", "definitions"):
        if key in result:
            result[key] = {name: provider_schema(value, unsupported, const_enum)
                for name, value in result[key].items()}
    for key in ("items", "not", "if", "then", "else"):
        if isinstance(result.get(key), dict):
            result[key] = provider_schema(result[key], unsupported, const_enum)
    for key in ("anyOf", "allOf", "oneOf", "prefixItems"):
        if key in result:
            result[key] = [provider_schema(value, unsupported, const_enum) for value in result[key]]
    return result


def gemini_tools(tools):
    result = []
    for tool in tools:
        function = tool.get("function") if tool.get("type") == "function" else None
        if isinstance(function, dict) and isinstance(function.get("parameters"), dict):
            parameters = provider_schema(function["parameters"], gemini_unsupported, const_enum=True)
            function = {**function, "parameters": parameters}
            tool = {**tool, "function": function}
        result.append(tool)
    return result


def task_breakpoint(data, limit):
    """Messages with a cache breakpoint on the task message (the first user message after the system prompt), or None
    when the request is too long or has no such message."""
    messages = data.get("messages")
    if not (isinstance(messages, list) and len(messages) > 1 and messages[0].get("role") == "system"
            and messages[1].get("role") == "user"):
        return None
    if len(json.dumps(messages)) + len(json.dumps(data["tools"])) >= limit:
        return None
    content = messages[1].get("content")
    if isinstance(content, str):
        content = [{"type": "text", "text": content}]
    if not (isinstance(content, list) and content and isinstance(content[-1], dict)):
        return None
    content = content[:-1] + [{**content[-1], "cache_control": {"type": "ephemeral"}}]
    return [messages[0], {**messages[1], "content": content}] + messages[2:]


class ProviderToolSchemas(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        model = str(data.get("model", "")).removeprefix("anthropic/")
        if not isinstance(data.get("tools"), list):
            return data
        if model.removeprefix("gemini/").startswith("gemini-"):
            result = {**data, "tools": gemini_tools(data["tools"])}
            if result.get("tool_choice") == "auto":
                del result["tool_choice"]
            messages = task_breakpoint(data, GEMINI_TASK_CACHE[model]) if model in GEMINI_TASK_CACHE else None
            if messages is not None:
                result["messages"] = messages
            return result
        if model not in STRICT_MODELS:
            return data
        result = dict(data)
        tools = []
        for tool in data["tools"]:
            function = tool.get("function", {}) if tool.get("type") == "function" else {}
            if function.get("strict") is True:
                mapped = {"name": function["name"], "strict": True,
                    "input_schema": provider_schema(function["parameters"])}
                if "description" in function:
                    mapped["description"] = function["description"]
                tools.append(mapped)
            elif tool.get("strict") is True and "input_schema" in tool:
                tools.append({**tool, "input_schema": provider_schema(tool["input_schema"])})
            else:
                tools.append(tool)
        result["tools"] = tools
        return result


hook = ProviderToolSchemas()
