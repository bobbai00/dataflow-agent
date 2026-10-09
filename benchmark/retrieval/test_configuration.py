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
from pathlib import Path
import tempfile
from unittest.mock import patch
import json
import os
import subprocess
import sys

from benchmark.retrieval.configuration import campaign_arms, full_result_char_limit, campaign_jobs, source_snapshot


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
        self.assertEqual(len(arms), 22)

    def test_layout_pair_changes_only_pinned_framing(self):
        arms = campaign_arms()
        for layout in ["native", "markdown"]:
            self.assertEqual(arms[f"layout_{layout}"], {
                "messageLayout": layout, "retrievalViews": ["sample_stats", "full"],
                "dataEvidence": True, "flowEvidence": True, "nativeProfileScope": "full",
            })
        models = ["Luna", "Terra", "Sol", "Opus48", "Qwen38_27B", "DeepSeek41Flash"]
        jobs = campaign_jobs(models, ["layout_native", "layout_markdown"],
                             ["legal-easy-3", "biomedical-hard-3"], 1, "fixture")
        self.assertEqual(len(jobs), 24)
        self.assertEqual(len({(j["model"], j["arm"], j["task"], j["rep"]) for j in jobs}), 24)
        self.assertEqual(jobs, campaign_jobs(models, ["layout_native", "layout_markdown"],
                                           ["legal-easy-3", "biomedical-hard-3"], 1, "fixture"))

    def test_source_freeze_covers_gateway_configs_and_hashes_contents(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            names = ["access-control-service/src/Gateway.scala", "bin/litellm-config.yaml",
                     "bin/single-node/litellm-config.yaml"]
            for name in names:
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("first")
            with patch("benchmark.retrieval.configuration.subprocess.check_output",
                       return_value="\n".join(names)) as command:
                first = source_snapshot(root)
                self.assertEqual({f["path"] for f in first["files"]}, set(names))
                self.assertTrue(set(["access-control-service/src", *names[1:]]).issubset(command.call_args.args[0]))
                (root / names[0]).write_text("changed")
                second = source_snapshot(root)
            self.assertNotEqual(first["sha256"], second["sha256"])
            self.assertNotEqual(first["files"][0]["sha256"], second["files"][0]["sha256"])

    def test_dry_run_succeeds_without_credentials_or_artifact_creation(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "not-created"
            run = Path(__file__).with_name("run.py")
            result = subprocess.run([sys.executable, str(run), "--dry-run", "--output", str(output),
                "--models", "Luna", "--tasks", "legal-easy-3", "biomedical-hard-3", "--arms",
                "layout_native", "layout_markdown", "--repetitions", "1", "--full-result-char-limit", "5000"],
                env={**os.environ, "OPENAI_API_KEY": "dummy"}, text=True, capture_output=True, check=True)
            plan = json.loads(result.stdout)
            self.assertTrue(plan["dry_run"])
            self.assertEqual(plan["attempts"], 4)
            self.assertEqual(plan["settings"]["fullResultCharLimit"], 5000)
            self.assertFalse(output.exists())

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
