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
"""Stock CodeAgent and a persistent, credential-free LocalPythonExecutor.

The execution RPC follows the DA-Code pilot adapter. Filesystem policy comes
from retrieval/execution_isolation.py; model usage comes from KramaBench's
UsageTrackingOpenAIModel. The model-written code never shares the model client.
"""

import contextlib
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import sys
import time


def save(directory, name, value):
    (Path(directory) / name).write_text(json.dumps(value, indent=2, ensure_ascii=False, default=str) + "\n")


def model_client_kwargs(config):
    from benchmark.runtime.model_limits import (
        DEFAULT_MODEL_REQUEST_TIMEOUT_SECONDS,
        validate_model_request_timeout_seconds,
    )

    seconds = validate_model_request_timeout_seconds(
        config.get("model_request_timeout_seconds", DEFAULT_MODEL_REQUEST_TIMEOUT_SECONDS)
    )
    return {"max_retries": 0, "timeout": seconds}


def completion_with_deadline(create, seconds, *args, observe_deadline=None, **kwargs):
    from benchmark.runtime.model_deadline import model_call_deadline

    with model_call_deadline(seconds) as metadata:
        if observe_deadline is not None:
            observe_deadline(metadata)
        return create(*args, **kwargs)


def executor_worker():
    """Run only stock Python execution inside the isolated subprocess."""
    from smolagents.default_tools import FinalAnswerTool
    from smolagents.local_python_executor import LocalPythonExecutor

    protocol_out, executor = sys.stdout, None
    for line in sys.stdin:
        request = json.loads(line)
        captured = io.StringIO()
        try:
            with contextlib.redirect_stdout(captured):
                if request["op"] == "init":
                    executor = LocalPythonExecutor(
                        additional_authorized_imports=request["imports"],
                        max_print_outputs_length=request["print_limit"],
                        additional_functions={"open": open},
                    )
                    executor.send_tools({"final_answer": FinalAnswerTool()})
                    response = {"ok": True}
                elif request["op"] == "variables":
                    executor.send_variables(request["variables"])
                    response = {"ok": True}
                elif request["op"] == "run":
                    result = executor(request["code"])
                    response = {
                        "ok": True,
                        "output": result.output,
                        "logs": result.logs,
                        "is_final_answer": result.is_final_answer,
                    }
                else:
                    raise ValueError("Unknown executor operation")
        except (Exception, SystemExit) as error:
            response = {
                "ok": False,
                "error": str(error),
                "error_type": type(error).__name__,
                "logs": str(executor.state.get("_print_outputs", "")) if executor else "",
            }
        if captured.getvalue():
            response["logs"] = response.get("logs", "") + captured.getvalue()
        protocol_out.write(json.dumps(response, default=str, ensure_ascii=False) + "\n")
        protocol_out.flush()


