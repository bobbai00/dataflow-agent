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
"""Provider diagnostics without client credentials or hidden SDK parameters."""
import gzip
import json


def field(value, name, default=None):
    return value.get(name, default) if isinstance(value, dict) else getattr(value, name, default)


def request_record(kwargs):
    allowed = {"model", "messages", "tools", "tool_choice", "parallel_tool_calls", "temperature",
               "top_p", "max_tokens", "max_completion_tokens", "reasoning_effort", "stop", "n", "stream"}
    return {k: v for k, v in kwargs.items() if k in allowed}


def as_json(value):
    return value.model_dump(mode="json") if hasattr(value, "model_dump") else value


def response_record(response):
    return {k: as_json(field(response, k)) for k in ["id", "created", "model", "usage"]} | {
        "choices": [as_json(c) for c in field(response, "choices", [])]}


def usage_record(response):
    usage = field(response, "usage")
    details = field(usage, "prompt_tokens_details")
    completion = field(usage, "completion_tokens_details")
    return {"input_tokens": field(usage, "prompt_tokens"),
            "output_tokens": field(usage, "completion_tokens"),
            "cached_tokens": field(details, "cached_tokens", 0) if usage is not None else None,
            "cache_write_tokens": field(details, "cache_write_tokens", 0) if usage is not None else None,
            "reasoning_tokens": field(completion, "reasoning_tokens", 0) if usage is not None else None,
            "cache_details_reported": details is not None,
            "finish_reasons": [field(c, "finish_reason") for c in field(response, "choices", [])]}


def write_wire(folder, number, kind, value):
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / f"{number:06d}-{kind}.json.gz").open("xb") as stream:
        stream.write(gzip.compress(json.dumps(value, ensure_ascii=False).encode()))
