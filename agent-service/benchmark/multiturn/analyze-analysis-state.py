#!/usr/bin/env python3
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.
"""Read existing LongDS verdicts and cache-aware usage; never invent scores.

Keep every trial separate. The first pass is the primary comparison; recovery
spending is always included in total spending, never hidden by best-of selection.
"""
import argparse
import ast
import json
import re
import statistics
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
HTML_LICENSE = """<!--
Licensed to the Apache Software Foundation (ASF) under one
or more contributor license agreements. See the NOTICE file
distributed with this work for additional information
regarding copyright ownership. The ASF licenses this file
to you under the Apache License, Version 2.0 (the
"License"); you may not use this file except in compliance
with the License. You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing,
software distributed under the License is distributed on an
"AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, either express or implied. See the License for the
specific language governing permissions and limitations
under the License.
-->

"""


def read(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def recorded_model_usage(directory, records):
    """Prefer complete call accounting, with no duplication of turn records.

    A stopped session may never write its final results file. Python checkpoints
    each completed response; native sessions checkpoint completed turns. Neither
    can account for a cancelled provider request that returned no usage.
    """
    source = "results records"
    turns = records
    if not turns and (directory / "turns/answers.json").exists():
        turns = read(directory / "turns/answers.json", [])
        source = "turns/answers.json"
    usage = defaultdict(float)
    for record in turns:
        for key, value in (record.get("stats") or {}).items():
            if isinstance(value, (int, float)):
                usage[key] += value
    calls_path = directory / "agent/calls.jsonl"
    calls = None
    if calls_path.exists():
        content = calls_path.read_text()
        # An in-progress final line is not yet a completed checkpoint.
        calls = [json.loads(line) for line in content.splitlines(keepends=True) if line.endswith("\n")]
        call_source = "agent/calls.jsonl"
    elif (directory / "agent/calls.json").exists():
        calls = read(directory / "agent/calls.json", {}).get("calls", [])
        call_source = "agent/calls.json"
    captured = directory / "interrupted-react-steps.json"
    if captured.exists():
        trace = read(captured)
        steps = trace.get("steps", []) if isinstance(trace, dict) else trace
        unique = {s["id"]: s for s in steps if s.get("role") == "agent" and s.get("usage", {}).get("inputTokens")}
        names = {"input_tokens": "inputTokens", "output_tokens": "outputTokens",
                 "cached_tokens": "cachedInputTokens", "cache_write_tokens": "cacheCreationInputTokens",
                 "reasoning_tokens": "reasoningTokens"}
        calls = [{key: s["usage"].get(field, 0) for key, field in names.items()} for s in unique.values()]
        call_source = captured.name
    if calls is not None and (captured.exists() or len(calls) >= usage.get("llm_calls", 0)):
        for key in ("input_tokens", "cached_tokens", "cache_write_tokens", "output_tokens", "reasoning_tokens"):
            usage[key] = sum(c.get(key, 0) or 0 for c in calls)
        usage["llm_calls"] = len(calls)
        usage["cost_usd"] = (
            (usage["input_tokens"] - usage["cached_tokens"] - usage["cache_write_tokens"]) * 0.2
            + usage["cached_tokens"] * 0.02 + usage["cache_write_tokens"] * 0.25
            + usage["output_tokens"] * 1.2
        ) / 1e6
        source = call_source
    return dict(usage), source


def judge_usage(directory):
    """Include archived scoring attempts, without pricing unknown models at zero."""
    protocol = read(directory / "judge_protocol.json", {})
    rates = protocol.get("rates_usd_per_token", {})
    result = {"calls": 0, "reported_usd": 0.0, "estimated_usd": 0.0,
              "unpriced_responses": 0, "failed_requests_without_usage": 0,
              "models": set(), "files": []}
    for path in sorted(directory.glob("results_eval*.json")):
        result["files"].append(path.name)
        for record in read(path, []):
            verdict = record.get("judge", {})
            model = verdict.get("model", "")
            if model:
                result["models"].add(model)
            calls = verdict.get("usage", [])
            if "judge call failed" in verdict.get("error_detail", "") and not calls:
                result["failed_requests_without_usage"] += 1
            for usage in calls:
                result["calls"] += 1
                if isinstance(usage.get("cost"), (int, float)):
                    result["reported_usd"] += usage["cost"]
                elif model == protocol.get("model") and rates and usage:
                    cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0) or 0
                    result["estimated_usd"] += (
                        (usage["prompt_tokens"] - cached) * rates["input"]
                        + cached * rates["cached_input"]
                        + usage["completion_tokens"] * rates["output"]
                    )
                else:
                    result["unpriced_responses"] += 1
    result["models"] = sorted(result["models"])
    result["accounted_usd"] = result["reported_usd"] + result["estimated_usd"]
    return result


