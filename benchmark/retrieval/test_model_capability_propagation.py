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
"""Explicit model facts reach ordinary and sandboxed CodeAgent without prompt changes."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler
from socketserver import UnixStreamServer
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]
KB = ROOT / "benchmark/Kramabench"
RETRIEVAL = ROOT / "benchmark/retrieval"
CAPABILITIES = {"forced_tool_choice": False, "structured_output_transport": "auto_tool"}


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_kb(source, python=None):
    process = subprocess.run(
        [str(python or KB / ".venv/bin/python"), "-c", source], cwd=KB, text=True, capture_output=True, timeout=30
    )
    assert process.returncode == 0, process.stdout + process.stderr
    return process


@pytest.mark.parametrize("python", [KB / ".venv/bin/python", Path(sys.executable)])
def test_ordinary_wrapper_preserves_default_prompt_and_legacy_model_suffix(python):
    run_kb(
        """
from code_agent import CodeAgentWrapper
old = CodeAgentWrapper(model_type='gpt-5-mini-medium', api_key='offline', verbosity_level=0).setup()
explicit = CodeAgentWrapper(model_type='gpt-5-mini', model_parameters={'reasoning_effort':'medium'}, model_capabilities={}, api_key='offline', verbosity_level=0).setup()
try:
    assert old._model.model_id == 'gpt-5-mini'
    assert old._model.kwargs['reasoning_effort'] == 'medium'
    assert old._agent._use_structured_outputs_internally is False
    assert explicit._agent._use_structured_outputs_internally is False
    assert old._agent.system_prompt == explicit._agent.system_prompt
finally:
    old._model.client.close()
    explicit._model.client.close()
""",
        python=python,
    )


def test_explicit_provider_model_id_is_not_rewritten_and_parameters_are_forwarded():
    run_kb(
        """
from code_agent import CodeAgentWrapper
wrapper = CodeAgentWrapper(model_type='provider/custom-medium', model_parameters={'reasoning_effort':'low', 'max_completion_tokens':4321}, api_key='offline', verbosity_level=0).setup()
try:
    assert wrapper._model.model_id == 'provider/custom-medium'
    assert wrapper._model.kwargs['reasoning_effort'] == 'low'
    assert wrapper._model.kwargs['max_completion_tokens'] == 4321
finally:
    wrapper._model.client.close()
"""
    )


def test_ordinary_wrapper_auto_tool_executes_stock_code_and_preserves_raw_response():
    run_kb(
        """
import json
from unittest.mock import patch
from openai.types.chat import ChatCompletion
from code_agent import CodeAgentWrapper
raw = ChatCompletion.model_validate({'id':'offline','object':'chat.completion','created':1,'model':'claude-sonnet-5.5','choices':[{'index':0,'finish_reason':'tool_calls','message':{'role':'assistant','content':None,'tool_calls':[{'id':'call1','type':'function','function':{'name':'ThoughtAndCodeAnswer','arguments':json.dumps({'thought':'Compute zero.','code':'final_answer(0)'})}}]}}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}})
seen = []
def create(*args, **kwargs):
    seen.append(kwargs)
    return raw
with patch('openai.resources.chat.completions.Completions.create', create):
    wrapper = CodeAgentWrapper(model_type='claude-sonnet-5.5', model_parameters={}, model_capabilities={'forced_tool_choice':False,'structured_output_transport':'auto_tool'}, use_structured_outputs_internally=True, api_key='offline', verbosity_level=0).setup()
    try:
        result = wrapper.run('Return zero.')
        assert result.response == '0' and result.state == 'success', result
        assert len(seen) == 1 and seen[0]['tool_choice'] == 'auto'
        assert 'response_format' not in seen[0]
        message = wrapper._agent.memory.steps[-1].model_output_message
        assert message.raw is raw
        assert message.raw.choices[0].message.content is None
        assert message.raw.choices[0].message.tool_calls[0].function.name == 'ThoughtAndCodeAnswer'
        assert result.input_tokens == 100 and result.output_tokens == 20
    finally:
        wrapper._model.client.close()
"""
    )


def test_system_forwards_explicit_facts_to_wrapper(tmp_path):
    run_kb(
        """
import tempfile
from unittest.mock import patch
from systems.code_agent_system import CodeAgentSystem
with tempfile.TemporaryDirectory() as directory, patch('systems.code_agent_system.CodeAgentWrapper') as wrapper:
    system = CodeAgentSystem(model_type='exact-provider-id', model_parameters={'reasoning_effort':'medium'}, model_capabilities={'structured_output_transport':'auto_tool'}, use_structured_outputs_internally=True, name='offline-test')
    system.process_dataset(directory)
    arguments = wrapper.call_args.kwargs
    assert arguments['model_parameters'] == {'reasoning_effort':'medium'}
    assert arguments['model_capabilities'] == {'structured_output_transport':'auto_tool'}
    assert arguments['use_structured_outputs_internally'] is True
