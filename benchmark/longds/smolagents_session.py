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
"""A LongDS session solved by smolagents' `CodeAgent`, the script-agent baseline.

Set up the way the KramaBench harness sets it up (its `code_agent.py`, loaded
from a KramaBench checkout at the revision this repository pins): no tools,
its authorized imports, `open`, and its model wrapper, which reads cache and
reasoning tokens from each response. The system prompt is smolagents' own and
a request gets smolagents' default of 20 steps. One agent serves the whole
session: every request after the first continues it (`reset=False`), so the
conversation and the Python variables persist.

Each request is sent as the dataflow arms receive it (the prepared
prompts.json). Model-written code runs in smolagents' own interpreter, in a
sandboxed child process (`smolagents_worker.py`) that sees the session's data
read-only, at the paths the requests name, and a scratch folder, with no
network. The model client stays outside and calls the stack's gateway
(LITELLM_BASE_URL, LITELLM_MASTER_KEY), as the dataflow agent does.

The output folder has the layout run_session.py writes, so judge.py and
report.py read it unchanged; the arm is `smolagents`. With `--select oracle`
(arm `smolagents-oracle`) a request's memory holds only the earlier requests
the selection names (common.oracle_selection), as run_session's
`transcript-oracle` does for the dataflow agent; the interpreter keeps every
variable either way.

Usage (from the repository root, inside the stack's environment):
    python -m benchmark.longds.smolagents_session --prepared R/prepared/<key> \\
        --out R/runs/<key>__smolagents__r1 --kramabench PATH
"""
import argparse
from datetime import datetime, timezone
import gzip
import importlib.util
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time

from benchmark.longds.common import DATA, HERE, ROOT, SELECTIONS, load, save, selection_note
from benchmark.retrieval.execution_isolation import isolated_command
from benchmark.retrieval.metrics import cost_for_usage, current_price_schedule

WORKER = HERE / "smolagents_worker.py"


class SessionLost(BaseException):
    """The interpreter process is gone, and the session's variables with it.
    Not an `Exception`: the agent would record it as a failed step and go on."""


def kramabench(path):
    """KramaBench's agent setup from a checkout at the pinned revision."""
    path = Path(path).resolve()
    pinned = subprocess.check_output(["git", "ls-tree", "HEAD", "benchmark/Kramabench"], cwd=ROOT, text=True).split()[2]
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=path, text=True).strip()
    if actual != pinned:
        raise SystemExit(f"KramaBench checkout {path} is at {actual[:9]}; this repository pins {pinned[:9]}")
    sys.path.insert(0, str(path))
    import code_agent  # noqa: E402
    return code_agent, actual


def available_imports(names):
    """smolagents refuses an authorized module that is not installed."""
    return [name for name in names if importlib.util.find_spec(name.split(".")[0]) is not None]


