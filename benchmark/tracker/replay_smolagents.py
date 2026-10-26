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
"""Replay recorded smolagents conversations in one session and record its memory after every step.

The agent is the benchmarks' script baseline, built by KramaBench's CodeAgentWrapper with each conversation's
settings, and runs every conversation with `reset=False`, as the smolagents service continues a chat. Its model
returns the recorded responses in order, and its executor returns what each step's code printed, returned or raised,
so no model is called and no code runs: the memory measured is the agent's history, without execution variables.

    .venv/bin/python benchmark/tracker/replay_smolagents.py CONVERSATIONS.jsonl OUT.jsonl [--limit N] [--kramabench DIR]

Each output line is one step: steps so far, the Python memory traced after a full collection, minus the memory
before the first conversation, and the characters of the step's model input.
"""
import argparse
import gc
import json
import sys
import time
import tracemalloc
from pathlib import Path

from openai.types.chat import ChatCompletion
from smolagents.local_python_executor import CodeOutput, InterpreterError, LocalPythonExecutor, PrintContainer
from smolagents.agent_types import handle_agent_output_types
from smolagents.memory import ActionStep

REPO = Path(__file__).resolve().parents[2]

LOGS, OUTPUT = "Execution logs:\n", "Last output from code snippet:\n"


class Replay:
    """The recorded conversation being replayed: its responses and steps, and the model call reached."""

    def __init__(self):
        self.conversation = None
        self.call = 0

    def start(self, conversation):
        self.conversation, self.call = conversation, 0

    def respond(self, **_request):
        responses = self.conversation["responses"]
        self.call += 1
        if self.call <= len(responses):
            recorded = responses[self.call - 1]
            choices, usage, model = recorded["choices"], recorded["usage"], recorded["model"]
        else:
            # The replay asked for more calls than the run made: end the task.
            choices = [{"index": 0, "finish_reason": "stop",
                        "message": {"role": "assistant", "content": "<code>\nfinal_answer('replay ended')\n</code>"}}]
            usage, model = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}, "replay"
        return ChatCompletion.model_validate(
            {"id": f"replay-{self.call}", "object": "chat.completion", "created": 0, "model": model,
             "choices": choices, "usage": usage}
        )

    def execute(self, executor, _code):
        """What the recorded step's code printed and returned, or the error it raised."""
        steps = self.conversation["steps"]
        if self.call > len(steps):
            return CodeOutput(output="replay ended", logs="", is_final_answer=True)
        step = steps[self.call - 1]
        text = step["observations"] or ""
        logs = text.removeprefix(LOGS)
        cut = logs.rfind(OUTPUT)
        output = logs[cut + len(OUTPUT):] if cut >= 0 else None
        logs = logs[:cut] if cut >= 0 else logs
        if step["error"]:
            executor.state["_print_outputs"] = PrintContainer()
            executor.state["_print_outputs"] += logs
            raise InterpreterError(step["error"]["message"])
        if step["is_final_answer"]:
            output = step["action_output"]
        return CodeOutput(output=output, logs=logs, is_final_answer=step["is_final_answer"])


def traced():
    gc.collect()
    return tracemalloc.get_traced_memory()[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("conversations", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--kramabench", type=Path, default=REPO / "benchmark" / "Kramabench",
                        help="the KramaBench checkout whose code_agent.py builds the baseline")
    args = parser.parse_args()
    sys.path.insert(0, str(args.kramabench))
    from code_agent import CodeAgentWrapper
    conversations = [json.loads(line) for line in args.conversations.read_text().splitlines()]
    if args.limit:
        conversations = conversations[: args.limit]

    replay = Replay()
    LocalPythonExecutor.__call__ = lambda executor, code: replay.execute(executor, code)
    # No code runs, so the baseline's imports (fiona, ...) need not be installed in this interpreter.
    LocalPythonExecutor._check_authorized_imports_are_installed = lambda executor: None
    tracemalloc.start()
    settings = conversations[0]["settings"]
    wrapper = CodeAgentWrapper(
        model_type="replay", api_base="http://127.0.0.1:9", api_key="replay", verbosity_level=-1,
        max_steps=settings["max_steps"], use_custom_prompt=settings["use_custom_prompt"],
        use_fine_grained_prompt=settings["use_fine_grained_prompt"], use_pitfalls_prompt=settings["use_pitfalls_prompt"],
        max_print_outputs_length=settings["max_print_outputs_length"], no_action_detail=settings["no_action_detail"],
    ).setup()
    agent, model = wrapper._agent, wrapper._model
    model.client.chat.completions.create = replay.respond

    steps = 0
    started = time.monotonic()
    with args.out.open("w") as sink:

        def record(step, agent=None):
            nonlocal steps
            steps += 1
            chars = sum(len(json.dumps(message.dict()["content"])) for message in step.model_input_messages or [])
            sink.write(json.dumps({"conversation": replay.conversation["id"], "steps": steps,
                                   "bytes": traced() - base, "inputChars": chars}) + "\n")

        agent.step_callbacks.register(ActionStep, record)
        # The first final answer that is not a string imports torch (agent_types.handle_agent_output_types): a fixed
        # cost, not history.
        handle_agent_output_types(0)
        base = traced()
        sink.write(json.dumps({"steps": 0, "bytes": 0, "base": base}) + "\n")
        for index, conversation in enumerate(conversations, 1):
            replay.start(conversation)
            agent.run(conversation["prompt"], reset=False)
            sink.flush()
            print(f"{index}/{len(conversations)} {conversation['id']}: {steps} steps, "
                  f"{(traced() - base) / 2**20:.1f} MiB, {time.monotonic() - started:.0f} s", flush=True)


if __name__ == "__main__":
    main()
