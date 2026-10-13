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
and reads one JSON line back. Two more requests read the session's state
without changing it: `describe` lists the variables (type, shape, columns and
a fingerprint of the value) and the functions the code defined; `render`
shows chosen variables' current values, as the dataflow agent's context shows
a table's result.

    python smolagents_worker.py '{"authorized_imports": [...], "max_print_outputs_length": null}'
"""
import hashlib
import json
import os
import pickle
import resource
import sys
import types

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


FINGERPRINT_CELLS = 2_000_000  # larger frames are fingerprinted on evenly spaced rows
WHOLE_ROWS, SAMPLE_ROWS, CELL_CHARS = 12, 3, 160


def _defined_by_code(value):
    """A function or lambda the agent's code made: smolagents builds them in its own module."""
    return callable(value) and (getattr(value, "__module__", "") or "").startswith("smolagents")


def fingerprint(value):
    """A short digest of a value, to tell whether a task changed it."""
    try:
        import pandas as pd
        if isinstance(value, (pd.DataFrame, pd.Series)):
            cells = len(value) * (value.shape[1] if value.ndim == 2 else 1)
            sample = value.iloc[::max(1, cells // FINGERPRINT_CELLS)]
            try:
                digest = pd.util.hash_pandas_object(sample, index=True).values.tobytes()
            except TypeError:  # unhashable cells, such as lists
                digest = pd.util.hash_pandas_object(sample.astype(str), index=True).values.tobytes()
            columns = list(map(str, value.columns)) if value.ndim == 2 else [str(value.name)]
            return hashlib.sha1(repr((value.shape, columns)).encode() + digest).hexdigest()[:16]
    except Exception:  # noqa: BLE001 - a value that cannot be digested this way falls through
        pass
    try:
        data = pickle.dumps(value, protocol=4)
    except Exception:  # noqa: BLE001
        data = repr(value)[:200_000].encode()
    return hashlib.sha1(data).hexdigest()[:16]


def describe_state(state, functions):
    """The session's variables and the names of the functions its code defined."""
    variables, defined = {}, sorted(functions)
    for name, value in state.items():
        if name.startswith("_") or isinstance(value, types.ModuleType):
            continue
        if callable(value) and not hasattr(value, "shape"):
            if _defined_by_code(value):
                defined.append(name)
            continue  # imported classes and functions are the interpreter's, not state
        info = {"type": type(value).__name__, "fingerprint": fingerprint(value)}
        shape = getattr(value, "shape", None)
        if isinstance(shape, tuple) and len(shape) == 2:
            info["shape"] = [int(shape[0]), int(shape[1])]
        elif hasattr(value, "__len__") and not isinstance(value, (str, bytes)):
            try:
                info["shape"] = len(value)
            except TypeError:
                pass
        columns = getattr(value, "columns", None)
        if columns is not None and hasattr(value, "dtypes"):
            info["columns"] = [[str(c), str(t)] for c, t in list(value.dtypes.items())[:200]]
        variables[name] = info
    return {"variables": variables, "functions": sorted(set(defined))}


def _cell(value):
    text = str(value)
    return text if len(text) <= CELL_CHARS else text[:CELL_CHARS - 1] + "…"


def render_value(value, limit=1000):
    """A value as the context shows it: its type and shape, a frame's columns,
    then the whole value when small, else a few rows; clipped to `limit`
    characters (twice that for a whole small table)."""
    import pandas as pd
    if isinstance(value, pd.Series):
        value = value.to_frame(name=str(value.name) if value.name is not None else "value")
    if isinstance(value, pd.DataFrame):
        rows, width = value.shape
        whole = rows <= WHOLE_ROWS
        head = [f"DataFrame: {rows:,} rows × {width:,} columns",
                "columns: " + ", ".join(f"{c} {t}" for c, t in value.dtypes.items())]
        shown = value if whole else value.head(SAMPLE_ROWS)
        budget = 2 * limit if whole else limit
        lines, used = [], 0
        index_named = not isinstance(value.index, pd.RangeIndex)
        for key, row in shown.iterrows():
            parts = ([f"index: {_cell(key)}"] if index_named else []) + [f"{c}: {_cell(v)}" for c, v in row.items()]
            line = "- " + ", ".join(parts)
            if used + len(line) > budget:
                lines.append(f"- … (cut at {budget:,} characters)")
                break
            lines.append(line)
            used += len(line)
        label = f"all {rows:,} rows:" if whole else f"first {len(shown)} of {rows:,} rows:"
        return "\n".join(head + [label] + lines)
    text = repr(value)
    size = f", {len(value):,} items" if hasattr(value, "__len__") and not isinstance(value, str) else ""
    shape = getattr(value, "shape", None)
    if isinstance(shape, tuple):
        size = f", shape {shape}"
    clipped = text if len(text) <= limit else text[:limit - 1] + "…"
    return f"{type(value).__name__}{size}: {clipped}"


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
        message = json.loads(line)
        if "describe" in message or "render" in message:
            try:
                if "describe" in message:
                    answer = describe_state(executor.state, executor.custom_tools)
                else:
                    answer = {"rendered": {name: render_value(executor.state[name])
                                           for name in message["render"] if name in executor.state}}
            except BaseException as error:  # noqa: BLE001 - reading state must not end the session
                if isinstance(error, KeyboardInterrupt):
                    raise
                answer = {"error": f"{type(error).__name__}: {error}"}
            reply.write(json.dumps(answer, default=str) + "\n")
            reply.flush()
            continue
        code = message["code"]
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
