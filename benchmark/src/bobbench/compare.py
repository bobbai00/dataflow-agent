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
"""bench compare: A against B over the same tasks, from two run folders (or two arms of one run).

    bench compare <run>[:<arm or model>] <run>[:<arm or model>] [--th 0.9] [--gap 0.10] [--top 10] [--rep 1]
                  [--scores <bench score prepbench output> ...] [--chronic <task list.json>] [--json OUT]

The Venn of who solves what (A only, B only, both, neither) on the answer-type metric, the cost split inside "both", and
per case (A only, B only, both with a material cost gap either way) the attempts behind it: cost, steps, operators and
depth of the final dataflow, rows of its tables, and the tasks' input files. A task the judge could not grade is left
out rather than counted as wrong; a NaN answer scores 0. --chronic marks tasks known to flip between runs with `*`.
Only files are read; no model, judge or service is called.
"""
import argparse
from collections import Counter
import json
import math
import os
from pathlib import Path

from bobbench.kramabench.tasks import SCORE_METRICS
from bobbench.report import attempts, load

# The metric that decides each answer type (a task's other metrics are diagnostics).
ANSWER_TYPE_METRIC = {"numeric_exact": "success", "string_exact": "success", "list_exact": "f1",
                      "numeric_approximate": "rae_score", "list_approximate": "f1_approximate",
                      "string_approximate": "llm_paraphrase"}


def answer_score(folder, scored=None):
    """An attempt's score on its answer type's metric; None when the judge could not grade it. PrepBench's verdict comes
    from `bench score prepbench` (`scored`)."""
    if scored is not None:
        return float(bool(scored.get("passed")))
    evaluation, truth = load(folder / "evaluation.json"), load(folder / "ground_truth.json", {})
    if not evaluation:
        return None
    metric = ANSWER_TYPE_METRIC.get(truth.get("answer_type") or "")
    if metric and metric in evaluation and evaluation[metric] is None:
        return None
    value = evaluation.get(metric) if metric and isinstance(evaluation.get(metric), (int, float)) else None
    if value is None:
        values = [float(evaluation[k]) for k in SCORE_METRICS if isinstance(evaluation.get(k), (int, float))]
        value = max(values) if values else 0.0
    return 0.0 if math.isnan(float(value)) else float(value)


def billed(stats):
    """The attempt's bill, or None when it is unknown (a zero with tokens is unknown too, never free)."""
    cost = stats.get("cost_usd")
    if isinstance(cost, bool) or not isinstance(cost, (int, float)) or not math.isfinite(cost) or cost < 0:
        return None
    return None if cost == 0 and any(stats.get(k) for k in ("input_tokens", "output_tokens", "total_tokens")) else float(cost)


def dataflow(folder):
    """The final dataflow of a BobFlow attempt: operators, deepest path, roots, and the rows of its tables."""
    snapshot = load(folder / "snapshot.json", {})
    saved = load(folder / "workflow.json", {})
    workflow = saved.get("workflow", saved) or snapshot.get("workflow") or {}
    operators = [op["operatorID"] for op in workflow.get("operators", [])]
    parents = {op: [] for op in operators}
    for link in workflow.get("links", []):
        parents.setdefault(link["target"]["operatorID"], []).append(link["source"]["operatorID"])
    depths = {}

    def depth(op, seen=()):
        if op not in depths:
            depths[op] = 0 if op in seen or not parents.get(op) else 1 + max(depth(p, (*seen, op)) for p in parents[op])
        return depths[op]

    results = snapshot.get("results") or {}
    return {"operators": len(operators), "depth": max((depth(op) for op in operators), default=0),
            "sources": sum(not parents.get(op) for op in operators),
            "rows": sorted(r["totalRowCount"] for r in results.values() if isinstance(r.get("totalRowCount"), int))}


