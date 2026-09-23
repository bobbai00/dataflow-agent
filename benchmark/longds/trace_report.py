#!/usr/bin/env python3
"""What each arm did with state, turn by turn, read from its own trace.

Dataflow (react-*): the programs the agent submitted. Per turn: model calls,
tables defined, raw files scanned again, tables from earlier turns used by name,
`at(name, task=N)` reads, and tables redefined that earlier turns had built.

Script (dsgym): the <python> blocks the agent ran. Per turn: model calls, names
assigned, files read again (read_csv/read_excel/open), names loaded that earlier
turns assigned (state reuse), and earlier names reassigned.

    python trace_report.py --sut LongDS_Official_react-catalog_luna_t3 --task university
    python trace_report.py --sut LongDS_Official_dsgym_luna_t3 --task university
"""
import argparse
import ast
import json
import re
from pathlib import Path

from _paths import SCRATCH
from official_table import TASKS

READERS = re.compile(r"\b(read_csv|read_excel|read_json|read_parquet|read_table|read_fwf|open|glob)\(")


def dataflow_turns(run: Path):
    for path in sorted(run.glob("turns/t*/react_steps.json")):
        turn = int(path.parent.name[1:])
        steps = json.loads(path.read_text())
        programs = [
            (c.get("input") or {}).get("program") or ""
            for s in steps
            for c in s.get("toolCalls") or []
            if c.get("toolName") == "dataflow"
        ]
        calls = sum(1 for s in steps if s.get("role") == "agent" and (s.get("usage") or {}).get("inputTokens"))
        yield turn, calls, programs


def report_dataflow(run: Path) -> None:
    defined: dict[str, int] = {}
    print(f"{'turn':>4}{'calls':>6}{'new':>5}{'scans':>6}{'reuse':>6}{'at()':>5}{'redef':>6}  reused tables / at() / redefined")
    for turn, calls, programs in dataflow_turns(run):
        new, scans, reuse, ats, redefined = set(), 0, set(), [], set()
        for program in programs:
            try:
                tree = ast.parse(program)
            except SyntaxError:
                continue
            for node in tree.body:
                if not (isinstance(node, ast.Assign) and isinstance(node.value, ast.Call) and isinstance(node.targets[0], ast.Name)):
                    continue
                name, call = node.targets[0].id, node.value
                if getattr(call.func, "id", "") == "scan":
                    scans += 1
                for arg in call.args:
                    if isinstance(arg, ast.Name) and defined.get(arg.id, turn) < turn:
                        reuse.add(arg.id)
                    if isinstance(arg, ast.Call) and getattr(arg.func, "id", "") == "at":
                        ats.append(ast.unparse(arg))
                if name in defined and defined[name] < turn:
                    redefined.add(name)
                elif name not in defined:
                    defined[name] = turn
                    new.add(name)
        detail = ", ".join(sorted(reuse)) + (f" / {' '.join(ats)}" if ats else "") + (f" / redefined {', '.join(sorted(redefined))}" if redefined else "")
        print(f"{turn:>4}{calls:>6}{len(new):>5}{scans:>6}{len(reuse):>6}{len(ats):>5}{len(redefined):>6}  {detail[:110]}")


def script_turns(run: Path):
    traj = json.loads((run / "agent/traj.json").read_text())
    conversation, index = traj.get("conversation", []), 0
    for solution in traj.get("solutions", []):
        blocks, assistant = [], 0
        while index < len(conversation) and assistant < solution["steps"]:
            message = conversation[index]
            index += 1
            if message.get("role") == "assistant":
                assistant += 1
                blocks += re.findall(r"<python>(.*?)</python>", message.get("content", ""), re.DOTALL)
        yield solution["turn_id"], solution["steps"], blocks


def report_script(run: Path) -> None:
    assigned: dict[str, int] = {}
    print(f"{'turn':>4}{'calls':>6}{'new':>5}{'reads':>6}{'reuse':>6}{'redef':>6}  reused names / redefined")
    for turn, steps, blocks in script_turns(run):
        new, reads, reuse, redefined = set(), 0, set(), set()
        for code in blocks:
            reads += len(READERS.findall(code))
            try:
                tree = ast.parse(code)
            except SyntaxError:
                continue
            assigned_here: set[str] = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
                    if node.id in assigned and assigned[node.id] < turn and node.id not in assigned_here:
                        redefined.add(node.id)
                    assigned_here.add(node.id)
                    if node.id not in assigned:
                        assigned[node.id] = turn
                        new.add(node.id)
            for node in ast.walk(tree):
                if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
                    if assigned.get(node.id, turn) < turn and node.id not in assigned_here:
                        reuse.add(node.id)
        detail = ", ".join(sorted(reuse))[:80] + (f" / redefined {', '.join(sorted(redefined))[:40]}" if redefined else "")
        print(f"{turn:>4}{steps:>6}{len(new):>5}{reads:>6}{len(reuse):>6}{len(redefined):>6}  {detail}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sut", required=True)
    ap.add_argument("--task", required=True, help="task key or short name")
    args = ap.parse_args()
    key = next((k for k, v in TASKS.items() if args.task in (k, v)), args.task)
    run = SCRATCH / args.sut / key
    if not run.exists():
        print(f"missing {run}")
        return 2
    if (run / "agent/traj.json").exists():
        report_script(run)
    else:
        report_dataflow(run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
