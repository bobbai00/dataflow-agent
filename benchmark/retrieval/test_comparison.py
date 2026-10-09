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
"""Matched matrix reporting without benchmark imports or provider calls."""
import unittest

from benchmark.retrieval.comparison import evidence_matrix_contrasts, layout_contrasts


class ComparisonTests(unittest.TestCase):
    def test_layout_contrast_keeps_unknown_cost_separate_from_other_metrics(self):
        rows = [{"model": "Luna", "arm": f"layout_{layout}", "task": task, "rep": 1,
                 "score": 1, "model_requests": calls, "model_calls": calls,
                 "cost_usd": cost, "format_compliant": layout == "markdown"}
                for task in ["a", "b"]
                for layout, calls, cost in [("native", 5, .02), ("markdown", 3, None)]]
        contrast, = layout_contrasts(rows, ["Luna"])
        self.assertEqual(contrast["tasks"], 2)
        self.assertEqual(contrast["matched_attempts"], 2)
        self.assertEqual(contrast["model_requests_delta"], -2)
        self.assertEqual(contrast["format_compliant_delta"], 1)
        self.assertEqual(contrast["score_delta"], 0)
        self.assertIsNone(contrast["cost_delta_usd"])
        self.assertEqual(contrast["metric_pairs"]["cost_usd"], 0)
        self.assertTrue(contrast["descriptive_only"])
        self.assertEqual(contrast["factor"], "message_layout")

    def test_layout_token_contrast_excludes_partial_usage_and_unreported_cache(self):
        rows = [{"model": "Luna", "arm": f"layout_{layout}", "task": "a", "rep": 1,
                 "model_requests": 4, "input_tokens": 100, "cached_tokens": 0,
                 "usage_complete": complete, "cache_read_usage_complete": False}
                for layout, complete in [("native", True), ("markdown", False)]]
        contrast, = layout_contrasts(rows, ["Luna"])
        self.assertIsNone(contrast["input_tokens_delta"])
        self.assertIsNone(contrast["cached_tokens_delta"])
        self.assertEqual(contrast["model_requests_delta"], 0)
        rows[1]["usage_complete"] = True
        contrast, = layout_contrasts(rows, ["Luna"])
        self.assertEqual(contrast["input_tokens_delta"], 0)
        self.assertIsNone(contrast["cached_tokens_delta"])

    def test_four_contrasts_change_one_factor_and_are_descriptive(self):
        rows = [{"model": "Luna", "arm": f"evidence_data{data}_flow{flow}",
                 "task": "a", "rep": 1, "score": data * 0.4 + flow * 0.1,
                 "cost_usd": data * 0.02 + flow * 0.01, "model_calls": 8 - data - flow}
                for data in [0, 1] for flow in [0, 1]]
        contrasts = evidence_matrix_contrasts(rows, ["Luna"])
        self.assertEqual(len(contrasts), 4)
        for contrast in contrasts:
            self.assertTrue(contrast["descriptive_only"])
            self.assertIsNone(contrast["score_delta_ci95"])
            self.assertIsNone(contrast["cost_delta_ci95"])
            self.assertEqual(contrast["tasks"], 1)
            self.assertEqual(contrast["matched_attempts"], 1)
            self.assertAlmostEqual(contrast["score_delta"],
                                   0.4 if contrast["factor"] == "data" else 0.1)
            self.assertEqual(contrast["model_calls_delta"], -1)

    def test_missing_cost_does_not_drop_score_and_unmatched_tasks_are_excluded(self):
        rows = [
            {"model": "Luna", "arm": "evidence_data1_flow0", "task": "a", "rep": 1,
             "score": 1.0, "cost_usd": None},
            {"model": "Luna", "arm": "evidence_data0_flow0", "task": "a", "rep": 1,
             "score": 0.0, "cost_usd": 0.1},
            {"model": "Luna", "arm": "evidence_data1_flow0", "task": "b", "rep": 1,
             "score": 0.0, "cost_usd": 3.0},
        ]
        contrast, = evidence_matrix_contrasts(rows, ["Luna"])
        self.assertEqual(contrast["score_delta"], 1.0)
        self.assertIsNone(contrast["cost_delta_usd"])
        self.assertEqual(contrast["metric_pairs"]["score"], 1)
        self.assertEqual(contrast["metric_pairs"]["cost_usd"], 0)
        self.assertEqual(contrast["tasks"], 1)

    def test_repetitions_are_averaged_within_task_before_across_tasks(self):
        rows = []
        for task, repetitions, delta in [("a", [1, 2], 1.0), ("b", [1], 0.0)]:
            for rep in repetitions:
                for data in [0, 1]:
                    rows.append({"model": "Luna", "arm": f"evidence_data{data}_flow0",
                                 "task": task, "rep": rep, "score": data * delta})
        contrast, = evidence_matrix_contrasts(rows, ["Luna"])
        self.assertEqual(contrast["matched_attempts"], 3)
        self.assertEqual(contrast["tasks"], 2)
        self.assertEqual(contrast["score_delta"], 0.5)
        self.assertEqual(evidence_matrix_contrasts(rows, ["Terra"]), [])


if __name__ == "__main__":
    unittest.main()
