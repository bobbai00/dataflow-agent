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
Lever 4 — post-cast coercion-dataloss telemetry.

The dominant confirmed wrong-answer cause (e.g. legal-hard-15) is a silent
``pd.to_numeric(col, errors="coerce")`` that turns formatted values ("$1,234",
"12%", "1,234") into NaN — the largest values vanish and the sum/count is wrong,
with no error. The value-format hint warns BEFORE the cast; this MEASURES the
damage AFTER: it transparently wraps ``pandas.to_numeric`` / ``pandas.to_datetime``
for the duration of an operator's execution and, when a coerce nulls a material
block of previously-non-null values, captures the COUNT and a SAMPLE of the
exact values that were dropped — so the agent sees what it lost, not just that a
number looks off.

Mirrors join_telemetry: install()/uninstall()/drain(), fully guarded (the real
conversion result is always returned unchanged), single-threaded-worker safe.
"""
from typing import List

import pandas

_SINK: List[str] = []
_orig_to_numeric = None
_orig_to_datetime = None
_installed = False

_MIN_ROWS = 5        # ignore tiny columns
_LOSS_FRAC = 0.02    # >= 2% of non-null values newly-nulled
_MIN_LOSS = 3        # and at least 3 absolute (ignore one-off bad cells)
_SAMPLE = 5


def reset() -> None:
    _SINK.clear()


def drain() -> List[str]:
    out = list(_SINK)
    _SINK.clear()
    return out


def _summarize(arg, result, kind: str) -> None:
    """Append a diagnostic when a coerce dropped a material block of values."""
    try:
        if not isinstance(arg, pandas.Series):
            return
        before_mask = arg.notna()
        before = int(before_mask.sum())
        if before < _MIN_ROWS:
            return
        newly_null = before_mask & result.isna()
        nulled = int(newly_null.sum())
        if nulled < _MIN_LOSS or nulled / before < _LOSS_FRAC:
            return
        sample = sorted(set(arg[newly_null].astype(str)))[:_SAMPLE]
        _SINK.append(
            f"{kind}(coerce) nulled {nulled} of {before} values (e.g. {sample}) — "
            f"these were DROPPED to NaN and are lost from any sum/mean/count. "
            f"Clean first (strip $ , % / fix the format) or use the right parse, then convert."
        )
    except Exception:
        pass


def _wrap(orig, kind):
    def wrapper(arg, *args, **kwargs):
        result = orig(arg, *args, **kwargs)  # real conversion first — untouched
        try:
            if kwargs.get("errors") == "coerce":
                _summarize(arg, result, kind)
        except Exception:
            pass
        return result
    return wrapper


def install() -> None:
    global _orig_to_numeric, _orig_to_datetime, _installed
    if _installed:
        return
    _orig_to_numeric = pandas.to_numeric
    _orig_to_datetime = pandas.to_datetime
    pandas.to_numeric = _wrap(_orig_to_numeric, "to_numeric")
    pandas.to_datetime = _wrap(_orig_to_datetime, "to_datetime")
    _installed = True


def uninstall() -> None:
    global _installed
    if not _installed:
        return
    try:
        if _orig_to_numeric is not None:
            pandas.to_numeric = _orig_to_numeric
        if _orig_to_datetime is not None:
            pandas.to_datetime = _orig_to_datetime
    finally:
        _installed = False
