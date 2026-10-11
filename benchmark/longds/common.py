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
"""Paths, files and trace reading shared by the LongDS session tools."""
import ast
import gzip
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
# The upstream checkout (github.com/DataMind-Lab, not vendored): tasks, gold
# answers, session data, and the judge prompt.
DATAMIND = HERE / "DataMind" / "longds"
TASKS = DATAMIND / "dataset" / "task" / "longds_v1.1"
DATA = DATAMIND / "dataset" / "data" / "longds"
JUDGE_PROMPT = DATAMIND / "runners" / "DSGym" / "scripts" / "prompt.py"


def save(path, value):
    """Write JSON atomically."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    tmp.replace(path)


def load(path):
    path = Path(path)
    if path.suffix == ".gz":
        with gzip.open(path, "rt") as stream:
            return json.load(stream)
    return json.loads(path.read_text())


def session_key(task):
    """`sports/nfl_big_data_bowl_2023/task1` as a folder name."""
    return task.strip("/").replace("/", "__")


# ---------------------------------------------------------------------------
# Statements, as the dataflow tool takes them


_KEYWORDS = ("set ", "delete ", "execute", "show ")


def statement_blocks(text):
    """The statements of one call, one string per statement. A statement starts
    at a line beginning with a command; anything else continues the one before."""
    blocks = []
    for line in (text or "").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith(_KEYWORDS) or stripped == "execute" or not blocks:
            blocks.append(stripped)
        else:
            blocks[-1] += "\n" + line
    return blocks


_SET = re.compile(r"^set\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$", re.DOTALL)


def parse_set(block):
    """`set id: op(inputs, k=v)` as {id, op, inputs, settings}, or None.

    Inputs are the positional names; settings are the keyword arguments, as
    literal values where they are literals and as source text otherwise.
    """
    match = _SET.match(block)
    if not match:
        return None
    target, expression = match.groups()
    try:
        call = ast.parse(expression.strip(), mode="eval").body
    except SyntaxError:
        return None
    if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Name):
        return None
    settings = {}
    for keyword in call.keywords:
        if keyword.arg is None:
            continue
        try:
            settings[keyword.arg] = ast.literal_eval(keyword.value)
        except ValueError:
            settings[keyword.arg] = ast.unparse(keyword.value)
    return {"id": target, "op": call.func.id,
            "inputs": [arg.id for arg in call.args if isinstance(arg, ast.Name)], "settings": settings}


def parse_delete(block):
    match = re.match(r"^delete\s+([A-Za-z_][A-Za-z0-9_]*)\s*$", block)
    return match.group(1) if match else None


def python_functions(source):
    """Public top-level functions in a call's `python`: name -> keyword-only
    parameter names (the settings a statement can pass)."""
    try:
        tree = ast.parse(source or "")
    except SyntaxError:
        return {}
    return {node.name: [arg.arg for arg in node.args.kwonlyargs]
            for node in tree.body
            if isinstance(node, ast.FunctionDef) and not node.name.startswith("_")}


# ---------------------------------------------------------------------------
# Traces


def committed_calls(steps):
    """Each dataflow call of `steps` with whether its edits were applied: a
    call's `set` and `delete` lines apply together or not at all."""
    calls = []
    for step in steps:
        results = {result.get("toolCallId"): result.get("output") for result in step.get("toolResults") or []}
        for call in step.get("toolCalls") or []:
            if call.get("toolName") != "dataflow":
                continue
            output = results.get(call.get("toolCallId")) or {}
            edits = [item for item in output.get("actions", []) if (item.get("action") or {}).get("type") == "edit"]
            calls.append({"input": call.get("input") or {},
                          "applied": bool(edits) and all(item.get("status") == "ok" for item in edits),
                          "status": output.get("status")})
    return calls
