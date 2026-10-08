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

"""A LongDS session solved by smolagents' `CodeAgent`.

Set up the way the KramaBench harness sets it up
(`benchmark/Kramabench/code_agent.py`): no tools, the same authorized imports,
`open`, and the same model wrapper, which reads cache and reasoning tokens from
each response. One agent serves the whole session: every request after the
first continues it (`reset=False`), so the conversation and the Python
variables persist, as smolagents' system prompt says they do.

Model-written code runs in smolagents' own local interpreter, hosted in a
sandboxed child process (`smolagents_worker.py`) that sees the session's data,
read-only, and a scratch folder, and has no network. The model client stays
outside, as it does for the DSGym kernel.
"""
import gzip
import importlib.util
import json
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time

import smolagents
from smolagents import CodeAgent
from smolagents.local_python_executor import CodeOutput, PythonExecutor
from smolagents.memory import ActionStep, TaskStep
from smolagents.monitoring import LogLevel
from smolagents.utils import AgentMaxStepsError

from _paths import KB_ROOT
from execution_isolation import isolated_command
from state_comparison import HERE, ROOT, cost_of, save

sys.path.append(str(KB_ROOT))
from code_agent import AUTHORIZED_IMPORTS, UsageTrackingOpenAIModel  # noqa: E402
from code_agent_custom_prompt import CUSTOM_INSTRUCTIONS  # noqa: E402

INSTRUCTIONS = {"kramabench": CUSTOM_INSTRUCTIONS}
# smolagents refuses an authorized module that is not installed (here: fiona).
IMPORTS = [name for name in AUTHORIZED_IMPORTS if importlib.util.find_spec(name.split(".")[0]) is not None]


class SessionLost(BaseException):
    """The interpreter process is gone, and the session's variables with it.
    Not an `Exception`: the agent would record it as a failed step and go on."""


