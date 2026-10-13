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
"""Keep the new model campaign matched to its recorded reference runs."""
import copy
from pathlib import Path
import unittest

from benchmark.retrieval.opus55 import build_plan, price_schedule
from benchmark.retrieval.metrics import cost_for_usage, normalize_usage


class Opus55SetupTests(unittest.TestCase):
    def references(self):
        tasks = [f"task-{i}" for i in range(104)]
        dag = {
            "task_ids": tasks, "agent_revision": "agent-revision",
            "harness_revision": "harness-revision", "pass_threshold": 1.0,
            "workers": 2, "large_workers": 1, "large_input_bytes": 100000000,
            "task_timeout_seconds": 900,
            "settings": {"agentMode": "native", "contextMode": "delta", "maxSteps": 25,
                         "maxOperatorResultCharLimit": 2000, "maxResultRows": 5,
                         "fullResultCharLimit": 5000, "dataEvidenceCharLimit": 2000,
                         "flowEvidenceCharLimit": 2000, "thoughtReplay": False,
                         "enableCodeInSnapshot": False, "nativeProfileCollection": True},
            "arms": {name: {"retrievalViews": ["full"], "flowEvidence": flow}
                     for name, flow in [("evidence_full_flow0", False),
                                        ("evidence_data1_flow0", False),
                                        ("evidence_full_flow1", True),
                                        ("evidence_data1_flow1", True)]},
        }
        smol = {"task_ids": tasks, "harness_revision": "harness-revision+dirty",
                "pass_threshold": 1.0, "workers": 1, "large_workers": 1,
                "large_input_bytes": 100000000, "task_timeout_seconds": 1200,
                "script_settings": {"max_steps": 25, "max_print_outputs_length": 5000,
                                    "use_custom_prompt": True, "use_fine_grained_prompt": False,
                                    "use_pitfalls_prompt": False, "no_action_detail": False,
                                    "final_answer_tool_prompt": True}}
        return dag, smol

    def test_every_task_has_three_independent_attempts_in_every_solution(self):
        dag, smol = self.references()
        before = copy.deepcopy((dag, smol))
        plan = build_plan(dag, smol, Path("/tmp/new-campaign"))
        jobs = plan["jobs"]
        self.assertEqual(len(jobs), 1560)
        self.assertEqual(len({(j["solution"], j["rep"], j["task"]) for j in jobs}), 1560)
        self.assertEqual(plan["dag"]["settings"], dag["settings"])
        self.assertEqual(plan["dag"]["arms"], dag["arms"])
        self.assertEqual(plan["smolagents"]["settings"], smol["script_settings"])
        self.assertEqual((dag, smol), before)
        self.assertEqual(plan["gateway"]["thinking"], {"type": "adaptive", "display": "summarized"})
        self.assertEqual(plan["gateway"]["output_config"], {"effort": "medium"})

    def test_mismatched_task_sets_and_harnesses_are_rejected(self):
        dag, smol = self.references()
        smol["task_ids"] = smol["task_ids"][:-1]
        with self.assertRaisesRegex(ValueError, "task"):
            build_plan(dag, smol, Path("/tmp/new-campaign"))
        dag, smol = self.references()
        smol["harness_revision"] = "different-revision"
        with self.assertRaisesRegex(ValueError, "harness"):
            build_plan(dag, smol, Path("/tmp/new-campaign"))

    def test_new_prices_include_thinking_once_and_use_opus55_cache_discount(self):
        usage = normalize_usage({"prompt_tokens": 1000, "completion_tokens": 200,
                                 "prompt_tokens_details": {"cached_tokens": 600, "cache_write_tokens": 100},
                                 "completion_tokens_details": {"reasoning_tokens": 150}})
        self.assertAlmostEqual(cost_for_usage(usage, price_schedule()), .00582)
        self.assertEqual(price_schedule()["verified_on"], "2026-10-12")


if __name__ == "__main__":
    unittest.main()