def trace_mechanisms(directory):
    """Count submitted operations; these are not physical execution counts."""
    if (directory / "agent/traj.json").exists():
        sys.path.insert(0, str(ROOT / "benchmark/longds"))
        from trace_report import script_turns
        turns = [{"turn": turn, "llm_calls": calls, "python_blocks": len(blocks),
                  "program_chars": sum(len(b) for b in blocks)}
                 for turn, calls, blocks in script_turns(directory)]
        return {"turns": turns, "python_blocks": sum(t["python_blocks"] for t in turns),
                "turns_without_python": [t["turn"] for t in turns if not t["python_blocks"]]}
    counters = defaultdict(int)
    turns = []
    prior_tables, prior_functions = set(), set()
    paths = sorted(directory.glob("turns/t*/react_steps.json"))
    for path in paths:
        steps = read(path)
        calls = [s for s in steps if s.get("role") == "agent" and s.get("usage", {}).get("inputTokens")]
        contexts = []
        for step in calls:
            sizes = defaultdict(int)
            for message in step.get("inputMessages") or []:
                text = message.get("content", "")
                if not isinstance(text, str):
                    continue
                historical = message.get("providerOptions", {}).get("texera", {}).get("taskHistory")
                if historical or text.startswith(("# Analysis memory", "# Current analysis tables")):
                    sizes["completed_projection"] += len(text)
                sizes["recorded_messages"] += len(text)
            contexts.append(dict(sizes))
        turns.append({"turn": int(path.parent.name[1:]), "llm_calls": len(calls),
                      "first_input_tokens": calls[0]["usage"]["inputTokens"] if calls else None,
                      "first_context_chars": contexts[0] if contexts else {},
                      "max_completed_projection_chars": max((c.get("completed_projection", 0) for c in contexts), default=0)})
        tables_this_turn, functions_this_turn = set(), set()
        for step in steps:
            results = {r.get("toolCallId"): r.get("output") for r in step.get("toolResults") or []}
            counters["tool_error_responses"] += sum(bool(r.get("isError")) for r in step.get("toolResults") or [])
            for call in step.get("toolCalls") or []:
                if call.get("toolName") != "dataflow":
                    continue
                counters["dataflow_calls"] += 1
                args = call.get("input") or {}
                code = args.get("edits") or ""
                counters["program_chars"] += len(code)
                counters["inspect_calls"] += bool(args.get("inspect"))
                counters["recall_calls"] += bool(args.get("recall"))
                counters["fork_requests"] += len(args.get("fork") or [])
                counters["observe_only_calls"] += bool(args.get("observe")) and not any(
                    [code.strip(), args.get("fork"), args.get("restore"), args.get("delete")])
                output = results.get(call.get("toolCallId"))
                if isinstance(output, dict):
                    counters["error_outcomes"] += sum(o.get("status") == "error" for o in output.get("operators", []))
                    counters["observation_errors"] += len(output.get("observationErrors", []))
                try:
                    tree = ast.parse(code)
                except SyntaxError:
                    counters["unparsed_programs"] += 1
                    continue
                definitions = {n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
                functions_this_turn |= definitions
                counters["prior_function_redefinitions"] += len(definitions & prior_functions)
                counters["function_chars"] += sum(len(ast.get_source_segment(code, n) or "") for n in tree.body
                                                  if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)))
                counters["historical_reads"] += sum(isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
                                                    and n.func.id == "at" for n in ast.walk(tree))
                for node in tree.body:
                    if not (isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name) and isinstance(node.value, ast.Call)):
                        continue
                    tables_this_turn.add(node.targets[0].id)
                    counters["prior_table_reassignments"] += node.targets[0].id in prior_tables
                    op = getattr(node.value.func, "id", "")
                    counters["parameter_assignments"] += op == "parameters"
                    counters["scan_assignments"] += op == "scan"
                    functions = [k.value.id for k in node.value.keywords if k.arg == "fn" and isinstance(k.value, ast.Name)]
                    if op in ("map", "filter") and len(node.value.args) > 1 and isinstance(node.value.args[1], ast.Name):
                        functions.append(node.value.args[1].id)
                    counters["prior_function_uses_without_resending_definition"] += sum(
                        f in prior_functions and f not in definitions for f in functions)
        prior_tables |= tables_this_turn
        prior_functions |= functions_this_turn
    graph = read(paths[-1].with_name("workflow.json"), {}) if paths else {}
    operators = graph.get("operators", [])
    return {**dict(counters), "turns": turns, "final_operators": len(operators),
            "final_branch_operators": sum(bool(o.get("nativeOp", {}).get("analysisBranch")) for o in operators),
            "final_workflow_json_bytes": paths[-1].with_name("workflow.json").stat().st_size if paths else None}