def side(spec, rep, scores):
    """{task: attempt record} of one side: `<run>[:<arm or model>[:<arm or model>]]`, one repetition."""
    path, *wanted = spec.split(":")
    run = Path(path)
    if not (run / "progress.json").exists():
        raise SystemExit(f"{run} is not a run folder (no progress.json)")
    inventory = {t["task_id"]: t for t in (load(run / "manifest.json") or {}).get("input_inventory", [])}
    found, names = {}, set()
    for row in attempts(run):
        if row.get("rep", 1) != rep or any(w not in (row.get("arm"), row.get("model")) for w in wanted):
            continue
        names.add(row["sut"])
        folder = run / "system_scratch" / row["sut"] / row["task"]
        stats = load(folder / "stats.json", {})
        trace = load(folder / "react_steps.json", {})
        found[row["task"]] = {
            "folder": str(folder), "score": answer_score(folder, scores.get((run.name, row["task"]))), "cost": billed(stats),
            "steps": stats.get("num_steps"), "calls": stats.get("model_requests"), "timeout": bool(row.get("timeout")),
            "elapsed": stats.get("elapsed_seconds"), "agent_steps": sum(s.get("role") == "agent" for s in trace.get("steps", [])),
            "input_bytes": (inventory.get(row["task"]) or {}).get("bytes"),
            "input_formats": sorted({os.path.splitext(f["path"])[1].lower() for f in (inventory.get(row["task"]) or {}).get("files", [])}),
            **dataflow(folder)}
    if len(names) > 1:
        raise SystemExit(f"{spec} holds {len(names)} SUTs ({', '.join(sorted(names))}): name an arm or a model, as <run>:<arm>")
    if not found:
        raise SystemExit(f"{spec} has no attempts of repetition {rep}")
    return found, (next(iter(names)) if names else spec)