def isolated_executor(config, directory, imports):
    """Construct the same stock-executor RPC used by the DA-Code pilot."""
    from smolagents.local_python_executor import CodeOutput, PythonExecutor

    root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root / "benchmark/retrieval"))
    from execution_isolation import isolated_command

    class IsolatedExecutor(PythonExecutor):
        def __init__(self):
            self.state = {}
            self.proc = None
            self.stderr = None
            self.workspace = directory / "outputs"
            self.workspace.mkdir()
            copied = directory / "worker-inputs"
            copied.mkdir()
            for name in config["allowed_files"]:
                (copied / name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(Path(config["input_path"]) / name, copied / name)
            self.stderr = (directory / "executor-stderr.txt").open("w")
            relative = "data/" + config.get("input_relative_path", f"dsbench/{config['task_id']}")
            physical = root / "benchmark/Kramabench" / relative
            command = isolated_command(
                [sys.executable, "-u", "/executor/smol_job.py", "--executor"],
                python=sys.executable,
                data_roots=[],
                workspace=self.workspace,
                read_only=[
                    (Path(__file__), "/executor/smol_job.py"),
                    (copied, str(Path("/workspace") / relative)),
                    (copied, str(physical)),
                ],
                network=False,
                environment={"HOME": "/workspace"},
            )
            self.proc = subprocess.Popen(
                command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr, text=True, bufsize=1
            )
            try:
                self._rpc(
                    {"op": "init", "imports": imports, "print_limit": config["settings"]["max_print_outputs_length"]}
                )
            except BaseException:
                self.close()
                raise

        def _rpc(self, request):
            if self.proc.poll() is not None:
                raise RuntimeError("Isolated executor exited")
            self.proc.stdin.write(json.dumps(request) + "\n")
            self.proc.stdin.flush()
            ready, _, _ = select.select([self.proc.stdout], [], [], 240)
            if not ready:
                self.close()
                raise TimeoutError("Python action exceeded execution time limit")
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("Isolated executor closed its response stream")
            result = json.loads(line)
            self.state["_print_outputs"] = result.get("logs", "")
            if not result.get("ok"):
                raise RuntimeError(result.get("error", "Python execution failed"))
            return result

        def send_tools(self, tools):
            if set(tools) != {"final_answer"}:
                raise ValueError("This baseline exposes only stock final_answer")

        def send_variables(self, variables):
            self._rpc({"op": "variables", "variables": variables})

        def __call__(self, code_action):
            started, error, result = time.monotonic(), None, None
            try:
                result = self._rpc({"op": "run", "code": code_action})
                return CodeOutput(
                    output=result.get("output"),
                    logs=result.get("logs", ""),
                    is_final_answer=result.get("is_final_answer", False),
                )
            except (Exception, SystemExit) as failure:
                error = str(failure)
                raise
            finally:
                with (directory / "executions.jsonl").open("a") as stream:
                    stream.write(
                        json.dumps(
                            {
                                "seconds": time.monotonic() - started,
                                "code_chars": len(code_action),
                                "logs_chars": len(self.state.get("_print_outputs", "")),
                                "error": error,
                                "is_final_answer": bool(result and result.get("is_final_answer")),
                            }
                        )
                        + "\n"
                    )

        def close(self):
            if self.proc and self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait()
            if self.stderr:
                self.stderr.close()

    return IsolatedExecutor()


def main(config_path):
    root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root))
    from benchmark.runtime import normalize_usage
    from benchmark.runtime.model_deadline import DEADLINE_METHOD, validate_deadline_support
    from benchmark.runtime.structured_output_transport import (
        StructuredOutputResponseError,
        prepare_completion_request,
        unwrap_structured_response,
    )

    sys.path.insert(0, str(root / "benchmark/Kramabench"))
    from code_agent import AUTHORIZED_IMPORTS, UsageTrackingOpenAIModel, extract_reasoning_trace
    from smolagents import CodeAgent
    from smolagents.utils import AgentMaxStepsError

    config = json.loads(Path(config_path).read_text())
    directory = Path(config["output_dir"])
    key = os.environ.get("CODE_AGENT_API_KEY") or os.environ.get("LITELLM_MASTER_KEY")
    if not key:
        raise RuntimeError("CODE_AGENT_API_KEY or LITELLM_MASTER_KEY is required")
    model_parameters = config.get("model_parameters", {"reasoning_effort": config["reasoning_effort"]})
    client_kwargs = model_client_kwargs(config)
    request_timeout_seconds = client_kwargs["timeout"]
    validate_deadline_support()
    save(
        directory,
        "model-request-timeout.json",
        {
            "schema_version": 1,
            "requested_seconds": config.get("model_request_timeout_seconds"),
            "resolved_seconds": request_timeout_seconds,
            "resolution_source": "explicit" if "model_request_timeout_seconds" in config else "default",
            "enforcement_method": DEADLINE_METHOD,
            "httpx_phase_timeout_seconds": request_timeout_seconds,
            "parent_deadline_policy": "SIGALRM handler and timer untouched; earlier parent exception propagates",
            "signal_reservation": "Unused default-handler unblocked Linux real-time signal per call; distinct signals when nested",
            "actual_signal_evidence": "model-request-deadlines.jsonl",
        },
    )
    model = UsageTrackingOpenAIModel(
        model_id=config["model"],
        api_base=config["script_endpoint"],
        api_key=key,
        client_kwargs=client_kwargs,
        max_completion_tokens=config["max_output_tokens"],
        **model_parameters,
    )
    calls, succeeded = 0, 0
    returned_usage = []
    original = model.client.chat.completions.create

    def append(event, filename="model-request-trace.jsonl"):
        event["timestamp"] = datetime.now(timezone.utc).isoformat()
        with (directory / filename).open("a") as stream:
            stream.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")

    def recorded_create(*args, **kwargs):
        nonlocal calls, succeeded
        kwargs, bridge = prepare_completion_request(kwargs, config.get("model_capabilities"))
        calls += 1
        start = time.monotonic()
        fields = [
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
        append(
            {
                "phase": "request",
                "call": calls,
                "request": {key: kwargs[key] for key in fields if key in kwargs},
                "structured_output_transport": bridge,
            }
        )
        try:
            response = completion_with_deadline(
                original,
                request_timeout_seconds,
                *args,
                observe_deadline=lambda metadata: append({"call": calls, **metadata}, "model-request-deadlines.jsonl"),
                **kwargs,
            )
        except (Exception, SystemExit) as error:
            append(
                {
                    "phase": "error",
                    "call": calls,
                    "exception": type(error).__name__,
                    "status_code": getattr(error, "status_code", None),
                    "seconds": time.monotonic() - start,
                }
            )
            raise
        succeeded += 1
        raw_usage = response.usage.model_dump() if response.usage is not None else None
        returned_usage.append(normalize_usage({"usage": raw_usage}, provider="openai", model=config["model"]))
        append(
            {
                "phase": "response",
                "call": calls,
                "response_model": response.model,
                "usage": raw_usage,
                "choices": [choice.model_dump() for choice in response.choices],
                "seconds": time.monotonic() - start,
            }
        )
        print(f"STEP smol_custom {config['task_id']} {calls}", flush=True)
        try:
            adapted = unwrap_structured_response(response, bridge)
        except ValueError as error:
            event = {"phase": "structured_output_error", "call": calls, "error": str(error)}
            if isinstance(error, StructuredOutputResponseError):
                event["provider_response_error"] = error.as_dict()
            append(event)
            raise
        if bridge is not None:
            append(
                {"phase": "structured_output_adaptation", "call": calls, "content": adapted.choices[0].message.content}
            )
        return adapted

    model.client.chat.completions.create = recorded_create
    agent, executor, error, state, output = None, None, None, None, None
    started = time.monotonic()
    lifecycle = {}

    def stop(signum, frame):
        raise SystemExit("Task wall-clock limit reached")

    signal.signal(signal.SIGALRM, stop)
    signal.signal(signal.SIGTERM, stop)
    signal.alarm(config["task_timeout_seconds"])
    try:
        executor = isolated_executor(config, directory, AUTHORIZED_IMPORTS)
        agent = CodeAgent(
            tools=[],
            model=model,
            executor=executor,
            additional_authorized_imports=AUTHORIZED_IMPORTS,
            max_steps=config["settings"]["max_steps"],
            max_print_outputs_length=config["settings"]["max_print_outputs_length"],
            instructions=config["shared_principles"],
            use_structured_outputs_internally=config["settings"]["use_structured_outputs_internally"],
            verbosity_level=0,
        )
        save(directory, "settings.json", {**config["settings"], "authorized_imports": AUTHORIZED_IMPORTS})
        save(
            directory,
            "system-info.json",
            {
                "systemPrompt": agent.system_prompt,
                "smolagents_version": __import__("smolagents").__version__,
                "custom_instructions_enabled": True,
                "custom_instructions": config["shared_principles"],
                "model_capabilities": config.get("model_capabilities", {}),
                "executor": "Stock LocalPythonExecutor in credential-free bubblewrap RPC",
                "network": False,
            },
        )
        if (
            agent.system_prompt.count("## Analysis principles") != 1
            or config["shared_principles"] not in agent.system_prompt
        ):
            raise ValueError("Shared principles drift")
        lifecycle["setup_seconds"] = time.monotonic() - started
        solve_started = time.monotonic()
        try:
            output = agent.run(config["prompt"])
        finally:
            lifecycle["solve_seconds"] = time.monotonic() - solve_started
        limited = bool(agent.memory.steps) and isinstance(
            getattr(agent.memory.steps[-1], "error", None), AgentMaxStepsError
        )
        state = "max_steps_error" if limited else "success"
    except (Exception, SystemExit) as failure:
        error = f"{type(failure).__name__}: {failure}"
    finally:
        signal.alarm(0)
        capture_started = time.monotonic()
        response = "" if output is None else str(output)
        (directory / "response.txt").write_text(response)
        save(directory, "answer.json", {"answer": response})
        save(directory, "run-result.json", {"state": state, "output": output, "error": error})
        usage = model.usage_acc
        save(directory, "usage-accumulator.json", usage)
        normalized_usage = {
            "input": sum(record["input_tokens"] or 0 for record in returned_usage),
            "output": sum(record["output_tokens"] or 0 for record in returned_usage),
            "cached": sum(record["cached_input_tokens"] or 0 for record in returned_usage),
            "cache_creation": sum(record["cache_creation_tokens"] or 0 for record in returned_usage),
            "reasoning": sum(record["reasoning_tokens"] or 0 for record in returned_usage),
        }
        save(directory, "normalized-returned-usage.json", returned_usage)
        usage = normalized_usage
        save(
            directory,
            "stats.json",
            {
                "input_tokens": usage["input"],
                "output_tokens": usage["output"],
                "cached_tokens": usage["cached"],
                "cache_creation_tokens": usage["cache_creation"],
                "reasoning_tokens": usage["reasoning"],
                "total_tokens": usage["input"] + usage["output"],
                "model_calls_attempted": calls,
                "model_calls_succeeded": succeeded,
                "failed_model_calls": calls - succeeded,
                "usage_incomplete": calls != succeeded or any(not record["complete"] for record in returned_usage),
                "usage_accounting": "shared runtime v1; explicit cache writes billed separately in new runs; historical accumulators preserved",
                "model_call_count_source": "model-request-trace.jsonl request/response events",
                "num_steps": len(agent.memory.steps) if agent else 0,
                "elapsed_seconds": time.monotonic() - started,
                "state": state,
            },
        )
        save(
            directory,
            "status.json",
            {
                "completed": error is None and state == "success",
                "state": state,
                "error": error,
                "provider_blocked": bool(
                    error
                    and any(
                        word in error
                        for word in [
                            "billing_not_active",
                            "AuthenticationError",
                            "PermissionDeniedError",
                            "insufficient_quota",
                        ]
                    )
                ),
                "integrity_failure": error == "ValueError: Shared principles drift",
            },
        )
        if agent:
            save(directory, "reasoning_trace.json", extract_reasoning_trace(agent))
            try:
                save(directory, "full-memory.json", agent.memory.get_full_steps())
            except Exception as failure:
                save(directory, "trace-export-error.json", {"error": str(failure)})
        if executor:
            lifecycle["capture_seconds"] = time.monotonic() - capture_started
            cleanup_started = time.monotonic()
            executor.close()
        save(directory, "cleanup.json", {"executor_stopped": executor is None or executor.proc.poll() is not None})
        model.client.close()
        lifecycle["cleanup_seconds"] = time.monotonic() - locals().get("cleanup_started", capture_started)
        lifecycle["worker_seconds"] = time.monotonic() - started
        save(directory, "lifecycle.json", lifecycle)


if __name__ == "__main__":
    if sys.argv[1:] == ["--executor"]:
        executor_worker()
    else:
        main(sys.argv[1])