"""
    )


def test_legacy_manifest_fact_options_are_explicit_and_empty_facts_preserve_defaults(monkeypatch):
    monkeypatch.syspath_prepend(str(RETRIEVAL))
    module = load(RETRIEVAL / "evaluate_script_task.py", "legacy_script_facts_test")
    assert module.model_options({"model_fact": None}) == {}
    assert module.model_options({"model_fact": {"model_parameters": {}, "model_capabilities": CAPABILITIES}}) == {
        "model_parameters": {},
        "model_capabilities": CAPABILITIES,
    }


def test_sandbox_forwards_facts_and_mounts_only_shared_helper(monkeypatch, tmp_path):
    monkeypatch.syspath_prepend(str(RETRIEVAL))
    module = load(RETRIEVAL / "script_sandbox.py", "legacy_sandbox_facts_test")
    settings = dict(
        max_steps=5,
        verbosity_level=0,
        use_fine_grained_prompt=False,
        use_custom_prompt=False,
        use_pitfalls_prompt=False,
        max_print_outputs_length=5000,
        no_action_detail=False,
        model_parameters={"reasoning_effort": "medium"},
        model_capabilities=CAPABILITIES,
        use_structured_outputs_internally=False,
    )
    # Isolate this wrapper contract from the package name collision in pytest.
    monkeypatch.setitem(sys.modules, "code_agent", SimpleNamespace(CodeAgentResult=object))
    monkeypatch.setitem(sys.modules, "systems.cost_utils", SimpleNamespace(compute_cost=lambda *args, **kwargs: 0))
    monkeypatch.setitem(sys.modules, "systems.dsgym_runner", SimpleNamespace(usage_totals=lambda path: {}))
    wrapper = SimpleNamespace(model_type="exact", api_base="http://offline", api_key="offline", **settings)
    sandbox = module.SandboxedScriptAgent(
        wrapper,
        harness=KB,
        data_root=tmp_path,
        data_relative="data/task",
        artifacts=tmp_path,
        workspace=tmp_path / "work",
    )
    assert sandbox.settings == settings
    assert module.STRUCTURED_OUTPUT_HELPER == ROOT / "benchmark/runtime/structured_output_transport.py"
    assert tuple(module.HARNESS_SOURCES) == ("code_agent.py", "code_agent_custom_prompt.py")


def test_legacy_child_records_actual_auto_tool_request_raw_response_and_final_answer(tmp_path):
    socket_path = tmp_path / "gateway.sock"
    seen = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            seen.append(request)
            assert request.get("tool_choice") == "auto"
            assert "response_format" not in request
            body = json.dumps(
                {
                    "id": "offline",
                    "object": "chat.completion",
                    "created": 1,
                    "model": "claude-sonnet-5.5",
                    "choices": [
                        {
                            "index": 0,
                            "finish_reason": "tool_calls",
                            "message": {
                                "role": "assistant",
                                "content": None,
                                "tool_calls": [
                                    {
                                        "id": "call1",
                                        "type": "function",
                                        "function": {
                                            "name": request["tools"][0]["function"]["name"],
                                            "arguments": json.dumps(
                                                {"thought": "Compute zero.", "code": "final_answer(0)"}
                                            ),
                                        },
                                    }
                                ],
                            },
                        }
                    ],
                    "usage": {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    with UnixStreamServer(str(socket_path), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        request = {
            "model": "claude-sonnet-5.5",
            "api_base": "http://offline/v1",
            "api_key": "offline",
            "gateway_socket": str(socket_path),
            "artifacts": str(tmp_path),
            "prompt": "Return zero.",
            "settings": {
                "verbosity_level": 0,
                "model_parameters": {},
                "model_capabilities": CAPABILITIES,
                "use_structured_outputs_internally": True,
            },
        }
        process = subprocess.run(
            [str(KB / ".venv/bin/python"), str(RETRIEVAL / "script_agent_child.py")],
            input=json.dumps(request),
            cwd=KB,
            text=True,
            capture_output=True,
            timeout=30,
            env={"PATH": str(Path(sys.executable).parent), "PYTHONPATH": str(KB)},
        )
        server.shutdown()
        thread.join()
    assert process.returncode == 0, process.stdout + process.stderr
    result = json.loads((tmp_path / "result.json").read_text())
    assert result["response"] == "0" and result["state"] == "success"
    events = [json.loads(line) for line in (tmp_path / "model-request-trace.jsonl").read_text().splitlines()]
    sent = next(event for event in events if event["phase"] == "request")
    assert sent["request"] == {key: seen[0][key] for key in sent["request"]}
    assert sent["structured_output_transport"]["transport"] == "auto_tool"
    raw = next(event for event in events if event["phase"] == "response")
    assert raw["choices"][0]["message"]["content"] is None
    assert raw["choices"][0]["message"]["tool_calls"][0]["function"]["name"] == "ThoughtAndCodeAnswer"
    assert raw["usage"]["prompt_tokens"] == 100
    adapted = next(event for event in events if event["phase"] == "structured_output_adaptation")
    assert json.loads(adapted["content"])["code"] == "final_answer(0)"
    executions = [json.loads(line) for line in (tmp_path / "executions.jsonl").read_text().splitlines()]
    assert len(executions) == 1 and executions[0]["is_final_answer"] is True
