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
Lever 2 — transparent join (merge) telemetry.

In CODE mode an operator is an arbitrary ``process_tables()`` that may call
``left.merge(right, on=...)``; the worker only sees the output, not "this is a
join" or its keys. So we transparently wrap ``pandas.DataFrame.merge`` and
``pandas.merge`` for the duration of an operator's execution and, when a merge
is DEGENERATE (near-zero key match, or a fan-out row explosion), capture an
ACTIONABLE diagnostic — the actual unmatched key SAMPLE (e.g. left has 'CA',
right has 'California') — so the agent can see *why* the join failed, not just
that the row count collapsed. Healthy joins are silent (alarm-only, the lesson
from lever 1: passive per-everything surfacing is noise).

Usage (see data_processor):
    join_telemetry.reset(); join_telemetry.install()
    try: <run operator>      # any merge the user wrote is now instrumented
    finally: join_telemetry.uninstall()
    diags = join_telemetry.drain()   # list[str]; attach to the stats channel

Robustness: every computation is guarded so a telemetry error can NEVER break
the user's actual merge — the real merge result is always returned unchanged.
The worker is single-threaded per operator, so the monkeypatch is scoped safely.
"""
from typing import Any, List, Optional

import pandas

# Diagnostics captured for the operator currently executing. Module-level
# because the merge wrapper has no other channel back to the worker; reset()
# per operator keeps it from leaking across operators.
_SINK: List[str] = []
_orig_df_merge = None
_orig_pd_merge = None
_installed = False

# Tuning. Fire only on the two unambiguous join pathologies; stay silent
# otherwise (a healthy inner join legitimately drops some rows).
_MATCH_FRAC_FLOOR = 0.05   # < 5% of left keys matched -> near-zero-match alarm
_FANOUT_CEIL = 3.0         # output > 3x larger input -> fan-out alarm
_SAMPLE = 5                # how many unmatched key values to show each side
_MIN_ROWS = 2              # ignore trivially tiny inputs


def reset() -> None:
    _SINK.clear()


def drain() -> List[str]:
    out = list(_SINK)
    _SINK.clear()
    return out


def _key_columns(left, right, on, left_on, right_on) -> Optional[list]:
    """The join key column name(s), or None when we can't sample keys cleanly
    (index joins, mismatched left/right key sets, no common columns)."""
    def as_list(x):
        if x is None:
            return None
        return list(x) if isinstance(x, (list, tuple)) else [x]
    if on is not None:
        return as_list(on)
    lo, ro = as_list(left_on), as_list(right_on)
    if lo is not None and ro is not None:
        # Only sample when both sides name the same columns (the common case);
        # cross-named keys can't be set-compared directly here.
        return lo if lo == ro else None
    if lo is not None or ro is not None:
        return None  # one-sided / index join — skip
    common = [c for c in left.columns if c in set(right.columns)]
    return common or None


def _key_set(df, cols):
    sub = df[cols].dropna()
    if len(cols) == 1:
        return set(sub[cols[0]].astype(str))
    return set(map(tuple, sub[cols].astype(str).itertuples(index=False, name=None)))


def summarize_merge(left, right, result, keys) -> Optional[str]:
    """Return an actionable diagnostic string when the merge is degenerate,
    else None. Pure (no side effects) so it is unit-testable standalone."""
    try:
        nl, nr, no = len(left), len(right), len(result)
        if nl < _MIN_ROWS or nr < _MIN_ROWS or not keys:
            return None
        lk, rk = _key_set(left, keys), _key_set(right, keys)
        if not lk:
            return None
        matched = lk & rk
        match_frac = len(matched) / len(lk)
        keyname = keys[0] if len(keys) == 1 else "(" + ", ".join(map(str, keys)) + ")"
        # 1) near-zero key match — the actionable case: show the mismatch.
        if match_frac < _MATCH_FRAC_FLOOR:
            lonly = sorted(lk - rk)[:_SAMPLE]
            ronly = sorted(rk - lk)[:_SAMPLE]
            return (
                f"Join check ⚠ on {keyname}: {nl}×{nr} rows → only "
                f"{round(100*match_frac)}% of left keys matched. "
                f"left-only e.g. {lonly}; right-only e.g. {ronly}. "
                f"Keys don't align — normalize (case / abbreviation / whitespace / dtype) before merging."
            )
        # 2) cartesian/fan-out explosion — output dwarfs BOTH inputs combined,
        #    which only happens with a many-to-many duplicate key. (A plain
        #    one-to-many join legitimately makes output > a single input, so we
        #    require output > 3×(left+right) to avoid alarming on intended
        #    expansions — the alarm-fatigue lesson from lever 1.)
        if no > _FANOUT_CEIL * (nl + nr):
            return (
                f"Join check ⚠ on {keyname}: {nl}×{nr} rows → {no} out "
                f"(>{_FANOUT_CEIL:.0f}× both inputs combined). A join key is non-unique on BOTH sides "
                f"(many-to-many); dedupe/aggregate before joining or rows are multiplied/double-counted."
            )
        return None
    except Exception:
        return None


def _instrumented(orig, is_method):
    def wrapper(*args, **kwargs):
        result = orig(*args, **kwargs)  # real merge first — never disturbed
        try:
            if is_method:
                left = args[0]; right = args[1] if len(args) > 1 else kwargs.get("right")
            else:
                left = args[0] if args else kwargs.get("left")
                right = args[1] if len(args) > 1 else kwargs.get("right")
            if isinstance(left, pandas.DataFrame) and isinstance(right, pandas.DataFrame):
                keys = _key_columns(left, right, kwargs.get("on"),
                                    kwargs.get("left_on"), kwargs.get("right_on"))
                msg = summarize_merge(left, right, result, keys)
                if msg and msg not in _SINK:
                    _SINK.append(msg)
        except Exception:
            pass
        return result
    return wrapper


def install() -> None:
    global _orig_df_merge, _orig_pd_merge, _installed
    if _installed:
        return
    _orig_df_merge = pandas.DataFrame.merge
    _orig_pd_merge = pandas.merge
    pandas.DataFrame.merge = _instrumented(_orig_df_merge, is_method=True)
    pandas.merge = _instrumented(_orig_pd_merge, is_method=False)
    _installed = True


def uninstall() -> None:
    global _installed
    if not _installed:
        return
    try:
        if _orig_df_merge is not None:
            pandas.DataFrame.merge = _orig_df_merge
        if _orig_pd_merge is not None:
            pandas.merge = _orig_pd_merge
    finally:
        _installed = False
