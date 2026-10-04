#!/usr/bin/env python
"""Numeric parity gate: do LongDS's published answers reproduce in OUR venv?

The gold answers were computed against the benchmark's frozen 181-package Python
stack, and the LongDS judge demands exact numeric equality with no rounding. If
our pandas/numpy produce different digits, a correct method grades 0 and the
benchmark measures our library versions instead of our agent. So: run their gold
`task.py` here and diff every published answer against `task.json`.

Three things about that gold code make this less direct than it sounds, and all
three vary from task to task, so the gate handles them by shape rather than by a
per-task rule:

  * **No imports.** They lived in a notebook cell that was not exported, so a
    PRELUDE supplies them.
  * **Notebook-relative data paths.** Some tasks bind one
    `../../../../../data/longds/<task>` literal (called ROOT, DATA_DIR or
    base_path depending on the task); others use bare `data/...` strings. Both
    are fixed by running with the task's own data root as the cwd and collapsing
    that walk-up prefix to `.`.
  * **Two different ways of publishing an answer.** Some tasks accumulate an
    `answers` dict; others just `print(json.dumps(...))` per turn and keep
    nothing. So the file is split on its `###### Task N:` markers and executed
    one turn at a time in a single shared namespace, with that turn's stdout
    captured — which gives an exact turn-to-answer mapping either way, and
    localizes a failure to the turn that caused it instead of losing the whole
    task.
"""
import argparse
import importlib
import io
import json
import os
import re
import sys
from pathlib import Path

from _paths import DATAMIND as UPSTREAM
DEFAULT_TASK = "sports/nfl_big_data_bowl_2023/task1"

PRELUDE = """
import os, sys, json, re, math, warnings, itertools, collections, functools, datetime, string, random
from pathlib import Path
from collections import Counter, defaultdict, OrderedDict
import numpy as np
import pandas as pd
# Notebook-local raw data root; execution sets cwd to the task's folder.
BASE_PATH = Path('data')
try:
    from sklearn.preprocessing import StandardScaler
    from sklearn.cluster import KMeans
    from sklearn.decomposition import PCA
    from sklearn.feature_extraction.text import CountVectorizer, TfidfVectorizer
    from sklearn.neighbors import NearestNeighbors
    from sklearn.model_selection import KFold, train_test_split, cross_val_predict
    from sklearn.ensemble import RandomForestRegressor, ExtraTreesRegressor
    from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
except ImportError:
    pass
try:
    import statsmodels.api as sm
except ImportError:
    pass
try:
    import geopandas as gpd
except ImportError:
    pass
try:
    from scipy import stats
    from scipy.stats import linregress, pearsonr, spearmanr
    from scipy.sparse import csr_matrix
except ImportError:
    pass

# `dumps4` is upstream's own publishing step on several tasks — the one that
# applies the "round all decimal results to 4 decimal places" rule every task's
# context states. It lived in the unexported notebook cell, and without it those
# turns publish unrounded values that diff against a rounded task.json: gold
# 2662.6182 vs ours 2662.6182215621907, which is the SAME number failing on
# presentation. Reconstructed here so the comparison is against what upstream
# actually published.
def _round4(o):
    if isinstance(o, bool):
        return o
    if isinstance(o, float):
        return round(o, 4)
    if isinstance(o, dict):
        return {k: _round4(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_round4(v) for v in o]
    return o

def dumps4(obj, **kw):
    return json.dumps(_round4(obj), **kw)

# `rounded_df(frame, {"col": digits})` is another helper from that unexported
# cell (kaggle-survey-2022/task2): the listed columns rounded for display.
def rounded_df(frame, digits):
    out = frame.copy()
    for column, places in digits.items():
        if column in out.columns:
            out[column] = out[column].round(places)
    return out
"""

#: Upstream delimits each turn's code with this comment, one per turn (verified
#: to match the turn count exactly on every task downloaded so far).
TURN_MARKER = re.compile(r"^###### Task (\d+):", re.M)


class AutoImportNS(dict):
    """Globals that import a missing MODULE on first reference.

    The gold code's imports lived in a notebook cell that upstream did not
    export, so every task is missing a different handful of them (`os` here,
    `contextlib` there). Enumerating them in the PRELUDE is whack-a-mole and
    each miss costs a full re-run of a task that can take minutes. A dict
    subclass used as globals gets `__missing__` called on a failed global
    lookup, so an absent name that happens to be an importable module resolves
    itself; anything else still raises NameError exactly as it would have.

    This only ever ADDS a stdlib import the original notebook must have had —
    it cannot change a computed value, which is the thing the gate is measuring.
    """

    def __missing__(self, name: str):
        if name.startswith("__"):
            raise KeyError(name)
        try:
            mod = importlib.import_module(name)
        except Exception:
            raise KeyError(name)
        self[name] = mod
        return mod


