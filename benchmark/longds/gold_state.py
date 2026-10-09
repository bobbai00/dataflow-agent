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

"""Per-turn gold state from a LongDS reference solution.

Replays the task's `task.py` one turn at a time in one namespace (the way
`numeric_gate.py` does) and, after every turn, records the analytical state the
reference holds at that point: every DataFrame/Series as a Parquet file (written
once per distinct content), every small scalar/collection as a constant, which
turn created and last changed each name, and which earlier names the turn's
code read. A turn is marked `exact` when its replayed answer equals gold.

The gold-prefix protocol loads this state before turn t in both arms (kernel
variables for the script agent, materialized operators for the dataflow agent),
so a turn is evaluated against a correct history instead of its own cascade.
Only turns whose whole prefix replays exactly are eligible.
"""
import argparse
import ast
import hashlib
import io
import json
import os
import pickle
import re
import sys
import traceback
import types
from pathlib import Path

import numpy as np
import pandas as pd

from numeric_gate import PRELUDE, TURN_MARKER, AutoImportNS, diff, json_blobs

#: The notebook-relative task folder, in both dataset conventions: v1.1 binds
#: `../../../../data/<domain>/<dataset>/<taskN>`, v1.0
#: `../../../../../data/longds/<domain>/<dataset>/<taskN>`. Both then append
#: `/data/...`, so the literal maps to a base whose `data/` is the task's data.
WALK_UP = re.compile(r"(?:\.\./)+data/(?:longds/)?([A-Za-z0-9_\-]+/[A-Za-z0-9_\-]+/task\d+)")
CONSTANT_TYPES = (bool, int, float, str, np.integer, np.floating, np.bool_)
MAX_CONSTANT_REPR = 120
#: A list or set is state the notebook keeps whole (a membership list, a column
#: selection); it is never dropped for length. Dicts stay capped.
MAX_COLLECTION_REPR = 4000
#: Frames scanned when matching a collection's items to a column's values.
MAX_MATCH_ROWS = 500_000
PATH_NAMES = {"BASE_PATH", "DATA_DIR", "DATA_PATH", "DATA_ROOT", "ROOT", "base_path", "data_dir"}


def rewrite_paths(src: str, task_rel: str, base: Path) -> str:
    """Point the walk-up literals at a local base whose `data/` is the task's data."""
    def replace(match: re.Match) -> str:
        if match.group(1) != task_rel:
            raise ValueError(f"task.py references another task's data: {match.group(0)}")
        return str(base)

    out = WALK_UP.sub(replace, src)
    if re.search(r"\.\./\.\./", out):
        raise ValueError("an unrecognised walk-up path survives in task.py")
    return out


def split_turns(src: str) -> tuple[str, list[tuple[int, str]]]:
    marks = [(m.start(), int(m.group(1))) for m in TURN_MARKER.finditer(src)]
    if not marks:
        raise ValueError("task.py has no `###### Task N:` markers")
    header = src[: marks[0][0]]
    chunks = [
        (tid, src[pos : (marks[i + 1][0] if i + 1 < len(marks) else len(src))]) for i, (pos, tid) in enumerate(marks)
    ]
    return header, chunks


