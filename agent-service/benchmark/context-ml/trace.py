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
Trace loading + dataflow-DAG reconstruction for the BobFlow context-ML pipeline
(see ML_TRAINING.md).

A kramabench task directory holds a complete agent run:
  - react_steps.json : the ReAct trajectory (steps with tool calls/results)
  - workflow.json    : the FINAL dataflow DAG (operators + links)
  - ground_truth.json: gold answer + answer_type
  - evaluation.json  : success flag + token usage
  - config.json      : model + agent settings

The trajectory only records three tool kinds — `initialize`,
`createOrModifyOperator{operatorId,code,summary}` and `deleteOperator{operatorId}`
— so the DAG state at every step is *reconstructed* by replaying those events.
Two non-obvious facts drive the reconstruction:

  1. Links are implicit. An operator's upstream dependencies are the argument
     names of its `def process(arg1, arg2)` signature; each arg is an upstream
     operatorId. `def load()` operators are sources. (Verified against the final
     workflow.json links.)

  2. Per-operator execution results (table shape, errors) are NOT in
     toolResults — they are rendered into the *next* step's `inputMessages`
     under a "# Current Dataflow" block as `Output table shape: (R, C)`.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


# --------------------------------------------------------------------------- #
# Parsing helpers
# --------------------------------------------------------------------------- #

_PROCESS_RE = re.compile(r"def\s+process\s*\(([^)]*)\)")
_LOAD_RE = re.compile(r"def\s+load\s*\(")
_SHAPE_RE = re.compile(r"Output table shape:\s*\((\d+)\s*,\s*(\d+)\)")
# A per-operator block inside the rendered "# Current Dataflow" context.
_OP_BLOCK_RE = re.compile(
    r"###\s+Operator\s+`([^`]+)`\s*\(([^)]*)\)(.*?)(?=(?:###\s+Operator)|\Z)",
    re.DOTALL,
)


def parse_process_args(code: str) -> list[str]:
    """Upstream operator ids = the parameter names of `def process(...)`.

    Strips type annotations / defaults / `self`. Returns [] for `def load()`
    sources or when no process signature is present.
    """
    m = _PROCESS_RE.search(code or "")
    if not m:
        return []
    raw = m.group(1).strip()
    if not raw:
        return []
    args: list[str] = []
    for part in raw.split(","):
        name = part.strip().split(":")[0].split("=")[0].strip()
        if name and name != "self":
            args.append(name)
    return args


def infer_op_type(code: str) -> str:
    if _LOAD_RE.search(code or ""):
        return "DataLoading"
    return "DataProcessing"


def parse_rendered_results(input_messages: list[dict]) -> dict[str, dict]:
    """From a step's inputMessages, extract per-operator rendered results.

    Returns {op_id: {"rows": int|None, "cols": int|None, "has_error": bool,
                     "result_text": str}}.
    The context renders an operator block as:
        ### Operator `opId` (DataProcessing)
        Summary: ...
        Result:
          Executed operator opId
          Output table shape: (R, C)
          <tsv...>
    Errors render in the same Result block (no shape, error keywords present).
    """
    out: dict[str, dict] = {}
    for im in input_messages or []:
        content = im.get("content")
        if not isinstance(content, str) or "Operator `" not in content:
            continue
        for m in _OP_BLOCK_RE.finditer(content):
            op_id = m.group(1).strip()
            body = m.group(3) or ""
            shape = _SHAPE_RE.search(body)
            rows = int(shape.group(1)) if shape else None
            cols = int(shape.group(2)) if shape else None
            low = body.lower()
            has_error = (
                shape is None
                and ("error" in low or "traceback" in low or "exception" in low)
            )
            # Prefer the most informative rendering seen for this op.
            prev = out.get(op_id)
            if prev is None or (prev.get("rows") is None and rows is not None):
                out[op_id] = {
                    "rows": rows,
                    "cols": cols,
                    "has_error": has_error,
                    "result_text": body.strip()[:4000],
                }
    return out


# --------------------------------------------------------------------------- #
# Data model
# --------------------------------------------------------------------------- #