class SandboxedInterpreter(PythonExecutor):
    """smolagents' local interpreter in a sandboxed child process, which keeps
    the interpreter state for the whole session."""

    def __init__(self, manifest, workspace, authorized_imports, max_print_outputs_length=None, timeout=1800):
        self.timeout = timeout
        self.state = {}
        workspace = Path(workspace)
        workspace.mkdir(parents=True, exist_ok=True)
        data_dir = Path(manifest["data_dir"])
        data_root = (ROOT / data_dir).resolve()
        python = ROOT / ".venv/bin/python"
        worker = "/harness/smolagents_worker.py"
        # As for the DSGym kernel: the data also appears under the relative
        # path the task text names, seen from the working directory.
        relative = [] if data_dir.is_absolute() else [(data_root, str(Path("/workspace") / data_dir))]
        settings = {"authorized_imports": list(authorized_imports), "max_print_outputs_length": max_print_outputs_length}
        self.process = subprocess.Popen(
            isolated_command([python, worker, json.dumps(settings)], python=python, data_roots=[data_root],
                             workspace=workspace, read_only=[(HERE / "smolagents_worker.py", worker), *relative],
                             environment={"HOME": "/workspace"}),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.replies = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        if not self._reply(180).get("ready"):
            raise SessionLost("The interpreter did not start")

    def _read(self):
        for line in self.process.stdout:
            self.replies.put(line)
        self.replies.put(None)

    def _reply(self, timeout):
        try:
            line = self.replies.get(timeout=timeout)
        except queue.Empty:
            self.process.kill()
            raise SessionLost(f"No reply from the interpreter in {timeout} s; it was stopped") from None
        if line is None:
            raise SessionLost(f"The interpreter exited (code {self.process.poll()})")
        return json.loads(line)

    def send_tools(self, tools):
        # The child defines `final_answer` itself; this harness gives the agent no other tool.
        extra = set(tools) - {"final_answer"}
        if extra:
            raise NotImplementedError(f"Tools are not forwarded to the sandbox: {sorted(extra)}")

    def send_variables(self, variables):
        if variables:
            raise NotImplementedError("Variables are not forwarded to the sandbox")

    def __call__(self, code_action):
        try:
            self.process.stdin.write(json.dumps({"code": code_action}) + "\n")
            self.process.stdin.flush()
        except (BrokenPipeError, ValueError):
            raise SessionLost("The interpreter is gone") from None
        reply = self._reply(self.timeout)
        # The agent reads the partial print output from here when a step fails.
        self.state = {"_print_outputs": reply["logs"]}
        if "error" in reply:
            raise RuntimeError(reply["error"])
        final = reply["is_final_answer"]
        return CodeOutput(output=reply["value"] if final else reply["text"], logs=reply["logs"], is_final_answer=final)

    def cleanup(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()


class RecordingModel(UsageTrackingOpenAIModel):
    """KramaBench's model wrapper, also keeping each call's token counts."""

    def reset_usage(self):
        super().reset_usage()
        self.calls = []

    def _track(self, msg):
        before = dict(self.usage_acc)
        super()._track(msg)
        if self.usage_acc["calls"] > before["calls"]:
            self.calls.append({key: self.usage_acc[key] - before[key] for key in ("input", "cached", "output", "reasoning")})


def answer_text(value):
    if value is None:
        return ""
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def step_trace(step):
    if isinstance(step, TaskStep):
        return {"type": "task", "task": step.task}
    if not isinstance(step, ActionStep):
        return {"type": type(step).__name__}
    usage = step.token_usage
    return {"type": "action", "step_number": step.step_number, "model_output": step.model_output,
            "code_action": step.code_action, "observations": step.observations,
            "error": None if step.error is None else f"{type(step.error).__name__}: {step.error}",
            "action_output": None if step.action_output is None else str(step.action_output)[:20000],
            "is_final_answer": step.is_final_answer,
            "token_usage": usage and {"input_tokens": usage.input_tokens, "output_tokens": usage.output_tokens},
            "seconds": step.timing and step.timing.duration}


class Session:
    def __init__(self, manifest, output, model, *, api_base, api_key, instructions=None, max_steps=None,
                 max_print_outputs_length=None):
        self.model_name = model
        self.model = RecordingModel(model_id=model, api_base=api_base, api_key=api_key)
        self.executor = SandboxedInterpreter(manifest, Path(output) / "sandbox", IMPORTS, max_print_outputs_length)
        # Only what the caller sets leaves smolagents' defaults.
        options = {key: value for key, value in (("instructions", INSTRUCTIONS.get(instructions)), ("max_steps", max_steps),
                                                  ("max_print_outputs_length", max_print_outputs_length)) if value is not None}
        self.agent = CodeAgent(tools=[], model=self.model, additional_authorized_imports=IMPORTS,
                               executor=self.executor, verbosity_level=LogLevel.OFF, **options)
        self.first = True
        save(Path(output) / "agent.json", {
            "smolagents": smolagents.__version__, "max_steps": self.agent.max_steps, "instructions": instructions,
            "max_print_outputs_length": max_print_outputs_length, "authorized_imports": IMPORTS,
            "system_prompt": self.agent.system_prompt})

    def solve(self, turn_id, text, directory, rates):
        """One request: a record with the answer and what it cost. After an
        `error` the conversation cannot be continued."""
        agent, model = self.agent, self.model
        start = 0 if self.first else len(agent.memory.steps)
        before, calls_before, started = dict(model.usage_acc), len(model.calls), time.monotonic()
        output = error = None
        try:
            output = agent.run(text, reset=self.first)
        except (Exception, SessionLost, SystemExit) as failure:
            error = f"{type(failure).__name__}: {failure}"
        self.first = False
        steps = agent.memory.steps[start:]
        actions = [step for step in steps if isinstance(step, ActionStep)]
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        with gzip.open(directory / "steps.json.gz", "wt") as stream:
            json.dump([step_trace(step) for step in steps], stream, ensure_ascii=False, default=str)
        for step in actions:
            # Each step keeps the full list of messages it was sent; over a
            # session that is quadratic. Later requests are built from the steps.
            step.model_input_messages = None
        used = {key: model.usage_acc[key] - before[key] for key in before}
        stats = {"input_tokens": used["input"], "output_tokens": used["output"], "cached_tokens": used["cached"],
                 "cache_write_tokens": used["cache_creation"], "reasoning_tokens": used["reasoning"],
                 "llm_calls": used["calls"], "elapsed_seconds": round(time.monotonic() - started, 3)}
        stats["cost_usd"] = cost_of(stats, rates)
        out_of_steps = bool(actions) and isinstance(actions[-1].error, AgentMaxStepsError)
        return {"turn_id": turn_id, "prompt": text, "answer": answer_text(output),
                "completed": error is None and output is not None, "error": error,
                "state": "max_steps" if out_of_steps else "error" if error else "answered",
                "steps": len(actions), "failed_steps": sum(step.error is not None for step in actions) - out_of_steps,
                "stats": stats, "calls": model.calls[calls_before:], "model": self.model_name, "policy": "smolagents"}

    def close(self):
        self.executor.cleanup()
