#!/usr/bin/env python
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

"""Per-turn inputs for the gold-prefix protocol, from a `gold_state.py` manifest.

For every turn t >= 2 whose turns 1..t-1 replayed exactly, writes under
`<out>/turns/tNN/`:

  prefix.md        the completed tasks 1..t-1: request, reference solution,
                   gold answer and the tables each one created or changed.
                   Byte-identical for both arms.
  state.json       every table in force after task t-1 (latest version), with
                   rows, columns, parents and the saved file.
  seed.changes     the dataflow arm's edit program: one `scan` per saved table,
                   including each list or set the solutions keep (a membership
                   list such as the qualified markets), saved as a one-column
                   parquet file under `collections/`.
  rules.md         optional: the conventions in force, written by
                   `gold_prefix_rules.py`; included in both arms when present.
  seed_kernel.py   the script arm's kernel preamble: the reference code of
                   turns 1..t-1, output suppressed, so the kernel holds the
                   reference variables and helpers.
  question.txt     the current request, `[Task t]` + context + question.

`index.json` lists every turn with its labels and eligibility.
"""
import argparse
import json
import re
import sys
from pathlib import Path

from numeric_gate import PRELUDE

HEADER = (
    "# Completed tasks\n\n"
    "Tasks 1-{last} of this analysis were already completed correctly. Each one is shown with its request, the "
    "solution that produced its answer, the answer, and the tables it created or changed "
    "as operator blocks. Their definitions, conventions and rounding rules remain in "
    "force unless a later task changed them. The tables in force after task {last} are loaded as the current state, "
    "with their columns listed; do not rebuild them.\n"
)

#: Column entries shown per table in the state listing; wider tables say how
#: many more. Names only (types come from inspect or retrieve), with numbered
#: families compressed losslessly (`Q6_1..Q6_12`), so a late turn's 80–100
#: tables cost a few thousand characters rather than tens of thousands.
MAX_LISTED_COLUMNS = 16
_NUMBERED = re.compile(r"^(.*?)(\d+)$")


def column_entries(names: list[str]) -> list[str]:
    """Column names with runs of three or more consecutively numbered names
    (`a_1, a_2, a_3` → `a_1..a_3`) compressed; order is kept."""
    out: list[str] = []
    i = 0
    while i < len(names):
        j = i
        m = _NUMBERED.match(names[i])
        if m and str(int(m.group(2))) == m.group(2):
            base, k = m.group(1), int(m.group(2))
            while j + 1 < len(names):
                m2 = _NUMBERED.match(names[j + 1])
                if m2 and m2.group(1) == base and int(m2.group(2)) == k + 1 and str(int(m2.group(2))) == m2.group(2):
                    j += 1
                    k += 1
                else:
                    break
        if j - i >= 2:
            out.append(f"{names[i]}..{names[j]}")
        else:
            out.extend(names[i : j + 1])
        i = j + 1
    return out


def columns_text(frame: dict, limit: int = MAX_LISTED_COLUMNS) -> str:
    entries = column_entries([str(c) for c in (frame.get("columns") or [])])
    shown = entries[:limit] if limit > 0 else entries
    visible = sum(int(_NUMBERED.match(e.split("..")[1]).group(2))
                  - int(_NUMBERED.match(e.split("..")[0]).group(2)) + 1
                  if ".." in e else 1 for e in shown)
    more = max(0, frame["cols"] - visible)
    return ", ".join(shown + ([f"… +{more} more"] if more else []))


def fmt_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def table_line(frame: dict, width: int = 0, with_columns: bool = False) -> str:
    """The shared operator block for a sealed gold-prefix task. Every loaded
    table, a kept list included, is a scan of its materialized file."""
    kind = "scan"
    change = "created" if frame.get("created_turn") == frame.get("changed_turn") else "updated"
    lines = [f"- **{frame['name']}** ({kind}, {change})"]
    if frame.get("parents"):
        lines.append("  - inputs: " + ", ".join(f"`{p}`" for p in frame["parents"]))
    lines.append(f"  - result: {frame['rows']:,} rows × {frame['cols']:,} columns")
    if with_columns:
        lines.append("  - columns: " + columns_text(frame))
    return "\n".join(lines)


