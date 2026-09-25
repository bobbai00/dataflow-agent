#!/usr/bin/env python3
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.

"""Read LongDS artifacts without running agents, saved programs, or judges.

Reproduce the September 24 state audit from the repository root:
    python3 agent-service/benchmark/multiturn/audit-longds-state.py --out /tmp/state-audit.json

Scores remain the recorded judge scores (pass = 1). AST counts describe submitted
programs, not successful execution. Receipts are recorded separately. Prompt
characters exclude the system prompt/tool schema, which inputMessages omits.
Historical reads are parsed calls to `at`, never substring matches of `float`.
"""
import argparse
import ast
import hashlib
import json
import subprocess
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "benchmark/longds"))
from official_table import TASKS, summarize  # noqa: E402
from trace_report import script_turns  # noqa: E402

TASK_KEYS = {v: k for k, v in TASKS.items()}


def read(path):
    return json.loads(path.read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def text_content(message):
    content = message.get("content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


def context_sizes(step):
    totals = Counter()
    for m in step.get("inputMessages") or []:
        content = text_content(m)
        options = m.get("providerOptions") or {}
        if (options.get("texera") or {}).get("taskHistory"):
            category = "completed_entries"
        elif content.startswith("# Tables now"):
            category = "live_index"
        else:
            category = "other_recorded_messages"
        totals[category] += len(content)
    return dict(totals)


def dataflow_details(run):
    prior = set()
    turns = {}
    paths = sorted(run.glob("turns/t*/react_steps.json"))
    for path in paths:
        steps = read(path)
        turn = int(path.parent.name[1:])
        here = set()
        calls = []
        llm = [s for s in steps if s.get("role") == "agent" and (s.get("usage") or {}).get("inputTokens")]
        for index, step in enumerate(steps):
            results = {r.get("toolCallId"): r for r in step.get("toolResults") or []}
            for call in step.get("toolCalls") or []:
                if call.get("toolName") != "dataflow":
                    continue
                args = call.get("input") or {}
                code = args.get("edits") or args.get("program") or ""
                output = (results.get(call.get("toolCallId")) or {}).get("output")
                record = {
                    "trace_index": index, "step_id": step.get("id"),
                    "description": args.get("reasoning") or args.get("step") or args.get("why"),
                    "program_chars": len(code), "restore": args.get("restore") or [],
                    "observe_only": bool(args.get("observe")) and not (code.strip() or args.get("restore") or args.get("delete")),
                    "statements": [], "at_calls": [], "prior_reassignments": [], "function_chars": 0,
                }
                if isinstance(output, dict):
                    record["outcomes"] = output.get("operators", [])
                    record["observation_errors"] = output.get("observationErrors", [])
                try:
                    tree = ast.parse(code)
                except SyntaxError as error:
                    record["parse_error"] = str(error)
                else:
                    record["at_calls"] = [ast.unparse(n) for n in ast.walk(tree)
                                          if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "at"]
                    for node in tree.body:
                        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            record["function_chars"] += len(ast.get_source_segment(code, node) or "")
                        if not (isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)):
                            continue
                        name = node.targets[0].id
                        here.add(name)
                        record["statements"].append(ast.unparse(node))
                        if name in prior:
                            record["prior_reassignments"].append(name)
                calls.append(record)
        prior |= here
        turns[turn] = {
            "calls": calls, "first_input_tokens": (llm[0].get("usage") or {}).get("inputTokens") if llm else None,
            "first_context_chars": context_sizes(llm[0]) if llm else {},
        }
    graph = {}
    if paths:
        workflow = read(paths[-1].parent / "workflow.json")
        operators = workflow.get("operators", [])
        graph = {
            "nodes": len(operators), "links": len(workflow.get("links", [])),
            "native_types": dict(Counter((o.get("nativeOp") or {}).get("type", "other") for o in operators)),
            "definitions": [{"id": o["operatorID"], "inputs": (o.get("nativeOp") or {}).get("inputs", []),
                             "source": (o.get("nativeOp") or {}).get("source", ""),
                             "code_chars": len(((o.get("nativeOp") or {}).get("properties") or {}).get("code", ""))}
                            for o in operators],
        }
    return turns, graph


def load_run(scratch, trial, arm, task):
    sut = f"LongDS_Official_{arm}_luna_t{trial}"
    run = scratch / sut / TASK_KEYS[task]
    path = run / "results_eval.json"
    if not path.exists():
        return None
    records = read(path)
    result = {"sut": sut, "trial": trial, "arm": arm, "task": task,
              "path": str(run.resolve()), "results_sha256": digest(path),
              "summary": summarize(records, True), "turns": []}
    config = run / "turns/config.json"
    if config.exists():
        c = read(config)
        result["settings"] = c.get("settings")
        result["cost_rates"] = c.get("cost_rates_usd_per_million")
        result["config_sha256"] = digest(config)
    details, graph = dataflow_details(run) if arm.startswith("react") else ({}, {})
    scripts = {t: {"python_blocks": len(blocks), "program_chars": sum(map(len, blocks))}
               for t, _, blocks in script_turns(run)} if arm == "dsgym" else {}
    result["graph"] = graph
    for record in records:
        tid = record["turn_id"]
        result["turns"].append({
            "turn": tid, "score": (record.get("judge") or {}).get("score"),
            "state_type": record.get("state_type", []), "depends_tasks": record.get("depends_tasks", []),
            "question": record.get("question"), "judge_error": (record.get("judge") or {}).get("error_detail"),
            "stats": record.get("stats") or {}, **details.get(tid, {}), **scripts.get(tid, {}),
        })
    calls = [c for t in result["turns"] for c in t.get("calls", [])]
    result["gestures"] = {
        "dataflow_calls": len(calls), "at_calls": sum(len(c["at_calls"]) for c in calls),
        "restore_requests": sum(len(c["restore"]) for c in calls),
        "prior_reassignments": sum(len(c["prior_reassignments"]) for c in calls),
        "turns_reassigning_prior": sum(any(c["prior_reassignments"] for c in t.get("calls", [])) for t in result["turns"]),
        "program_chars": sum(c["program_chars"] for c in calls),
        "function_chars": sum(c["function_chars"] for c in calls),
        "observe_only_calls": sum(c["observe_only"] for c in calls),
        "unparsed_programs": sum("parse_error" in c for c in calls),
        "error_outcomes": sum(o.get("status") == "error" for c in calls for o in c.get("outcomes", [])),
    }
    return result


def replay_university():
    """Offline intervention on the observed encoding decision, not an agent run.

    Requires pandas/numpy. Keeps the requested pairwise covariance fixed and
    varies the encoding used by its ancestor and by the downstream filter.
    """
    import numpy as np
    import pandas as pd

    path = ROOT / "benchmark/longds/DataMind/longds/dataset/data/longds/education/world_university_rankings/task2/data/world-university-rankings/timesData.csv"
    data = pd.read_csv(path, na_values=["", "-"])
    data = data.loc[data.year == 2016].copy().reset_index(drop=True)
    for col in ["teaching", "international", "research", "citations", "income", "total_score", "num_students", "student_staff_ratio", "international_students"]:
        data[col] = pd.to_numeric(data[col].astype("string").str.replace(",", "", regex=False).str.replace("%", "", regex=False), errors="coerce").astype(float)
    parts = data["female_male_ratio"].astype("string").str.split(":", expand=True)
    female = pd.to_numeric(parts[0], errors="coerce").astype(float)
    male = pd.to_numeric(parts[1], errors="coerce").astype(float)
    quotient = female / male.replace(0, np.nan)
    formula = 0.3 * data.teaching + 0.3 * data.research + 0.3 * data.citations + 0.075 * data.international + 0.025 * data.income
    data["total_score"] = data.total_score.fillna(formula)
    columns = ["teaching", "international", "research", "citations", "income", "total_score", "num_students", "student_staff_ratio", "international_students", "female_male_ratio"]
    encodings = {"quotient": quotient, "female_percentage": female}
    cases = []
    for upstream, screening in [("quotient", "quotient"), ("quotient", "female_percentage"), ("female_percentage", "female_percentage")]:
        numeric = data.copy()
        numeric["female_male_ratio"] = encodings[upstream]
        x = numeric[columns]
        inverse = np.linalg.pinv(x.cov().to_numpy(dtype=float))
        complete = x.notna().all(axis=1)
        centered = x.loc[complete].to_numpy(dtype=float) - x.mean().to_numpy(dtype=float)
        distance = pd.Series(np.nan, index=data.index)
        distance.loc[complete] = np.einsum("ij,jk,ik->i", centered, inverse, centered)
        values = encodings[screening]
        keep = (distance.isna() | (distance < 25)) & data.num_students.notna() & values.notna() & (data.num_students < 90000) & (values > 5)
        cleaned = data.loc[keep]
        cases.append({"distance_encoding": upstream, "filter_encoding": screening,
                      "anadolu_distance": float(distance.loc[data.university_name == "Anadolu University"].iloc[0]),
                      "cleaned_rows": len(cleaned),
                      "total_score_mean": float(cleaned.total_score.mean()) if len(cleaned) else None,
                      "total_score_std": float(cleaned.total_score.std()) if len(cleaned) > 1 else None,
                      "members": sorted(cleaned.university_name.tolist())})
    mixed, fixed = map(lambda case: set(case["members"]), cases[1:])
    for case in cases:
        del case["members"]
    return {"source_sha256": digest(path), "numpy": np.__version__, "pandas": pd.__version__,
            "covariance": "pairwise-complete pandas cov in all three cases", "cases": cases,
            "added_after_ancestor_repair": sorted(fixed - mixed), "removed_after_ancestor_repair": sorted(mixed - fixed),
            "limitation": "Validates the numerical mechanism at turn 5 only; no later model turns were rerun and no saved scores were changed."}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--scratch", type=Path, default=ROOT / "benchmark/longds/system_scratch")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--replay-university", action="store_true", help="also replay the encoding correction locally; needs pandas and numpy")
    args = ap.parse_args()
    selection = [(t, a, k) for t in [9, 10, 11] for a in ["react-entries", "dsgym"] for k in ["university", "netflix3"]]
    selection += [(4, a, k) for a in ["react-catalog", "react-full"] for k in ["github", "university", "policing"]]
    selection += [(8, "react-entries", "university"), (3, "react-catalog", "github")]
    selection += [(5, a, k) for a in ["react-entries", "react-restore"] for k in ["netflix3", "policing"]]
    runs, missing = [], []
    for selection_item in selection:
        run = load_run(args.scratch, *selection_item)
        if run is None:
            missing.append(selection_item)
        else:
            runs.append(run)
    paired = defaultdict(list)
    latest = {(r["trial"], r["arm"], r["task"]): r for r in runs if r["trial"] in [9, 10, 11]}
    for trial in [9, 10, 11]:
        for task in ["university", "netflix3"]:
            a, b = (latest.get((trial, arm, task)) for arm in ["react-entries", "dsgym"])
            if not a or not b:
                continue
            bt = {t["turn"]: t for t in b["turns"]}
            for ta in a["turns"]:
                tb = bt.get(ta["turn"])
                if tb is None or ta["score"] is None or tb["score"] is None:
                    continue
                key = "both_pass" if ta["score"] == tb["score"] == 1 else "dataflow_only" if ta["score"] == 1 else "dsgym_only" if tb["score"] == 1 else "both_fail"
                paired[key].append({"trial": trial, "task": task, "turn": ta["turn"],
                                    "dataflow_cost": ta["stats"].get("cost_usd"), "dsgym_cost": tb["stats"].get("cost_usd")})
    payload = {
        "audit_date": "2026-09-24", "audited_checkout": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "notes": ["Run configs do not record runtime commits; current checkout is not asserted to be their runtime.",
                  "Trials 9–11 have matching recorded settings. Earlier trials are separate diagnostics, not pooled controls.",
                  "Binary recorded judge score 1 means pass; no scores were changed or judged afresh.",
                  "Only available scored pairs enter buckets; missing/unscored counts are reported per run.",
                  "Cost is the recorded repository estimate, not an invoice; gesture counts describe attempts.",
                  "Python parse failures are counted, so AST gesture counts alone are not exhaustive for those programs.",
                  "No future question, annotation, or reference solution is supplied to an agent by this offline audit."],
        "missing": missing, "paired_counts": {k: len(v) for k, v in paired.items()}, "paired": paired, "runs": runs,
    }
    if args.replay_university:
        payload["university_repair_replay"] = replay_university()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"out": str(args.out), "runs": len(runs), "missing": missing, "paired_counts": payload["paired_counts"]}))


if __name__ == "__main__":
    main()
