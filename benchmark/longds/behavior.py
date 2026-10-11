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
"""How a session carried its work across requests, from applied edits only.

Per request, in order, a run's trace gives the functions the agent registered
and the operators it set. Across the session that answers whether later
requests reused earlier work the way the multi-request prompt asks:
- earlier functions called: `set` statements calling a function an earlier
  request registered (the rule reused rather than rewritten);
- settings changes: an operator set again with the same function and inputs
  but different settings (a rule changed for everything after it);
- alternatives: a new operator calling an earlier function with settings no
  earlier call used (a version of a rule beside the current one);
- earlier tables read: new operators whose inputs an earlier request set;
- rescans: a scan of files an earlier request already scanned;
- new functions per request, and the share of them that take settings.
The gold's Update, Rollback and Counterfactual requests are where reuse is
expected; `revisits_reusing` is the share of them with any reuse.
"""
import ast
from collections import Counter
from pathlib import Path
import statistics

from benchmark.longds.common import committed_calls, load, parse_delete, parse_set, statement_blocks

REVISIT = {"Update", "Rollback", "Counterfactual"}


def function_sources(source):
    """Public top-level functions: name -> (source, keyword-only parameters)."""
    try:
        tree = ast.parse(source or "")
    except SyntaxError:
        return {}
    return {node.name: (ast.get_source_segment(source, node) or "", [a.arg for a in node.args.kwonlyargs])
            for node in tree.body if isinstance(node, ast.FunctionDef) and not node.name.startswith("_")}


def session_behavior(requests, labels=None):
    """`requests`: per request, in order, the steps it added. `labels`: the
    gold state types of each request (1-based), when known."""
    labels = labels or {}
    origin, sources = {}, {}  # function -> request that registered it, its current source
    defined = {}  # operator -> (function, inputs, settings, request that last set it)
    calls_by_function = {}  # function -> settings of every call so far
    scanned = set()
    per_request = []
    for number, steps in enumerate(requests, start=1):
        counts = Counter()
        new_functions = []
        for call in committed_calls(steps):
            if not call["applied"]:
                continue
            for name, (source, settings) in function_sources(call["input"].get("python")).items():
                if name not in origin:
                    origin[name] = number
                    new_functions.append((name, bool(settings)))
                elif sources.get(name) != source:
                    counts["functions redefined"] += 1
                sources[name] = source
            for block in statement_blocks(call["input"].get("statements")):
                if (removed := parse_delete(block)) is not None:
                    defined.pop(removed, None)
                    continue
                statement = parse_set(block)
                if statement is None:
                    continue
                op, inputs, settings = statement["op"], statement["inputs"], statement["settings"]
                earlier_function = origin.get(op, number) < number
                previous = defined.get(statement["id"])
                if earlier_function:
                    counts["earlier functions called"] += 1
                if previous and previous[3] < number and previous[:2] == (op, inputs) and previous[2] != settings:
                    counts["settings changes"] += 1
                elif not previous and earlier_function and settings not in calls_by_function.get(op, []):
                    counts["alternatives"] += 1
                if not previous and any(defined.get(name, (None,) * 4)[3] not in (None, number) for name in inputs):
                    counts["earlier tables read"] += 1
                if op == "scan":
                    files = str(settings.get("files"))
                    if files in scanned and not previous:
                        counts["rescans"] += 1
                    scanned.add(files)
                calls_by_function.setdefault(op, []).append(settings)
                defined[statement["id"]] = (op, inputs, settings, number)
        reuse = counts["earlier functions called"] + counts["settings changes"]
        per_request.append({"request": number, "labels": labels.get(number, []), **counts,
                            "new functions": len(new_functions),
                            "new functions with settings": sum(1 for _, has in new_functions if has),
                            "reused": reuse > 0})
    later = per_request[1:]
    revisits = [r for r in per_request if REVISIT & set(r["labels"])]
    total = lambda key: sum(r.get(key, 0) for r in per_request)  # noqa: E731
    new = total("new functions")
    return {
        "requests": len(per_request),
        "earlier functions called": total("earlier functions called"),
        "settings changes": total("settings changes"),
        "alternatives": total("alternatives"),
        "earlier tables read": total("earlier tables read"),
        "rescans": total("rescans"),
        "functions redefined": total("functions redefined"),
        "new functions per request": round(new / len(per_request), 2) if per_request else None,
        "share of new functions with settings": round(total("new functions with settings") / new, 2) if new else None,
        "later requests reusing": round(sum(r["reused"] for r in later) / len(later), 2) if later else None,
        "revisits reusing": round(sum(r["reused"] for r in revisits) / len(revisits), 2) if revisits else None,
        "per request": per_request,
    }


def run_behavior(run):
    """The behavior of one session run folder (see run_session.py)."""
    protocol = load(run / "protocol.json")
    gold = load(Path(protocol["prepared"]) / "gold.json")
    labels = {turn["turn_id"]: turn.get("state_type", []) for turn in gold["turns"]}
    folders = sorted(path for path in run.glob("t[0-9][0-9]") if (path / "steps.json.gz").exists())
    return session_behavior([load(folder / "steps.json.gz") for folder in folders], labels)


def mean(values):
    values = [v for v in values if v is not None]
    return round(statistics.mean(values), 2) if values else None
