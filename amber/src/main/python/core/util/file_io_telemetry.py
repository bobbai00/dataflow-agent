# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

"""
A7 — multi-file load telemetry.

An agent that writes ``glob.glob(...)`` never sees what it matched: the rendered
result shows only the concatenated table, so the file list is information it has
no path to. Measured consequences of that blind spot:

  * grouping identity often lives ONLY in the file name (one CSV per state /
    station / year). On legal-hard-29 the runs that reconstructed state from a
    metro-name suffix regex scored 0/26; the ones that carried the file name
    scored 88-100%.
  * a glob that matches fewer files than assumed loads a silent partial, and a
    typo'd path yields a FileNotFoundError the agent re-derives repeatedly
    (wildfire-hard-19: the same missing file across 3 operators, 8 times).

This reports the FACT and nothing else — no advice, no reference to a column
that does not exist. Deliberately styled after ``__table_hints__``
("duplicate rows: 359 of 764 (47%)") rather than ``__coercion_telemetry__``,
which prescribes a remedy: the agent can draw its own conclusion, which is
exactly what the winning traces did unprompted.

Fires only for MULTI-file loads (>= 2 distinct paths in one operator). A
single-file read already appears verbatim in the agent's own code, so repeating
it would be pure duplication.

Mirrors coercion_telemetry: install()/uninstall()/drain(), fully guarded (the
real read result is always returned untouched), single-threaded-worker safe.
"""
import os
from typing import List, Set

import pandas

_PATHS: Set[str] = set()
_ORIG = {}
_installed = False

_MAX_NAMES = 8   # names listed before eliding; keeps the line ~1 render line
_READERS = ("read_csv", "read_excel", "read_parquet", "read_table", "read_fwf", "read_json")


def reset() -> None:
    _PATHS.clear()


def _record(arg) -> None:
    """Record a path-like first argument. Buffers/handles are ignored — only
    real filesystem paths are provenance."""
    try:
        if isinstance(arg, (str, os.PathLike)):
            p = os.fspath(arg)
            # ignore URLs and in-memory markers; keep it to on-disk reads
            if "://" not in p:
                _PATHS.add(p)
    except Exception:
        pass


def drain() -> List[str]:
    """One diagnostic line for a multi-file load, else nothing."""
    try:
        paths = sorted(_PATHS)
        _PATHS.clear()
        if len(paths) < 2:
            return []
        names = [os.path.basename(p) for p in paths]
        shown = names[:_MAX_NAMES]
        more = f", … (+{len(names) - len(shown)})" if len(names) > len(shown) else ""
        return [f"files read: {len(paths)} [{', '.join(shown)}{more}]"]
    except Exception:
        return []


def _wrap(orig):
    def wrapper(*args, **kwargs):
        try:
            if args:
                _record(args[0])
            elif "filepath_or_buffer" in kwargs:
                _record(kwargs["filepath_or_buffer"])
            elif "io" in kwargs:
                _record(kwargs["io"])
            elif "path" in kwargs:
                _record(kwargs["path"])
        except Exception:
            pass
        return orig(*args, **kwargs)  # the real read — never altered

    return wrapper


def install() -> None:
    global _installed
    if _installed:
        return
    for name in _READERS:
        fn = getattr(pandas, name, None)
        if fn is None:
            continue
        _ORIG[name] = fn
        setattr(pandas, name, _wrap(fn))
    reset()
    _installed = True


def uninstall() -> None:
    global _installed
    if not _installed:
        return
    for name, fn in _ORIG.items():
        try:
            setattr(pandas, name, fn)
        except Exception:
            pass
    _ORIG.clear()
    _installed = False
