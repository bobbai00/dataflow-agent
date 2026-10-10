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
"""Descriptive, task-matched contrasts for the evidence exposure matrix."""
from collections import defaultdict
import statistics


def evidence_matrix_contrasts(rows, models):
    """Toggle one factor at a time; retain independent metric availability.

    Repetitions are averaged within each task before tasks receive equal weight.
    A small diagnostic matrix does not support population significance claims.
    """
    pairs = [("data", f"evidence_data1_flow{flow}", f"evidence_data0_flow{flow}")
             for flow in [0, 1]]
    pairs += [("flow", f"evidence_data{data}_flow1", f"evidence_data{data}_flow0")
              for data in [0, 1]]
    metrics = {"score": "score_delta", "cost_usd": "cost_delta_usd",
               "model_calls": "model_calls_delta", "input_tokens": "input_tokens_delta",
               "output_tokens": "output_tokens_delta", "cached_tokens": "cached_tokens_delta",
               "elapsed_seconds": "elapsed_seconds_delta"}
    contrasts = []
    for model in models:
        lookup = {(row["arm"], row["task"], row["rep"]): row
                  for row in rows if row["model"] == model}
        for factor, treatment, control in pairs:
            matched = [(row, lookup[(control, task, rep)])
                       for (arm, task, rep), row in lookup.items()
                       if arm == treatment and (control, task, rep) in lookup]
            if not matched:
                continue
            contrast = {"model": model, "treatment": treatment, "control": control,
                        "factor": factor, "tasks": len({a["task"] for a, _ in matched}),
                        "matched_attempts": len(matched), "descriptive_only": True,
                        "score_delta_ci95": None, "cost_delta_ci95": None,
                        "metric_pairs": {}, "metric_tasks": {}}
            for metric, output_key in metrics.items():
                differences = defaultdict(list)
                for a, b in matched:
                    if a.get(metric) is not None and b.get(metric) is not None:
                        differences[a["task"]].append(a[metric] - b[metric])
                contrast["metric_pairs"][metric] = sum(map(len, differences.values()))
                contrast["metric_tasks"][metric] = len(differences)
                contrast[output_key] = (statistics.mean(statistics.mean(values)
                                                       for values in differences.values())
                                        if differences else None)
            contrasts.append(contrast)
    return contrasts
