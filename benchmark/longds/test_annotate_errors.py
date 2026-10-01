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

import copy

import pytest

from annotate_errors import dsgym_turn, summarize, validate_annotation


def annotation():
    rows = [{"turn_id": 1, "judge": {"score": 1}}, {"turn_id": 2, "judge": {"score": 0}}]
    items = [{
        "task_id": 2, "primary_error_type": "Cascade Error",
        "all_error_types": ["Cascade Error"], "upstream_error_task_id": 1,
        "error_summary": "Uses the wrong table created during turn 1.",
        "evidence": "Turn 1 saved only three rows, and turn 2 aggregates those rows.",
        "confidence": "high",
    }]
    result = {"task_error_analysis": items, "summary": summarize(items, ["Wrong saved table."])}
    return result, rows


def test_cascade_can_start_at_a_passing_turn():
    result, rows = annotation()
    assert validate_annotation(result, rows) == []


@pytest.mark.parametrize("mutation", ["missing", "duplicate", "passed", "future", "no_root", "bad_count", "unknown_type"])
def test_rejects_incomplete_or_inconsistent_annotations(mutation):
    result, rows = annotation()
    item = result["task_error_analysis"][0]
    if mutation == "missing":
        result["task_error_analysis"] = []
    elif mutation == "duplicate":
        result["task_error_analysis"].append(copy.deepcopy(item))
    elif mutation == "passed":
        item["task_id"] = 1
    elif mutation == "future":
        item["upstream_error_task_id"] = 2
    elif mutation == "no_root":
        item["upstream_error_task_id"] = None
    elif mutation == "bad_count":
        result["summary"]["total_incorrect_tasks"] = 8
    elif mutation == "unknown_type":
        item["all_error_types"].append("Engine Error")
    assert validate_annotation(result, rows)


def test_dsgym_turn_preserves_observations_without_mistaking_them_for_questions():
    question = "What is the count?"
    trace = [
        {"role": "system", "content": "You are an analyst."},
        {"role": "user", "content": "Question: Earlier question?"},
        {"role": "assistant", "content": "<answer>old</answer>"},
        {"role": "user", "content": "Context\nQuestion: " + question},
        {"role": "assistant", "content": "<python>print(3)</python>"},
        {"role": "user", "content": "<information>Question: What is the count? 3</information>"},
        {"role": "assistant", "content": "<answer>3</answer>"},
    ]
    start, messages = dsgym_turn(trace, question)
    assert start == 3
    assert messages == trace[3:]
    assert messages[2]["content"].endswith("3</information>")