@dataclass
class OperatorState:
    """State of one operator as of a particular decision point (step)."""

    op_id: str
    op_type: str
    code: str
    summary: str
    upstream: list[str]            # operator ids feeding this op (live or not)
    created_seq: int               # agent-action index when first created
    last_edit_seq: int             # agent-action index of most recent edit
    revisions: int                 # number of create/modify calls so far
    failed_revisions: int          # create/modify calls that returned isError
    alive: bool                    # not deleted as of this step
    deleted_seq: Optional[int] = None
    # Execution result parsed from the *context* visible at this step.
    rows: Optional[int] = None
    cols: Optional[int] = None
    has_error: bool = False
    result_text: str = ""

    def to_dict(self) -> dict:
        return {
            "op_id": self.op_id,
            "op_type": self.op_type,
            "summary": self.summary,
            "upstream": list(self.upstream),
            "created_seq": self.created_seq,
            "last_edit_seq": self.last_edit_seq,
            "revisions": self.revisions,
            "failed_revisions": self.failed_revisions,
            "alive": self.alive,
            "rows": self.rows,
            "cols": self.cols,
            "has_error": self.has_error,
        }


@dataclass
class DecisionPoint:
    """A point in the trajectory just before an agent action.

    `live_ops` are the operators that exist (candidate context items) when the
    model decided this step. `acted_op_ids` are the operators this step
    created/modified/deleted (the agent's choice — useful for diagnostics).
    """

    seq: int                       # 0-based agent-action index
    step_id: str
    timestamp: int
    live_ops: dict[str, OperatorState]
    acted_op_ids: list[str] = field(default_factory=list)


@dataclass
class Trace:
    task_id: str
    domain: str
    model_type: str
    question: str
    answer_type: str
    gold_answer: str
    success: Optional[int]
    num_steps: int
    total_tokens: Optional[int]
    decisions: list[DecisionPoint]
    final_ops: dict[str, list[str]]   # final op_id -> upstream (from workflow.json)
    final_lineage: set[str]           # ancestor-closure of the primary answer sink
    final_op_ids: set[str]

    @property
    def n_final_ops(self) -> int:
        return len(self.final_op_ids)


# --------------------------------------------------------------------------- #
# Final-DAG lineage (the weak-label backbone)
# --------------------------------------------------------------------------- #


def _final_graph(workflow_json: dict) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    """Return (upstream, downstream) adjacency from final workflow.json links."""
    wf = workflow_json.get("workflow", workflow_json)
    ops = [o["operatorID"] for o in wf.get("operators", [])]
    upstream: dict[str, list[str]] = {o: [] for o in ops}
    downstream: dict[str, list[str]] = {o: [] for o in ops}
    for link in wf.get("links", []):
        s = link["source"]["operatorID"]
        t = link["target"]["operatorID"]
        if s in downstream and t in upstream:
            downstream[s].append(t)
            upstream[t].append(s)
    return upstream, downstream


def _ancestors(op: str, upstream: dict[str, list[str]]) -> set[str]:
    seen: set[str] = set()
    stack = [op]
    while stack:
        cur = stack.pop()
        for u in upstream.get(cur, []):
            if u not in seen:
                seen.add(u)
                stack.append(u)
    return seen


def compute_final_lineage(workflow_json: dict) -> tuple[set[str], dict[str, list[str]], set[str]]:
    """The load-bearing operators in the final DAG.

    The answer is produced by a terminal (sink) operator. With multiple sinks
    (e.g. an exploration branch left dangling), the *primary* answer sink is the
    deepest one (longest ancestor chain); ties broken by larger ancestor set.
    Lineage = that sink + its ancestors. Returns (lineage, upstream_adj, sinks).
    """
    upstream, downstream = _final_graph(workflow_json)
    all_ops = set(upstream.keys())
    sinks = [o for o in all_ops if not downstream.get(o)]
    if not all_ops:
        return set(), {}, set()
    if not sinks:                       # cyclic / degenerate: treat all as lineage
        return set(all_ops), upstream, set()

    def depth(o: str) -> int:
        # longest path length from any source to o
        memo: dict[str, int] = {}

        def d(x: str) -> int:
            if x in memo:
                return memo[x]
            ups = upstream.get(x, [])
            memo[x] = 0 if not ups else 1 + max(d(u) for u in ups)
            return memo[x]

        return d(o)

    primary = max(sinks, key=lambda o: (depth(o), len(_ancestors(o, upstream))))
    lineage = {primary} | _ancestors(primary, upstream)
    return lineage, upstream, set(sinks)


