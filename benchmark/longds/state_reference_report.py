#!/usr/bin/env python3
"""How each arm handled LongDS's state patterns, turn by turn, from its trace
and the benchmark's annotations.

For every judged turn: its pattern (Initial / Update / Counterfactual /
Rollback, from `state_type`), the turns it depends on, the judge score, and
what the agent did with state:

  dataflow arms  reassign  redefined an id that an earlier task had defined
                 restore   used `restore`; anchored=yes when the restored task
                           is one of the turn's `depends_tasks`
                 newid     built new ids on tables from earlier tasks
                 rescan    scanned a raw file again
  dsgym          reread    read a raw file again (read_csv/open/...)

Rates per pattern and per arm follow, with the judge accuracy beside them, so a
gesture's use and its payoff are read together.

    python state_reference_report.py --trial 5 --arms dsgym,react-entries,react-restore
"""
import argparse
import ast
import json
import re
from collections import defaultdict
from pathlib import Path

from _paths import SCRATCH
from official_table import MODELS, TASKS
from trace_report import READERS, script_turns

PATTERNS = ["Initial", "Update", "Counterfactual", "Rollback"]


def pattern_of(state_type: list[str]) -> str:
    for name in ("Rollback", "Counterfactual", "Update"):
        if name in state_type:
            return name
    return "Initial"


def dataflow_gestures(run: Path) -> dict[int, dict]:
    """Per turn: which gestures the programs used, and the tasks restores anchored on."""
    defined: dict[str, int] = {}
    out: dict[int, dict] = {}
    for path in sorted(run.glob("turns/t*/react_steps.json")):
        turn = int(path.parent.name[1:])
        g = out.setdefault(turn, {"reassign": 0, "restore": [], "newid": 0, "rescan": 0, "calls": 0})
        for step in json.loads(path.read_text()):
            if step.get("role") == "agent" and (step.get("usage") or {}).get("inputTokens"):
                g["calls"] += 1
            for call in step.get("toolCalls") or []:
                if call.get("toolName") != "dataflow":
                    continue
                inp = call.get("input") or {}
                for item in inp.get("restore") or []:
                    if isinstance(item, dict) and isinstance(item.get("task"), int):
                        g["restore"].append(item["task"])
                try:
                    tree = ast.parse(inp.get("edits") or inp.get("program") or "")
                except SyntaxError:
                    continue
                for node in tree.body:
                    if not (isinstance(node, ast.Assign) and isinstance(node.value, ast.Call) and isinstance(node.targets[0], ast.Name)):
                        continue
                    name, call_ = node.targets[0].id, node.value
                    if getattr(call_.func, "id", "") == "scan":
                        g["rescan"] += 1
                    if name in defined and defined[name] < turn:
                        g["reassign"] += 1
                    elif name not in defined:
                        defined[name] = turn
                        if any(isinstance(a, ast.Name) and defined.get(a.id, turn) < turn for a in call_.args):
                            g["newid"] += 1
    return out


def script_gestures(run: Path) -> dict[int, dict]:
    out = {}
    for turn, steps, blocks in script_turns(run):
        out[turn] = {"reread": sum(len(READERS.findall(b)) for b in blocks), "calls": steps}
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trial", type=int, required=True)
    ap.add_argument("--arms", default="dsgym,react-entries,react-restore")
    ap.add_argument("--models", default="luna,terra")
    args = ap.parse_args()
    arms = args.arms.split(",")
    for tail in args.models.split(","):
        rows = defaultdict(lambda: defaultdict(lambda: {"n": 0, "correct": 0, "reassign": 0, "restore": 0, "anchored": 0, "newid": 0, "rescan": 0, "reread": 0}))
        found = False
        for arm in arms:
            root = SCRATCH / f"LongDS_Official_{arm}_{tail}_t{args.trial}"
            if not root.exists():
                continue
            for run in sorted(p for p in root.iterdir() if (p / "results_eval.json").exists()):
                found = True
                gestures = script_gestures(run) if (run / "agent/traj.json").exists() else dataflow_gestures(run)
                for t in json.loads((run / "results_eval.json").read_text()):
                    score = (t.get("judge") or {}).get("score")
                    if score is None:
                        continue
                    pat = pattern_of(t.get("state_type") or [])
                    g = gestures.get(t["turn_id"], {})
                    cell = rows[pat][arm]
                    cell["n"] += 1
                    cell["correct"] += score
                    cell["reassign"] += bool(g.get("reassign"))
                    restores = g.get("restore") or []
                    cell["restore"] += bool(restores)
                    depends = set(t.get("depends_tasks") or [])
                    cell["anchored"] += bool(restores) and any(r in depends for r in restores)
                    cell["newid"] += bool(g.get("newid"))
                    cell["rescan"] += bool(g.get("rescan"))
                    cell["reread"] += bool(g.get("reread"))
        if not found:
            continue
        print(f"\n=== {tail}: per pattern, per arm — turns / accuracy / turns using each gesture ===")
        print(f"{'pattern':<15}{'arm':<15}{'n':>4}{'acc%':>6}{'reassign':>9}{'restore':>8}{'anchored':>9}{'newid':>6}{'rescan':>7}{'reread':>7}")
        for pat in PATTERNS:
            for arm in arms:
                c = rows[pat].get(arm)
                if not c or not c["n"]:
                    continue
                pct = lambda k: f"{100 * c[k] // c['n']:>3}%"  # noqa: E731
                print(f"{pat:<15}{arm:<15}{c['n']:>4}{100 * c['correct'] / c['n']:>6.1f}{pct('reassign'):>9}{pct('restore'):>8}{pct('anchored'):>9}{pct('newid'):>6}{pct('rescan'):>7}{pct('reread'):>7}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
