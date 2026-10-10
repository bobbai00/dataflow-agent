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
import gzip
import json
from types import SimpleNamespace

from comparison_capture import request_record, response_record, usage_record, write_wire


def test_wire_trace_keeps_all_choices_without_credentials(tmp_path):
    request = request_record({"model": "model", "messages": [{"role": "user", "content": "task"}],
                              "max_completion_tokens": 8192, "api_key": "secret", "extra_headers": {"Authorization": "secret"}})
    response = response_record({"model": "model", "choices": [{"index": 0, "message": {"content": "a"}},
                                                               {"index": 1, "message": {"content": "b"}}],
                                "_hidden_params": {"api_key": "secret"}})
    write_wire(tmp_path, 1, "request", request)
    write_wire(tmp_path, 1, "response", response)
    saved = json.loads(gzip.decompress((tmp_path / "000001-response.json.gz").read_bytes()))
    assert len(saved["choices"]) == 2
    assert "secret" not in json.dumps([request, saved])


def test_usage_supports_sdk_objects_and_keeps_missing_usage_unknown():
    assert usage_record({})["input_tokens"] is None
    assert usage_record({})["output_tokens"] is None
    response = SimpleNamespace(usage=SimpleNamespace(prompt_tokens=100, completion_tokens=7,
        prompt_tokens_details=SimpleNamespace(cached_tokens=40, cache_write_tokens=10)), choices=[])
    usage = usage_record(response)
    assert (usage["input_tokens"], usage["output_tokens"], usage["cached_tokens"], usage["cache_write_tokens"]) == (100, 7, 40, 10)
    assert usage["cache_details_reported"]