def canon(x, places=None):
    """Judge-equivalent normalization: trailing zeros are insignificant."""
    if isinstance(x, dict):
        return {k: canon(v) for k, v in sorted(x.items())}
    if isinstance(x, (list, tuple)):
        return [canon(v) for v in x]
    if isinstance(x, bool):
        return x
    if isinstance(x, float):
        if x == int(x):
            return int(x)
        return round(x, 10)
    if isinstance(x, int):
        return x
    return x


def diff(gold, got, path=""):
    """Yield (path, gold, got) for every leaf mismatch."""
    if isinstance(gold, dict) and isinstance(got, dict):
        for k in gold:
            if k not in got:
                yield (f"{path}.{k}", gold[k], "<MISSING>")
            else:
                yield from diff(gold[k], got[k], f"{path}.{k}")
        return
    if isinstance(gold, list) and isinstance(got, list):
        if len(gold) != len(got):
            yield (f"{path}[len]", len(gold), len(got))
        for i, (a, b) in enumerate(zip(gold, got)):
            yield from diff(a, b, f"{path}[{i}]")
        return
    if canon(gold) != canon(got):
        yield (path or ".", gold, got)


def json_blobs(text: str) -> list:
    """Every top-level JSON value printed in `text`, in order.

    The gold code prints with `indent=2`, so a blob spans many lines and cannot
    be found line-by-line; the decoder is walked over the buffer instead.
    """
    dec = json.JSONDecoder()
    out, i = [], 0
    while i < len(text):
        if text[i] in "{[":
            try:
                obj, end = dec.raw_decode(text, i)
                out.append(obj)
                i = end
                continue
            except ValueError:
                pass
        i += 1
    return out


def run_turns(src: str, data_root: Path, n_turns: int):
    """Execute the gold code one turn at a time; return {turn_id: answer}.

    A turn's answer is whatever it added to an `answers` dict, and failing that
    the last JSON value it printed — the two styles upstream actually uses. Both
    are read per turn rather than at the end, so a turn that raises costs only
    itself: the remaining turns still run, and the report says which ones the
    numbers cannot speak for.
    """
    marks = [(m.start(), int(m.group(1))) for m in TURN_MARKER.finditer(src)]
    header = src[: marks[0][0]] if marks else src
    chunks = (
        [(tid, src[pos : (marks[i + 1][0] if i + 1 < len(marks) else len(src))]) for i, (pos, tid) in enumerate(marks)]
        if marks
        else [(i + 1, "") for i in range(n_turns)]
    )

    ns: dict = AutoImportNS(__name__="__gold__")
    produced: dict = {}
    errors: list = []
    cwd = os.getcwd()
    real_stdout = sys.stdout
    try:
        os.chdir(data_root)
        try:
            sys.stdout = open(os.devnull, "w")
            exec(compile(PRELUDE + header, "task.py", "exec"), ns)
        except Exception:
            sys.stdout = real_stdout
            import traceback

            traceback.print_exc()
            return {}, errors, None
        finally:
            sys.stdout = real_stdout

        for tid, code in chunks:
            buf = io.StringIO()
            before = set((ns.get("answers") or {}).keys()) if isinstance(ns.get("answers"), dict) else set()
            try:
                sys.stdout = buf
                exec(compile(code, f"task.py[turn {tid}]", "exec"), ns)
            except Exception as exc:
                # Extraction still runs. Several tasks end a turn by printing
                # through a formatting helper that lived in the unexported
                # notebook cell (`dumps4`), so the turn raises AFTER its answer
                # is already stored — discarding it there would fail a task on a
                # missing pretty-printer rather than on its numbers. If the turn
                # died before computing anything there is simply nothing to find,
                # and it lands in `missing` as before.
                errors.append(f"{tid}:{type(exc).__name__}:{exc}")
            finally:
                sys.stdout = real_stdout

            # What the turn PRINTED is what upstream published — on tasks that
            # print through `dumps4` the printed form carries the 4-decimal
            # rounding that task.json was built from, while the in-memory dict
            # still holds full precision. So the print wins, and the dict is the
            # fallback for turns (and tasks) that publish without printing.
            got = None
            blobs = json_blobs(buf.getvalue())
            if blobs:
                got = blobs[-1]
            answers = ns.get("answers")
            if got is None and isinstance(answers, dict):
                # Prefer the key this turn just added; fall back to the two key
                # spellings upstream uses ("7" and "task_7").
                new_keys = [k for k in answers if k not in before]
                fresh = new_keys[-1] if len(new_keys) == 1 else None
                for k in (fresh, str(tid), f"task_{tid}"):
                    if k is not None and k in answers:
                        got = answers[k]
                        break
            if got is not None:
                produced[str(tid)] = got
    finally:
        sys.stdout = real_stdout
        os.chdir(cwd)
    return produced, errors, ns


