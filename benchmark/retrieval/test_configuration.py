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
"""Pure campaign configuration checks; never connect to a service/provider."""
import argparse
import unittest

from benchmark.retrieval.configuration import campaign_arms, full_result_char_limit


class ConfigurationTests(unittest.TestCase):
    def test_evidence_matrix_changes_only_exposure_and_keeps_full_available(self):
        arms = campaign_arms()
        for data in [0, 1]:
            for flow in [0, 1]:
                self.assertEqual(arms[f"evidence_data{data}_flow{flow}"], {
                    "retrievalViews": ["sample_stats" if data else "sample", "full"],
                    "dataEvidence": bool(data),
                    "flowEvidence": bool(flow),
                    "nativeProfileScope": "full",
                })

    def test_full_only_baseline_differs_from_the_data_arms_only_in_the_statistics_view(self):
        arms = campaign_arms()
        for flow in [0, 1]:
            baseline, data = arms[f"evidence_full_flow{flow}"], arms[f"evidence_data1_flow{flow}"]
            self.assertEqual(baseline, {
                "retrievalViews": ["full"],
                "dataEvidence": False,
                "flowEvidence": bool(flow),
                "nativeProfileScope": "full",
            })
            self.assertEqual({**baseline, "retrievalViews": data["retrievalViews"], "dataEvidence": True}, data)

    def test_historical_arms_retain_their_original_meaning(self):
        arms = campaign_arms()
        for view in ["full", "sample", "sample_stats", "adaptive"]:
            for flow in [0, 1]:
                expected = {
                    "retrievalViews": ["full", "sample", "sample_stats"] if view == "adaptive" else [view],
                    "flowEvidence": bool(flow),
                    "dataEvidence": view in ["sample_stats", "adaptive"],
                }
                self.assertEqual(arms[f"{view}_flow{flow}"], expected)
                self.assertEqual(arms[f"{view}_flow{flow}_fullstats"], {
                    **expected, "nativeProfileScope": "full",
                })
        self.assertEqual(len(arms), 30)

    def test_lean_arms_change_only_the_record_format_on_the_default_views(self):
        arms = campaign_arms()
        data, tsv, lean = (arms[name] for name in
                           ["evidence_data1_flow0", "evidence_data1_flow0_tsv", "evidence_data1_flow0_lean"])
        self.assertEqual(tsv, {**data, "tableFormat": "tsv", "keyValueColumns": 40})
        self.assertEqual(lean, {**tsv, "fullPreviewRows": 5, "optionalPython": True})
        self.assertEqual(arms["evidence_data1_flow0_hygiene"],
                         {**lean, "dataHygiene": True, "pandasRound": True, "compactRecords": True})
        self.assertEqual(arms["evidence_data1_flow0_hygiene_strict"],
                         {**arms["evidence_data1_flow0_hygiene"], "optionalPython": False})
        self.assertEqual(arms["evidence_data1_flow0_opt"], {**arms["evidence_data1_flow0_hygiene"], "answerOnlyReply": True})
        self.assertEqual(arms["evidence_data1_flow0_opt_strict"], {**arms["evidence_data1_flow0_opt"], "optionalPython": False})
        self.assertEqual(arms["evidence_data1_flow0_optreply"], {**arms["evidence_data1_flow0_opt"], "callReply": True})
        self.assertEqual(arms["evidence_data1_flow0_optreply_strict"], {**arms["evidence_data1_flow0_optreply"], "optionalPython": False})

    def test_full_result_cap_accepts_api_bounds_and_smaller_display_budget(self):
        for value in ["128", "5000", "100000"]:
            self.assertEqual(full_result_char_limit(value), int(value))

    def test_full_result_cap_rejects_invalid_values_before_launch(self):
        for value in ["0", "127", "100001", "-1", "5000.5", "unlimited"]:
            with self.subTest(value=value), self.assertRaisesRegex(
                argparse.ArgumentTypeError, "integer between 128 and 100000"
            ):
                full_result_char_limit(value)


if __name__ == "__main__":
    unittest.main()
