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
"""Score, cost and latency of a run_baselines.py round, as Markdown.

    benchmark/Kramabench/.venv/bin/python baseline_report.py <output> [--json metrics.json]

The score is evaluate.py's headline: the mean, over scored tasks, of the task's
headline metric. It is also recomputed the way upstream KramaBench scores
(`--upstream`, a git revision of the harness that holds upstream's
metrics.py and workloads): upstream's `success` tolerance instead of this
fork's rounding rule, upstream's golds, and judge failures counted as zero.
"""
import argparse
import importlib.util
import json
import math
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile

KB = Path(__file__).resolve().parents[1] / "Kramabench"
HEADLINE = ["success", "llm_paraphrase", "rae_score", "f1", "f1_approximate"]


def read(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def lines(path):
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def spread(values):
    """Mean, median, 90th percentile and maximum of a list of seconds."""
    if not values:
        return {"n": 0, "mean": None, "median": None, "p90": None, "max": None, "total": 0.0}
    ordered = sorted(values)
    return {
        "n": len(ordered),
        "mean": statistics.fmean(ordered),
        "median": statistics.median(ordered),
        "p90": ordered[min(len(ordered) - 1, int(0.9 * len(ordered)))],
        "max": ordered[-1],
        "total": sum(ordered),
    }


def upstream_scorer(revision):
    """Upstream's `success` metric and golds, read from a harness revision."""

    def show(path):
        return subprocess.check_output(["git", "-C", str(KB), "show", f"{revision}:{path}"], text=True)

    with tempfile.TemporaryDirectory() as temp:
        source = Path(temp) / "upstream_metrics.py"
        source.write_text(show("benchmark/metrics.py"))
        sys.path.insert(0, str(KB))  # its judge helpers; the judged metrics are not rerun
        spec = importlib.util.spec_from_file_location("upstream_metrics", source)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    golds = {}
    for domain in ["archeology", "astronomy", "biomedical", "environment", "legal", "wildfire"]:
        golds.update({task["id"]: task["answer"] for task in json.loads(show(f"workload/{domain}.json"))})
    return module.Success(), golds


def attempt(root, row):
    """Everything recorded about one attempt, reduced to numbers."""
    path = root / "system_scratch" / row["sut"] / row["task"]
    stats, evaluation = read(path / "stats.json", {}), read(path / "evaluation.json", {})
    trace = lines(path / "model-request-trace.jsonl")
    responses = [e for e in trace if e["phase"] == "response"]
    executions = [e for e in lines(path / "executions.jsonl") if e["event"] == "execute"]
    kernel = lines(path / "kernel-executions.jsonl")
    metric = next((name for name in HEADLINE if name in evaluation), None)
    value = None if metric is None or evaluation[metric] is None else float(evaluation[metric])
    return {
        **{key: row[key] for key in ("arm", "task", "rep", "timeout", "exit_code")},
        "domain": row["task"].split("-")[0],
        "metric": metric,
        # evaluate.py drops a missing value (the judge failed) and a NaN one
        # (the answer was `nan`) from its average alike.
        "score": None if value is None or math.isnan(value) else value,
        "answer": (read(path / "answer.json", {}) or {}).get("answer"),
        "cost_usd": stats.get("cost_usd") or 0.0,
        "input_tokens": stats.get("input_tokens") or 0,
        "cached_tokens": stats.get("cached_tokens") or 0,
        "output_tokens": stats.get("output_tokens") or 0,
        "reasoning_tokens": stats.get("reasoning_tokens") or 0,
        "model_calls": len(responses),
        "failed_model_calls": sum(e["phase"] == "error" for e in trace),
        "empty_responses": sum(
            not e.get("choices") or not (e["choices"][0]["message"].get("content") or "").strip() for e in responses
        ),
        "model_call_seconds": [e["seconds"] for e in responses],
        "execution_seconds": [e["seconds"] for e in executions],
        "kernel_seconds": [e["seconds"] for e in kernel if e["event"] == "execute"],
        "sandbox_start_seconds": sum(e["seconds"] for e in kernel if e["event"] == "allocate"),
        "truncated_outputs": sum(bool(e.get("truncated")) for e in executions),
        "largest_output_chars": max((e.get("output_chars") or 0 for e in executions), default=0),
        "largest_logs_chars": max((e.get("logs_chars") or 0 for e in executions), default=0),
        "execution_errors": sum(bool(e.get("error")) for e in executions)
        + sum(bool(e.get("errors")) for e in kernel if e["event"] == "execute"),
        "execution_timeouts": sum(bool(e.get("timed_out")) for e in kernel),
        "wall_seconds": row["seconds"],
        "agent_seconds": stats.get("elapsed_seconds") or 0.0,
        # smolagents: RunResult.state; DSGym: the turn limit reached without an <answer>.
        "step_limit": stats.get("state") == "max_steps_error"
        or (
            row["arm"] != "smolagents"
            and stats.get("num_steps") == read(path / "settings.json", {}).get("max_turns")
            and not (read(path / "result.json", {}) or {}).get("answer")
        ),
        "no_answer": (read(path / "answer.json", {}) or {}).get("answer") in (None, "", "No response from agent"),
        "audit": row["audit"],
    }


def summarize(attempts, scorer):
    scored = [a for a in attempts if a["score"] is not None]
    calls = [s for a in attempts for s in a["model_call_seconds"]]
    executions = [s for a in attempts for s in a["execution_seconds"]]
    kernel = [s for a in attempts for s in a["kernel_seconds"]]
    total = lambda key: sum(a[key] for a in attempts)  # noqa: E731
    summary = {
        "tasks": len(attempts),
        "scored": len(scored),
        "unscored": len(attempts) - len(scored),
        "score": 100 * statistics.fmean(a["score"] for a in scored) if scored else None,
        "score_unscored_as_zero": 100 * sum(a["score"] for a in scored) / len(attempts),
        "full_passes": sum(a["score"] == 1.0 for a in scored),
        "cost_usd": total("cost_usd"),
        "input_tokens": total("input_tokens"),
        "cached_tokens": total("cached_tokens"),
        "uncached_input_tokens": total("input_tokens") - total("cached_tokens"),
        "output_tokens": total("output_tokens"),
        "reasoning_tokens": total("reasoning_tokens"),
        "model_calls": total("model_calls"),
        "failed_model_calls": total("failed_model_calls"),
        "empty_responses": total("empty_responses"),
        "executions": len(executions),
        "execution_errors": total("execution_errors"),
        "execution_timeouts": total("execution_timeouts"),
        "truncated_outputs": total("truncated_outputs"),
        "tasks_without_execution": sum(not a["execution_seconds"] for a in attempts),
        "step_limit_tasks": sum(bool(a["step_limit"]) for a in attempts),
        "timeout_tasks": sum(bool(a["timeout"]) for a in attempts),
        "no_answer_tasks": sum(bool(a["no_answer"]) for a in attempts),
        "largest_output_chars": max((a["largest_output_chars"] for a in attempts), default=0),
        "largest_logs_chars": max((a["largest_logs_chars"] for a in attempts), default=0),
        "task_wall": spread([a["wall_seconds"] for a in attempts]),
        "task_agent": spread([a["agent_seconds"] for a in attempts]),
        "model_call": spread(calls),
        "execution": spread(executions),
        "kernel_execution": spread(kernel),
        "sandbox_start_seconds": total("sandbox_start_seconds"),
        "by_domain": {
            domain: 100 * statistics.fmean(a["score"] for a in scored if a["domain"] == domain)
            for domain in sorted({a["domain"] for a in scored})
        },
        "audit_violations": sorted({v for a in attempts for v in a["audit"]["violations"]}),
        "audit_warnings": {
            w: sum(w in a["audit"]["warnings"] for a in attempts)
            for w in sorted({w for a in attempts for w in a["audit"]["warnings"]})
        },
    }
    if scorer:
        success, golds = scorer
        values = [
            float(success(a["answer"], golds[a["task"]])[0]) if a["metric"] == "success" else (a["score"] or 0.0)
            for a in attempts
        ]
        summary["upstream_score"] = 100 * statistics.fmean(values)
        summary["upstream_changed_tasks"] = sorted(
            a["task"] for a, value in zip(attempts, values) if a["metric"] == "success" and value != a["score"]
        )
    return summary


def seconds(value):
    return "-" if value is None else f"{value:.1f}"


def render(root, manifest, summaries):
    arms = list(summaries)
    out = [f"# Script-agent baselines on KramaBench: `{root.name}`", ""]
    model = next(iter(manifest["models"].values()))
    out += [
        f"Model `{model}` through `{manifest['script_endpoint']}`; {len(manifest['task_ids'])} tasks, "
        f"{manifest['repetitions']} attempt(s) each; {manifest['script_settings']['max_steps']} steps, "
        f"{manifest['script_settings']['max_print_outputs_length']:,} characters of output per execution; "
        f"task limit {manifest['task_timeout_seconds']} s.",
        "",
    ]

    def table(title, rows):
        out.extend([f"## {title}", "", "| | " + " | ".join(arms) + " |", "|---|" + "---|" * len(arms)])
        out.extend(
            "| " + label + " | " + " | ".join(cell(summaries[arm]) for arm in arms) + " |" for label, cell in rows
        )
        out.append("")

    table(
        "Score and cost",
        [
            ("Score, this harness (%)", lambda s: "-" if s["score"] is None else f"{s['score']:.2f}"),
            ("Score, upstream rule (%)", lambda s: f"{s['upstream_score']:.2f}" if "upstream_score" in s else "-"),
            ("Tasks scored 1.0", lambda s: f"{s['full_passes']} / {s['tasks']}"),
            ("Unscored tasks (judge failed or NaN metric)", lambda s: str(s["unscored"])),
            ("Score with unscored tasks as 0 (%)", lambda s: f"{s['score_unscored_as_zero']:.2f}"),
            ("Cost (USD)", lambda s: f"{s['cost_usd']:.4f}"),
            ("Cost per task (USD)", lambda s: f"{s['cost_usd'] / s['tasks']:.5f}"),
        ],
    )
    table(
        "Tokens",
        [
            ("Input", lambda s: f"{s['input_tokens']:,}"),
            ("  of which cached", lambda s: f"{s['cached_tokens']:,}"),
            ("  of which uncached", lambda s: f"{s['uncached_input_tokens']:,}"),
            ("Output", lambda s: f"{s['output_tokens']:,}"),
            ("  of which reasoning", lambda s: f"{s['reasoning_tokens']:,}"),
        ],
    )
    table(
        "Latency (seconds)",
        [
            ("Task wall clock: total", lambda s: seconds(s["task_wall"]["total"])),
            (
                "Task wall clock: mean / median / p90 / max",
                lambda s: " / ".join(seconds(s["task_wall"][k]) for k in ("mean", "median", "p90", "max")),
            ),
            ("Agent loop per task: mean", lambda s: seconds(s["task_agent"]["mean"])),
            ("Successful model requests", lambda s: f"{s['model_call']['n']:,}"),
            ("Successful model request: total", lambda s: seconds(s["model_call"]["total"])),
            (
                "Successful model request: mean / median / p90 / max",
                lambda s: " / ".join(seconds(s["model_call"][k]) for k in ("mean", "median", "p90", "max")),
            ),
            ("Python executions", lambda s: f"{s['execution']['n']:,}"),
            ("Python execution: total", lambda s: seconds(s["execution"]["total"])),
            (
                "Python execution: mean / median / p90 / max",
                lambda s: " / ".join(seconds(s["execution"][k]) for k in ("mean", "median", "p90", "max")),
            ),
            (
                "Kernel-side execution: total",
                lambda s: seconds(s["kernel_execution"]["total"]) if s["kernel_execution"]["n"] else "-",
            ),
            (
                "Kernel start: total",
                lambda s: seconds(s["sandbox_start_seconds"]) if s["sandbox_start_seconds"] else "-",
            ),
        ],
    )
    table(
        "Behaviour",
        [
            ("Successful model requests per task", lambda s: f"{s['model_calls'] / s['tasks']:.2f}"),
            ("Executions per task", lambda s: f"{s['executions'] / s['tasks']:.2f}"),
            ("Tasks answered without any execution", lambda s: str(s["tasks_without_execution"])),
            ("Tasks ended by the step limit", lambda s: str(s["step_limit_tasks"])),
            ("Tasks ended by the wall-clock limit", lambda s: str(s["timeout_tasks"])),
            ("Tasks with no answer", lambda s: str(s["no_answer_tasks"])),
            ("Empty model responses", lambda s: str(s["empty_responses"])),
            ("Failed model requests", lambda s: str(s["failed_model_calls"])),
            ("Executions that raised", lambda s: str(s["execution_errors"])),
            ("Executions cut at the output limit", lambda s: str(s["truncated_outputs"])),
            ("Audit violations", lambda s: ", ".join(s["audit_violations"]) or "none"),
        ],
    )
    domains = sorted({d for s in summaries.values() for d in s["by_domain"]})
    table("Score by domain (%)", [(d, lambda s, d=d: f"{s['by_domain'].get(d, float('nan')):.1f}") for d in domains])
    return "\n".join(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--upstream", default="upstream/main", help="Harness revision with upstream's scorer; '' skips it"
    )
    parser.add_argument("--json", type=Path, help="Also write the summaries and per-attempt numbers here")
    args = parser.parse_args()
    root = args.output.resolve()
    manifest, progress = read(root / "manifest.json"), read(root / "progress.json")
    scorer = upstream_scorer(args.upstream) if args.upstream else None
    attempts = [attempt(root, row) for row in progress["completed"]]
    summaries = {
        arm: summarize([a for a in attempts if a["arm"] == arm], scorer)
        for arm in dict.fromkeys(job["arm"] for job in manifest["jobs"])
        if any(a["arm"] == arm for a in attempts)
    }
    print(render(root, manifest, summaries))
    if args.json:
        args.json.write_text(json.dumps({"summaries": summaries, "attempts": attempts}, indent=1, default=str) + "\n")


if __name__ == "__main__":
    main()
