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
"""Solve one task with the smolagents SUT's own wrapper, inside the sandbox.

script_sandbox.py starts this under bubblewrap with a JSON request on stdin.
smolagents executes model-written code in the agent's own process, so the
whole agent runs here: the task's input directory is the only data mounted and
the model gateway, through a Unix socket, the only way out. Model requests,
code executions and steps are recorded as they happen, without changing them.
"""
import dataclasses
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import time

REQUEST_FIELDS = [
    "model",
    "messages",
    "stop",
    "max_tokens",
    "max_completion_tokens",
    "temperature",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "response_format",
    "reasoning_effort",
]
TRUNCATION_MARK = "has been truncated to stay below"


def save(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str) + "\n")


def save_full_memory(base, memory):
    """Optional diagnostics must not prevent official grading of a saved answer."""
    try:
        save(base / "full-memory.json", memory.get_full_steps())
    except Exception as exc:
        save(
            base / "trace-export-error.json",
            {
                "exception": type(exc).__name__,
                "message": str(exc)[:1000],
            },
        )


def main():
    # The request carries the gateway key: stdin leaves no copy in the
    # environment or on disk for model-written code to read.
    request = json.loads(sys.stdin.read())
    out = Path(request["artifacts"])
    import httpx
    from smolagents.local_python_executor import LocalPythonExecutor

    from code_agent import CodeAgentWrapper, load_structured_output_transport

    def append(name, event):
        event["timestamp"] = datetime.now(timezone.utc).isoformat()
        with (out / name).open("a") as stream:
            stream.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")

    call_number = 0
    execute = LocalPythonExecutor.__call__

    def timed_execute(self, code_action):
        started, failure, output = time.monotonic(), None, None
        try:
            output = execute(self, code_action)
            return output
        except Exception as error:
            failure = type(error).__name__
            raise
        finally:
            logs = str(self.state.get("_print_outputs", ""))
            append(
                "executions.jsonl",
                {
                    "event": "execute",
                    "after_model_call": call_number,
                    "seconds": time.monotonic() - started,
                    "code_chars": len(code_action),
                    "logs_chars": len(logs),
                    "truncated": TRUNCATION_MARK in logs,
                    "output_chars": None if output is None else len(str(output.output)),
                    "is_final_answer": bool(output is not None and output.is_final_answer),
                    "error": failure,
                },
            )

    LocalPythonExecutor.__call__ = timed_execute

    wrapper = CodeAgentWrapper(
        model_type=request["model"], api_base=request["api_base"], api_key=request["api_key"], **request["settings"]
    )
    wrapper.setup()
    save(out / "system-info.json", {"systemPrompt": wrapper._agent.system_prompt})

    # SDK retries happen inside create(). Observe their HTTP headers without
    # reading response bodies or recording credentials.
    def transport_request(http_request):
        http_request.extensions["krama_trace_started"] = time.monotonic()
        append(
            "model-request-trace.jsonl",
            {
                "phase": "transport_request",
                "call": call_number,
                "method": http_request.method,
                "path": http_request.url.path,
            },
        )

    def transport_response(response):
        started = response.request.extensions.get("krama_trace_started", time.monotonic())
        append(
            "model-request-trace.jsonl",
            {
                "phase": "transport_headers",
                "call": call_number,
                "status": response.status_code,
                "seconds": time.monotonic() - started,
            },
        )

    # smolagents builds its own client; it only gets the socket as transport.
    model = wrapper._model
    model.client_kwargs["http_client"] = httpx.Client(
        transport=httpx.HTTPTransport(uds=request["gateway_socket"]),
        event_hooks={"request": [transport_request], "response": [transport_response]},
    )
    model.client = model.create_client()
    create = model.client.chat.completions.create
    transport_helpers = load_structured_output_transport() if wrapper.model_capabilities else None

    def recorded_create(*args, **kwargs):
        nonlocal call_number
        bridge = None
        if transport_helpers is not None:
            kwargs, bridge = transport_helpers.prepare_completion_request(kwargs, wrapper.model_capabilities)
        call_number += 1
        number, started = call_number, time.monotonic()
        append(
            "model-request-trace.jsonl",
            {
                "phase": "request",
                "call": number,
                "request": {key: kwargs[key] for key in REQUEST_FIELDS if key in kwargs},
                "structured_output_transport": bridge,
            },
        )
        try:
            response = create(*args, **kwargs)
        except (Exception, SystemExit) as error:
            append(
                "model-request-trace.jsonl",
                {
                    "phase": "error",
                    "call": number,
                    "exception": type(error).__name__,
                    "status_code": getattr(error, "status_code", None),
                    "seconds": time.monotonic() - started,
                },
            )
            raise
        append(
            "model-request-trace.jsonl",
            {
                "phase": "response",
                "call": number,
                "response_model": response.model,
                "usage": response.usage.model_dump() if response.usage is not None else None,
                "choices": [choice.model_dump() for choice in response.choices],
                "seconds": time.monotonic() - started,
            },
        )
        if transport_helpers is not None:
            try:
                adapted = transport_helpers.unwrap_structured_response(response, bridge)
            except ValueError as error:
                append(
                    "model-request-trace.jsonl",
                    {"phase": "structured_output_error", "call": number, "error": str(error)},
                )
                raise
            if bridge is not None:
                append(
                    "model-request-trace.jsonl",
                    {
                        "phase": "structured_output_adaptation",
                        "call": number,
                        "content": adapted.choices[0].message.content,
                    },
                )
            return adapted
        return response

    model.client.chat.completions.create = recorded_create

    result = wrapper.run(request["prompt"])

    memory = wrapper._agent.memory
    steps = []
    for step in memory.steps:
        timing, usage = getattr(step, "timing", None), getattr(step, "token_usage", None)
        error = getattr(step, "error", None)
        steps.append(
            {
                "type": type(step).__name__,
                "step_number": getattr(step, "step_number", None),
                "start_time": getattr(timing, "start_time", None),
                "end_time": getattr(timing, "end_time", None),
                "input_tokens": getattr(usage, "input_tokens", None),
                "output_tokens": getattr(usage, "output_tokens", None),
                "error": type(error).__name__ if error else None,
                "is_final_answer": bool(getattr(step, "is_final_answer", False)),
                "observation_chars": len(getattr(step, "observations", None) or ""),
            }
        )
    save(out / "steps.json", steps)
    save(out / "usage-accumulator.json", model.usage_acc)
    # The wrapper's summary clips code and observations; keep the complete
    # memory for manual auditing.
    save_full_memory(out, memory)
    save(out / "result.json", dataclasses.asdict(result))


if __name__ == "__main__":
    main()