# --------------------------------------------------------------------------- #
# Replay
# --------------------------------------------------------------------------- #


def _meta_from_dir(task_dir: Path) -> dict:
    """Unify metadata across the two on-disk layouts:
      - kramabench shipped traces: react_steps.json + ground_truth.json + evaluation.json + config.json + stats.json
      - trace-gen output (fresh runs): react-steps.json + task.json + meta.json
    Returns {steps_file, task_id, domain, model_type, question, answer_type,
             gold_answer, success, num_steps, total_tokens}.
    """
    if (task_dir / "react_steps.json").exists():            # kramabench layout
        gt = _maybe_json(task_dir / "ground_truth.json")
        ev = _maybe_json(task_dir / "evaluation.json")
        cfg = _maybe_json(task_dir / "config.json")
        stats = _maybe_json(task_dir / "stats.json")
        return {
            "steps_file": "react_steps.json",
            "task_id": (cfg.get("query_id") or gt.get("id") or task_dir.name),
            "domain": task_dir.name.split("-")[0],
            "model_type": cfg.get("model_type", ""),
            "question": gt.get("query", ""),
            "answer_type": gt.get("answer_type", ""),
            "gold_answer": "" if gt.get("answer") is None else str(gt.get("answer")),
            "success": ev.get("success"),
            "num_steps": stats.get("num_steps"),
            "total_tokens": stats.get("total_tokens"),
        }
    # trace-gen layout
    task = _maybe_json(task_dir / "task.json")
    meta = _maybe_json(task_dir / "meta.json")
    md = task.get("metadata", {}) or {}
    score = meta.get("score", {}) or {}
    usage = (meta.get("timings", {}) or {})
    return {
        "steps_file": "react-steps.json",
        "task_id": task.get("id", task_dir.name),
        "domain": md.get("domain", task_dir.name.split("-")[0]),
        "model_type": (meta.get("agentInfo", {}) or {}).get("modelType", ""),
        "question": task.get("question", ""),
        "answer_type": md.get("krama_answer_type", task.get("answerType", "")),
        "gold_answer": str(task.get("goldAnswer", "")),
        "success": (1 if score.get("passed") else 0) if score else None,
        "num_steps": None,
        "total_tokens": None,
    }


def reconstruct(task_dir: str | Path) -> Trace:
    """Load a task dir (either layout) and reconstruct per-step DAG decisions."""
    task_dir = Path(task_dir)
    md = _meta_from_dir(task_dir)
    steps = json.loads((task_dir / md["steps_file"]).read_text()).get("steps", [])
    workflow = json.loads((task_dir / "workflow.json").read_text())

    final_lineage, final_upstream, _sinks = compute_final_lineage(workflow)
    final_ops = {k: v for k, v in final_upstream.items()}
    final_op_ids = set(final_ops.keys())

    # Replay state.
    ops: dict[str, OperatorState] = {}
    decisions: list[DecisionPoint] = []
    action_seq = 0

    for step in steps:
        if step.get("role") != "agent":
            continue
        tool_calls = step.get("toolCalls") or []
        # Skip the synthetic `initialize` baseline step (no candidate items yet).
        meaningful = [
            tc for tc in tool_calls
            if tc.get("toolName") in ("createOrModifyOperator", "deleteOperator")
        ]
        if not meaningful and not ops:
            continue

        # 1. Refresh execution results from the context the model saw THIS step.
        rendered = parse_rendered_results(step.get("inputMessages") or [])
        for op_id, r in rendered.items():
            if op_id in ops:
                ops[op_id].rows = r["rows"]
                ops[op_id].cols = r["cols"]
                ops[op_id].has_error = r["has_error"]
                ops[op_id].result_text = r["result_text"]

        # 2. Snapshot the decision point BEFORE applying this step's actions.
        live_snapshot = {
            op_id: _clone(op) for op_id, op in ops.items() if op.alive
        }
        acted: list[str] = []

        # 3. Apply this step's tool calls to evolve the DAG.
        results_by_id = {
            tr.get("toolCallId"): tr for tr in (step.get("toolResults") or [])
        }
        for tc in meaningful:
            name = tc.get("toolName")
            inp = tc.get("input") or {}
            op_id = inp.get("operatorId") or inp.get("operatorID")
            if not op_id:
                continue
            acted.append(op_id)
            tr = results_by_id.get(tc.get("toolCallId"), {})
            is_err = bool(tr.get("isError"))
            if name == "createOrModifyOperator":
                code = inp.get("code", "") or ""
                summary = inp.get("summary", "") or ""
                if op_id in ops and ops[op_id].alive:
                    o = ops[op_id]
                    o.code = code or o.code
                    o.summary = summary or o.summary
                    o.op_type = infer_op_type(o.code)
                    o.upstream = parse_process_args(o.code)
                    o.revisions += 1
                    o.last_edit_seq = action_seq
                    if is_err:
                        o.failed_revisions += 1
                else:
                    ops[op_id] = OperatorState(
                        op_id=op_id,
                        op_type=infer_op_type(code),
                        code=code,
                        summary=summary,
                        upstream=parse_process_args(code),
                        created_seq=action_seq,
                        last_edit_seq=action_seq,
                        revisions=1,
                        failed_revisions=1 if is_err else 0,
                        alive=True,
                    )
            elif name == "deleteOperator":
                if op_id in ops:
                    ops[op_id].alive = False
                    ops[op_id].deleted_seq = action_seq

        # Only record a decision point if there were candidate items to reason over.
        if live_snapshot:
            decisions.append(
                DecisionPoint(
                    seq=action_seq,
                    step_id=step.get("id", ""),
                    timestamp=_parse_ts(step.get("timestamp")),
                    live_ops=live_snapshot,
                    acted_op_ids=acted,
                )
            )
        action_seq += 1

    return Trace(
        task_id=md["task_id"],
        domain=md["domain"],
        model_type=md["model_type"] or "",
        question=md["question"] or "",
        answer_type=md["answer_type"] or "",
        gold_answer=md["gold_answer"] or "",
        success=md["success"],
        num_steps=md["num_steps"] if md["num_steps"] is not None else len(steps),
        total_tokens=md["total_tokens"],
        decisions=decisions,
        final_ops=final_ops,
        final_lineage=final_lineage,
        final_op_ids=final_op_ids,
    )


