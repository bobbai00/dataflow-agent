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
"""Analyze marginal task costs in saved runs; no model calls or rescoring.

Run with the repository Python environment. Prices are the saved campaign's
accounting assumptions, not current provider prices. Text tokenization is an
o200k_base estimate and excludes message framing and tool/system schemas.
"""
import argparse
import csv
import hashlib
import json
import subprocess
import tarfile
from collections import defaultdict
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import tiktoken

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
RATES = {"input": .2, "cached": .02, "write": .25, "output": 1.2}
CAMPAIGNS = ("dev-run2", "frames-run1", "dev-run3", "synthetic-run1")
ENCODING = tiktoken.get_encoding("o200k_base")


def read(path):
    return json.loads(path.read_text())


def summarize(rows):
    assert rows
    calls = sum(r["llm_calls"] for r in rows)
    out = {"tasks": len(rows), "passed": sum(r["passed"] for r in rows),
           "calls": calls, "usage_missing_tasks": sum(not r["llm_calls"] for r in rows)}
    for key in ("cost_usd", "read_usd", "write_usd", "other_input_usd", "output_usd",
                "input_tokens", "cached_tokens", "cache_write_tokens", "output_tokens",
                "code_characters"):
        out[key] = sum(r[key] for r in rows)
    out["mean_cost_usd"] = out["cost_usd"] / len(rows)
    out["mean_calls"] = calls / len(rows)
    out["mean_input_tokens_per_call"] = out["input_tokens"] / calls if calls else None
    input_cost = out["read_usd"] + out["write_usd"] + out["other_input_usd"]
    out["mean_input_usd_per_call"] = input_cost / calls if calls else None
    return out


def load_current():
    rows, sources = [], {}
    for campaign in CAMPAIGNS:
        folder = ROOT / "logs/campaigns" / campaign
        manifest = read(folder / "manifest.json")
        sources[campaign] = {
            "revision": manifest["revision"],
            "manifest_sha256": hashlib.sha256((folder / "manifest.json").read_bytes()).hexdigest(),
        }
        for session in manifest["primary"] + manifest["recoveries"]:
            run = folder / session["label"]
            cumulative_index_tokens = 0
            for path in sorted(run.glob("t[0-9][0-9]/stats.json")):
                stat, evaluation = read(path), read(path.with_name("evaluation.json"))
                row = {"campaign": campaign, "session": session["label"],
                       "family": session["family"], "arm": session["arm"],
                       "task": int(path.parent.name[1:]), "passed": evaluation["passed"],
                       "source": str(path.relative_to(ROOT)), **stat}
                ordinary = stat["input_tokens"] - stat["cached_tokens"] - stat["cache_write_tokens"]
                assert ordinary >= 0, path
                row.update(read_usd=stat["cached_tokens"] * RATES["cached"] / 1e6,
                           write_usd=stat["cache_write_tokens"] * RATES["write"] / 1e6,
                           other_input_usd=ordinary * RATES["input"] / 1e6,
                           output_usd=stat["output_tokens"] * RATES["output"] / 1e6)
                row["input_usd"] = row["read_usd"] + row["write_usd"] + row["other_input_usd"]
                assert abs(row["input_usd"] + row["output_usd"] - stat["cost_usd"]) < 1e-10, path
                if session["arm"] == "coderetain":
                    prompt = read(path.with_name("prompt.json"))["prompt"]
                    preamble = prompt.partition("\n\n")[0] if prompt.startswith("Retained state from earlier tasks.") else ""
                    current_index_tokens = len(ENCODING.encode(preamble))
                    cumulative_index_tokens += current_index_tokens
                    row.update(retention_index_text_tokens=current_index_tokens,
                               cumulative_retention_index_text_tokens=cumulative_index_tokens)
                trace = read(path.with_name("react_steps.json"))
                row["code_characters"] = 0
                for step in trace:
                    row["code_characters"] += len(step.get("code_action") or "")
                    for call in step.get("toolCalls", []):
                        # Program-mode calls carry the whole program; older
                        # JSON-batch traces carry code per operator.
                        row["code_characters"] += len(str(call.get("input", {}).get("program") or ""))
                        for op in call.get("input", {}).get("operators", []):
                            row["code_characters"] += len(str(op.get("code", "")))
                first = next((s for s in trace if s.get("role") == "agent"
                              and (s.get("usage") or {}).get("inputTokens", 0)), None)
                if first:
                    messages = first.get("inputMessages", [])
                    catalog_at = next((i for i, m in enumerate(messages)
                                       if isinstance(m.get("content"), str)
                                       and (m["content"].startswith("# Current operator catalog")
                                            or m["content"].startswith("# Operator catalog at the start"))), None)
                    row["first_call_input_tokens"] = first["usage"]["inputTokens"]
                    if catalog_at is not None:
                        history = [str(m["content"]) for m in messages[:catalog_at]]
                        catalog = messages[catalog_at]["content"]
                        row.update(history_chars=sum(map(len, history)), catalog_chars=len(catalog),
                                   history_text_tokens=sum(len(ENCODING.encode(t)) for t in history),
                                   catalog_text_tokens=len(ENCODING.encode(catalog)))
                rows.append(row)
            actual = [r for r in rows if r["campaign"] == campaign and r["session"] == session["label"]]
            saved = read(run / "summary.json")
            assert len(actual) == saved["tasks"]
            assert sum(r["passed"] for r in actual) == saved["passed"]
            assert abs(sum(r["cost_usd"] for r in actual) - saved["cost_usd"]) < 1e-10
    return rows, sources