def median(values):
    values = sorted(v for v in values if v is not None)
    return values[len(values) // 2] if values else None


def show(value):
    return "-" if value is None else f"{value:,}"


def money(value):
    return "-" if value is None else f"{value:.4f}"


def aggregate(records):
    """One side's numbers over one case's tasks."""
    return {"tasks": len(records), "cost": sum(r["cost"] or 0 for r in records), "steps_med": median([r["steps"] for r in records]),
            "operators_med": median([r["operators"] for r in records]), "depth_med": median([r["depth"] for r in records]),
            "rows_med": median([median(r["rows"]) for r in records]), "timeouts": sum(r["timeout"] for r in records)}


def compare(a, b, th, gap):
    common = sorted(t for t in set(a) & set(b) if a[t]["score"] is not None and b[t]["score"] is not None)
    both = [t for t in common if a[t]["score"] >= th and b[t]["score"] >= th]
    only_a = [t for t in common if a[t]["score"] >= th > b[t]["score"]]
    only_b = [t for t in common if b[t]["score"] >= th > a[t]["score"]]
    costed = [t for t in both if a[t]["cost"] is not None and b[t]["cost"] is not None]

    def relative_gap(t):  # the saving as a fraction of the dearer side
        return (b[t]["cost"] - a[t]["cost"]) / max(a[t]["cost"], b[t]["cost"], 1e-9)

    return {"common": common, "only_a": only_a, "only_b": only_b, "both": both,
            "neither": [t for t in common if a[t]["score"] < th and b[t]["score"] < th], "costed": costed,
            "a_cheaper": [t for t in costed if relative_gap(t) >= gap], "b_cheaper": [t for t in costed if -relative_gap(t) >= gap],
            "a_saves": sum(b[t]["cost"] - a[t]["cost"] for t in costed if b[t]["cost"] > a[t]["cost"]),
            "b_saves": sum(a[t]["cost"] - b[t]["cost"] for t in costed if a[t]["cost"] > b[t]["cost"]),
            "unscored": sorted((set(a) | set(b)) - set(common))}


def main():
    parser = argparse.ArgumentParser(prog="bench compare", description=__doc__.split("\n\n")[0],
                                     formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n\n", 1)[1])
    parser.add_argument("a", metavar="A", help="<run>[:<arm or model>]")
    parser.add_argument("b", metavar="B", help="<run>[:<arm or model>]")
    parser.add_argument("--th", type=float, default=0.9, help="pass threshold on the answer-type metric")
    parser.add_argument("--gap", type=float, default=0.10, help="material cost gap, as a fraction of the dearer side")
    parser.add_argument("--top", type=int, default=10, help="most tasks listed per case")
    parser.add_argument("--rep", type=int, default=1, help="which repetition of each side")
    parser.add_argument("--scores", nargs="+", type=Path, default=[], help="bench score prepbench outputs, for PrepBench runs")
    parser.add_argument("--chronic", type=Path, help="JSON list of tasks known to flip between runs; they get a *")
    parser.add_argument("--json", type=Path, help="also write the cases and attempts here")
    args = parser.parse_args()
    scores = {(Path(row["run"]).name, row["task"]): row for path in args.scores for row in load(path, [])}
    a, name_a = side(args.a, args.rep, scores)
    b, name_b = side(args.b, args.rep, scores)
    chronic = set(load(args.chronic, [])) if args.chronic else set()
    tag = lambda task: task + ("*" if task in chronic else "")  # noqa: E731
    c = compare(a, b, args.th, args.gap)
    print(f"A = {name_a}\nB = {name_b}\npass threshold {args.th} on the answer-type metric; material cost gap {args.gap:.0%}"
          + ("; * = chronic flipper" if chronic else ""))
    print(f"shared tasks {len(c['common'])}: A only {len(c['only_a'])} | both {len(c['both'])} | B only {len(c['only_b'])} | "
          f"neither {len(c['neither'])}" + (f"; left out unscored or missing: {len(c['unscored'])}" if c["unscored"] else ""))
    print(f"both pass, {len(c['costed'])} with both costs known: A cheaper on "
          f"{sum(b[t]['cost'] > a[t]['cost'] for t in c['costed'])} (saves ${c['a_saves']:.3f}; material {len(c['a_cheaper'])}) | "
          f"B cheaper on {sum(a[t]['cost'] > b[t]['cost'] for t in c['costed'])} (saves ${c['b_saves']:.3f}; material {len(c['b_cheaper'])})")
    print(f"A only: {[tag(t) for t in c['only_a']]}\nB only: {[tag(t) for t in c['only_b']]}")
    cases = [("A wins, B fails", c["only_a"]), ("B wins, A fails", c["only_b"]),
             ("both pass, A materially cheaper", c["a_cheaper"]), ("both pass, B materially cheaper", c["b_cheaper"])]
    dump = {"a": name_a, "b": name_b, "th": args.th, "gap": args.gap, "summary": {k: v for k, v in c.items()}, "cases": {},
            "attempts": {"a": a, "b": b}}
    for label, tasks in cases:
        if not tasks:
            continue
        print(f"\n== {label}: {len(tasks)} tasks")
        print(f"{'task':28} {'cost A/B $':>17} {'steps A/B':>10} {'ops A/B':>8} {'depth A/B':>10} {'input MB':>9} formats")
        for t in sorted(tasks, key=lambda t: -abs((a[t]['cost'] or 0) - (b[t]['cost'] or 0)))[:args.top]:
            x, y = a[t], b[t]
            print(f"{tag(t):28} {money(x['cost']):>8}/{money(y['cost']):<8} {show(x['steps']):>4}/{show(y['steps']):<5} "
                  f"{x['operators']:>3}/{y['operators']:<4} {x['depth']:>4}/{y['depth']:<5} "
                  f"{(x['input_bytes'] or 0) / 1e6:>9.1f} {','.join(x['input_formats'])}")
        sa, sb = aggregate([a[t] for t in tasks]), aggregate([b[t] for t in tasks])
        for name, numbers in (("A", sa), ("B", sb)):
            print(f"  [{name}] cost ${numbers['cost']:.3f}, medians: steps {show(numbers['steps_med'])}, operators "
                  f"{show(numbers['operators_med'])}, depth {show(numbers['depth_med'])}, table rows {show(numbers['rows_med'])}; "
                  f"timeouts {numbers['timeouts']}")
        formats = Counter(f for t in tasks for f in a[t]["input_formats"])
        print(f"  [inputs] median {show(median([a[t]['input_bytes'] for t in tasks]))} bytes; formats {dict(formats.most_common())}")
        dump["cases"][label] = {"tasks": tasks, "a": sa, "b": sb, "input_formats": dict(formats)}
    if args.json:
        args.json.write_text(json.dumps(dump, indent=1) + "\n")


if __name__ == "__main__":
    main()
