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
"""New canonical reports retain unknowns without reinterpreting old runs."""
import json

from benchmark.retrieval.baseline_report import attempt, summarize


def row():
    return {
        "sut": "sut",
        "task": "legal-easy-3",
        "arm": "smolagents",
        "rep": 1,
        "timeout": False,
        "exit_code": 0,
        "seconds": 1,
        "audit": {"violations": [], "warnings": []},
    }


def test_partial_new_metrics_are_not_free_tokens_or_cost(tmp_path):
    directory = tmp_path / "system_scratch/sut/legal-easy-3"
    directory.mkdir(parents=True)
    (directory / "stats.json").write_text('{"input_tokens":null,"cost_usd":null}')
    (directory / "metrics.json").write_text(
        json.dumps(
            {
                "cost": {"total_usd": None, "known_usd": 0.01},
                "tokens": {
                    "input_tokens": None,
                    "output_tokens": None,
                    "cached_tokens": None,
                    "cache_creation_tokens": None,
                    "reasoning_tokens": None,
                    "uncached_input_tokens": None,
                },
                "requests": {"succeeded": 1, "failed": 1},
                "resource_completeness": {"complete": False},
            }
        )
    )
    result = summarize([attempt(tmp_path, row())], None)
    assert result["cost_usd"] is None and result["known_cost_usd"] == 0.01
    assert result["input_tokens"] is None and result["uncached_input_tokens"] is None


def test_historical_uncached_interpretation_is_unchanged_without_sidecar(tmp_path):
    directory = tmp_path / "system_scratch/sut/legal-easy-3"
    directory.mkdir(parents=True)
    (directory / "stats.json").write_text('{"input_tokens":100,"cached_tokens":20,"cache_creation_tokens":10}')
    result = summarize([attempt(tmp_path, row())], None)
    assert result["uncached_input_tokens"] == 80
