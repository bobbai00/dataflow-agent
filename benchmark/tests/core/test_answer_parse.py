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
"""Every recorded reply parses to the answer its attempt recorded.

fixtures/answers.jsonl: the distinct replies of the paper's KramaBench runs (BobFlow, 8 models, plain and optimized
arms), one PrepBench run (Luna) and two Script ReAct runs, with the answer.json each attempt wrote at the time."""
import json
from pathlib import Path

import pytest

from bobbench.kramabench.prompt import parse_answer, parse_explicit_answer

ROWS = [json.loads(line) for line in (Path(__file__).resolve().parents[1] / "fixtures/answers.jsonl").open()]


@pytest.mark.parametrize("row", ROWS, ids=[f"{r['system']}:{r['run']}:{r['task']}" for r in ROWS])
def test_recorded_reply_parses_to_its_answer(row):
    if row["system"] == "scriptreact" and row.get("state") == "success":
        assert parse_explicit_answer(row["response"]) == row["answer"]
    else:
        assert parse_answer(row["response"]) == row["answer"]


def test_the_fixture_covers_both_systems():
    assert {r["system"] for r in ROWS} == {"bobflow", "scriptreact"} and len(ROWS) > 500


def test_an_empty_reply_is_no_response():
    assert parse_answer("") == "No response from agent"
    assert parse_explicit_answer("") == "No response from agent"


def test_a_repeated_label_and_markdown_are_stripped():
    assert parse_answer("Some work.\n**Final Answer: **Final Answer: 1.1413****") == "1.1413"
    assert parse_answer("**Final Answer:** [\"a\", \"b\"]") == '["a", "b"]'
    assert parse_answer("Final Answer: 42.") == "42"
