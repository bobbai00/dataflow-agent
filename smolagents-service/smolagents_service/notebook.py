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

"""A Jupyter notebook read as the agent's own earlier work.

The markdown before the first code cell is the task the notebook answers, the
markdown above each code cell is the reasoning that led to it, and the markdown
after the last code cell is the answer. `ChatSession.import_notebook` runs the
cells in the session's interpreter and adds them to the agent's memory as steps.
"""

import ast
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

MAGIC = re.compile(r"^(\s*)([%!])", re.MULTILINE)  # IPython's %magic and !shell lines
PYTHON_CELL_MAGICS = {"%%time", "%%timeit", "%%capture"}  # cell magics whose body is Python
READERS = re.compile(r"read_\w+|open|load|loadtxt|genfromtxt|imread")  # calls whose first argument is a file read
WRITERS = re.compile(r"to_\w+|save\w*|write_\w+")
FILE_NAME = re.compile(r"[^:]*\.[A-Za-z0-9]{1,10}")  # a path with a suffix, not a URL or a query


@dataclass
class Cell:
    number: int
    code: str
    thought: str = ""  # the markdown above the cell


@dataclass
class Notebook:
    task: str
    cells: list[Cell] = field(default_factory=list)
    answer: str = ""


def read_notebook(path: Path) -> Notebook:
    """The notebook at `path`; ValueError when it is not one or has no code to run."""
    try:
        cells = json.loads(Path(path).read_text(encoding="utf-8", errors="replace"))["cells"]
    except (json.JSONDecodeError, KeyError, TypeError) as bad:
        raise ValueError("not a Jupyter notebook") from bad
    task, code_cells, pending = "", [], []
    for cell in cells:
        source = "".join(cell.get("source", [])).strip()
        if cell.get("cell_type") == "markdown" and source:
            pending.append(source)
        elif cell.get("cell_type") == "code" and source:
            thought, pending = "\n\n".join(pending), []
            if not code_cells:
                task, thought = thought, ""
            code_cells.append(Cell(len(code_cells) + 1, without_magics(source), thought))
    if not code_cells:
        raise ValueError("the notebook has no code cells")
    return Notebook(task=task, cells=code_cells, answer="\n\n".join(pending))


def parses(code: str) -> bool:
    try:
        ast.parse(code)
    except SyntaxError:
        return False
    return True


def without_magics(code: str) -> str:
    """A cell with its IPython-only lines (`%matplotlib inline`, `!pip install ...`) commented out,
    when that is what keeps it from being plain Python; any other cell as it is, a `%%bash` cell
    included, to fail as it runs."""
    if parses(code) or (code.startswith("%%") and code.split(None, 1)[0] not in PYTHON_CELL_MAGICS):
        return code
    commented = MAGIC.sub(r"\1# \2", code)
    return commented if parses(commented) else code


def files_read(notebook: Notebook) -> list[str]:
    """The files the cells read by a literal name, as `pd.read_csv("listings.csv")` or
    `open("notes.txt")` do, leaving out any the cells write themselves."""
    read, written = [], set()
    for cell in notebook.cells:
        try:
            tree = ast.parse(cell.code)
        except SyntaxError:
            continue
        for call in (node for node in ast.walk(tree) if isinstance(node, ast.Call) and node.args):
            name = call.args[0].value if isinstance(call.args[0], ast.Constant) else None
            if not isinstance(name, str) or not FILE_NAME.fullmatch(name):
                continue
            called = call.func.attr if isinstance(call.func, ast.Attribute) else getattr(call.func, "id", "")
            modes = call.args[1:2] + [keyword.value for keyword in call.keywords if keyword.arg == "mode"]
            opened_to_write = called == "open" and any(
                isinstance(mode, ast.Constant) and set("wax+") & set(str(mode.value)) for mode in modes)
            if WRITERS.fullmatch(called) or opened_to_write:
                written.add(name)
            elif READERS.fullmatch(called) and name not in read:
                read.append(name)
    return [name for name in read if name not in written]


def missing_files(notebook: Notebook, folder: Path) -> list[str]:
    """The files the notebook reads (see `files_read`) that are not in `folder`, where its cells run."""
    folder = folder.resolve()
    return [name for name in files_read(notebook)
            if not ((folder / name).resolve().is_relative_to(folder) and (folder / name).exists())]


def observation_of(reply: dict) -> str:
    """What a cell printed and returned, worded as smolagents words a step's observation."""
    printed = reply.get("output") or ""
    if printed and not printed.endswith("\n"):
        printed += "\n"
    if reply.get("error"):
        return f"Execution logs:\n{printed}"
    value = reply.get("value")
    return f"Execution logs:\n{printed}Last output from code snippet:\n{'None' if value is None else value}"
