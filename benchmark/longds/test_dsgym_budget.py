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
import os
from pathlib import Path
import subprocess

import pytest

HERE = Path(__file__).resolve().parent
CLIENT = HERE / ".dsgym-venv/bin/python"


def run_client(code):
    if not CLIENT.exists():
        pytest.skip("Optional DSGym client environment is not installed")
    result = subprocess.run([str(CLIENT), "-c", code], cwd=HERE,
                            env={**os.environ, "MODEL_INPUT_TOKEN_BUDGET": "18000",
                                 "MODEL_INPUT_TOKEN_SCALE": ".92", "MODEL_MAX_CALLS_PER_TURN": "40"},
                            capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr


def test_script_compaction_and_summary_requests_include_system_overhead(tmp_path):
    run_client(f'''
import copy
from types import SimpleNamespace
from pathlib import Path
import dsgym_agent as agent
from comparison_budget import estimate_full_input
messages = [{{"role": "system", "content": "Rules " * 100}},
            {{"role": "user", "content": "Question: First request and inventory"}}]
for i in range(24):
    messages.extend([{{"role": "assistant", "content": "<python>df = calculate()</python>"}},
                     {{"role": "user", "content": "<information>" + "rows " * 3000 + "</information>"}},
                     {{"role": "user", "content": "Question: next " + str(i)}}])
before = copy.deepcopy(messages)
calls = []
def summary(**kwargs):
    estimate = estimate_full_input(kwargs, .92)
    assert estimate <= 18000, estimate
    calls.append(kwargs)
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="df holds the complete working population; definition unchanged."))])
compactor = agent.Compactor(18000, "inventory", Path({str(tmp_path / 'compactions.jsonl')!r}))
agent.TURN_STARTS[:] = list(range(25))
result = compactor.compact(messages, summary, {{"messages": messages}})
assert calls
assert estimate_full_input({{"messages": result}}, .92) <= 18000
assert result[0] == messages[0] and result[1] == messages[1]
assert messages == before
compactor.observe(100, 200)
assert compactor.scale == 1 and compactor.units == 18000
''')


def test_script_guard_rejects_tool_overhead_without_calling_provider():
    run_client('''
import dsgym_agent as agent
def provider(*args, **kwargs):
    raise AssertionError("Provider must not run")
agent.litellm.completion = provider
agent.install_usage_capture("openai")
try:
    agent.litellm.completion(messages=[{"role": "user", "content": "short"}], tools=[{"description": "x" * 100000}])
except RuntimeError as error:
    assert "request not sent" in str(error)
else:
    raise AssertionError("Expected full-input rejection")
assert not agent.CALLS
''')


def test_script_guard_counts_summary_calls_in_the_turn_limit():
    run_client('''
import dsgym_agent as agent
def provider(*args, **kwargs):
    raise AssertionError("Provider must not run")
agent.litellm.completion = provider
agent.install_usage_capture("openai")
agent.TURN_STARTS[:] = [0]
agent.CALLS[:] = [{"summary": True}] * 40
try:
    agent.litellm.completion(messages=[{"role": "user", "content": "short"}])
except RuntimeError as error:
    assert "call limit" in str(error)
else:
    raise AssertionError("Expected call-limit rejection")
assert len(agent.CALLS) == 40
''')


def test_compaction_summarizes_complete_turns_and_preserves_the_first_request(tmp_path):
    run_client(f'''
from types import SimpleNamespace
from pathlib import Path
import copy
import dsgym_agent as agent
from comparison_budget import estimate_full_input
first = {{"role": "user", "content": "Question: " + "rules " * 3000}}
code = "<python>" + "x" * 14000 + "EXACT_HISTORICAL_RULE=17" + "y" * 60000 + "</python>"
messages = [{{"role": "system", "content": "Rules"}}, first,
            {{"role": "assistant", "content": code}},
            {{"role": "user", "content": "<information>result</information>"}},
            {{"role": "user", "content": "Question: second"}}]
before = copy.deepcopy(messages)
requests = []
def summary(**kwargs):
    assert estimate_full_input(kwargs, .92) <= 18000
    requests.append(kwargs)
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="The saved rule is 17."))])
compactor = agent.Compactor(18000, "inventory", Path({str(tmp_path / 'complete-summary.jsonl')!r}))
agent.TURN_STARTS[:] = [0, 1]
result = compactor.compact(messages, summary, {{"messages": messages, "max_tokens": 8192}})
assert requests
assert len(requests) >= 2, "A large complete turn must be summarized in chunks"
assert "EXACT_HISTORICAL_RULE=17" in ''.join(request['messages'][1]['content'] for request in requests)
assert result[1] == first, "The original request must remain intact"
assert messages == before
assert estimate_full_input({{"messages": result}}, .92) <= 18000
''')


def test_failed_summary_is_transactional_and_counted(tmp_path):
    run_client(f'''
from types import SimpleNamespace
from pathlib import Path
import dsgym_agent as agent
attempts = []
def provider(**kwargs):
    attempts.append(kwargs)
    if len(attempts) == 2:
        raise RuntimeError("summary provider unavailable")
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="partial replacement"))])
agent.litellm.completion = provider
agent.install_usage_capture("openai")
compactor = agent.Compactor(18000, "inventory", Path({str(tmp_path / 'failed-summary.jsonl')!r}))
compactor.summary = "original complete memory"
compactor.upto = 3
agent.COMPACTOR = compactor
agent.TURN_STARTS[:] = [0]
try:
    compactor.extend_summary([[{{"role": "assistant", "content": "x" * 150000}}]],
                             agent.litellm.completion, {{"messages": []}})
except RuntimeError as error:
    assert "unavailable" in str(error)
else:
    raise AssertionError("Expected failed second summary chunk")
assert compactor.summary == "original complete memory"
assert compactor.upto == 3
assert compactor.summarizing is False
assert len(agent.CALLS) == 2
assert all(call['summary'] for call in agent.CALLS)
assert agent.CALLS[-1]['failed'] is True
''')