def names_in(code: str) -> tuple[set[str], dict[str, set[str]]]:
    """Module-level assigned names, and for each the names its statement read.

    Statements are walked in order, so a name assigned twice keeps the reads of
    its last assignment; reads inside `def` bodies are not attributed to any
    name (helpers are called from the statements that bind their results).
    """
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return set(), {}
    assigned: set[str] = set()
    reads: dict[str, set[str]] = {}

    def targets(node: ast.AST, into: set[str]):
        if isinstance(node, ast.Name):
            into.add(node.id)
        elif isinstance(node, (ast.Tuple, ast.List)):
            for elt in node.elts:
                targets(elt, into)
        elif isinstance(node, ast.Starred):
            targets(node.value, into)
        elif isinstance(node, (ast.Attribute, ast.Subscript)):
            # `frame["col"] = ...` or `frame.attr = ...` changes `frame` in place.
            targets(node.value, into)

    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Import, ast.ImportFrom)):
            continue
        bound: set[str] = set()
        if isinstance(node, ast.Assign):
            for t in node.targets:
                targets(t, bound)
        elif isinstance(node, (ast.AugAssign, ast.AnnAssign)):
            targets(node.target, bound)
        elif isinstance(node, ast.For):
            targets(node.target, bound)
        if isinstance(node, (ast.For, ast.While, ast.If, ast.With, ast.Try)):
            for inner in ast.walk(node):
                if isinstance(inner, ast.Assign):
                    for t in inner.targets:
                        targets(t, bound)
                elif isinstance(inner, (ast.AugAssign, ast.AnnAssign)):
                    targets(inner.target, bound)
                elif isinstance(inner, ast.withitem) and inner.optional_vars is not None:
                    targets(inner.optional_vars, bound)
        loaded = {n.id for n in ast.walk(node) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
        for name in bound:
            assigned.add(name)
            reads[name] = (loaded - {name}) | (reads.get(name, set()) if isinstance(node, ast.AugAssign) else set())
    return assigned, reads


def frame_digest(frame: pd.DataFrame) -> str:
    h = hashlib.sha256()
    h.update(str(frame.shape).encode())
    h.update("\x1f".join(map(str, frame.columns)).encode())
    h.update("\x1f".join(str(d) for d in frame.dtypes).encode())
    try:
        h.update(pd.util.hash_pandas_object(frame, index=True).values.tobytes())
    except Exception:
        h.update(pickle.dumps(frame.to_dict(orient="list"), protocol=4))
    return h.hexdigest()


def as_frame(value) -> pd.DataFrame | None:
    if isinstance(value, pd.DataFrame):
        return value
    if isinstance(value, pd.Series):
        name = value.name if isinstance(value.name, str) and value.name else "value"
        frame = value.to_frame(name=name)
        if not isinstance(frame.index, pd.RangeIndex):
            frame = frame.reset_index()
        return frame
    return None


def loadable(frame: pd.DataFrame) -> pd.DataFrame:
    """The table as a loader sees it: a meaningful index becomes columns,
    column labels become strings, and nested cells (lists, dicts, tuples,
    sets) become JSON strings, which is the scalar-cell contract the engine's
    scan enforces. Recorded shapes describe this form."""
    out = frame
    if not isinstance(out.index, pd.RangeIndex) or out.index.name is not None:
        out = out.reset_index()
    if any(not isinstance(c, str) for c in out.columns):
        out = out.copy()
        out.columns = [str(c) for c in out.columns]
    # The engine's scan contract takes UTC datetimes only; the reference keeps
    # naive timestamps. Localizing as UTC preserves every instant and ordering.
    for column in out.columns:
        series = out[column]
        if pd.api.types.is_datetime64_any_dtype(series) and getattr(series.dt, "tz", None) is None:
            if out is frame:
                out = out.copy()
            out[column] = series.dt.tz_localize("UTC")
    nested = (list, dict, tuple, set, frozenset, np.ndarray)
    for column in out.columns:
        series = out[column]
        if series.dtype == object and series.map(lambda v: isinstance(v, nested)).any():
            if out is frame:
                out = out.copy()
            out[column] = series.map(
                lambda v: json.dumps(sorted(v) if isinstance(v, (set, frozenset)) else
                                     v.tolist() if isinstance(v, np.ndarray) else v, default=str)
                if isinstance(v, nested) else v
            )
            series = out[column]
        if series.dtype == object:
            # A key/value table mixes str, int, float and bool in one column
            # (`row` from iterrows, a melted Series). No typed reader accepts
            # that, so such a column becomes text; null stays null.
            kinds = {type(v).__name__ for v in series if v is not None and not (isinstance(v, float) and np.isnan(v))}
            if len(kinds) > 1:
                if out is frame:
                    out = out.copy()
                out[column] = series.map(
                    lambda v: None if v is None or (isinstance(v, float) and np.isnan(v)) else str(v)
                )
    return out


def write_frame(out: pd.DataFrame, path: Path) -> tuple[str, bool]:
    """Parquet when the columns serialize; otherwise pickle. Returns (format, ok)."""
    # `path` ends in a content digest; append the format, never replace it.
    try:
        out.to_parquet(path.parent / f"{path.name}.parquet", index=False)
        return "parquet", True
    except Exception:
        try:
            out.to_pickle(path.parent / f"{path.name}.pkl")
            return "pickle", True
        except Exception:
            return "unsaved", False


def constant_repr(name: str, value) -> str | None:
    """Short scalars and small collections only: thresholds, weights, labels.
    Paths and large lookup collections are state the frames already carry."""
    if name in PATH_NAMES or isinstance(value, (types.ModuleType, type, Path)) or callable(value):
        return None
    if isinstance(value, CONSTANT_TYPES):
        plain = value.item() if isinstance(value, (np.integer, np.floating, np.bool_)) else value
        if isinstance(plain, str) and ("/" in plain or len(plain) > MAX_CONSTANT_REPR):
            return None
        text = repr(plain)
    elif isinstance(value, (list, tuple, set, frozenset, dict)):
        try:
            text = repr(sorted(value) if isinstance(value, (set, frozenset)) else value)
        except Exception:
            return None
        if len(text) > (MAX_CONSTANT_REPR if isinstance(value, dict) else MAX_COLLECTION_REPR):
            return None
    else:
        return None
    return text


def collection_items(value) -> list | None:
    """The items of a list/tuple/set of plain scalars (str or int, not bool),
    in a stable order; None for anything else."""
    if not isinstance(value, (list, tuple, set, frozenset)) or not value:
        return None
    items = sorted(value) if isinstance(value, (set, frozenset)) else list(value)
    plain = []
    for item in items:
        item = item.item() if isinstance(item, (np.integer, np.floating, np.bool_)) else item
        if isinstance(item, bool) or not isinstance(item, (str, int)) or (isinstance(item, str) and "/" in item):
            return None
        plain.append(item)
    if len({type(i) for i in plain}) != 1:
        return None
    return plain


def classify_collection(items: list, frames: dict) -> dict:
    """What a collection is, from the tables beside it: `column_names` when
    every item names a column of one table, else `values` with the column
    whose values contain every item (the most specific such column), else
    `values` with no column. `frames` maps names to DataFrames."""
    wanted = set(items)
    for frame_name, frame in frames.items():
        if wanted <= {str(c) for c in frame.columns}:
            return {"kind": "column_names", "source": frame_name, "column": None}
    best = None
    for frame_name, frame in frames.items():
        if len(frame) > MAX_MATCH_ROWS:
            continue
        for column in frame.columns:
            series = frame[column]
            if isinstance(items[0], str) and not (series.dtype == object or pd.api.types.is_string_dtype(series.dtype)):
                continue
            if isinstance(items[0], int) and not pd.api.types.is_integer_dtype(series.dtype):
                continue
            try:
                domain = set(series.dropna().unique().tolist())
            except TypeError:
                continue
            if wanted <= domain and (best is None or len(domain) < best[0]):
                best = (len(domain), frame_name, str(column))
    if best:
        return {"kind": "values", "source": best[1], "column": best[2]}
    return {"kind": "values", "source": None, "column": None}


def replay(prepared: Path, references: Path, out: Path) -> dict:
    manifest = json.loads((prepared / "manifest.json").read_text())
    gold = json.loads((prepared / "gold.json").read_text())
    gold_by_id = {t["turn_id"]: t for t in gold["turns"]}
    task_rel = f"{manifest['domain']}/{manifest['dataset_name']}/{manifest['task_id']}"
    data_dir = Path(manifest["data_dir"]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    base = out / "base"
    base.mkdir(exist_ok=True)
    link = base / "data"
    if link.is_symlink() or link.exists():
        link.unlink()
    link.symlink_to(data_dir)
    frames_dir = out / "frames"
    frames_dir.mkdir(exist_ok=True)

    src = rewrite_paths((references / "task.py").read_text(), task_rel, base)
    header, chunks = split_turns(src)
    ns: dict = AutoImportNS(__name__="__gold__")
    turns: list[dict] = []
    created: dict[str, int] = {}
    changed: dict[str, int] = {}
    digests: dict[str, str] = {}
    files: dict[str, dict] = {}  # digest -> {file, format}
    constants_seen: dict[str, str] = {}
    collections_seen: dict[str, dict] = {}
    cwd = os.getcwd()
    real_stdout = sys.stdout
    header_error = None
    try:
        os.chdir(base)
        try:
            sys.stdout = io.StringIO()
            exec(compile(PRELUDE + header, "task.py", "exec"), ns)
        except Exception:
            header_error = traceback.format_exc()
        finally:
            sys.stdout = real_stdout
        if header_error:
            return {"key": manifest["key"], "header_error": header_error, "turns": []}
        known_frames: set[str] = set()
        for tid, code in chunks:
            buf = io.StringIO()
            before = set((ns.get("answers") or {}).keys()) if isinstance(ns.get("answers"), dict) else set()
            error = None
            try:
                sys.stdout = buf
                exec(compile(code, f"task.py[turn {tid}]", "exec"), ns)
            except Exception:
                error = traceback.format_exc(limit=3)
            finally:
                sys.stdout = real_stdout
            stdout = buf.getvalue()
            got = None
            blobs = json_blobs(stdout)
            if blobs:
                got = blobs[-1]
            answers = ns.get("answers")
            if got is None and isinstance(answers, dict):
                new_keys = [k for k in answers if k not in before]
                fresh = new_keys[-1] if len(new_keys) == 1 else None
                for k in (fresh, str(tid), f"task_{tid}"):
                    if k is not None and k in answers:
                        got = answers[k]
                        break
            gold_turn = gold_by_id.get(tid)
            mismatches = list(diff(gold_turn["answer"], got)) if gold_turn and got is not None else None
            exact = bool(gold_turn) and got is not None and not mismatches
            assigned, reads = names_in(code)
            frames: list[dict] = []
            constants: dict[str, str] = {}
            collections: dict[str, dict] = {}
            frame_names_now = {n for n, v in ns.items() if not n.startswith("_") and as_frame(v) is not None}
            frames_by_name = {n: as_frame(ns[n]) for n in frame_names_now}
            for name, value in list(ns.items()):
                if name.startswith("_") or name in ("answers",):
                    continue
                frame = as_frame(value)
                if frame is None:
                    text = constant_repr(name, value)
                    if text is not None and (name in assigned or name in constants_seen):
                        constants[name] = text
                        constants_seen[name] = text
                        items = collection_items(value)
                        if items is not None and name not in PATH_NAMES:
                            if name in assigned or name not in collections_seen:
                                collections_seen[name] = {"items": items, **classify_collection(items, frames_by_name)}
                            collections[name] = collections_seen[name]
                    continue
                frame = loadable(frame)
                digest = frame_digest(frame)
                is_new = name not in created
                did_change = digests.get(name) != digest
                if is_new:
                    created[name] = tid
                if did_change:
                    changed[name] = tid
                    digests[name] = digest
                if digest not in files:
                    fmt, ok = write_frame(frame, frames_dir / f"{name}.{digest[:12]}")
                    files[digest] = {
                        "file": str(frames_dir / f"{name}.{digest[:12]}.{'parquet' if fmt == 'parquet' else 'pkl'}")
                        if ok
                        else None,
                        "format": fmt,
                    }
                parents = (
                    sorted(n for n in reads.get(name, set()) if n != name and (n in frame_names_now or n in known_frames))
                    if did_change
                    else []
                )
                frames.append(
                    {
                        "name": name,
                        "rows": int(frame.shape[0]),
                        "cols": int(frame.shape[1]),
                        "columns": [str(c) for c in frame.columns],
                        "dtypes": [str(d) for d in frame.dtypes],
                        "digest": digest,
                        "created_turn": created[name],
                        "changed_turn": changed[name],
                        "changed_this_turn": did_change,
                        "parents": parents,
                        **files[digest],
                    }
                )
            known_frames = {f["name"] for f in frames}
            turns.append(
                {
                    "turn_id": tid,
                    "question": gold_turn["question"] if gold_turn else None,
                    "context": gold_turn["context"] if gold_turn else None,
                    "state_type": gold_turn.get("state_type") if gold_turn else None,
                    "depends_tasks": gold_turn.get("depends_tasks") if gold_turn else None,
                    "code": code.strip(),
                    "stdout_tail": stdout[-4000:],
                    "replayed_answer": got,
                    "exact": exact,
                    "mismatches": [list(m) for m in (mismatches or [])][:8],
                    "error": error,
                    "assigned": sorted(assigned),
                    "frames": frames,
                    "constants": constants,
                    "collections": collections,
                }
            )
            print(
                f"turn {tid:>2}: {'exact' if exact else 'DIFF ' if got is not None else 'none '}"
                f" frames={len(frames)} changed={sum(f['changed_this_turn'] for f in frames)}"
                f"{' error=' + error.strip().splitlines()[-1] if error else ''}",
                file=sys.stderr,
            )
    finally:
        sys.stdout = real_stdout
        os.chdir(cwd)
    prefix_ok = []
    ok = True
    for t in turns:
        ok = ok and t["exact"] and not t["error"]
        prefix_ok.append(ok)
    for t, good in zip(turns, prefix_ok):
        t["prefix_exact"] = good
    result = {
        "key": manifest["key"],
        "task_rel": task_rel,
        "data_dir": str(data_dir),
        "base": str(base),
        "references": str(references),
        "pandas": pd.__version__,
        "numpy": np.__version__,
        "header": header.strip(),
        "turns": turns,
    }
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--prepared", type=Path, required=True, help="prepared case dir (manifest.json, gold.json)")
    ap.add_argument("--references", type=Path, help="reference dir with task.py; default: sibling references/<case>")
    ap.add_argument("--out", type=Path, required=True, help="output dir for manifest.json and frames/")
    args = ap.parse_args()
    prepared = args.prepared.resolve()
    references = args.references or prepared.parent.parent / "references" / prepared.name
    result = replay(prepared, references.resolve(), args.out.resolve())
    (args.out / "manifest.json").write_text(json.dumps(result, indent=1, default=str))
    turns = result["turns"]
    exact = sum(t["exact"] for t in turns)
    usable = sum(t["prefix_exact"] for t in turns)
    print(f"{result['key']}: {exact}/{len(turns)} turns exact; {usable} turns with an exact prefix", file=sys.stderr)
    return 0 if turns and not result.get("header_error") else 1


if __name__ == "__main__":
    sys.exit(main())
