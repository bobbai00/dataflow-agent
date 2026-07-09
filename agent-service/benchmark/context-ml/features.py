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
Feature extraction, weak labels, and token cost for the context-ML pipeline.

Each row is one (decision-point, candidate-operator) pair: at step `seq` the
agent is about to act, and `op_id` is a live operator that *could* be placed in
the LLM context. We attach:

  - features  phi = [flow, temporal, data, task]  (observable at step `seq`)
  - cost      c   = tiktoken length of the serialized bundle (summary + result)
  - label     y   = is the operator load-bearing for the final answer?
  - aux       additional future-use signals for analysis (NOT used as runtime
              inputs; some look into the future, hence label-only).

Feature group prefixes (`flow_`, `temp_`, `data_`, `task_`) let downstream
code run the ML_TRAINING.md ablation (temporal < flow < flow+data).
"""

from __future__ import annotations

import math
import re
from functools import lru_cache

import pandas as pd

from trace import DecisionPoint, OperatorState, Trace


# --------------------------------------------------------------------------- #
# Token cost (tiktoken, exact serialized length)
# --------------------------------------------------------------------------- #


@lru_cache(maxsize=1)
def _encoder():
    import tiktoken

    # cl100k_base is the standard BPE shared by GPT-4-class + a good proxy for
    # the token budget regardless of the exact serving model.
    return tiktoken.get_encoding("cl100k_base")


def n_tokens(text: str) -> int:
    if not text:
        return 0
    return len(_encoder().encode(text))


def serialize_bundle(op: OperatorState) -> str:
    """The optional-evidence bundle the selector decides whether to include.

    The mandatory core (op id + type + edges) is always kept and is NOT part of
    this cost; here we cost the *detailed* summary + rendered result.
    """
    parts = [f"### Operator `{op.op_id}` ({op.op_type})", f"Summary: {op.summary}"]
    if op.result_text:
        parts.append("Result:\n" + op.result_text)
    elif op.rows is not None:
        parts.append(f"Result: shape ({op.rows}, {op.cols})")
    return "\n".join(parts)


# --------------------------------------------------------------------------- #
# Live-DAG graph metrics at a decision point
# --------------------------------------------------------------------------- #


def _live_graph(dp: DecisionPoint) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    live = set(dp.live_ops.keys())
    upstream: dict[str, list[str]] = {o: [] for o in live}
    downstream: dict[str, list[str]] = {o: [] for o in live}
    for op_id, op in dp.live_ops.items():
        for u in op.upstream:
            if u in live:
                upstream[op_id].append(u)
                downstream[u].append(op_id)
    return upstream, downstream


def _closure(start: str, adj: dict[str, list[str]]) -> set[str]:
    seen: set[str] = set()
    stack = [start]
    while stack:
        cur = stack.pop()
        for nxt in adj.get(cur, []):
            if nxt not in seen:
                seen.add(nxt)
                stack.append(nxt)
    return seen


def _depths(upstream: dict[str, list[str]]) -> dict[str, int]:
    memo: dict[str, int] = {}

    def d(x: str) -> int:
        if x in memo:
            return memo[x]
        memo[x] = -1  # cycle guard
        ups = upstream.get(x, [])
        memo[x] = 0 if not ups else 1 + max((d(u) for u in ups), default=0)
        return memo[x]

    return {o: d(o) for o in upstream}


# --------------------------------------------------------------------------- #
# Task-conditioned similarity
# --------------------------------------------------------------------------- #

_STOP = {
    "the", "a", "an", "of", "to", "in", "and", "or", "for", "is", "are", "be",
    "on", "with", "by", "as", "at", "from", "this", "that", "should", "answer",
    "data", "value", "based", "following", "according", "single", "result",
}


def _toks(text: str) -> set[str]:
    return {
        w for w in re.findall(r"[a-z0-9_]+", (text or "").lower())
        if w not in _STOP and len(w) > 1
    }


def _overlap(a: str, b: str) -> float:
    ta, tb = _toks(a), _toks(b)
    if not ta or not tb:
        return 0.0
    inter = len(ta & tb)
    return inter / len(ta | tb)  # Jaccard


# --------------------------------------------------------------------------- #
# Per-trace row extraction
# --------------------------------------------------------------------------- #


def rows_for_trace(tr: Trace) -> list[dict]:
    rows: list[dict] = []
    n_dec = len(tr.decisions)

    # Future-use lookups (label-only): for each op, the last seq it was alive,
    # whether it was deleted at any later point, and whether a later op depends
    # on it. Built by scanning all decision points.
    last_seen: dict[str, int] = {}
    deleted_anywhere: set[str] = set()
    for dp in tr.decisions:
        for op_id, op in dp.live_ops.items():
            last_seen[op_id] = dp.seq
            if not op.alive:
                deleted_anywhere.add(op_id)
    # An op is deleted-later if it survives in a snapshot but is absent from the
    # final DAG (superseded/pruned).
    for dp in tr.decisions:
        for op_id in dp.live_ops:
            if op_id not in tr.final_op_ids:
                deleted_anywhere.add(op_id)

    for dp in tr.decisions:
        upstream, downstream = _live_graph(dp)
        depths = _depths(upstream)
        max_depth = max(depths.values(), default=0)
        live_ids = set(dp.live_ops.keys())
        # frontier = most recently created live op(s)
        frontier = max(dp.live_ops.values(), key=lambda o: o.created_seq).op_id if dp.live_ops else None
        frontier_ancestors = _closure(frontier, upstream) | ({frontier} if frontier else set())

        for op_id, op in dp.live_ops.items():
            anc = _closure(op_id, upstream)
            desc = _closure(op_id, downstream)
            cost = n_tokens(serialize_bundle(op))

            # ---- label: load-bearing for the final answer ----
            on_lineage = op_id in tr.final_lineage
            survives = op_id in tr.final_op_ids
            y = int(on_lineage)

            rows.append({
                # identity
                "task_id": tr.task_id,
                "domain": tr.domain,
                "seq": dp.seq,
                "op_id": op_id,
                # ---- flow / lineage ----
                "flow_is_source": int(len(upstream[op_id]) == 0),
                "flow_n_upstream": len(upstream[op_id]),
                "flow_n_downstream": len(downstream[op_id]),
                "flow_n_ancestors": len(anc),
                "flow_n_descendants": len(desc),
                "flow_depth": depths.get(op_id, 0),
                "flow_dist_to_frontier": max_depth - depths.get(op_id, 0),
                "flow_is_sink_now": int(len(downstream[op_id]) == 0),
                "flow_on_frontier_path": int(op_id in frontier_ancestors),
                "flow_frac_live": 1.0 / max(1, len(live_ids)),
                "flow_n_live": len(live_ids),
                # ---- temporal / version ----
                "temp_age_seq": dp.seq - op.created_seq,
                "temp_steps_since_edit": dp.seq - op.last_edit_seq,
                "temp_revisions": op.revisions,
                "temp_failed_revisions": op.failed_revisions,
                "temp_recently_edited": int((dp.seq - op.last_edit_seq) <= 1),
                "temp_norm_recency": (dp.seq - op.last_edit_seq) / max(1, n_dec),
                # ---- execution / data ----
                "data_has_result": int(op.rows is not None),
                "data_has_error": int(op.has_error),
                "data_log_rows": math.log1p(op.rows) if op.rows else 0.0,
                "data_n_cols": float(op.cols or 0),
                "data_is_empty": int(op.rows == 0) if op.rows is not None else 0,
                "data_is_loader": int(op.op_type == "DataLoading"),
                # ---- task-conditioned ----
                "task_sim_question": _overlap(op.summary, tr.question),
                "task_summary_tokens": n_tokens(op.summary),
                # ---- cost ----
                "cost_tokens": cost,
                # ---- labels / aux (NOT features) ----
                "y": y,
                "aux_survives_final": int(survives),
                "aux_on_lineage": int(on_lineage),
                "aux_deleted_or_pruned": int(op_id in deleted_anywhere and not survives),
                "aux_task_success": int(tr.success) if tr.success is not None else -1,
            })
    return rows


# Canonical feature columns (everything with a group prefix).
FLOW_COLS = ["flow_is_source", "flow_n_upstream", "flow_n_downstream", "flow_n_ancestors",
             "flow_n_descendants", "flow_depth", "flow_dist_to_frontier", "flow_is_sink_now",
             "flow_on_frontier_path", "flow_frac_live", "flow_n_live"]
TEMP_COLS = ["temp_age_seq", "temp_steps_since_edit", "temp_revisions", "temp_failed_revisions",
             "temp_recently_edited", "temp_norm_recency"]
DATA_COLS = ["data_has_result", "data_has_error", "data_log_rows", "data_n_cols",
             "data_is_empty", "data_is_loader"]
TASK_COLS = ["task_sim_question", "task_summary_tokens"]
ALL_FEATURES = FLOW_COLS + TEMP_COLS + DATA_COLS + TASK_COLS
FEATURE_GROUPS = {"flow": FLOW_COLS, "temporal": TEMP_COLS, "data": DATA_COLS, "task": TASK_COLS}


def build_dataframe(traces: list[Trace]) -> pd.DataFrame:
    rows: list[dict] = []
    for tr in traces:
        rows.extend(rows_for_trace(tr))
    return pd.DataFrame(rows)


if __name__ == "__main__":
    import sys
    from trace import reconstruct, find_task_dirs

    root = sys.argv[1] if len(sys.argv) > 1 else (
        "/home/bob/Desktop/bobflow/dataflow-agent/llm-training-set-v1-kramabench"
    )
    traces = [reconstruct(d) for d in find_task_dirs(root)]
    df = build_dataframe(traces)
    pd.set_option("display.width", 200, "display.max_columns", 100)
    print(f"rows={len(df)}  tasks={df.task_id.nunique()}  features={len(ALL_FEATURES)}")
    print(f"positive rate (load-bearing): {df.y.mean():.3f}")
    print(f"cost tokens: mean={df.cost_tokens.mean():.0f} median={df.cost_tokens.median():.0f} max={df.cost_tokens.max()}")
    print("\nlabel vs survives_final crosstab:")
    print(pd.crosstab(df.aux_on_lineage, df.aux_survives_final))
    print("\nmean feature value by label:")
    print(df.groupby("y")[ALL_FEATURES].mean().T)
