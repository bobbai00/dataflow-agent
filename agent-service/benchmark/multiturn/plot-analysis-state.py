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
"""Render a standalone research figure from the audit's recorded results.

The first pass stays primary. Recovery trials are individual markers, not a
best-of score. Missing/incomplete aggregates are never drawn as zero accuracy.
"""
import argparse
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ARMS = ["dsgym", "dsgym-functions", "react-entries", "react-analysis"]
LABELS = ["Persistent Python", "Python + function guidance", "Existing dataflow entries", "Analysis-state candidate"]
COLORS = ["#768599", "#a4b1be", "#227da5", "#d56b36"]
TASKS = [
    ("business__goodbooks_10k__task1", "Goodbooks"),
    ("community__kaggle-survey-2022__task2", "Survey"),
    ("education__bi__task2", "BI"),
    ("geoscience__water-potability__task3", "Water"),
    ("social_good__data_science_for_good_city_of_los_angeles__task1", "Los Angeles"),
    ("sports__nfl_big_data_bowl_2023__task1", "NFL"),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    data = json.loads(args.input.read_text())
    aggregates = {(g["trial"], g["arm"]): g for g in data["aggregates"]}
    primary = [aggregates.get((1, arm)) for arm in ARMS]
    if any(not g or g.get("macro_accuracy") is None or not g.get("eligible_for_primary_comparison") for g in primary):
        raise SystemExit("All four eligible first-pass aggregates must be complete before plotting.")
    runs = {(r["trial"], r["arm"], r["task"]): r for r in data["runs"]}
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "svg.fonttype": "none"})
    fig = plt.figure(figsize=(12, 9.4), facecolor="white")
    grid = fig.add_gridspec(2, 2, height_ratios=[1, 1.2], hspace=0.55, wspace=0.35)
    accuracy, cost = fig.add_subplot(grid[0, 0]), fig.add_subplot(grid[0, 1])
    y = np.arange(len(ARMS))
    for axis, key, factor, title in [
        (accuracy, "macro_accuracy", 100, "Task macro accuracy (%)"),
        (cost, "model_cost_usd", 1, "Model cost for 209 planned turns (USD)"),
    ]:
        values = [g[key] * factor for g in primary]
        axis.barh(y, values, color=COLORS, height=0.58, alpha=0.9, label="First pass")
        for trial, marker, delta in [(2, "o", -0.12), (3, "D", 0.12)]:
            for i, arm in enumerate(ARMS):
                group = aggregates.get((trial, arm))
                if group and group.get("complete") and group.get("eligible_for_primary_comparison") and group.get(key) is not None:
                    axis.scatter(group[key] * factor, i + delta, marker=marker, s=38,
                                 facecolor="white", edgecolor="#192f42", linewidth=1.2, zorder=3)
        for i, value in enumerate(values):
            axis.text(value, i + 0.39, f" {value:.1f}%" if factor == 100 else f" ${value:.3f}", fontsize=9)
        axis.set_yticks(y, LABELS if axis is accuracy else [""] * len(ARMS))
        axis.invert_yaxis()
        axis.set_title(title, loc="left", fontweight="bold", pad=13)
        axis.spines[["top", "right", "left"]].set_visible(False)
        axis.tick_params(axis="y", length=0)
        axis.grid(axis="x", alpha=0.18)
        axis.set_axisbelow(True)
        axis.margins(x=0.2)
    accuracy.set_xlim(0, max(60, accuracy.get_xlim()[1]))
    target = primary[0]["model_cost_usd"] * 1.25
    cost.axvline(target, color="#6d7277", linestyle="--", linewidth=1)
    cost.text(0.98, 0.98, "Dashed: accepted 1.25× Python ceiling", transform=cost.transAxes,
              ha="right", va="top", fontsize=8, color="#505960")

    axis = fig.add_subplot(grid[1, :])
    matrix = np.array([[runs[1, arm, task]["accuracy"] * 100 for task, _ in TASKS] for arm in ARMS])
    axis.imshow(matrix, vmin=0, vmax=100, cmap="Blues", aspect="auto")
    axis.set_xticks(np.arange(len(TASKS)), [name for _, name in TASKS])
    axis.set_yticks(np.arange(len(ARMS)), LABELS)
    axis.tick_params(length=0, pad=8)
    axis.set_title("First-pass outcomes by domain: correct / planned (attempted)", loc="left", fontweight="bold", pad=15)
    for i, arm in enumerate(ARMS):
        for j, (task, _) in enumerate(TASKS):
            row = runs[1, arm, task]
            axis.text(j, i, f"{row['correct']:g}/{row['expected']}\n({row['attempted']} attempted)",
                      ha="center", va="center", fontsize=9, color="white" if matrix[i, j] > 55 else "#192f42")
    for spine in axis.spines.values():
        spine.set_visible(False)
    fig.suptitle("LongDS: state reuse, accuracy and cost", x=0.25, y=0.98, ha="left", fontsize=17, fontweight="bold")
    fig.text(0.25, 0.942, "Six selected v1 sessions · gpt-5.6-luna · gpt-5.2 judge · first pass is primary", fontsize=10)
    fig.text(0.25, 0.048,
             "Bars = first pass; ○ = recovery 1; ◇ = recovery 2 (only complete trials shown). No best-of selection.\n"
             "Uniform 1-hour wall limit introduced during the exploratory first pass; unreached turns are failures.\n"
             "Model costs use recorded cache-aware rates; judging and infrastructure are excluded from these bars.",
             fontsize=8.5, linespacing=1.6, color="#505960")
    fig.subplots_adjust(left=0.25, right=0.97, top=0.86, bottom=0.16)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    for suffix in (".svg", ".png"):
        path = args.out.with_suffix(suffix)
        fig.savefig(path, dpi=180, bbox_inches="tight")
        if suffix == ".svg":
            # Carry this source's ASF header into the standalone vector artifact.
            license_lines = []
            for line in Path(__file__).read_text().splitlines()[1:]:
                if not line.startswith("#"):
                    break
                license_lines.append(line.removeprefix("#").removeprefix(" "))
            comment = "\n<!--\n" + "\n".join(license_lines) + "\n-->"
            path.write_text(path.read_text().replace("?>", "?>" + comment, 1))
    plt.close(fig)
    print(args.out.with_suffix(".svg"))


if __name__ == "__main__":
    main()
