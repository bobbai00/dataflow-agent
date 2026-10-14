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
import re
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

    TOOLS = [{"type": "function", "function": {"name": "dataflow", "parameters": {
        "type": "object", "properties": {"python": {"type": "string"}, "statements": {"type": "string"}}}}}]

    def prompt(self, data=False, flow=False):
        prompt = ("Python functions you can register. Every operator execution has its own isolated environment. "
                  "Use the `dataflow` tool: `python` and `statements` (one per line).")
        if data:
            prompt += " Column statistics in `sample_stats` describe the requested result."
        if flow:
            prompt += " Runtime stats are very helpful for validating your result."
        return prompt

    def request(self, n=1, extra=None, data=False, flow=False, tools=None):
        request = {"messages": [{"role": "system", "content": self.prompt(data, flow)}, {"role": "user", "content": "task"}],
                   "parallel_tool_calls": False, "tools": tools or self.TOOLS}
        request["messages"].extend(extra or [])
        self.write(f"wire/{n:06d}-request.json", request)
        return request

    def trace(self, actions, wrapped=True):
        steps = [{"stepId": 1, "toolResults": [{"output": {
            "protocol": "registered-python-v1", "actions": actions}}]}]
        self.write("react_steps.json", {"steps": steps} if wrapped else steps)

    def findings(self):
        return audit_attempt(self.path, self.settings)

    def receipt_request(self, receipt, data=False, flow=False, tool_choice="auto", tools=True, prompt_extra=""):
        """One call and its receipt, as the tool message a later request replays."""
        self.settings.update(retrievalViews=["sample_stats" if data else "sample", "full"], flowEvidence=flow)
        call = {"id": "c1", "type": "function", "function": {
            "name": "dataflow", "arguments": json.dumps({"python": "", "statements": "show result data"})}}
        request = {"messages": [{"role": "system", "content": self.prompt(data, flow) + prompt_extra},
                                {"role": "user", "content": "task"},
                                {"role": "assistant", "content": "", "tool_calls": [call]},
                                {"role": "tool", "tool_call_id": "c1", "content": receipt}],
                   "parallel_tool_calls": False, "tool_choice": tool_choice}
        if tools:
            request["tools"] = self.TOOLS
        self.write("wire/000001-request.json", request)
        return request

    def test_tool_receipts_are_audited_in_all_four_arms(self):
        for data in (False, True):
            for flow in (False, True):
                with self.subTest(data=data, flow=flow):
                    receipt = "## show result data\nrecords: sample; 1 of 3 rows, 1 of 1 columns (incomplete)"
                    if data:
                        receipt += "\nstatistics: full table, 3 of 3 rows, 1 of 1 columns"
                    if flow:
                        receipt += "\n- flow: measured rows=3\n\nnote: `- flow:` lines show what the steps above dropped, rejected, left unmatched or repeated; compare them with the population the question asks for."
                    self.receipt_request(receipt, data, flow)
                    result = self.findings()
                    self.assertEqual(result["violations"], [])
                    self.assertEqual(result["observations"]["tool_messages"], 1)
                    self.assertEqual(result["observations"]["retrieve_blocks"], 1)
                    self.assertEqual(result["observations"]["with_flow"], int(flow))
                    self.assertEqual(result["observations"]["with_table_statistics"], int(data))

    def test_receipt_leaks_are_detected_but_user_tasks_are_not_observations(self):
        receipt = "## show result data\n- flow: leaked\nstatistics: full table, 3 of 3 rows, 1 of 1 columns"
        request = self.receipt_request(receipt)
        result = self.findings()
        self.assertIn("data_markdown_leak", result["violations"])
        self.assertIn("flow_markdown_leak", result["violations"])
        request["messages"] = request["messages"][:2]
        request["messages"][1]["content"] = receipt
        self.write("wire/000001-request.json", request)
        self.assertEqual(self.findings()["violations"], [])

    def test_the_tool_must_be_offered_unforced_and_full_captions_must_be_true(self):
        receipt = "## show result data\nrecords: sample; 1 of 3 rows, 1 of 1 columns (incomplete)"
        self.receipt_request(receipt, tool_choice="required")
        self.assertIn("forced_tool_choice", self.findings()["violations"])
        self.receipt_request(receipt, tools=False)
        self.assertIn("missing_dataflow_tool", self.findings()["violations"])
        self.receipt_request("## show result data\nstatistics: full table, 2 of 3 rows, 1 of 1 columns", data=True)
        self.assertIn("false_full_statistics_caption", self.findings()["violations"])

    def test_unavailable_explicit_views_in_prompt_examples_are_rejected(self):
        cases = [
            (["sample", "full"], "show result data sample_stats", False),
            (["sample_stats"], "show result data full", True),
            (["sample_stats", "full"], "show result data[value, label] sample", True),
            (["sample"], "show result first, second full", False),
        ]
        for views, command, data in cases:
            with self.subTest(views=views, command=command):
                request = self.receipt_request("## show result data", data=data)
                self.settings["retrievalViews"] = views
                request["messages"][0]["content"] += f"\n```text\n{command}\n```"
                self.write("wire/000001-request.json", request)
                self.assertIn("disabled_view_in_prompt_example", self.findings()["violations"])
        # Example calls carry their statements inside JSON strings with literal \n escapes.
        self.receipt_request("## show result data", prompt_extra='\n```json\n{"statements": "set a: scan(files=\'x.csv\')\\nshow result data sample_stats"}\n```')
        self.assertIn("disabled_view_in_prompt_example", self.findings()["violations"])

    def test_enabled_or_implicit_views_are_not_reported_as_unavailable(self):
        request = self.receipt_request("## show result data")
        request["messages"][0]["content"] += "\n```text\nshow result data\nshow result data sample\nshow result first, second full\n```"
        self.write("wire/000001-request.json", request)
        self.assertEqual(self.findings()["violations"], [])

    def test_wire_statistics_cannot_claim_more_columns_than_the_result(self):
        self.receipt_request("## show result data\nstatistics: full table, 3 of 3 rows, 8 of 2 columns", data=True)
        self.assertIn("false_full_statistics_caption", self.findings()["violations"])
        # Full-table statistics may still cover a bounded subset of columns.
        self.receipt_request("## show result data\nstatistics: full table, 3 of 3 rows, 2 of 8 columns", data=True)
        self.assertEqual(self.findings()["violations"], [])

    def test_wire_text_catches_execute_flow_leak_without_retrieval_evidence(self):
        self.request()
        self.request(2, [{"role": "tool", "tool_call_id": "t1", "content":
                          "## execute source\n- flow: Scan parsed selected sources."}])
        result = self.findings()
        self.assertIn("flow_markdown_leak", result["violations"])
        self.assertEqual(result["wire_prefix_checks"], 1)
        self.assertEqual(result["observations"]["execute_blocks"], 1)

    def test_each_wire_request_must_keep_conditional_prompt_and_schema(self):
        self.request()
        request = self.request(2, data=True, flow=True, tools=[{"type": "function", "function": {"name": "dataflow"}}])
        # The flow paragraph left the prompt: in any arm it marks a stale build.
        request["messages"][0]["content"] += " Flow lines report what upstream steps did that row counts do not show."
        self.write("wire/000002-request.json", request)
        result = self.findings()
        self.assertTrue({"wire_prefix_changed", "tool_schema_changed",
                         "data_prompt_mismatch", "flow_prompt_mismatch"}.issubset(result["violations"]))

    def test_runtime_stats_lines_need_flow_and_no_note(self):
        # Since 2026-10-14 the prompt explains runtime stats; their lines carry no note.
        self.receipt_request("## show result data\n- runtime stats: measured rows=3", flow=True)
        self.assertEqual(self.findings()["violations"], [])
        self.receipt_request("## show result data\n- runtime stats (rows): measured rows=3", flow=False)
        self.assertIn("flow_markdown_leak", self.findings()["violations"])
        # Earlier agents' flow lines and notes still count as flow output.
        self.receipt_request("## show result data\n- flow: measured rows=3", flow=False)
        self.assertIn("flow_markdown_leak", self.findings()["violations"])
        trimmed = "note: a `- flow:` line reports something a step above measured that its code may not expect."
        self.receipt_request(f"## show result data\n\n{trimmed}", flow=False)
        self.assertIn("flow_markdown_leak", self.findings()["violations"])
        # The prompt paragraph belongs to flow-on arms only.
        self.receipt_request("## show result data", flow=False, prompt_extra=" Runtime stats are very helpful for validating your result.")
        self.assertIn("flow_prompt_mismatch", self.findings()["violations"])

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
                          "## show result source\nstatistics: not shown; the complete records above show every value"}])
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

    def test_evidence_prompt_checks_match_the_shipped_prompt(self):
        # The runner pauses a campaign on these checks: they must follow the prompt's wording.
        from benchmark.retrieval.matrix_audit import DATA_PROMPT, FLOW_PROMPT, RUNTIME_PROMPT
        root = Path(__file__).resolve().parents[2]
        evidence = (root / "native-mode/SYSTEM_PROMPT_WITH_EVIDENCE.txt").read_text()
        plain = (root / "native-mode/SYSTEM_PROMPT.txt").read_text()
        self.assertTrue(DATA_PROMPT.search(evidence))
        # Runtime stats are explained in the prompt when flow evidence is on, never in earlier wordings.
        self.assertFalse(FLOW_PROMPT.search(evidence) or FLOW_PROMPT.search(plain))
        self.assertTrue(RUNTIME_PROMPT.search(evidence))
        self.assertFalse(RUNTIME_PROMPT.search(plain))

    def test_a_timed_out_attempt_is_audited_from_the_watchdog_trace(self):
        self.write("manifest.json", {"settings": self.settings, "arms": {"data0flow0": {}}, "jobs": [
            {"model": "test", "arm": "data0flow0", "sut": "sut", "task": "task", "rep": 1}]})
        attempt = self.path / "system_scratch" / "sut" / "task"
        attempt.mkdir(parents=True)
        steps = {"steps": [{"stepId": 1, "toolResults": [{"output": {
            "protocol": "registered-python-v1", "actions": [{"action": {"type": "execute"}, "status": "error"}]}}]}]}
        (attempt / "watchdog-react_steps.json").write_text(json.dumps(steps))
        # Stopped before the harness wrote a trace: the watchdog copy is the trace.
        row = audit_matrix(self.path)["rows"][0]
        self.assertIsNotNone(row["audit"])
        self.assertTrue(row["audit"]["watchdog_trace"])
        self.assertEqual(row["audit"]["action_failures"], 1)
        self.assertNotIn("missing_trace", row["audit"]["warnings"])
        # Stopped while writing it: the truncated dump yields to the watchdog copy.
        (attempt / "react_steps.json").write_text(json.dumps(steps)[:40])
        row = audit_matrix(self.path)["rows"][0]
        self.assertTrue(row["audit"]["watchdog_trace"])
        self.assertEqual(row["audit"]["action_failures"], 1)
        (attempt / "react_steps.json").write_text(json.dumps(steps))
        self.assertFalse(audit_matrix(self.path)["rows"][0]["audit"]["watchdog_trace"])


if __name__ == "__main__":
    unittest.main()
