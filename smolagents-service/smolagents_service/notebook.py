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

import json
from dataclasses import dataclass, field
from pathlib import Path


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
            code_cells.append(Cell(len(code_cells) + 1, source, thought))
    if not code_cells:
        raise ValueError("the notebook has no code cells")
    return Notebook(task=task, cells=code_cells, answer="\n\n".join(pending))


def observation_of(reply: dict) -> str:
    """What a cell printed and returned, worded as smolagents words a step's observation."""
    printed = reply.get("output") or ""
    if printed and not printed.endswith("\n"):
        printed += "\n"
    if reply.get("error"):
        return f"Execution logs:\n{printed}"
    value = reply.get("value")
    return f"Execution logs:\n{printed}Last output from code snippet:\n{'None' if value is None else value}"