def load_secondary():
    """Older experiments stay separate because accounting/settings differ."""
    output = {"note": "Older recorded costs omit cache-write accounting; do not pool with current campaigns."}
    archive = ROOT / "benchmark/longds/system_scratch/TaskHistoryMilestone/artifacts.tar.gz"
    if archive.exists():
        with tarfile.open(archive) as source:
            runs = {}
            for prefix in ("v2-code/code-repeated_corrections", "v3-tasks/tasks-repeated_corrections"):
                tasks = []
                for i in range(1, 21):
                    stat = json.load(source.extractfile(f"{prefix}/t{i:02}/stats.json"))
                    evaluation = json.load(source.extractfile(f"{prefix}/t{i:02}/evaluation.json"))
                    tasks.append({"task": i, "passed": evaluation["passed"], **stat})
                runs[prefix] = [{"range": [a, b], "passed": sum(r["passed"] for r in tasks[a-1:b]),
                                 "mean_cost_usd": np.mean([r["cost_usd"] for r in tasks[a-1:b]])}
                                for a, b in ((1, 5), (6, 10), (11, 15), (16, 20))]
            output["repeated_corrections"] = {"archive": str(archive.relative_to(ROOT)), "runs": runs}
    old = ROOT.parent / "multi-turn-optimization/benchmark/longds/system_scratch"
    runs = {}
    for arm in ("LongDS_LongDSLunaNativeCatalog", "LongDS_LongDSLunaNativeSession",
                "LongDS_LongDSLunaNativeCatalogR2", "LongDS_LongDSLunaNativeSessionR2"):
        folder = old / arm / "geoscience__phase-ii-widsdatathon2022__task1"
        if not folder.exists():
            continue
        tasks = [read(folder / f"t{i:02}/stats.json") for i in range(1, 41)]
        runs[arm] = [{"range": [a, b], "mean_cost_usd": np.mean([r["cost_usd"] for r in tasks[a-1:b]])}
                     for a, b in ((1, 10), (11, 20), (21, 30), (31, 40))]
    output["older_wids"] = runs
    return output


def save_figure(fig, out, name):
    for ext in ("svg", "png"):
        path = out / f"{name}.{ext}"
        fig.savefig(path, dpi=160, metadata={"Date": None} if ext == "svg" else None)
        if ext == "svg":
            # Matplotlib emits trailing spaces in SVG path coordinates.
            path.write_text("\n".join(line.rstrip() for line in path.read_text().splitlines()) + "\n")


