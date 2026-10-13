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
"""Provider accounting: cache classes are disjoint and missing cost is unknown."""
import unittest
import json
from pathlib import Path
import tempfile

from benchmark.retrieval.metrics import (cost_for_usage, current_price_schedule, normalize_usage, reconcile_run,
                                         reconcile_trace, recost, response_cost, retrieval_results, edit_operations)
from benchmark.retrieval.audit import audit


class MetricsTests(unittest.TestCase):
    def test_reasoning_is_not_added_to_output_and_cache_writes_are_separate(self):
        usage = normalize_usage({"prompt_tokens": 1000, "completion_tokens": 200,
            "prompt_tokens_details": {"cached_tokens": 600, "cache_write_tokens": 100},
            "completion_tokens_details": {"reasoning_tokens": 150}})
        self.assertEqual(usage["total_tokens"], 1200)
        self.assertEqual(usage["reasoning_tokens"], 150)
        rates = {"input": 2e-6, "output": 12e-6, "cache_read": 0.2e-6, "cache_creation": 2.5e-6}
        self.assertAlmostEqual(cost_for_usage(usage, {"rates": rates}), .00337)

    def test_unknown_pricing_stays_null_instead_of_free(self):
        self.assertIsNone(cost_for_usage(normalize_usage({"prompt_tokens": 10, "completion_tokens": 2}), None))

    def test_long_context_rates_apply_per_request(self):
        price = {"rates": {"input": 4e-6, "output": 20e-6, "cache_read": .4e-6,
                           "cache_creation": 5e-6}, "long_context_threshold": 272000}
        usage = normalize_usage({"prompt_tokens": 300000, "completion_tokens": 1000,
            "prompt_tokens_details": {"cached_tokens": 200000, "cache_write_tokens": 50000}})
        self.assertAlmostEqual(cost_for_usage(usage, price), 1.09)

    def test_provider_charge_is_the_cost_and_the_estimate_stays_available(self):
        usage = {"prompt_tokens": 1000, "completion_tokens": 200, "cost": .0004,
                 "prompt_tokens_details": {"cached_tokens": 600, "cache_write_tokens": 0}}
        price = current_price_schedule("deepseek-v4.1-flash")
        self.assertEqual(response_cost(usage, price), .0004)
        # 400 uncached x 0.14 + 600 cached x 0.0042 + 200 output x 0.42 per million
        self.assertAlmostEqual(response_cost(usage, price, billed=False), 1.4252e-4)

    def test_gpt56_cache_writes_are_priced_when_usage_omits_them(self):
        sol = current_price_schedule("gpt-5.6-sol")
        omitted = {"prompt_tokens": 1000, "completion_tokens": 100, "prompt_tokens_details": {"cached_tokens": 600}}
        # The 400 uncached prompt tokens were written to the cache at 1.25x input.
        self.assertAlmostEqual(response_cost(omitted, sol), 400 * 5e-6 + 600 * .4e-6 + 100 * 20e-6)
        reported = {"prompt_tokens": 1000, "completion_tokens": 100,
                    "prompt_tokens_details": {"cached_tokens": 600, "cache_write_tokens": 300}}
        self.assertAlmostEqual(response_cost(reported, sol), 100 * 4e-6 + 300 * 5e-6 + 600 * .4e-6 + 100 * 20e-6)
        # Providers without implicit writes keep unreported cache creation at zero.
        haiku = current_price_schedule("claude-haiku-5.5")
        self.assertAlmostEqual(response_cost(omitted, haiku), 400 * .1e-6 + 600 * .01e-6 + 100 * .5e-6)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            (path / "wire").mkdir()
            (path / "wire/000001-meta.json").write_text(json.dumps({"status": 200,
                "started_at": "2026-10-08T10:00:00Z", "finished_at": "2026-10-08T10:00:02Z"}))
            (path / "wire/000001-response.json").write_text(json.dumps({"usage": omitted}))
            stats, _ = reconcile_run(path, "gpt-5.6-sol", sol)
            self.assertAlmostEqual(stats["cost_usd"], .00424)
            self.assertEqual(stats["cost_basis"], "token_estimate")
            self.assertIn("priced as cache writes", stats["cost_estimate_assumptions"][0])

    def test_script_trace_is_priced_per_response(self):
        price = current_price_schedule("deepseek-v4.1-flash")
        usage = {"prompt_tokens": 1000, "completion_tokens": 200, "prompt_tokens_details": {"cached_tokens": 600, "cache_write_tokens": 0}}
        events = [{"phase": "request", "call": 1}, {"phase": "response", "call": 1, "usage": {**usage, "cost": .0004}},
                  {"phase": "request", "call": 2}, {"phase": "response", "call": 2, "usage": {**usage, "cost": .0006}}]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "system_scratch/S/t"
            path.mkdir(parents=True)
            (path / "stats.json").write_text(json.dumps({"cost_usd": .5, "num_steps": 2}))
            (path / "model-request-trace.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events))
            stats = reconcile_trace(path, "deepseek-v4.1-flash", price)
            self.assertAlmostEqual(stats["cost_usd"], .001)
            self.assertAlmostEqual(stats["estimated_cost_usd"], 2 * 1.4252e-4)
            self.assertEqual(stats["cost_basis"], "provider_reported")
            self.assertEqual((stats["harness_cost_usd"], stats["num_steps"]), (.5, 2))
            # A request without a response leaves the total unknown, never a partial total.
            with open(path / "model-request-trace.jsonl", "a") as trace:
                trace.write(json.dumps({"phase": "request", "call": 3}) + "\n")
            stats = reconcile_trace(path, "deepseek-v4.1-flash", price)
            self.assertIsNone(stats["cost_usd"])
            self.assertAlmostEqual(stats["reported_usage_cost_usd"], .001)
            self.assertEqual(stats["harness_cost_usd"], .5)
            # Offline re-pricing of a finished run changes the rows' cost and keeps the first originals.
            (root / "manifest.json").write_text(json.dumps({"models": {"DS": "deepseek-v4.1-flash"}}))
            (root / "progress.json").write_text(json.dumps({"status": "complete", "completed": [
                {"model": "DS", "sut": "S", "task": "t", "cost_usd": .5}]}))
            (path / "stats.json").write_text(json.dumps({"cost_usd": .5}))
            (path / "stats.before-billing-fix.json").unlink(missing_ok=True)
            for _ in range(2):
                self.assertEqual(recost(root), 1)
            self.assertIsNone(json.loads((root / "progress.json").read_text())["completed"][0]["cost_usd"])
            self.assertEqual(json.loads((root / "progress.before-billing-fix.json").read_text())["completed"][0]["cost_usd"], .5)
            self.assertEqual(json.loads((path / "stats.before-billing-fix.json").read_text())["cost_usd"], .5)

    def test_batch_retrieval_keeps_successful_and_failed_targets(self):
        item = {"action": {"type": "retrieve", "operator_ids": ["a", "b"], "view": "full"},
                "status": "error", "output": {"results": [
                    {"operator_id": "a", "status": "ok", "table": {"complete": True}},
                    {"operator_id": "b", "status": "error", "error": "stale"}]}}
        rows = retrieval_results(item)
        self.assertEqual([r["operator_id"] for r in rows], ["a", "b"])
        self.assertEqual([r["status"] for r in rows], ["ok", "error"])

    def test_edit_summary_supports_registered_and_legacy_changes(self):
        self.assertEqual(edit_operations({"changes": [{"operation": "upsert"},
            {"change": "operator", "action": "created"},
            {"change": "function", "action": "registered"}]}),
            ["upsert", "operator.created", "function.registered"])

    def test_wire_audit_preserves_original_stats_and_separates_timings(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary)
            (path / "wire").mkdir()
            (path / "stats.json").write_text(json.dumps({"input_tokens": 500, "output_tokens": 100,
                "cost_usd": 0, "elapsed_seconds": 9}))
            (path / "wire/000001-meta.json").write_text(json.dumps({"status": 200,
                "started_at": "2026-10-08T10:00:00Z", "finished_at": "2026-10-08T10:00:02Z"}))
            (path / "wire/000001-response.json").write_text(json.dumps({"model": "test-model", "usage": {
                "prompt_tokens": 1000, "completion_tokens": 200, "cost": .001,
                "prompt_tokens_details": {"cached_tokens": 600, "cache_write_tokens": 100}}}))
            price = {"rates": {"input": 2e-6, "output": 12e-6, "cache_read": .2e-6, "cache_creation": 2.5e-6}}
            stats, audit = reconcile_run(path, "test-model", price)
            self.assertEqual(stats["input_tokens"], 1000)
            self.assertAlmostEqual(stats["cost_usd"], .001)
            self.assertAlmostEqual(stats["estimated_cost_usd"], .00337)
            self.assertEqual(stats["cost_basis"], "provider_reported")
            self.assertEqual(stats["provider_reported_cost_usd"], .001)
            self.assertTrue(stats["provider_cost_complete"])
            self.assertTrue(stats["cache_usage_reporting"]["cache_creation_tokens"]["complete"])
            self.assertEqual(stats["cost_estimate_assumptions"], [])
            self.assertEqual(stats["elapsed_seconds"], 9)
            self.assertEqual(stats["model_latency_seconds"], 2)
            self.assertEqual(len(audit["usage_mismatches"]), 2)
            self.assertEqual(json.loads((path / "harness-stats.json").read_text())["input_tokens"], 500)
            (path / "wire/000002-meta.json").write_text(json.dumps({"status": 500,
                "started_at": "2026-10-08T10:00:02Z", "finished_at": "2026-10-08T10:00:03Z"}))
            (path / "wire/000002-response.json").write_text('{"error":"failed"}')
            stats, audit = reconcile_run(path, "test-model", price)
            self.assertIsNone(stats["cost_usd"])
            self.assertIsNone(stats["estimated_cost_usd"])
            self.assertAlmostEqual(stats["reported_usage_cost_usd"], .001)
            self.assertFalse(stats["usage_complete"])
            self.assertIsNone(stats["provider_reported_cost_usd"])
            self.assertEqual(stats["partial_provider_reported_cost_usd"], .001)
            self.assertFalse(stats["provider_cost_complete"])
            self.assertFalse(stats["cache_usage_reporting"]["cache_creation_tokens"]["complete"])
            self.assertEqual(len(audit["usage_mismatches"]), 2)

    def test_missing_cache_write_counter_is_not_reported_zero_or_missing_usage(self):
        price = {"rates": {"input": 2e-6, "output": 12e-6, "cache_read": .2e-6, "cache_creation": 2.5e-6}}
        for details, reported in [
            ({"cached_tokens": 600}, False),
            ({"cached_tokens": 600, "cache_write_tokens": None}, False),
            ({"cached_tokens": 600, "cache_write_tokens": 0}, True),
            ({"cached_tokens": 600, "cache_creation_tokens": 0}, True),
        ]:
            with self.subTest(details=details), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary)
                (path / "wire").mkdir()
                (path / "wire/000001-meta.json").write_text(json.dumps({"status": 200,
                    "started_at": "2026-10-08T10:00:00Z", "finished_at": "2026-10-08T10:00:02Z"}))
                (path / "wire/000001-response.json").write_text(json.dumps({"usage": {
                    "prompt_tokens": 1000, "completion_tokens": 200, "cost": .001,
                    "prompt_tokens_details": details}}))
                stats, audit = reconcile_run(path, "test-model", price)
                self.assertTrue(stats["usage_complete"])
                self.assertNotIn("usage_incomplete", audit["warnings"])
                self.assertEqual(stats["cache_creation_tokens"], 0)
                self.assertAlmostEqual(stats["cost_usd"], .001)
                self.assertAlmostEqual(stats["estimated_cost_usd"], .00332)
                self.assertEqual(stats["provider_reported_cost_usd"], .001)
                self.assertTrue(stats["provider_cost_complete"])
                creation = stats["cache_usage_reporting"]["cache_creation_tokens"]
                self.assertEqual(creation["complete"], reported)
                self.assertEqual(creation["reported_responses"], int(reported))
                self.assertEqual(creation["unreported_responses"], int(not reported))
                self.assertTrue(stats["cache_usage_reporting"]["cached_tokens"]["complete"])
                assumptions = stats["cost_estimate_assumptions"]
                self.assertEqual(bool(assumptions), not reported)
                if not reported:
                    self.assertIn("assume zero cache-creation tokens", assumptions[0])
                self.assertEqual(audit["cost_estimate_assumptions"], assumptions)
                self.assertEqual(audit["cache_usage_reporting"], stats["cache_usage_reporting"])

    def test_offline_audit_handles_successful_target_in_failed_batch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            task = root / "system_scratch/SUT/task"
            task.mkdir(parents=True)
            (root / "analysis.json").write_text(json.dumps({"rows": [{"sut": "SUT", "task": "task",
                "model": "test", "arm": "adaptive", "rep": 1}]}))
            (task / "react_steps.json").write_text(json.dumps([{"toolResults": [{"output": {"actions": [{
                "action": {"type": "retrieve", "operator_ids": ["a", "b"], "view": "full"},
                "status": "error", "output": {"results": [
                    {"operator_id": "a", "status": "ok", "text": "result", "table": {"complete": True}},
                    {"operator_id": "b", "status": "error", "error": "stale"}]}}]}}]}]))
            result = audit(root)
            self.assertEqual(len(result["reads"]), 1)
            self.assertEqual(result["reads"][0]["operator"], "a")


if __name__ == "__main__":
    unittest.main()