def py_literal(items: list) -> str:
    return "[" + ", ".join(json.dumps(i, ensure_ascii=False) if isinstance(i, str) else repr(i) for i in items) + "]"


def collection_frames(turns: list[dict], upto: int) -> list[dict]:
    """Lists and sets of values the solutions keep, as one-column tables: the
    latest version of each in force after turn `upto`. Column-name lists stay
    constants."""
    latest: dict[str, dict] = {}
    for turn in turns:
        if turn["turn_id"] > upto:
            break
        for name, item in (turn.get("collections") or {}).items():
            if item.get("kind") != "values":
                continue
            column = item.get("column") or "value"
            values = item["items"]
            previous = latest.get(name)
            latest[name] = {
                "name": name,
                "rows": len(values),
                "cols": 1,
                "columns": [column],
                "dtypes": ["str" if isinstance(values[0], str) else "int64"],
                # The table whose column matched the items says what the values
                # are, not what the list was derived from; no parent is claimed.
                "parents": [],
                "created_turn": previous["created_turn"] if previous else turn["turn_id"],
                "changed_turn": turn["turn_id"] if previous is None or previous["values"] != values else previous["changed_turn"],
                "kind": "values",
                "column": column,
                "values": values,
            }
    return list(latest.values())


def task_block(turn: dict) -> str:
    changed = [f for f in turn["frames"] if f["changed_this_turn"]]
    # Lists and sets the task kept are tables in the loaded state, not
    # constants: a 300-key membership list printed in full per task would
    # swell the prefix by more than the table it stands for.
    values_names = {n for n, c in (turn.get("collections") or {}).items() if c.get("kind") == "values"}
    changed = changed + [
        {"name": n, "rows": len(c["items"]), "cols": 1, "parents": [], "kind": "values"}
        for n, c in (turn.get("collections") or {}).items()
        if c.get("kind") == "values" and n in turn.get("assigned", []) and n not in {f["name"] for f in changed}
    ]
    width = max([len(f["name"]) for f in changed] + [8])
    lines = [
        f"## Task {turn['turn_id']}",
        turn["context"].strip(),
        f"Question: {turn['question'].strip()}",
        "",
        "Solution:",
        "```python",
        turn["code"].rstrip(),
        "```",
        f"Answer: {fmt_json(turn['replayed_answer'])}",
    ]
    if changed:
        lines.append(f"Tables created or changed by task {turn['turn_id']}:")
        lines.extend(table_line(f, width) for f in changed)
    if turn["constants"]:
        new_constants = {
            k: v for k, v in turn["constants"].items() if k in turn.get("assigned", []) and k not in values_names
        }
        if new_constants:
            lines.append("Constants set: " + "; ".join(f"{k} = {v}" for k, v in new_constants.items()))
    return "\n".join(lines) + "\n"


def state_after(turns: list[dict], upto: int) -> list[dict]:
    """Latest version of every table in force after turn `upto`."""
    latest: dict[str, dict] = {}
    for turn in turns:
        if turn["turn_id"] > upto:
            break
        for frame in turn["frames"]:
            latest[frame["name"]] = {**frame, "turn": turn["turn_id"]}
    return list(latest.values())


def collection_file(root: Path, item: dict) -> Path:
    """A kept list materialized as a one-column parquet file, one file per
    version, so it loads like every other table of the state."""
    import pandas as pd

    path = root / "collections" / f'{item["name"]}-t{item["changed_turn"]:02d}.parquet'
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        pd.DataFrame({item["column"]: item["values"]}).to_parquet(path, index=False)
    return path


def seed_changes(state: list[dict], collections: list[dict], root: Path) -> tuple[str, list[str]]:
    lines, skipped = [], []
    taken = set()
    for frame in state:
        if frame.get("format") == "parquet" and frame.get("file"):
            lines.append(f'set {frame["name"]}: scan(files={json.dumps(str(frame["file"]))}, format="parquet")')
            taken.add(frame["name"])
        else:
            skipped.append(frame["name"])
    for item in collections:
        if item["name"] in taken:
            continue
        lines.append(f'set {item["name"]}: scan(files={json.dumps(str(collection_file(root, item)))}, format="parquet")')
    return "\n".join(lines) + "\n", skipped


