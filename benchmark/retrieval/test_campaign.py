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
"""Campaign scheduling and trace integrity checks, without live model calls."""
from concurrent.futures import ThreadPoolExecutor
import json
import importlib.util
from pathlib import Path
import tempfile
import threading
import unittest

from benchmark.retrieval.campaign import ResourceQueue, audit_attempt, prepare_artifacts, install_provider_prices


class CampaignTests(unittest.TestCase):
    def test_sonnet_prices_charge_each_token_class_once_and_keep_other_models(self):
        path = Path(__file__).resolve().parents[1] / "Kramabench/systems/cost_utils.py"
        spec = importlib.util.spec_from_file_location("cost_fixture", path)
        cost = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cost)
        before = cost.price_schedule("claude-haiku-4.5")
        frozen = install_provider_prices(cost, ["claude-haiku-4.5", "claude-sonnet-5.5"])
        self.assertAlmostEqual(cost.compute_cost("claude-sonnet-5.5", 1000, 20, 800, 100), 0.00081)
        self.assertEqual(cost.price_schedule("claude-haiku-4.5"), before)
        self.assertEqual(set(frozen), {"claude-sonnet-5.5"})
        self.assertEqual(frozen["claude-sonnet-5.5"]["rates"]["output"], 10e-6)
        self.assertIn("platform.claude.com", frozen["claude-sonnet-5.5"]["source"])

    def test_large_tasks_wait_while_small_tasks_continue(self):
        jobs = [{"task": task} for task in ["large-a", "large-b", "small"]]
        work = ResourceQueue(jobs, {"large-a", "large-b"}, 1)
        self.assertEqual(work.get(), jobs[0])
        self.assertEqual(work.get(), jobs[2])
        waiting = threading.Event()
        def take():
            waiting.set()
            return work.get()
        with ThreadPoolExecutor(1) as pool:
            future = pool.submit(take)
            self.assertTrue(waiting.wait(1))
            self.assertFalse(future.done())
            work.done(jobs[0])
            self.assertEqual(future.result(timeout=1), jobs[1])
        work.done(jobs[1])
        work.done(jobs[2])
        self.assertIsNone(work.get())

    def test_artifacts_have_one_copy_and_existing_runs_are_protected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source, archive = root / "kb", root / "out"
            prepare_artifacts(source, archive, ["SUT"])
            (source / "SUT" / "trace.json").write_text("trace")
            self.assertEqual((archive / "SUT" / "trace.json").read_text(), "trace")
            with self.assertRaises(FileExistsError):
                prepare_artifacts(source, archive, ["SUT"])

    def test_audit_flags_exposure_and_prefix_errors(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            settings = {"retrievalViews": ["sample"], "flowEvidence": False}
            (path / "settings.json").write_text(json.dumps(settings))
            steps = [
                {"role": "agent", "inputMessages": [{"role": "user", "content": "task"}]},
                {"role": "agent", "inputMessages": [{"role": "user", "content": "changed"}]},
                {"toolResults": [{"output": {"actions": [{
                    "action": {"type": "retrieve", "view": "full"}, "status": "ok",
                    "output": {"evidence": ["flow.rows=10", "data.nulls=0"]}
                }]}}]},
            ]
            (path / "react_steps.json").write_text(json.dumps(steps))
            findings = audit_attempt(path, settings)
            self.assertEqual(set(findings["violations"]), {
                "context_prefix_changed", "unexpected_retrieval_view", "flow_evidence_leak", "data_evidence_leak"
            })

    def test_rejected_model_action_is_not_an_engine_violation(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            settings = {"retrievalViews": ["sample"], "flowEvidence": False}
            (path / "settings.json").write_text(json.dumps(settings))
            (path / "react_steps.json").write_text(json.dumps([{"toolResults": [{"output": {
                "actions": [{"action": {"type": "retrieve", "view": "full"}, "status": "error",
                             "output": {"error": "View not enabled"}}]
            }}]}]))
            findings = audit_attempt(path, settings)
            self.assertEqual(findings["violations"], [])
            self.assertEqual(findings["action_errors"], 1)

    def test_campaign_audits_tool_receipts_on_the_wire(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            settings = {"retrievalViews": ["sample"], "flowEvidence": False}
            (path / "settings.json").write_text(json.dumps(settings))
            (path / "react_steps.json").write_text("[]")
            (path / "wire").mkdir()
            call = {"id": "c1", "type": "function", "function": {
                "name": "dataflow", "arguments": json.dumps({"python": "", "statements": "show result rows"})}}
            request = {"tools": [{"type": "function", "function": {"name": "dataflow"}}], "parallel_tool_calls": False,
                       "messages": [
                {"role": "system", "content": "Python functions you register. Each execution runs in isolation. Use `statements`."},
                {"role": "user", "content": "task"},
                {"role": "assistant", "content": "", "tool_calls": [call]},
                {"role": "tool", "tool_call_id": "c1", "content": "## show result rows\n- flow: 10 → 4 rows"},
            ]}
            (path / "wire/0001-request.json").write_text(json.dumps(request))
            findings = audit_attempt(path, settings)
            self.assertIn("flow_markdown_leak", findings["violations"])
            self.assertEqual(findings["wire_audit"]["observations"]["tool_messages"], 1)

    def test_final_reply_is_the_answer_but_a_lapse_is_not(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            settings = {"agentMode": "native", "retrievalViews": ["sample", "full"], "flowEvidence": False}
            (path / "settings.json").write_text(json.dumps(settings))
            receipt = {"kind": "dataflow-actions", "status": "completed", "actions": [
                {"action": {"type": "retrieve", "operator_ids": ["rows"], "view": "sample"}, "status": "ok",
                 "output": {"results": [{"status": "ok", "operator_id": "rows", "evidence": []}]}}]}
            call = {"role": "agent", "inputMessages": [], "toolCalls": [{"toolName": "dataflow", "toolCallId": "c1"}],
                    "toolResults": [{"toolCallId": "c1", "output": receipt}]}
            final = {"role": "agent", "inputMessages": [], "toolCalls": [], "content": "**Final Answer: 4**", "isEnd": True}
            (path / "react_steps.json").write_text(json.dumps([call, final]))
            findings = audit_attempt(path, settings)
            self.assertNotIn("missing_answer", findings["warnings"])
            self.assertNotIn("text_without_dataflow", findings["warnings"])
            lapse = {"role": "agent", "inputMessages": [], "toolCalls": [], "content": "I cannot open files.", "isEnd": False}
            (path / "react_steps.json").write_text(json.dumps([lapse, call, final]))
            self.assertIn("text_without_dataflow", audit_attempt(path, settings)["warnings"])
            failed = {**final, "content": "Error: The turn ended before any result was shown."}
            (path / "react_steps.json").write_text(json.dumps([call, failed]))
            self.assertIn("missing_answer", audit_attempt(path, settings)["warnings"])
            stopped = {**final, "content": "Generation stopped by user."}
            (path / "react_steps.json").write_text(json.dumps([call, stopped]))
            self.assertIn("missing_answer", audit_attempt(path, settings)["warnings"])
            # Newer traces mark a failed turn's last step, whatever its text.
            marked = {**final, "endReason": "error"}
            (path / "react_steps.json").write_text(json.dumps([call, marked]))
            self.assertIn("missing_answer", audit_attempt(path, settings)["warnings"])

    def test_haiku_55_prices_and_its_long_prompt_rate(self):
        from benchmark.retrieval.metrics import cost_for_usage, current_price_schedule
        pricing = current_price_schedule("claude-haiku-5.5")
        usage = {"input_tokens": 1000, "output_tokens": 100, "cached_tokens": 800, "cache_creation_tokens": 100}
        # 100 uncached at $0.10, 800 cache reads at $0.01, 100 writes at $0.125, 100 output at $0.50 per million.
        self.assertAlmostEqual(cost_for_usage(usage, pricing), (100 * .1 + 800 * .01 + 100 * .125 + 100 * .5) / 1e6)
        long = {**usage, "input_tokens": 100_100}
        uncached = 100_100 - 800 - 100
        self.assertAlmostEqual(cost_for_usage(long, pricing), 5 * (uncached * .1 + 800 * .01 + 100 * .125 + 100 * .5) / 1e6)
        # GPT keeps its own long-context rule.
        gpt = current_price_schedule("gpt-5.6-luna")
        self.assertNotIn("long_context_multiplier", gpt)

    def test_an_answer_the_judge_could_not_grade_is_unscored_not_wrong(self):
        from benchmark.retrieval.run import judge_unavailable
        answer = {"id": "main-task", "answer": "More aggressive suppression did not end fires faster."}
        self.assertTrue(judge_unavailable({"llm_paraphrase": None}, answer))
        self.assertTrue(judge_unavailable({"f1_approximate": None}, answer))
        self.assertFalse(judge_unavailable({"llm_paraphrase": 0}, answer))
        self.assertFalse(judge_unavailable({"success": None}, answer))
        # No answer, an agent error or a missing response is the system's failure.
        for text in ("", "Error: The turn ended before a final reply.", "No response from agent"):
            self.assertFalse(judge_unavailable({"llm_paraphrase": None}, {"answer": text}))
        self.assertFalse(judge_unavailable({"llm_paraphrase": None}, {}))

    def test_partial_batch_failure_still_audits_successful_result(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            settings = {"retrievalViews": ["sample"], "flowEvidence": False}
            (path / "settings.json").write_text(json.dumps(settings))
            (path / "react_steps.json").write_text(json.dumps([{"toolResults": [{"output": {
                "actions": [{"action": {"type": "retrieve", "operator_ids": ["a", "b"], "view": "sample"},
                    "status": "error", "output": {"results": [
                        {"operator_id": "a", "status": "ok", "evidence": ["flow.rows=10"]},
                        {"operator_id": "b", "status": "error", "error": "stale"}]}}]
            }}]}]))
            findings = audit_attempt(path, settings)
            self.assertEqual(findings["violations"], ["flow_evidence_leak"])
            self.assertEqual(findings["retrievals"], 1)

    def test_whole_call_rejections_are_errors_without_failed_actions(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            settings = {"agentMode": "native", "retrievalViews": ["sample"], "flowEvidence": False}
            (path / "settings.json").write_text(json.dumps(settings))
            (path / "react_steps.json").write_text(json.dumps([{"toolResults": [
                {"isError": True, "output": {"status": "error", "actions": [],
                    "error": "Selected names must be unique. No actions ran."}},
                {"output": {"status": "error", "actions": [
                    {"action": {"type": "execute"}, "status": "skipped"}]}},
                {"output": {"actions": [{"action": {"type": "execute"}, "status": "error"}]}},
            ]}]))
            findings = audit_attempt(path, settings)
            self.assertEqual(findings["tool_errors"], 3)
            self.assertEqual(findings["envelope_errors"], 2)
            self.assertEqual(findings["action_errors"], 1)
            self.assertEqual(findings["violations"], [])
            self.assertIn("missing_answer", findings["warnings"])

    def test_a_reply_before_any_result_is_a_lapse_until_a_final_reply_ends_the_task(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            settings = {"agentMode": "native", "retrievalViews": ["sample_stats"], "flowEvidence": False}
            (path / "settings.json").write_text(json.dumps(settings))
            steps = [{"role": "agent", "content": "Final Answer: No", "inputMessages": [{"role": "user", "content": "question"}], "toolCalls": []},
                     {"role": "agent", "content": "Error: No final answer was produced.", "isEnd": True}]
            (path / "react_steps.json").write_text(json.dumps(steps))
            findings = audit_attempt(path, settings)
            self.assertEqual(findings["violations"], [])
            self.assertEqual(set(findings["warnings"]), {"text_without_dataflow", "missing_answer"})
            self.assertEqual(findings["text_replies"], 1)
            steps[-1] = {"role": "agent", "content": "Final Answer: No", "inputMessages": [], "toolCalls": [], "isEnd": True}
            (path / "react_steps.json").write_text(json.dumps(steps))
            findings = audit_attempt(path, settings)
            self.assertNotIn("missing_answer", findings["warnings"])
            self.assertEqual(findings["text_replies"], 1)


if __name__ == "__main__":
    unittest.main()
