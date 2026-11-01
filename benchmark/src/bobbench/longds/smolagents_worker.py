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
"""The Python side of a sandboxed smolagents session.

Hosts smolagents' own `LocalPythonExecutor`, so the agent's code runs under the
library's interpreter and its rules, in a process that sees only the session's
data and a scratch folder and has no network. `smolagents_session.py` starts it
and holds the model client outside; it sends each code action as one JSON line
and reads one JSON line back.

    python smolagents_worker.py '{"authorized_imports": [...], "max_print_outputs_length": null}'
"""
import json
import os
import resource
import sys

# Address space of the interpreter. Code that outgrows it fails its step with
# a MemoryError and the session goes on; without a cap, one exploding join took
# 9 GB and the machine's out-of-memory daemon ended the session.
MEMORY_GB = 6


def plain(value):
    """A JSON form for what `json` cannot write: NumPy scalars and arrays as
    numbers and lists, anything else as its text."""
    if getattr(value, "ndim", None) == 0 and callable(getattr(value, "item", None)):
        return value.item()
    if callable(getattr(value, "tolist", None)):
        return value.tolist()
    return str(value)


def final_value(output):
    try:
        return json.loads(json.dumps(output, default=plain))
    except (TypeError, ValueError):  # for example a dict keyed by tuples
        return str(output)


def main():
    settings = json.loads(sys.argv[1])
    limit = int(settings.get("memory_gb", MEMORY_GB) * 2**30)
    resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    # The protocol keeps its own descriptor. Whatever a library writes to
    # stdout or stderr goes to the scratch folder's log instead of the pipe.
    reply = os.fdopen(os.dup(1), "w")
    log = os.open("worker.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    os.dup2(log, 1)
    os.dup2(log, 2)

    from smolagents import FinalAnswerTool
    from smolagents.local_python_executor import LocalPythonExecutor

    executor = LocalPythonExecutor(
        settings["authorized_imports"],
        max_print_outputs_length=settings.get("max_print_outputs_length"),
        additional_functions={"open": open},
    )
    executor.send_tools({"final_answer": FinalAnswerTool()})
    reply.write(json.dumps({"ready": True}) + "\n")
    reply.flush()
    for line in sys.stdin:
        code = json.loads(line)["code"]
        try:
            result = executor(code)
            answer = {
                # The agent shows `str(output)` after each step; keep that text
                # exact. A final answer also travels as a JSON value, so that a
                # dict of NumPy numbers is recorded as numbers.
                "text": str(result.output),
                "value": final_value(result.output) if result.is_final_answer else None,
                "logs": result.logs,
                "is_final_answer": result.is_final_answer,
            }
        # Model code may call sys.exit(); it must fail that step, not end the session.
        except BaseException as error:  # noqa: BLE001
            if isinstance(error, KeyboardInterrupt):
                raise
            answer = {"error": str(error), "logs": str(executor.state.get("_print_outputs", ""))}
        reply.write(json.dumps(answer) + "\n")
        reply.flush()


if __name__ == "__main__":
    main()
