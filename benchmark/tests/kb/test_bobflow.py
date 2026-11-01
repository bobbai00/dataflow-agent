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
"""BobFlow's KramaBench system against a fake agent service: the exact requests, in order, and the artifacts."""
import json

import pytest

pytest.importorskip("websocket", reason="the WebSocket client is in the KramaBench venv")

from bobbench.agent_client import Endpoints  # noqa: E402
from bobbench.arms import ARMS, base_settings  # noqa: E402
from bobbench.kramabench.bobflow import WORKFLOW, BobFlowSystem  # noqa: E402
from bobbench.paths import KB  # noqa: E402
from fakes.agent_service import FakeServices  # noqa: E402

TASK = "archeology-easy-6"
SETTINGS = {**base_settings(), **ARMS["evidence_data1_flow0_opt"]}
STEP = {"id": "s1", "role": "agent", "toolCalls": [{"toolName": "dataflow"}], "usage": {"inputTokens": 100, "outputTokens": 5}}
FINAL = {"id": "s2", "role": "agent", "isEnd": True, "content": "**Final Answer: São Paulo**",
         "usage": {"inputTokens": 200, "outputTokens": 9, "cachedInputTokens": 150}}
COMPLETE = {"type": "complete", "usage": {"inputTokens": 300, "outputTokens": 14, "totalTokens": 314, "reasoningTokens": 3,
                                          "cachedInputTokens": 150, "cacheCreationInputTokens": 20}}


def system(services, tmp_path, settings=SETTINGS, after_reply=None):
    bobflow = BobFlowSystem(model="claude-haiku-5.5", settings=settings,
                            endpoints=Endpoints(web=services.url, units=services.url, engine=services.url, agent=services.url),
                            computing_unit=5, scratch=tmp_path / "SUT", kb=KB,
                            provenance={"agent_revision": "a", "harness_revision": "h", "job": {"task": TASK}},
                            after_reply=after_reply)
    if not (KB / "data" / "archeology" / "input").is_dir():
        pytest.skip("no KramaBench data (bench setup)")
    bobflow.process_dataset(str(KB / "data" / "archeology" / "input"))
    return bobflow


@pytest.fixture
def services():
    fake = FakeServices(events=[{"type": "step", "step": STEP}, {"type": "step", "step": {**FINAL, "isEnd": False}},
                                {"type": "step", "step": FINAL}, COMPLETE],
                        steps=[STEP, FINAL])
    yield fake
    fake.close()


