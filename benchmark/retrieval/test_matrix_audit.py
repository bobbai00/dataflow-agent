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
"""Offline matrix checks exercise actual wire text, not only evidence IDs."""
import json
from pathlib import Path
import tempfile
import unittest

from benchmark.retrieval.matrix_audit import audit_attempt, audit_matrix


class MatrixAuditTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name)
        self.settings = {"retrievalViews": ["sample", "full"], "flowEvidence": False,
                         "nativeProfileCollection": True, "fullResultCharLimit": 5000}

    def write(self, name, value):
        path = self.path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))

    def request(self, n=1, extra=None, data=False, flow=False):
        views = ["sample_stats", "full"] if data else ["sample", "full"]
        prompt = "Python functions you can register. Every operator execution has its own isolated environment."
        if data:
            prompt += " Column statistics are collected separately from displayed records."
        if flow:
            prompt += " Flow statistics describe measured built-in effects."
        request = {"messages": [{"role": "system", "content": prompt}, {"role": "user", "content": "task"}],
                   "parallel_tool_calls": False,
                   "tools": [{"type": "function", "function": {"name": "dataflow", "parameters": {
                       "properties": {"actions": {"items": {"anyOf": [{"properties": {
                           "type": {"const": "retrieve"}, "view": {"enum": views}}}]}}}}}}]}
        request["messages"].extend(extra or [])
        self.write(f"wire/{n:06d}-request.json", request)
        return request

    def trace(self, actions, wrapped=True):
        steps = [{"stepId": 1, "toolResults": [{"output": {
            "protocol": "registered-python-v1", "actions": actions}}]}]
        self.write("react_steps.json", {"steps": steps} if wrapped else steps)

    def findings(self):
        return audit_attempt(self.path, self.settings)

    def test_wire_text_catches_execute_flow_leak_without_retrieval_evidence(self):
        self.request()
        self.request(2, [{"role": "tool", "tool_call_id": "t1", "content":
                          "### 1. execute source: ok\n- flow: Scan parsed selected sources."}])
        result = self.findings()
        self.assertIn("flow_markdown_leak", result["violations"])
        self.assertEqual(result["wire_prefix_checks"], 1)
        self.assertEqual(result["observations"]["execute_blocks"], 1)

    def test_markdown_wire_history_is_audited_without_scanning_fenced_source(self):
        self.settings["messageLayout"] = "markdown"
        self.request()
        history = {"role": "user", "content": "# Environment history\n\n## Iteration 1\n\n### Submitted actions\n"
                   "````python\ndef f():\n    \"\"\"\n- flow: fake source text\nstatistics: fake\n```\n    \"\"\"\n````\n"
                   "### 1. execute source: ok\n#### Outcome\n1 operator executed."}
        self.request(2, [history])
        result = self.findings()
        self.assertEqual(result["violations"], [])
        self.assertEqual(result["observations"]["markdown_messages"], 1)
        self.assertEqual(result["observations"]["execute_blocks"], 1)
        self.assertEqual(result["wire_context"]["roles"], {"system": 2, "user": 3})
        self.assertEqual(result["wire_context"]["prefix_pairs"][0]["unchanged_messages"], 2)
        self.assertTrue(result["wire_context"]["prefix_pairs"][0]["full_previous_prefix"])
        self.assertGreater(result["wire_context"]["total_context_bytes"], 0)
        self.assertEqual(len(result["wire_context"]["requests"][0]["request_sha256"]), 64)
        history["content"] += "\n- flow: actual measured output"
        self.request(2, [history])
        self.assertIn("flow_markdown_leak", self.findings()["violations"])

    def test_markdown_layout_cannot_replay_native_tool_frames(self):
        self.settings["messageLayout"] = "markdown"
        self.request(extra=[{"role": "assistant", "tool_calls": [{"id": "call"}], "content": None},
                            {"role": "tool", "tool_call_id": "call", "content": "ok"}])
        self.assertIn("markdown_contains_native_tool_frames", self.findings()["violations"])

    def test_markdown_outcome_ends_before_the_next_call_submission(self):
        self.settings["messageLayout"] = "markdown"
        self.request(extra=[{"role": "user", "content":
            "# Environment history\n\n## Iteration 1\n### Call 1: dataflow\n"
            "### 1. inspect graph: ok\n#### Outcome\nThe graph is empty.\n"
            "### Call 2: dataflow\nstatistics: authored text, not a receipt\n"
            "- flow: authored text, not a receipt\n"
            "### 1. retrieve report: ok\n#### Outcome\nrecords: one row"}])
        result = self.findings()
        self.assertEqual(result["violations"], [])
        self.assertEqual(result["observations"]["retrieve_blocks"], 1)
        self.assertEqual(result["observations"]["with_statistics_caption"], 0)

    def test_wire_request_usage_keeps_missing_cache_fields_unknown_and_reports_format(self):
        self.request()
        self.write("wire/000001-response.json", {"usage": {"prompt_tokens": 50, "completion_tokens": 5}})
        self.write("wire/000001-meta.json", {"status": 200})
        (self.path / "prompt.txt").write_text("End with **Final Answer: <value>**")
        (self.path / "response.txt").write_text("Final Answer: 3")
        result = self.findings()
        request = result["wire_context"]["requests"][0]
        self.assertEqual(request["usage"]["input_tokens"], 50)
        self.assertIsNone(request["usage"]["cached_tokens"])
        self.assertEqual(request["http_status"], 200)
        self.assertFalse(result["answer_diagnostics"]["format_compliant"])

    def test_each_wire_request_must_keep_conditional_prompt_and_schema(self):
        self.request()
        self.request(2, data=True, flow=True)
        result = self.findings()
        self.assertTrue({"wire_prefix_changed", "tool_schema_changed", "retrieval_schema_mismatch",
                         "data_prompt_mismatch", "flow_prompt_mismatch"}.issubset(result["violations"]))

    def test_developer_role_is_a_provider_prompt_encoding_not_a_missing_prompt(self):
        self.settings["retrievalViews"] = ["sample_stats", "full"]
        self.settings["flowEvidence"] = True
        request = self.request(data=True, flow=True)
        request["messages"][0]["role"] = "developer"
        self.write("wire/000001-request.json", request)
        result = self.findings()
        self.assertEqual(result["violations"], [])
        request["messages"][0]["content"] = "unrelated prompt"
        self.write("wire/000002-request.json", request)
        self.assertIn("registered_prompt_missing", self.findings()["violations"])

    def test_complete_small_stats_suppression_is_valid(self):
        self.settings["retrievalViews"] = ["sample_stats", "full"]
        self.request(data=True)
        self.trace([{"action": {"type": "retrieve", "view": "sample_stats"}, "status": "ok", "output": {
            "results": [{"operator_id": "answer", "status": "ok", "evidence": ["data.complete"],
                         "text": "columns: answer int64\nrecords: sample_stats; 1 of 1 rows, 1 of 1 columns (complete)\nstatistics: not shown; the complete records above show every value",
                         "table": {"complete": True, "totalRows": 1, "returnedRows": 1,
                                   "totalColumns": 1, "columnsShown": 1}}]}}])
        result = self.findings()
        self.assertEqual(result["violations"], [])
        self.assertEqual(result["retrievals"]["complete_small_without_stats"], 1)
        self.assertEqual(result["retrievals"]["with_data_facts"], 0)
        self.assertEqual(result["retrievals"]["stats_actions_requested"], 1)
        self.assertEqual(result["retrievals"]["statistics_suppressed_complete"], 1)

    def test_statistics_request_and_actual_exposure_have_separate_counts(self):
        self.settings["retrievalViews"] = ["sample_stats", "full"]
        self.request(data=True)
        self.trace([{"action": {"type": "retrieve", "operator_ids": ["a", "b", "c"], "view": "sample_stats"},
                     "status": "error", "output": {"results": [
            {"operator_id": "a", "status": "ok", "evidence": ["data.statistics.3", "data.column.x.counts"],
             "text": "statistics: full table, 3 of 3 rows, 1 of 1 columns",
             "table": {"complete": False, "totalRows": 3, "returnedRows": 1, "totalColumns": 1, "columnsShown": 1}},
            {"operator_id": "b", "status": "ok", "evidence": ["data.status"],
             "text": "statistics: unavailable for this result", "table": {"complete": False}},
            {"operator_id": "c", "status": "error", "error": "RESULT_STALE"}]}}])
        result = self.findings()
        self.assertEqual(result["violations"], [])
        counts = result["retrievals"]
        self.assertEqual(counts["stats_actions_requested"], 1)
        self.assertEqual(counts["stats_targets_requested"], 3)
        self.assertEqual(counts["with_data_facts"], 1)
        self.assertEqual(counts["with_table_statistics"], 1)
        self.assertEqual(counts["statistics_unavailable"], 1)

    def test_suppression_notice_is_not_allowed_when_data_disabled(self):
        self.request()
        self.request(2, [{"role": "tool", "tool_call_id": "t1", "content":
                          "### 1. retrieve source: ok\nstatistics: not shown; the complete records above show every value"}])
        result = self.findings()
        self.assertIn("data_markdown_leak", result["violations"])
        self.assertEqual(result["observations"]["with_table_statistics"], 0)

    def test_full_profile_caption_cannot_claim_more_than_profiled_rows(self):
        self.settings["retrievalViews"] = ["sample_stats", "full"]
        self.request(data=True)
        self.trace([{"action": {"type": "retrieve", "view": "sample_stats"}, "status": "ok", "output": {
            "results": [{"operator_id": "source", "status": "ok", "result_version": "v1", "evidence": [],
                         "text": "statistics: full table, 2 of 3 rows, 1 of 1 columns",
                         "table": {"complete": False, "totalRows": 3, "returnedRows": 1,
                                   "totalColumns": 1, "columnsShown": 1}}]}}], wrapped=False)
        self.write("snapshot.json", {"results": {"source": {"resultVersion": {"id": "v1"},
                   "tableProfile": {"coverage": {"complete": False}}}}})
        result = self.findings()
        self.assertIn("false_full_statistics_caption", result["violations"])
        self.assertIn("full_statistics_for_partial_profile", result["violations"])

    def test_telemetry_required_for_real_execution_but_not_cached_result(self):
        self.request()
        self.trace([{"action": {"type": "execute"}, "status": "ok", "output": {
            "operators": [{"id": "source", "state": "executed", "status": "ok"}]}}])
        self.assertIn("missing_execution_runs", self.findings()["violations"])
        self.trace([{"action": {"type": "execute"}, "status": "ok", "output": {
            "operators": [{"id": "source", "state": "cached", "status": "ok"}], "execution_runs": []}}])
        self.assertNotIn("missing_execution_runs", self.findings()["violations"])

    def test_telemetry_and_source_unknowns_are_separate_from_corruption(self):
        self.request()
        self.trace([{"action": {"type": "execute"}, "status": "error", "output": {
            "operators": [{"id": "source", "state": "failed", "status": "error"}],
            "execution_runs": [{"targets": ["source"], "success": False, "phaseMetrics": None}]}}])
        self.write("snapshot.json", {"results": {"source": {"tableProfile": {
            "status": "unavailable", "omissions": ["native_multi_worker"]}}}})
        result = self.findings()
        self.assertEqual(result["violations"], [])
        self.assertEqual(result["execution"]["phase_metrics_unknown"], 1)
        self.assertEqual(result["profiles"]["unavailable"], 1)

    def test_source_identity_loss_is_visible_even_when_flow_off(self):
        self.request()
        self.write("snapshot.json", {"results": {"source": {"tableProfile": {
            "native": {"operations": {"scan": {"selectedFiles": 1, "sources": [], "sourcesOmitted": 1}}}
        }}}})
        self.assertIn("scan_source_identity_missing", self.findings()["violations"])

    def test_all_four_prompt_arms_and_exact_reported_cache_fraction(self):
        for data in (False, True):
            for flow in (False, True):
                with self.subTest(data=data, flow=flow):
                    self.settings["retrievalViews"] = ["sample_stats", "full"] if data else ["sample", "full"]
                    self.settings["flowEvidence"] = flow
                    self.request(data=data, flow=flow)
                    self.write("stats.json", {"input_tokens": 1000, "cached_tokens": 800, "usage_complete": True,
                        "cache_usage_reporting": {"cached_tokens": {"complete": True}}})
                    result = self.findings()
                    self.assertEqual(result["violations"], [])
                    self.assertEqual(result["accounting"]["cache_read_fraction"], .8)

    def test_unreported_cache_is_unknown_not_a_zero_hit_rate(self):
        self.request()
        self.write("stats.json", {"input_tokens": 1000, "cached_tokens": 0,
            "cache_usage_reporting": {"cached_tokens": {"complete": False, "unreported_responses": 1}}})
        self.assertIsNone(self.findings()["accounting"]["cache_read_fraction"])

    def test_missing_timeout_usage_never_has_a_whole_attempt_cache_fraction(self):
        self.request()
        self.write("stats.json", {"input_tokens": 1000, "cached_tokens": 800, "usage_complete": False,
            "cache_usage_reporting": {"cached_tokens": {
                "complete": False, "reported_responses": 4, "unreported_responses": 0}}})
        accounting = self.findings()["accounting"]
        self.assertIsNone(accounting["cache_read_fraction"])
        self.assertEqual(accounting["known_usage_cache_read_fraction"], .8)
        # Even malformed/stale completeness metadata cannot price unknown usage.
        self.write("stats.json", {"input_tokens": 1000, "cached_tokens": 800, "usage_complete": False,
            "cache_usage_reporting": {"cached_tokens": {"complete": True}}})
        self.assertIsNone(self.findings()["accounting"]["cache_read_fraction"])

    def test_incomplete_matrix_does_not_call_missing_artifacts_success(self):
        self.write("manifest.json", {"settings": self.settings, "arms": {"data0flow0": {}}, "jobs": [
            {"model": "test", "arm": "data0flow0", "sut": "sut", "task": "task", "rep": 1}]})
        result = audit_matrix(self.path)
        self.assertEqual(result["attempts_present"], 0)
        self.assertEqual(result["attempts_expected"], 1)
        self.assertIsNone(result["rows"][0]["audit"])


if __name__ == "__main__":
    unittest.main()