def make_interpreter_class(PythonExecutor, CodeOutput):
    class SandboxedInterpreter(PythonExecutor):
        """smolagents' local interpreter in a sandboxed child process, which
        keeps the interpreter state for the whole session."""

        def __init__(self, task, workspace, authorized_imports, max_print_outputs_length=None, timeout=1800,
                     data_root=DATA):
            self.timeout = timeout
            self.state = {}
            workspace = Path(workspace)
            workspace.mkdir(parents=True, exist_ok=True)
            data = (Path(data_root) / task / "data").resolve()
            python = Path(sys.executable)
            worker = "/harness/smolagents_worker.py"
            settings = {"authorized_imports": list(authorized_imports),
                        "max_print_outputs_length": max_print_outputs_length}
            # The requests name the data relative to the repository root, the
            # working directory here, as `data/longds/<task>/data/...`.
            self.process = subprocess.Popen(
                isolated_command([str(python), worker, json.dumps(settings)], python=python, data_roots=[data],
                                 workspace=workspace,
                                 read_only=[(WORKER, worker), (data, f"/workspace/data/longds/{task}/data")],
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
            # The child defines `final_answer` itself; the agent has no other tool.
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
            return CodeOutput(output=reply["value"] if final else reply["text"], logs=reply["logs"],
                              is_final_answer=final)

        def cleanup(self):
            if self.process.poll() is None:
                self.process.stdin.close()
                try:
                    self.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.process.kill()

    return SandboxedInterpreter


def answer_text(value):
    if value is None:
        return ""
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def request_record(turn, prompt, calls, pricing, *, output, error, out_of_steps, steps, failed, elapsed):
    """One request's outcome in run_session.py's record layout."""
    usages = [{"input_tokens": c["input"], "output_tokens": c["output"], "cached_tokens": c["cached"],
               "cache_creation_tokens": c.get("cache_creation", 0), "reasoning_tokens": c["reasoning"]} for c in calls]
    costs = [cost_for_usage(usage, pricing) for usage in usages]
    completed = error is None and output is not None
    return {
        "turn_id": turn, "prompt": prompt, "completed": completed, "answer": answer_text(output) if completed else "",
        "end": "answer" if completed and not out_of_steps else "max_steps" if out_of_steps else "error",
        "error": error, "llm_calls": len(usages),
        "usage": {key: sum(u[key] for u in usages) for key in
                  ("input_tokens", "output_tokens", "cached_tokens", "cache_creation_tokens", "reasoning_tokens")},
        "cost_usd": sum(costs) if None not in costs else None,
        "max_input_tokens": max((u["input_tokens"] for u in usages), default=0),
        "dataflow_calls": 0, "steps": steps, "failed_steps": failed, "elapsed_seconds": round(elapsed, 1),
    }


def run(prepared, out, model, kramabench_path, turns=None, spend_limit=5.0, max_steps=None, select=None):
    import smolagents
    from smolagents import CodeAgent
    from smolagents.local_python_executor import CodeOutput, PythonExecutor
    from smolagents.memory import ActionStep, TaskStep
    from smolagents.monitoring import LogLevel
    from smolagents.utils import AgentMaxStepsError

    code_agent, kb_revision = kramabench(kramabench_path)

    class RecordingModel(code_agent.UsageTrackingOpenAIModel):
        """KramaBench's model wrapper, also keeping each call's token counts."""

        def reset_usage(self):
            super().reset_usage()
            self.calls = []

        def _track(self, msg):
            before = dict(self.usage_acc)
            super()._track(msg)
            if self.usage_acc["calls"] > before["calls"]:
                self.calls.append({key: self.usage_acc[key] - before[key]
                                   for key in ("input", "cached", "cache_creation", "output", "reasoning")})

    out.mkdir(parents=True, exist_ok=False)
    selector = SELECTIONS[select] if select else None
    gold = load(prepared / "gold.json") if selector else None
    manifest = load(prepared / "manifest.json")
    prompts = load(prepared / "prompts.json")[:turns]
    imports = available_imports(code_agent.AUTHORIZED_IMPORTS)
    pricing = current_price_schedule(model)
    gateway = os.environ["LITELLM_BASE_URL"].rstrip("/") + "/v1"
    model_client = RecordingModel(model_id=model, api_base=gateway, api_key=os.environ["LITELLM_MASTER_KEY"])
    interpreter = make_interpreter_class(PythonExecutor, CodeOutput)(manifest["task"], out / "sandbox", imports)
    agent = CodeAgent(tools=[], model=model_client, additional_authorized_imports=imports, executor=interpreter,
                      verbosity_level=LogLevel.OFF, **({"max_steps": max_steps} if max_steps else {}))
    save(out / "protocol.json", {
        "prepared": str(prepared.resolve()), "arm": f"smolagents-{select}" if select else "smolagents", "model": model,
        "turns": len(prompts), "selection": select,
        "settings": {"smolagents": smolagents.__version__, "max_steps": agent.max_steps, "instructions": None,
                     "kramabench_revision": kb_revision, "python": sys.version.split()[0],
                     "authorized_imports": imports, "request_text": "prepared prompts.json"},
        "spend_limit_usd": spend_limit,
        "source_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "source_status": subprocess.check_output(["git", "status", "--short", "--", "benchmark"], cwd=ROOT, text=True),
        "started": datetime.now(timezone.utc).isoformat()})
    save(out / "system-info.json", {"systemPrompt": agent.system_prompt})
    records, spent, first = [], 0.0, True
    # Each request's memory steps (its task and actions), so a selection can rebuild memory from them.
    request_steps = {}
    try:
        for entry in prompts:
            if spent >= spend_limit:
                print(json.dumps({"stopped": "spend limit", "spent_usd": spent}), flush=True)
                break
            selected = selector(gold, entry["turn_id"]) if selector else None
            prompt = entry["prompt"] + selection_note(selected, entry["turn_id"])
            if selected is not None:
                # Memory holds only the chosen requests; the interpreter's variables all stay.
                agent.memory.steps = [step for turn in selected for step in request_steps.get(turn, [])]
            start = 0 if first else len(agent.memory.steps)
            calls_before, started = len(model_client.calls), time.monotonic()
            output = error = None
            try:
                output = agent.run(prompt, reset=first)
            except (Exception, SessionLost, SystemExit) as failure:
                error = f"{type(failure).__name__}: {failure}"
            first = False
            steps = agent.memory.steps[start:]
            request_steps[entry["turn_id"]] = list(steps)
            actions = [step for step in steps if isinstance(step, ActionStep)]
            out_of_steps = bool(actions) and isinstance(actions[-1].error, AgentMaxStepsError)
            folder = out / f"t{entry['turn_id']:02d}"
            folder.mkdir(parents=True, exist_ok=True)
            with gzip.open(folder / "steps.json.gz", "wt") as stream:
                json.dump([step_trace(step, TaskStep, ActionStep) for step in steps], stream, ensure_ascii=False,
                          default=str)
            for step in actions:
                # Each step keeps the full messages it was sent; over a session
                # that is quadratic. Later requests are built from the steps.
                step.model_input_messages = None
            record = request_record(entry["turn_id"], prompt, model_client.calls[calls_before:], pricing,
                                    output=output, error=error, out_of_steps=out_of_steps, steps=len(actions),
                                    failed=sum(step.error is not None for step in actions) - out_of_steps,
                                    elapsed=time.monotonic() - started)
            if selected is not None:
                record["context_requests"] = selected
            save(folder / "record.json", record)
            records.append(record)
            save(out / "records.json", records)
            spent += record["cost_usd"] or 0.0
            print(json.dumps({"turn": entry["turn_id"], "completed": record["completed"], "end": record["end"],
                              "calls": record["llm_calls"], "cost_usd": record["cost_usd"],
                              "seconds": record["elapsed_seconds"]}), flush=True)
            # A lost interpreter takes the session's variables with it: stop.
            if error and error.startswith("SessionLost"):
                break
    finally:
        interpreter.cleanup()
        save(out / "cleanup.json", {"interpreter": "stopped"})
    return records


def step_trace(step, TaskStep, ActionStep):
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


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--prepared", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model", default="gpt-5.6-luna")
    parser.add_argument("--kramabench", type=Path, default=os.environ.get("KRAMABENCH_ROOT", ROOT / "benchmark/Kramabench"),
                        help="a KramaBench checkout at the pinned revision (default: the submodule, or KRAMABENCH_ROOT)")
    parser.add_argument("--turns", type=int)
    parser.add_argument("--spend-limit", type=float, default=5.0)
    parser.add_argument("--max-steps", type=int, help="default: smolagents' own (20 a request)")
    parser.add_argument("--select", choices=sorted(SELECTIONS), help="show each request only these earlier requests")
    args = parser.parse_args()
    if current_price_schedule(args.model) is None:
        raise SystemExit(f"No price schedule for {args.model}; costs would be unknown")
    run(args.prepared, args.out, args.model, args.kramabench, args.turns, args.spend_limit, args.max_steps, args.select)


if __name__ == "__main__":
    main()
