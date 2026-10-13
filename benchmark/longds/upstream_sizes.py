# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements. See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""How much earlier code describes the state a request builds on? Offline, from full-history runs.

For every request from the second on, take the earlier state it actually used
and the code that made that state:
- dataflow (run_session's `transcript` arm): the earlier tables it read (as
  inputs or with `show`) and their upstream tables, back to the files, as
  their statements, plus the source of the functions those statements call
  (with the definitions those functions reach) and of earlier functions it
  called itself;
- script (`smolagents` arm): the earlier variables its code read before
  setting them, and every earlier statement that made them
  (script_state.upstream), or, coarser, the whole code actions holding those
  statements.
Each is measured in tokens, against all the code the agent wrote in earlier
tasks, with the number of earlier tasks it spans.

Usage: python -m benchmark.longds.upstream_sizes --root R [--out R/upstream-sizes.json]
"""
import argparse
import json
from pathlib import Path
import re
import statistics

import tiktoken

from benchmark.longds.common import load
from benchmark.longds.script_state import earlier_reads, statements, trace_statements, upstream

SET = re.compile(r"^\s*set\s+([A-Za-z_]\w*)\s*:\s*([A-Za-z_]\w*)\s*\((.*)\)\s*$")
DELETE = re.compile(r"^\s*delete\s+(.+)$")
SHOW = re.compile(r"^\s*show\s+(result|schema|operator|function)\s+(.+)$")
IDENT = re.compile(r"\b[A-Za-z_]\w*\b")
ENCODING = tiktoken.get_encoding("o200k_base")


def tokens(text):
    return len(ENCODING.encode(text or "", disallowed_special=()))


def steps_of(run):
    return {int(re.search(r"/t(\d+)/", str(p)).group(1)): load(p) for p in Path(run).glob("t*/steps.json.gz")}


def first_input(steps, script):
    if script:
        calls = [s for s in steps if s.get("type") == "action" and s.get("token_usage")]
        return calls[0]["token_usage"]["input_tokens"] if calls else None
    calls = [s for s in steps if s.get("role") == "agent" and s.get("usage")]
    return calls[0]["usage"]["inputTokens"] if calls else None


# ---------------------------------------------------------------------------
# dataflow

def edits(steps):
    """A request's tool calls in order: (python, statements, applied)."""
    for step in steps:
        if step.get("role") != "agent":
            continue
        for call, result in zip(step.get("toolCalls") or [], step.get("toolResults") or []):
            actions = (result.get("output") or {}).get("actions", [])
            applied = [a["action"] for a in actions if a["action"]["type"] == "edit" and a["status"] == "ok"]
            yield call["input"].get("python") or "", call["input"].get("statements") or "", applied


def dataflow_sizes(steps_by_task):
    tables, functions = {}, {}  # id -> {line, op, args, task}; name -> Statement (task in .task)
    out = {}
    for task in sorted(steps_by_task):
        start_tables, start_functions = dict(tables), dict(functions)
        if task > 1:
            used_tables, used_functions, own_tables, own_functions = set(), set(), set(), set()
            for python, text, applied in edits(steps_by_task[task]):
                for statement in statements(python, task, 0):
                    # New Python that calls an earlier function or constant uses it too.
                    used_functions |= {n for n in statement.reads if n in start_functions and n not in own_functions}
                    own_functions |= statement.kills if statement.kind != "import" else set()
                for line in text.splitlines():
                    if (m := SET.match(line)):
                        oid, op, args = m.groups()
                        used_tables |= {n for n in IDENT.findall(args.split("lambda")[0])
                                        if n in start_tables and n not in own_tables}
                        if op in start_functions and op not in own_functions:
                            used_functions.add(op)
                        own_tables.add(oid)
                    elif (m := SHOW.match(line)):
                        names = IDENT.findall(re.sub(r"\[[^\]]*\]", "", m.group(2)))
                        if m.group(1) == "function":
                            used_functions |= {n for n in names if n in start_functions and n not in own_functions}
                        else:
                            used_tables |= {n for n in names if n in start_tables and n not in own_tables}
            closure, pending = set(), list(used_tables)
            while pending:
                oid = pending.pop()
                if oid in closure:
                    continue
                closure.add(oid)
                pending += [n for n in IDENT.findall(start_tables[oid]["args"].split("lambda")[0])
                            if n in start_tables and n != oid]
            reached, pending = set(), [start_tables[o]["op"] for o in closure if start_tables[o]["op"] in start_functions]
            pending += list(used_functions)
            while pending:
                name = pending.pop()
                if name in reached or name not in start_functions:
                    continue
                reached.add(name)
                pending += list(start_functions[name].reads & start_functions.keys())
            earlier_code = sum(tokens(p) + tokens(s) for t in steps_by_task if t < task
                               for p, s, _ in edits(steps_by_task[t]))
            out[task] = {
                "used": len(used_tables) + len(used_functions),
                "tokens": sum(tokens(start_tables[o]["line"]) for o in closure) +
                sum(tokens(start_functions[f].source) for f in reached),
                "units": len(closure) + len(reached),
                "tasks": sorted({start_tables[o]["task"] for o in closure} | {start_functions[f].task for f in reached}),
                "earlier_code": earlier_code,
            }
        for python, _, applied in edits(steps_by_task[task]):
            for action in applied:
                for statement in statements(action.get("python") or python, task, 0):
                    if statement.kind != "import":
                        for name in statement.kills:
                            functions[name] = statement
                for line in (action.get("changes") or "").splitlines():
                    if (m := SET.match(line)):
                        oid, op, args = m.groups()
                        tables[oid] = {"line": line.strip(), "op": op, "args": args, "task": task}
                    elif (m := DELETE.match(line)):
                        for name in IDENT.findall(m.group(1)):
                            tables.pop(name, None)
    return out


