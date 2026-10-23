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

"""The interpreter process behind one chat session.

Hosts smolagents' own `LocalPythonExecutor`, so model-written code runs under the
library's interpreter and its import rules, in a process of its own: a session's
variables, its matplotlib figures and a crash stay with that session. The server
starts it in the user's files folder (under a sandbox profile where the platform
has one) and sends each request as one JSON line; the reply is one JSON line with
the output, the execution time measured here, and every figure the code left open
as a base64 PNG. Adapted from benchmark/longds/smolagents_worker.py.

Two kinds of request share one namespace, the interpreter's state:

    {"code": ...}                                 the agent's code, through smolagents' interpreter
    {"code": ..., "mode": "python", "name": ...}  the user's own code, run as plain Python so any
                                                  existing script runs, when a sandbox contains the
                                                  process ("plain_user_code"); else through
                                                  smolagents' interpreter like the agent's

    python -I worker.py '{"authorized_imports": [...], "max_print_outputs_length": null}'

Stand-alone on purpose: it runs with `python -I` and imports nothing from the service.
"""

import ast
import base64
import builtins
import contextlib
import io
import json
import linecache
import os
import resource
import sys
import threading
import time
import traceback
import types
import warnings

MEMORY_GB = 4


def plain(value):
    """A JSON form for what `json` cannot write: NumPy scalars and arrays as numbers and lists, else text."""
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


def open_figures():
    """Every figure the code left open, as base64 PNGs; closes them."""
    import matplotlib.pyplot as plt

    images = []
    for number in plt.get_fignums():
        buffer = io.BytesIO()
        plt.figure(number).savefig(buffer, format="png", dpi=100, bbox_inches="tight")
        images.append(base64.b64encode(buffer.getvalue()).decode())
    plt.close("all")
    return images


def describe(value) -> str:
    """A variable as the agent should hear about it: its type, and its shape or length."""
    kind = type(value).__name__
    shape = getattr(value, "shape", None)
    if isinstance(shape, tuple) and shape:
        return f"{kind}, {'×'.join(str(n) for n in shape)}"
    if isinstance(value, (list, dict, set, tuple, str)):
        return f"{kind}, length {len(value)}"
    return kind


def user_traceback(error: BaseException, name: str) -> str:
    """The traceback from the user's own code only, without this worker's frames."""
    report = traceback.TracebackException.from_exception(error)
    report.stack = traceback.StackSummary.from_list([frame for frame in report.stack if frame.filename == name])
    return "".join(report.format())


def display(*values):
    """Jupyter's display(), for notebook code: each value printed, as the cell's output."""
    for value in values:
        print(value)


# The user's code sees Python's builtins and Jupyter's display(); the agent's interpreter does not.
USER_BUILTINS = {**vars(builtins), "display": display}


def run_python(state: dict, code: str, name: str) -> dict:
    """Run the user's code as plain Python in the session's namespace, notebook-style:
    prints are captured, a trailing expression is shown, and variables persist.

    The code runs in `state` itself, as a notebook cell runs in its kernel's globals, so a
    function or class it defines sees the variables later code sets, the agent's included,
    and `del` and `global` act on the session. What ran before an error is kept."""
    linecache.cache[name] = (len(code), None, code.splitlines(True), name)  # source lines in tracebacks
    before = dict(state)  # holds the old values, so that a rebound name is told apart by identity
    state.update(__name__="__main__", __file__=name, __builtins__=USER_BUILTINS)
    printed, answer = io.StringIO(), {}
    try:
        tree = ast.parse(code, filename=name)
        last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
        with contextlib.redirect_stdout(printed), contextlib.redirect_stderr(printed):
            exec(compile(tree, name, "exec"), state)
            if last is not None:
                value = eval(compile(ast.Expression(last.value), name, "eval"), state)
                if value is not None:
                    answer["value"] = repr(value)
    except BaseException as error:  # noqa: BLE001 - SystemExit too: the session goes on
        if isinstance(error, KeyboardInterrupt):
            raise
        answer["error"] = user_traceback(error, name)
    finally:
        # Functions keep the builtins they were defined with; the agent's interpreter never saw any.
        state.pop("__builtins__", None)
    changed = {key: value for key, value in state.items()
               if not key.startswith("__") and (key not in before or before[key] is not value)}
    answer["output"] = printed.getvalue()
    answer["variables"] = {key: describe(value) for key, value in changed.items()
                           if not isinstance(value, types.ModuleType)}
    return answer