def seed_kernel(header: str, turns: list[dict], upto: int) -> str:
    parts = [
        "import contextlib as _seed_contextlib, io as _seed_io, warnings as _seed_warnings",
        "_seed_warnings.filterwarnings('ignore')",
        "with _seed_contextlib.redirect_stdout(_seed_io.StringIO()):",
    ]
    body = PRELUDE + "\n" + header + "\n" + "\n".join(t["code"] for t in turns if t["turn_id"] <= upto)
    parts.extend("    " + line if line.strip() else "" for line in body.splitlines())
    parts.append(f"print('seeded turns 1-{upto}')")
    return "\n".join(parts) + "\n"


def state_listing(state: list[dict], constants: dict[str, str], last: int,
                  collections: list[dict] = (), *, table_format: str = "markdown",
                  columns_shown: int = MAX_LISTED_COLUMNS) -> str:
    """The shared operator index, ordered with inputs before their consumers."""
    if table_format not in ("markdown", "tsv"):
        raise ValueError("table_format must be markdown or tsv")
    names = {f["name"] for f in state}
    pending = list(state) + [c for c in collections if c["name"] not in names]
    ordered = []
    while pending:
        names = {f["name"] for f in pending}
        ready = next((f for f in pending if not any(p in names for p in f.get("parents", []))), pending[0])
        ordered.append(ready); pending.remove(ready)
    headers = ["operator", "kind", "inputs", "result", "task", "columns"]
    lines = [f"Tables in force after task {last}:"]
    def cell(value):
        text = str(value)
        if table_format == "markdown":
            return text.replace("\\", "\\\\").replace("|", "\\|").replace("\n", "\\n").replace("\t", "\\t")
        return json.dumps(text, ensure_ascii=False) if any(c in text for c in "\t\r\n") else text
    def row(values):
        cells = [cell(v) for v in values]
        return "| " + " | ".join(cells) + " |" if table_format == "markdown" else "\t".join(cells)
    if ordered:
        lines.append(row(headers))
        if table_format == "markdown":
            lines.append("|" + "|".join("---" for _ in headers) + "|")
        for frame in ordered:
            lines.append(row([frame["name"], "scan",
                              ", ".join(frame.get("parents", [])), f"{frame['rows']:,} × {frame['cols']:,}",
                              frame["changed_turn"], columns_text(frame, columns_shown)]))
    else:
        lines.append("No operators.")
    if constants:
        lines.append("Constants in force: " + "; ".join(f"{k} = {v}" for k, v in constants.items()))
    return "\n".join(lines) + "\n"


ARM_TEXT = {
    "dataflow": {
        "persistence": (
            "Operators remain available across requests in one dataflow. Name them meaningfully. After editing "
            "definitions or edges, explicitly execute before retrieving current results. Retrieval never executes."
        ),
        "answer": (
            "Put a single-line JSON object in answer.content containing exactly the quantities requested. Follow the "
            "task's rounding and scale rules. Submit Answer as the sole action in its batch after observing the evidence."
        ),
        "loaded": (
            "Loaded state: the tables below exist as executed operators with the same names and the columns listed. "
            "Build on them with new operators; do not recreate them from the files. Lists the solutions kept are "
            "loaded as one-column tables: join them (how=\"semi\" or \"anti\") rather than retyping their "
            "members. The solution code above is the reference for how each table was derived."
        ),
    },
    "script": {
        "persistence": (
            "Code execution is continuous: variables, functions and data loaded earlier remain available in the kernel."
        ),
        "answer": (
            "Put a single-line JSON object containing exactly the quantities requested inside <answer></answer>. "
            "Follow the task's rounding and scale rules."
        ),
        "loaded": (
            "Loaded state: the tables below exist as pandas DataFrames with the same names in the kernel, together with "
            "the helper functions and constants the solutions defined. Use them directly; do not reload them from the "
            "files."
        ),
    },
}