def test_one_agent_per_task_with_the_run_settings_and_the_exact_requests(services, tmp_path):
    hooked = []
    bobflow = system(services, tmp_path, after_reply=hooked.append)
    reply = bobflow.serve_query("Which city?", TASK, ["worldcities.csv"])
    attempt = tmp_path / "SUT" / TASK
    prompt = (attempt / "prompt.txt").read_text()
    assert prompt == bobflow.prompt("Which city?", TASK, ["worldcities.csv"])
    assert prompt.endswith("Your reply MUST BE exactly one line, with nothing before or after it: **Final Answer: <value>**")
    agent = f"/api/agents/{services.agent_id}"
    assert [(method, path) for method, path, *_ in services.log] == [
        ("POST", "/api/auth/login"), ("POST", "/api/workflow/create"), ("POST", "/api/agents"),
        ("GET", f"{agent}/system-info"), ("GET", f"{agent}/settings"), ("WS", f"{agent}/react"),
        ("GET", f"{agent}/react-steps"), ("GET", f"{agent}/workflow"), ("GET", f"{agent}/snapshots/head"),
        ("DELETE", agent), ("POST", "/api/workflow/delete")]
    bodies = {path: (body, auth) for method, path, body, auth in services.log}
    assert bodies["/api/auth/login"][0] == {"username": "texera", "password": "texera"}
    assert bodies["/api/workflow/create"] == (WORKFLOW, "Bearer token")
    assert json.loads(WORKFLOW["content"]) == {"operators": [], "operatorPositions": {}, "links": [], "commentBoxes": [],
                                               "settings": {}}
    assert bodies["/api/agents"] == ({"modelType": "claude-haiku-5.5", "workflowId": 7, "computingUnitId": 5,
                                      "settings": SETTINGS}, "Bearer token")
    assert bodies[f"{agent}/react"][0] == {"type": "message", "content": prompt, "messageSource": "chat"}
    assert bodies["/api/workflow/delete"][0] == {"wids": [7]}
    assert hooked == [attempt]

    def read(name):
        return json.loads((attempt / name).read_text())

    assert read("resources.json") == {"agent_id": services.agent_id, "workflow_id": 7, "computing_unit_id": 5}
    assert read("provenance.json")["job"] == {"task": TASK} and "agent_listener" in read("provenance.json")
    assert read("settings.json") == {"contextMode": "delta", **SETTINGS}
    assert (attempt / "response.txt").read_text() == "**Final Answer: São Paulo**"
    assert read("answer.json") == {"id": "main-task", "answer": "São Paulo"}
    stats = read("stats.json")
    assert {k: stats[k] for k in ("input_tokens", "output_tokens", "total_tokens", "reasoning_tokens", "cached_tokens",
                                  "cache_creation_tokens", "cost_usd", "stopped", "error", "num_steps")} == {
        "input_tokens": 300, "output_tokens": 14, "total_tokens": 314, "reasoning_tokens": 3, "cached_tokens": 150,
        "cache_creation_tokens": 20, "cost_usd": None, "stopped": False, "error": None, "num_steps": 2}
    assert read("ground_truth.json")["id"] == TASK and read("ground_truth.json")["answer_type"]
    assert read("react_steps.json")["steps"] == [STEP, FINAL]
    assert read("workflow.json") == {"operators": []} and read("snapshot.json")["results"] == {}
    assert reply == {"explanation": {"id": "main-task", "answer": "São Paulo"}, "pipeline_code": "", "token_usage": 314,
                     "token_usage_input": 300, "token_usage_output": 14, "token_usage_reasoning": 3,
                     "token_usage_cached": 150, "cost_usd": None}


def test_without_a_complete_event_the_streamed_steps_are_summed_once(tmp_path):
    services = FakeServices(events=[{"type": "step", "step": STEP}, {"type": "step", "step": FINAL},
                                    {"type": "step", "step": FINAL}])
    try:
        system(services, tmp_path).serve_query("q", TASK, ["worldcities.csv"])
    finally:
        services.close()
    stats = json.loads((tmp_path / "SUT" / TASK / "stats.json").read_text())
    assert (stats["input_tokens"], stats["output_tokens"], stats["cached_tokens"], stats["num_steps"]) == (300, 14, 150, 2)


def test_settings_the_agent_does_not_echo_fail_the_attempt_and_still_tear_down(tmp_path):
    services = FakeServices(settings_override={"maxSteps": 50})
    try:
        with pytest.raises(AssertionError, match="Settings drift"):
            system(services, tmp_path).serve_query("q", TASK, ["worldcities.csv"])
    finally:
        services.close()
    assert [(method, path) for method, path, *_ in services.log][-2:] == [
        ("DELETE", f"/api/agents/{services.agent_id}"), ("POST", "/api/workflow/delete")]


def test_a_failed_turn_is_an_error_reply_not_a_crash(services, tmp_path):
    services.events = [{"type": "error", "error": "model unavailable"}]
    reply = system(services, tmp_path).serve_query("q", TASK, ["worldcities.csv"])
    attempt = tmp_path / "SUT" / TASK
    assert json.loads((attempt / "stats.json").read_text())["error"] == "model unavailable"
    assert (attempt / "response.txt").read_text() == "(empty response)"
    assert reply["explanation"]["answer"] == "No response from agent"