def run_restricted(executor, code: str) -> dict:
    """The user's code through smolagents' interpreter, as the agent's code runs: for when no
    sandbox stands behind plain Python."""
    before = {key: id(value) for key, value in executor.state.items()}
    answer = {}
    try:
        result = executor(code)
        answer["output"] = result.logs
        if result.output is not None:
            answer["value"] = repr(result.output)
    except BaseException as error:  # noqa: BLE001
        if isinstance(error, KeyboardInterrupt):
            raise
        answer["output"] = str(executor.state.get("_print_outputs", ""))
        answer["error"] = str(error)
    changed = {key: value for key, value in executor.state.items()
               if not key.startswith("_") and before.get(key) != id(value)}
    answer["variables"] = {key: describe(value) for key, value in changed.items()
                           if not isinstance(value, types.ModuleType)}
    return answer


def exit_with_parent():
    """Code that never returns would keep this process alive after the server is gone."""
    parent = os.getppid()
    while os.getppid() == parent:
        time.sleep(2)
    os._exit(1)


def main():
    settings = json.loads(sys.argv[1])
    try:
        limit = int(settings.get("memory_gb", MEMORY_GB) * 2**30)
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    except (ValueError, OSError):  # macOS does not enforce RLIMIT_AS
        pass
    # The protocol keeps its own descriptors. Code reading stdin (input()) gets end of file
    # instead of the server's next request; whatever a library prints goes to the log.
    requests = os.fdopen(os.dup(0), "r")
    reply = os.fdopen(os.dup(1), "w")
    os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
    sys.stdin = open(os.devnull)
    os.makedirs(".worker", exist_ok=True)
    log = os.open(".worker/worker.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    os.dup2(log, 1)
    os.dup2(log, 2)
    threading.Thread(target=exit_with_parent, daemon=True).start()

    import matplotlib

    matplotlib.use("Agg")
    # Scripts end in plt.show(); here the open figures are sent back instead.
    warnings.filterwarnings("ignore", message="FigureCanvasAgg is non-interactive")
    from smolagents import FinalAnswerTool
    from smolagents.local_python_executor import LocalPythonExecutor

    executor = LocalPythonExecutor(settings["authorized_imports"],
                                   max_print_outputs_length=settings.get("max_print_outputs_length"))
    executor.send_tools({"final_answer": FinalAnswerTool()})
    reply.write(json.dumps({"ready": True}) + "\n")
    reply.flush()
    for line in requests:
        request = json.loads(line)
        code = request["code"]
        started = time.perf_counter()
        if request.get("mode") == "python" and settings.get("plain_user_code"):
            answer = run_python(executor.state, code, request.get("name") or "<code>")
        elif request.get("mode") == "python":
            answer = run_restricted(executor, code)
        else:
            try:
                result = executor(code)
                answer = {
                    "output": final_value(result.output) if result.is_final_answer else str(result.output),
                    "logs": result.logs,
                    "is_final_answer": result.is_final_answer,
                }
            # Model code may call sys.exit(); it must fail that step, not end the session.
            except BaseException as error:  # noqa: BLE001
                if isinstance(error, KeyboardInterrupt):
                    raise
                answer = {"error": str(error), "logs": str(executor.state.get("_print_outputs", ""))}
        answer["seconds"] = time.perf_counter() - started
        try:
            answer["figures"] = open_figures()
        except Exception as error:  # noqa: BLE001 - a figure that cannot render must not lose the step
            answer["figures"], answer["figure_error"] = [], str(error)
        reply.write(json.dumps(answer) + "\n")
        reply.flush()


if __name__ == "__main__":
    main()