def plot(rows, cohorts, out):
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10,
                         "axes.spines.top": False, "axes.spines.right": False,
                         "svg.hashsalt": "task-history-long-horizon"})
    colors = {"code": "#3a67b1", "coderetain": "#a96b22", "maint": "#16856b"}
    labels = {"code": "CodeAgent", "coderetain": "CodeAgent + snapshots", "maint": "Dataflow compact catalog"}
    fig, axes = plt.subplots(2, 2, figsize=(12, 7.8), layout="constrained")
    for col, (family, title, window) in enumerate((("longds_nfl", "NFL · 42 tasks", 5),
                                                 ("longds_univ", "University · 21 tasks", 3))):
        for arm, campaign in (("code", "dev-run2"), ("coderetain", "dev-run2"),
                              ("maint", "dev-run2"), ("maint", "dev-run3")):
            sub = [r for r in rows if r["campaign"] == campaign and r["family"] == family and r["arm"] == arm]
            sub.sort(key=lambda r: r["task"])
            xs, costs, inputs = [], [], []
            for i in range(window-1, len(sub)):
                batch = sub[i-window+1:i+1]
                xs.append(sub[i]["task"])
                costs.append(np.mean([r["cost_usd"] for r in batch]) * 1000)
                inputs.append(sum(r["input_tokens"] for r in batch) / sum(r["llm_calls"] for r in batch) / 1000)
            style = "--" if campaign == "dev-run3" else "-"
            label = labels[arm] + (" (repeat)" if campaign == "dev-run3" else "")
            axes[0, col].plot(xs, costs, style, color=colors[arm], label=label, linewidth=2)
            axes[1, col].plot(xs, inputs, style, color=colors[arm], linewidth=2)
        axes[0, col].set(title=f"{title}\n{window}-task trailing means", ylabel="Model cost per task (milli-USD)")
        axes[1, col].set(ylabel="Input per model call (thousand tokens)", xlabel="Task number")
        for ax in axes[:, col]:
            ax.grid(alpha=.17)
            ax.set_ylim(bottom=0)
    fig.legend(*axes[0, 0].get_legend_handles_labels(), loc="outside lower center", ncols=2, frameon=False)
    fig.suptitle("Longer cached history costs more; current catalog prompts also grow", fontsize=14)
    save_figure(fig, out, "marginal-cost")
    plt.close(fig)

    fig, axes = plt.subplots(1, 3, figsize=(14, 4.5), layout="constrained")
    parts = (("read_usd", "Cached reads", "#7b9dcc"), ("write_usd", "Cache writes", "#e5a46e"),
             ("output_usd", "Output / reasoning", "#67a591"), ("other_input_usd", "Other input", "#a1a7ac"))
    for ax, cohort, title in ((axes[0], cohorts["nfl_last12"], "NFL tasks 31–42 · all answers"),
                              (axes[1], cohorts["univ_common_correct"], "University · same 7 correct late tasks")):
        for x, arm in enumerate(("code", "coderetain", "maint")):
            s = cohort[arm]
            bottom = 0
            for key, label, color in parts:
                value = s[key] / s["tasks"] * 1000
                ax.bar(x, value, bottom=bottom, color=color, label=label if x == 0 else None)
                bottom += value
            ax.text(x, bottom + .12, f"{s['passed']}/{s['tasks']} pass", ha="center", fontsize=9)
        ax.set(title=title, ylabel="Model cost per task (milli-USD)",
               xticks=[0, 1, 2], xticklabels=["Code", "Code +\nsnapshots", "Dataflow"])
        ax.set_ylim(0, ax.get_ylim()[1] * 1.16)
    xs = np.linspace(0, 260, 100)
    axes[2].plot(xs, xs * RATES["cached"], color="#3a67b1", label="Read cached history")
    for size, color in ((5, "#16856b"), (10, "#a96b22"), (20, "#8956a7")):
        price = size * RATES["write"]
        axes[2].axhline(price, color=color, label=f"Write {size}k-token catalog")
        cross = size * RATES["write"] / RATES["cached"]
        axes[2].scatter([cross], [price], color=color, s=25)
        axes[2].annotate(f"{cross:g}k", (cross, price), xytext=(3, 7), textcoords="offset points", fontsize=9)
    axes[2].set(title="Context-only break-even · one call", xlabel="Cached history tokens (thousands)",
                ylabel="Cost (milli-USD)", ylim=(0, 6))
    axes[2].legend(fontsize=8, frameon=False, loc="upper left")
    for ax in axes:
        ax.grid(axis="y", alpha=.15)
    fig.legend(*axes[0].get_legend_handles_labels(), loc="outside lower center", ncols=4, frameon=False)
    fig.suptitle("Separate context growth, generated work, and accuracy", fontsize=14)
    save_figure(fig, out, "cost-components")
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=HERE / "long-horizon-analysis")
    args = parser.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    rows, sources = load_current()
    groups = defaultdict(list)
    for row in rows:
        groups[(row["campaign"], row["session"])].append(row)
    stages = []
    for (campaign, session), sub in groups.items():
        n = len(sub)
        windows = ((1, 10), (11, 20), (21, 30), (31, 42)) if n == 42 else (
            ((1, 7), (8, 14), (15, 21)) if n == 21 else ((1, 2), (3, 5), (6, 8)))
        for start, end in windows:
            stages.append({"campaign": campaign, "session": session, "arm": sub[0]["arm"],
                           "family": sub[0]["family"], "range": [start, end],
                           **summarize([r for r in sub if start <= r["task"] <= end])})
    arms = ("code", "coderetain", "maint")
    university = {arm: {r["task"]: r for r in rows if r["campaign"] == "dev-run2"
                       and r["family"] == "longds_univ" and r["arm"] == arm} for arm in arms}
    shared = sorted(t for t in university["code"] if t >= 8 and all(university[a][t]["passed"] for a in arms))
    cohorts = {
        "common_correct_task_numbers": shared,
        "univ_common_correct": {a: summarize([university[a][t] for t in shared]) for a in arms},
        "nfl_last12": {a: summarize([r for r in rows if r["campaign"] == "dev-run2"
                        and r["family"] == "longds_nfl" and r["arm"] == a and r["task"] >= 31]) for a in arms},
    }
    components = [{k: r[k] for k in ("campaign", "session", "task", "first_call_input_tokens",
                   "history_chars", "catalog_chars", "history_text_tokens", "catalog_text_tokens")}
                  for r in rows if r["campaign"] == "dev-run2" and r["arm"] == "maint"
                  and r["task"] in (1, 7, 10, 14, 20, 21, 30, 42)]
    output = {"revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
              "scope": "Existing traces only; stage means are descriptive, not difficulty-controlled effects.",
              "rates_usd_per_million": RATES, "sources": sources, "tasks": len(rows),
              "sessions": len(groups), "stages": stages, "cohorts": cohorts,
              "first_call_text_components": components, "secondary": load_secondary(),
              "retention_preambles": [{k: r[k] for k in ("campaign", "session", "task",
                   "retention_index_text_tokens", "cumulative_retention_index_text_tokens")}
                   for r in rows if r["campaign"] == "dev-run2" and r["arm"] == "coderetain"
                   and r["task"] in (10, 20, 21, 30, 42)],
              "limitations": ["No new agent evaluation; no causal accuracy claim for deleting history.",
                              "Correct-only cohort is diagnostic; retain all-task scores.",
                              "Code traces do not retain inputMessages; its inputs are measured aggregate provider usage.",
                              "o200k_base text estimates are not provider billing counts.",
                              "Multiple tasks within a session are correlated; repetitions are sparse."]}
    (out / "results.json").write_text(json.dumps(output, indent=2) + "\n")
    fields = sorted(set().union(*(r.keys() for r in rows)))
    with (out / "per-task.csv").open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    plot(rows, cohorts, out)
    print(json.dumps({"tasks": len(rows), "sessions": len(groups), "correct_task_numbers": shared,
                      "output": str(out)}, indent=2))


if __name__ == "__main__":
    main()