# ---------------------------------------------------------------------------
# script

def script_sizes(steps_by_task):
    by_task = {task: trace_statements(steps_by_task[task], task) for task in steps_by_task}
    cells = {}
    for task, steps in steps_by_task.items():
        number = 0
        for step in steps:
            if step.get("type") == "action" and step.get("code_action"):
                number += 1
                cells[(task, number)] = step["code_action"]
    out = {}
    for task in sorted(by_task):
        if task == 1:
            continue
        earlier = [s for t in sorted(by_task) if t < task for s in by_task[t]]
        used = earlier_reads(by_task[task], earlier)
        made = upstream(earlier, used)
        whole = {(s.task, s.step) for s in made}
        out[task] = {
            "used": len(used),
            "tokens": sum(tokens(s.source) for s in made),
            "whole_cells_tokens": sum(tokens(cells[key]) for key in whole),
            "units": len(made),
            "tasks": sorted({s.task for s in made}),
            "earlier_code": sum(tokens(code) for (t, _), code in cells.items() if t < task),
        }
    return out


def summary(label, rows, history):
    used = [r for r in rows if r["used"]]
    if not used:
        return f"{label}: no request used earlier state"
    share = [r["tokens"] / r["earlier_code"] for r in used if r["earlier_code"]]
    span = [len(r["tasks"]) / (r["request"] - 1) for r in used]
    hist = [history[(r["session"], r["request"])] for r in used if history.get((r["session"], r["request"]))]
    line = (f"{label:28s} {len(rows):5d} {len(used) / len(rows):6.0%} {statistics.median(r['tokens'] for r in used):9,.0f} "
            f"{statistics.mean(r['tokens'] for r in used):9,.0f} {statistics.mean(share):9.0%} "
            f"{statistics.mean(len(r['tasks']) for r in used):7.1f} {statistics.mean(span):8.0%} "
            f"{statistics.mean(hist):10,.0f}")
    return line


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    rows = {"dataflow": [], "script": [], "script, whole cells": []}
    history = {"dataflow": {}, "script": {}}
    for prepared in sorted((args.root / "prepared").iterdir()):
        key = prepared.name
        flow_run, script_run = args.root / "runs" / f"{key}__transcript__r1", args.root / "runs" / f"{key}__smolagents__r1"
        if not (flow_run / "records.json").exists() or not (script_run / "records.json").exists():
            continue
        flow_steps, script_steps = steps_of(flow_run), steps_of(script_run)
        for task, row in dataflow_sizes(flow_steps).items():
            rows["dataflow"].append({"session": key, "request": task, **row})
            history["dataflow"][(key, task)] = first_input(flow_steps[task], False)
        for task, row in script_sizes(script_steps).items():
            rows["script"].append({"session": key, "request": task, **row})
            rows["script, whole cells"].append({"session": key, "request": task, **row,
                                                "tokens": row["whole_cells_tokens"]})
            history["script"][(key, task)] = first_input(script_steps[task], True)
    print(f"{'':28s} {'reqs':>5s} {'uses':>6s} {'median':>9s} {'mean':>9s} {'of code':>9s} {'tasks':>7s} "
          f"{'of tasks':>8s} {'history':>10s}")
    print(f"{'':28s} {'':>5s} {'earlier':>6s} {'tokens':>9s} {'tokens':>9s} {'written':>9s} {'spanned':>7s} "
          f"{'spanned':>8s} {'in context':>10s}")
    for label, data in rows.items():
        print(summary(label, data, history["dataflow" if label == "dataflow" else "script"]))
    if args.out:
        args.out.write_text(json.dumps(rows, indent=1))


if __name__ == "__main__":
    main()