def _clone(o: OperatorState) -> OperatorState:
    return OperatorState(
        op_id=o.op_id, op_type=o.op_type, code=o.code, summary=o.summary,
        upstream=list(o.upstream), created_seq=o.created_seq,
        last_edit_seq=o.last_edit_seq, revisions=o.revisions,
        failed_revisions=o.failed_revisions, alive=o.alive,
        deleted_seq=o.deleted_seq, rows=o.rows, cols=o.cols,
        has_error=o.has_error, result_text=o.result_text,
    )


def _maybe_json(p: Path) -> dict:
    try:
        return json.loads(p.read_text())
    except Exception:
        return {}


def _parse_ts(ts) -> int:
    """Timestamps are epoch-ms ints (kramabench) or ISO strings (trace-gen export)."""
    if ts is None:
        return 0
    if isinstance(ts, (int, float)):
        return int(ts)
    try:
        from datetime import datetime
        return int(datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return 0


# --------------------------------------------------------------------------- #
# Discovery
# --------------------------------------------------------------------------- #


def find_task_dirs(root: str | Path) -> list[Path]:
    root = Path(root)
    return sorted(
        d for d in root.iterdir()
        if d.is_dir() and ((d / "react_steps.json").exists() or (d / "react-steps.json").exists())
    )


if __name__ == "__main__":
    import sys

    target = sys.argv[1] if len(sys.argv) > 1 else (
        "/home/bob/Desktop/bobflow/dataflow-agent/llm-training-set-v1-kramabench/wildfire-easy-15"
    )
    tr = reconstruct(target)
    print(f"task={tr.task_id} domain={tr.domain} model={tr.model_type} success={tr.success}")
    print(f"answer_type={tr.answer_type} gold={tr.gold_answer!r}")
    print(f"decision points={len(tr.decisions)} final_ops={tr.n_final_ops} lineage={sorted(tr.final_lineage)}")
    for d in tr.decisions:
        live = ", ".join(
            f"{o.op_id}(v{op.revisions},r{op.rows}x{op.cols}{'!' if op.has_error else ''})"
            for o, op in ((v, v) for v in d.live_ops.values())
        )
        print(f"  seq={d.seq:2d} live={len(d.live_ops)} acted={d.acted_op_ids} :: {live}")