def summarize(directory, traces=False):
    protocol = read(directory / "protocol.json", {})
    summary = read(directory / "summary.json", {})
    budget = read(directory / "session-budget.json")
    validity = read(directory / "evaluation-validity.json", {"eligible_for_primary_comparison": True})
    records = read(directory / "results_eval.json",
                   read(directory / "results_with_ground_truth.json", []))
    expected = protocol.get("turns", summary.get("turns_total", len(records)))
    scored = [r for r in records if r.get("judge", {}).get("score") in (0, 1)]
    correct = int(sum(r["judge"]["score"] for r in scored))
    usage, usage_source = recorded_model_usage(directory, records)
    judge = judge_usage(directory)
    by_pattern = defaultdict(lambda: [0, 0])
    for record in scored:
        for pattern in record.get("state_type") or ["Unlabeled"]:
            by_pattern[pattern][0] += record["judge"]["score"]
            by_pattern[pattern][1] += 1
    return {
        "sut": directory.parent.name, "task": directory.name,
        "arm": protocol.get("arm"),
        "trial": int(re.search(r"_t(\d+)$", directory.parent.name).group(1)),
        "expected": expected, "completed": len(records), "judged": len(scored),
        "attempted": ((budget or {}).get("attempted") if (budget or {}).get("expired") else
                      summary.get("turns_attempted", summary.get("turns_completed"))),
        "budget_stopped": bool((budget or {}).get("expired")),
        "correct": correct,
        "accuracy": correct / expected if expected and len(scored) == expected else None,
        "complete": len(scored) == expected and len(records) == expected,
        "eligible_for_primary_comparison": validity.get("eligible_for_primary_comparison", True),
        "validity": validity,
        "execution_isolation": protocol.get("execution_isolation", "not recorded"),
        "session_budget": budget,
        "usage": usage, "usage_source": usage_source, "by_pattern": dict(by_pattern),
        "judge_usage": judge,
        "scoring_model": read(directory / "judge_protocol.json", {}).get("model"),
        "runtime": protocol.get("runtime"), "path": str(directory.resolve()),
        **({"mechanisms": trace_mechanisms(directory)} if traces else {}),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--selection", type=Path)
    parser.add_argument("--traces", action="store_true", help="also audit operation and context mechanisms")
    args = parser.parse_args()
    selection = read(args.selection) if args.selection else {}
    selected = (set(t.replace("/", "__") for t in selection["selected_tasks"])
                if args.selection else None)
    rows = [summarize(p.parent, args.traces) for p in sorted((ROOT / "benchmark/longds/system_scratch").glob(
        args.prefix + "*/*/protocol.json")) if selected is None or p.parent.name in selected]
    groups = defaultdict(list)
    for row in rows:
        groups[row["trial"], row["arm"]].append(row)
    planned = {row["task"]: row["expected"] for row in rows}
    planned.update({row["task"].replace("/", "__"): row["turns"] for row in selection.get("inventory", [])})
    aggregates = []
    for (trial, arm), group in sorted(groups.items()):
        complete = all(r["complete"] for r in group) and (selected is None or {r["task"] for r in group} == selected)
        eligible = all(r["eligible_for_primary_comparison"] for r in group)
        aggregates.append({
            "trial": trial, "arm": arm, "tasks": len(group), "complete": complete,
            "eligible_for_primary_comparison": eligible,
            "turns": sum(r["expected"] for r in group), "judged": sum(r["judged"] for r in group),
            "planned_turns": (sum(planned[t] for t in selected) if selected <= planned.keys() else None)
                             if selected is not None else sum(r["expected"] for r in group),
            "missing_tasks": sorted(selected - {r["task"] for r in group}) if selected is not None else [],
            "correct": sum(r["correct"] for r in group),
            "attempted": sum(r["attempted"] for r in group) if all(r["attempted"] is not None for r in group) else None,
            "budget_stopped_sessions": sum(r["budget_stopped"] for r in group),
            "macro_accuracy": statistics.mean(r["accuracy"] for r in group) if complete and eligible else None,
            "excluded_diagnostic_macro_accuracy": statistics.mean(r["accuracy"] for r in group) if complete and not eligible else None,
            "model_cost_usd": sum(r["usage"].get("cost_usd", 0) for r in group),
            "llm_calls": sum(r["usage"].get("llm_calls", 0) for r in group),
            "cached_tokens": sum(r["usage"].get("cached_tokens", 0) for r in group),
            "cache_write_tokens": sum(r["usage"].get("cache_write_tokens", 0) for r in group),
            "output_tokens": sum(r["usage"].get("output_tokens", 0) for r in group),
            "input_tokens": sum(r["usage"].get("input_tokens", 0) for r in group),
            "session_seconds": sum(r["usage"].get("elapsed_seconds", 0) for r in group),
            "judge_accounted_usd": sum(r["judge_usage"]["accounted_usd"] for r in group),
        })
    payload = {"prefix": args.prefix, "selected_tasks": sorted(selected) if selected else None,
               "runs": rows, "aggregates": aggregates,
               "all_recorded_model_spend_usd": sum(r["usage"].get("cost_usd", 0) for r in rows),
               "reported_judge_spend_usd": sum(r["judge_usage"]["reported_usd"] for r in rows),
               "estimated_judge_spend_usd": sum(r["judge_usage"]["estimated_usd"] for r in rows),
               "unpriced_judge_responses": sum(r["judge_usage"]["unpriced_responses"] for r in rows),
               "failed_judge_requests_without_usage": sum(r["judge_usage"]["failed_requests_without_usage"] for r in rows),
               "scoring_models": sorted({r["scoring_model"] for r in rows if r["scoring_model"]})}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.with_suffix(".json").write_text(json.dumps(payload, indent=2))
    lines = ["First-pass results are primary. Recovery trials are separate; no best-of selection.",
             "Model costs use repository cache-aware rates. Infrastructure is excluded.",
             "Where recorded, session-budget.json defines the wall limit; unreached questions count as failures.",
             "Missing sessions remain unjudged. Incomplete trial costs cover only recorded sessions and are not comparable to complete trials.",
             f"Scoring models: {', '.join(payload['scoring_models']) or 'not yet recorded'}.", "",
             "| Trial | Arm | Correct / judged / planned | Attempted | Budget stops | Task macro | Model USD | Calls |",
             "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for g in aggregates:
        macro = ("excluded" if not g["eligible_for_primary_comparison"] else
                 f"{100 * g['macro_accuracy']:.1f}%" if g["macro_accuracy"] is not None else "incomplete")
        attempted = g["attempted"] if g["attempted"] is not None else "running"
        lines.append(f"| {g['trial']} | {g['arm']} | {g['correct']}/{g['judged']}/{g['planned_turns'] if g['planned_turns'] is not None else 'unknown'} | {attempted} | {g['budget_stopped_sessions']} | {macro} | {g['model_cost_usd']:.4f} | {g['llm_calls']:.0f} |")
    lines += ["", f"Recorded model spending for this report's run prefix: ${payload['all_recorded_model_spend_usd']:.4f}.",
              f"Judge spending for these runs, including archived judge attempts: ${payload['reported_judge_spend_usd']:.4f} "
              f"provider-reported + ${payload['estimated_judge_spend_usd']:.4f} estimated from recorded tokens.",
              f"Unpriced judge responses: {payload['unpriced_judge_responses']}; failed requests without "
              f"usage: {payload['failed_judge_requests_without_usage']} (billing unavailable).", "",
              "| Trial | Arm | Task | Correct / judged / planned | Attempted | Model USD |",
              "| ---: | --- | --- | ---: | ---: | ---: |"]
    for r in rows:
        attempted = r["attempted"] if r["attempted"] is not None else "running"
        lines.append(f"| {r['trial']} | {r['arm']} | {r['task']} | {r['correct']}/{r['judged']}/{r['expected']} | {attempted} | {r['usage'].get('cost_usd', 0):.4f} |")
    args.out.with_suffix(".md").write_text(HTML_LICENSE + "\n".join(lines) + "\n")
    print(json.dumps({"runs": len(rows), "aggregates": aggregates, "out": str(args.out)}))


if __name__ == "__main__":
    main()
