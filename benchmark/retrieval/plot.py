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
"""Plot a completed retrieval comparison from analyze.py's recorded results."""
import argparse
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    directory = args.directory
    manifest = json.loads((directory / "manifest.json").read_text())
    report = json.loads((directory / "analysis.json").read_text())
    if len(report["rows"]) != len(manifest["jobs"]):
        raise SystemExit("Finish and analyze every planned attempt before plotting the comparison.")
    if any(s["costs_known"] != s["attempts"] or s["scored"] != s["attempts"] for s in report["summary"]):
        raise SystemExit("Missing cost or score: resolve and report incomplete accounting before plotting.")
    models = list(manifest["models"])
    arms = list(manifest["arms"])
    labels = {"full": "Full", "sample": "Sample", "sample_stats": "Sample + stats", "adaptive": "Agent chooses"}
    colors = {"full": "#4477AA", "sample": "#EEAA33", "sample_stats": "#228833", "adaptive": "#AA3377"}
    lookup = {(s["model"], s["arm"]): s for s in report["summary"]}
    fig, axes = plt.subplots(len(models), 2, figsize=(12, 4.1 * len(models)), squeeze=False,
                             gridspec_kw={"wspace": .36, "hspace": .44})
    for model_index, model in enumerate(models):
        for metric_index in range(2):
            ax = axes[model_index][metric_index]
            values = [lookup[(model, arm)] for arm in arms]
            heights = [100 * s["passes"] / s["attempts"] if metric_index == 0
                       else s["cost_usd"] / s["attempts"] for s in values]
            for i, (arm, value, summary) in enumerate(zip(arms, heights, values)):
                view, flow = arm.rsplit("_flow", 1)
                ax.barh(i, value, color=colors[view], edgecolor="white", hatch="//" if flow == "1" else None)
                annotation = f"{summary['passes']}/{summary['attempts']}" if metric_index == 0 else f"${value:.4f}"
                ax.annotate(annotation, (value, i), xytext=(5, 0), textcoords="offset points", va="center", fontsize=10)
            ax.set_yticks(range(len(arms)), [labels[a.rsplit("_flow", 1)[0]] +
                          (" · flow on" if a.endswith("1") else " · flow off") for a in arms])
            ax.invert_yaxis()
            ax.set_xlim(0, 119 if metric_index == 0 else max(heights) * 1.3)
            ax.set_xlabel("Full passes (%) · official score ≥ 1" if metric_index == 0 else "Mean model cost per attempt (USD)")
            ax.set_title(model + (" — accuracy" if metric_index == 0 else " — cost"), loc="left", fontweight="bold")
            ax.set_axisbelow(True)
            ax.grid(axis="x", alpha=.18)
            for spine in ["top", "right", "left"]:
                ax.spines[spine].set_visible(False)
    fig.suptitle("KramaBench retrieval pilot", fontsize=17, fontweight="bold", y=.98)
    fig.text(.05, .025, f"{len(manifest['task_ids'])} diagnostic tasks × {manifest['repetitions']} independent repetitions per setting. "
             "Costs use recorded harness rates and cache discounts.\n"
             "Exploratory task selection; these are not full-benchmark accuracy estimates. Engine and evaluator costs excluded.", fontsize=10)
    fig.subplots_adjust(left=.19, right=.98, top=.90, bottom=.13)
    for extension in ["png", "svg"]:
        fig.savefig(directory / ("cost-accuracy." + extension), dpi=180, facecolor="white")
    plt.close(fig)


if __name__ == "__main__":
    main()