def reference_source(task_dir: Path) -> str:
    """Use an exported notebook when present, otherwise the published cells.

    Some distributed tasks include code in task.json without a task.py export.
    No answer values are substituted into the executed reference code.
    """
    preamble = []
    notebook = task_dir / "task.ipynb"
    if notebook.exists():
        # Original setup cells preserve notebook-local imports, roots and
        # publishing helpers exactly, including task-specific precision.
        # Never inspect outputs or execute solution cells twice.
        for cell in json.loads(notebook.read_text()).get("cells", []):
            source = "".join(cell.get("source", []))
            if re.search(r"(?:^|\n)#+\s*Task\s+\d+", source):
                break
            if cell.get("cell_type") == "code":
                preamble.append(source)
    exported = task_dir / "task.py"
    if exported.exists():
        body = exported.read_text()
    else:
        turns = json.loads((task_dir / "task.json").read_text())
        if not all(isinstance(t.get("code"), str) and t["code"].strip() for t in turns):
            raise ValueError("Reference code is missing")
        body = "\n\n".join(f"###### Task {t['turn_id']}:\n{t['code']}" for t in turns)
    return "\n\n".join(preamble + [body])


def gate(task_rel: str) -> int:
    """Run one task's gold `task.py` here and diff every published answer."""
    TASK = UPSTREAM / "task" / "longds" / task_rel
    DATA_ROOT = UPSTREAM / "data" / "longds" / task_rel
    print(f"\n{'=' * 78}\n{task_rel}\n{'=' * 78}")

    # Upstream's gold code resolves data RELATIVE TO THE NOTEBOOK it was lifted
    # from, and does it two different ways: some tasks bind one
    # `../../../../../data/longds/<task>` literal to a variable (named ROOT /
    # DATA_DIR / base_path, task by task), others just use bare `data/...`
    # strings. Both are handled by the same move — run with the task's own data
    # root as the cwd, and collapse the walk-up prefix to `.` wherever it appears
    # — so no per-task rewrite rule is needed.
    try:
        src = reference_source(TASK)
    except (OSError, ValueError) as exc:
        print(f"SKIP: {exc}")
        return 2
    src = src.replace(f"../../../../../data/longds/{task_rel}", ".")
    if "../../../../../data/longds" in src:
        print("FATAL: an unrecognised walk-up path survives — inspect the literals in task.py")
        return 2

    turns = json.loads((TASK / "task.json").read_text())
    produced, errors, ns = run_turns(src, DATA_ROOT, len(turns))
    if ns is None:
        print("FATAL: the gold code's header (imports / helpers / data load) raised — see above")
        return 2

    print(f"turns in task.json: {len(turns)}   answers produced: {len(produced)}")
    print(f"pandas {ns['pd'].__version__}  numpy {ns['np'].__version__}")
    if errors:
        print(f"turns whose gold code RAISED here: {sorted(errors)}")
    print()

    exact, mismatched, missing = [], [], []
    for t in turns:
        tid = str(t["turn_id"])
        if tid not in produced:
            missing.append(tid)
            continue
        bad = list(diff(t["answer"], produced[tid]))
        if bad:
            mismatched.append((tid, bad))
        else:
            exact.append(tid)

    print(f"EXACT      {len(exact)}/{len(turns)}")
    print(f"MISMATCH   {len(mismatched)}")
    print(f"NOT BUILT  {len(missing)}  {missing if missing else ''}")
    for tid, bad in mismatched:
        print(f"\n--- turn {tid}: {len(bad)} leaf mismatches (first 6) ---")
        for p, g, o in bad[:6]:
            print(f"    {p}\n      gold {g!r}\n      ours {o!r}")
    return 0 if not mismatched and not missing else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--task",
        action="append",
        default=None,
        help="domain/dataset/taskN, repeatable. Defaults to the pilot task.",
    )
    args = ap.parse_args()
    tasks = args.task or [DEFAULT_TASK]
    codes = {t: gate(t) for t in tasks}
    if len(codes) > 1:
        print(f"\n{'=' * 78}\nSUMMARY")
        for t, c in codes.items():
            print(f"  {'PASS' if c == 0 else 'FAIL' if c == 1 else 'ERROR':<6} {t}")
    return max(codes.values())


if __name__ == "__main__":
    sys.exit(main())