def build_message(arm: str, folder: Path, files: list[str]) -> str:
    """The first (and only) request of a gold-prefix turn. Identical in both
    arms except the three arm sentences: persistence, answer channel, loaded state."""
    text = ARM_TEXT[arm]
    prefix = (folder / "prefix.md").read_text()
    state = (folder / "state.md").read_text()
    question = (folder / "question.txt").read_text()
    rules = (folder / "rules.md").read_text().strip() + "\n\n" if (folder / "rules.md").exists() else ""
    question = rules + question
    return (
        "You are an expert data scientist working through a long analysis with me. I will send you a series of "
        "requests, one at a time, about the same data.\n\n"
        "Data files available (use these paths verbatim; never modify input files):\n"
        + "\n".join(f" - {f}" for f in files)
        + f"\n\n{text['persistence']}\nDo not use plotting libraries. Use text summaries and statistics. Use code for "
        f"every calculation. Answer when you have evidence.\n\n{text['answer']}\n\n{prefix}\n{text['loaded']}\n\n"
        f"{state}\n{question}"
    )


def build(manifest_path: Path, out: Path) -> dict:
    manifest = json.loads(manifest_path.read_text())
    turns = manifest["turns"]
    header = manifest.get("header", "")
    out.mkdir(parents=True, exist_ok=True)
    index = []
    for turn in turns:
        tid = turn["turn_id"]
        previous = [t for t in turns if t["turn_id"] < tid]
        eligible = tid >= 2 and all(t["prefix_exact"] for t in previous) and bool(previous)
        entry = {
            "turn_id": tid,
            "state_type": turn.get("state_type"),
            "depends_tasks": turn.get("depends_tasks"),
            "exact": turn["exact"],
            "eligible": eligible,
        }
        if eligible:
            folder = out / "turns" / f"t{tid:02d}"
            folder.mkdir(parents=True, exist_ok=True)
            prefix = HEADER.format(last=tid - 1) + "\n" + "\n".join(task_block(t) for t in previous)
            (folder / "prefix.md").write_text(prefix)
            state = state_after(turns, tid - 1)
            (folder / "state.json").write_text(json.dumps(state, indent=1))
            collections = collection_frames(turns, tid - 1)
            values_names = {c["name"] for c in collections}
            constants: dict[str, str] = {}
            for t in previous:
                constants.update({k: v for k, v in t["constants"].items() if k not in values_names})
            (folder / "state.md").write_text(state_listing(state, constants, tid - 1, collections))
            changes, skipped = seed_changes(state, collections, out)
            (folder / "seed.changes").write_text(changes)
            (folder / "seed_kernel.py").write_text(seed_kernel(header, turns, tid - 1))
            (folder / "question.txt").write_text(
                f"[Task {tid}]\n{turn['context'].strip()}\nQuestion: {turn['question'].strip()}"
            )
            entry.update(
                {
                    "prefix_chars": len(prefix),
                    "tables": len(state),
                    "value_tables": sorted(values_names),
                    "tables_not_loadable": skipped,
                    "dir": str(folder),
                }
            )
        index.append(entry)
    summary = {
        "key": manifest["key"],
        "gold_state_manifest": str(manifest_path),
        "turns": index,
        "eligible": sum(e["eligible"] for e in index),
        "eligible_dependent": sum(e["eligible"] and bool(e["depends_tasks"]) for e in index),
    }
    (out / "index.json").write_text(json.dumps(summary, indent=1))
    return summary


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--gold-state", type=Path, required=True, help="gold_state.py output dir (manifest.json)")
    ap.add_argument("--out", type=Path, help="output dir (default: <gold-state>/prefix)")
    ap.add_argument("--prepared", type=Path, help="prepared case dir; writes message.<arm>.txt per eligible turn")
    args = ap.parse_args()
    out = args.out or args.gold_state / "prefix"
    summary = build(args.gold_state / "manifest.json", out)
    if args.prepared:
        files = json.loads((args.prepared / "manifest.json").read_text())["files"]
        for entry in summary["turns"]:
            if not entry["eligible"]:
                continue
            folder = Path(entry["dir"])
            for arm in ARM_TEXT:
                (folder / f"message.{arm}.txt").write_text(build_message(arm, folder, files))
    print(
        f"{summary['key']}: {summary['eligible']} eligible turns, {summary['eligible_dependent']} dependent",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
