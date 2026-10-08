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
"""Offline contracts for the frozen DSBench judge and its accounting wrapper."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import judge  # noqa: E402


def response(content="True", *, choices=True):
    usage = {
        "prompt_tokens": 1000,
        "completion_tokens": 10,
        "total_tokens": 1010,
        "prompt_tokens_details": {"cached_tokens": 200},
        "completion_tokens_details": {"reasoning_tokens": 3},
    }
    payload = {
        "id": "offline-response",
        "model": judge.JUDGE_MODEL,
        "usage": usage,
        "choices": [{"message": {"content": content}}] if choices else [],
    }
    return SimpleNamespace(
        model=judge.JUDGE_MODEL,
        choices=[SimpleNamespace(message=SimpleNamespace(content=content))] if choices else [],
        usage=SimpleNamespace(model_dump=lambda: usage),
        model_dump=lambda: payload,
        _request_id="offline-request",
    )


class Client:
    def __init__(self, reply=None, error=None):
        self.reply = reply if reply is not None else response()
        self.error = error
        self.requests = []
        self.options = []
        self.base_url = "https://api.openai.com/v1"
        self.closed = False
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def with_options(self, **options):
        self.options.append(options)
        return self

    def create(self, **request):
        self.requests.append(request)
        if self.error:
            raise self.error
        return self.reply

    def close(self):
        self.closed = True


class OfficialRequestTests(unittest.TestCase):
    def test_request_matches_pinned_upstream_function_byte_for_byte(self):
        request = judge.official_request("Question?\n", {"value": 1}, "Answer\n")
        canonical = json.dumps(request, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        # Captured from evaluate_prediction at upstream ba786096137a5108af11c016ad3f09cdb97beefd.
        self.assertEqual(
            hashlib.sha256(canonical.encode()).hexdigest(),
            "ca195eb6c0c83c48a106ecbb751bcfa4099fb7bd2b47cfecc55eb12c09b075ab",
        )

    def test_official_substring_rule_is_preserved(self):
        for text, correct in (("True", True), ("False", False), ("not true", True), ("Flase", False)):
            with self.subTest(text=text), tempfile.TemporaryDirectory() as cache:
                result = judge.judge_prediction("Q", "A", "prediction", cache_dir=cache, client=Client(response(text)))
                self.assertEqual(result["official_correct"], correct)
                self.assertEqual(result["judgment"], text)
                self.assertIsNone(result["error"])


class JudgeCacheTests(unittest.TestCase):
    def test_same_request_is_judged_once_and_cache_adds_no_cost(self):
        client = Client()
        with tempfile.TemporaryDirectory() as cache:
            first = judge.judge_prediction("Q", "A", "prediction", cache_dir=cache, client=client)
            second = judge.judge_prediction("Q", "A", "prediction", cache_dir=cache, client=client)
            self.assertEqual(first["cache_key"], second["cache_key"])
            self.assertFalse(first["cache_hit"])
            self.assertTrue(second["cache_hit"])
            self.assertEqual(len(client.requests), 1)
            self.assertEqual(client.options[0]["max_retries"], 0)
            self.assertEqual(first["input_tokens"], 1000)
            self.assertEqual(first["cached_tokens"], 200)
            self.assertEqual(first["output_tokens"], 10)
            self.assertEqual(first["reasoning_tokens"], 3)
            # May 2024 has no published cached tier: count all input at $5/M.
            self.assertAlmostEqual(first["original_estimated_cost_usd"], 0.00515)
            self.assertEqual(first["incremental_cost_usd"], first["original_estimated_cost_usd"])
            self.assertEqual(second["original_estimated_cost_usd"], first["original_estimated_cost_usd"])
            self.assertEqual(second["incremental_cost_usd"], 0)

    def test_question_gold_or_prediction_change_requires_a_new_judgment(self):
        client = Client()
        with tempfile.TemporaryDirectory() as cache:
            keys = [
                judge.judge_prediction(question, answer, prediction, cache_dir=cache, client=client)["cache_key"]
                for question, answer, prediction in (
                    ("Q", "A", "P"),
                    ("Q2", "A", "P"),
                    ("Q", "B", "P"),
                    ("Q", "A", "P2"),
                )
            ]
        self.assertEqual(len(set(keys)), 4)
        self.assertEqual(len(client.requests), 4)

    def test_exception_is_official_false_and_cached_without_error_secrets(self):
        client = Client(error=RuntimeError("sensitive-credential-never-record"))
        with tempfile.TemporaryDirectory() as cache:
            first = judge.judge_prediction("Q", "A", "P", cache_dir=cache, client=client)
            second = judge.judge_prediction("Q", "A", "P", cache_dir=cache, client=client)
            self.assertFalse(first["official_correct"])
            self.assertEqual(first["judgment"], "False")
            self.assertEqual(first["error"]["type"], "RuntimeError")
            self.assertIsNone(first["original_estimated_cost_usd"])
            self.assertTrue(second["cache_hit"])
            self.assertEqual(second["incremental_cost_usd"], 0)
            self.assertEqual(len(client.requests), 1)
            for path in Path(cache).glob("*.json*"):
                self.assertNotIn("sensitive-credential-never-record", path.read_text())

    def test_response_parse_error_keeps_billed_usage(self):
        with tempfile.TemporaryDirectory() as cache:
            result = judge.judge_prediction("Q", "A", "P", cache_dir=cache, client=Client(response(choices=False)))
        self.assertFalse(result["official_correct"])
        self.assertEqual(result["error"]["type"], "IndexError")
        self.assertAlmostEqual(result["original_estimated_cost_usd"], 0.00515)

    def test_concurrent_identical_requests_do_not_duplicate_calls(self):
        client = Client()
        with tempfile.TemporaryDirectory() as cache, ThreadPoolExecutor(max_workers=4) as pool:
            results = list(
                pool.map(lambda _: judge.judge_prediction("Q", "A", "P", cache_dir=cache, client=client), range(4))
            )
        self.assertEqual(len(client.requests), 1)
        self.assertEqual(sum(not row["cache_hit"] for row in results), 1)
        self.assertAlmostEqual(sum(row["incremental_cost_usd"] for row in results), 0.00515)

    def test_interrupted_request_is_not_sent_again(self):
        client = Client()
        with tempfile.TemporaryDirectory() as cache:
            request = judge.official_request("Q", "A", "P")
            key = judge.cache_key(request)
            (Path(cache) / f"{key}.pending.json").write_text(json.dumps({"cache_key": key, "request": request}))
            first = judge.judge_prediction("Q", "A", "P", cache_dir=cache, client=client)
            second = judge.judge_prediction("Q", "A", "P", cache_dir=cache, client=client)
        self.assertEqual(len(client.requests), 0)
        self.assertFalse(first["official_correct"])
        self.assertEqual(first["error"]["type"], "InterruptedJudgeRequest")
        self.assertTrue(second["cache_hit"])
        self.assertEqual(second["incremental_model_calls"], 0)


class RunInputTests(unittest.TestCase):
    def test_failed_and_missing_answers_are_still_official_judge_inputs(self):
        client = Client()
        with tempfile.TemporaryDirectory() as cache:
            rows = [
                judge.judge_prediction("Q\n", 42, prediction, cache_dir=cache, client=client)
                for prediction in ("Failure\n", "")
            ]
        self.assertEqual(len(client.requests), 2)
        self.assertEqual(client.requests[0], judge.official_request("Q\n", 42, "Failure\n"))
        self.assertEqual(client.requests[1], judge.official_request("Q\n", 42, ""))
        # Only the official judge decides the verdict, including unusual predictions.
        self.assertTrue(all(row["official_correct"] for row in rows))

    def test_cli_waves_reuse_cache_and_report_only_incremental_cost(self):
        client = Client()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source, output, cache = root / "input.jsonl", root / "grades.jsonl", root / "cache"
            source.write_text(
                "\n".join(
                    json.dumps(
                        {"task_id": "00000034-question5", "arm": arm, "question": "Q", "answer": "A", "prediction": "P"}
                    )
                    for arm in ("native00", "smolcustom")
                )
                + "\n"
            )
            command = ["judge.py", "--input", str(source), "--output", str(output), "--cache-dir", str(cache)]
            with (
                patch.object(sys, "argv", command),
                redirect_stdout(io.StringIO()),
                patch.object(judge, "create_judge_client", return_value=(client, {"endpoint": client.base_url})),
            ):
                judge.main()
            grades = [json.loads(line) for line in output.read_text().splitlines()]
            summary = json.loads(Path(str(output) + ".summary.json").read_text())
            self.assertEqual([row["arm"] for row in grades], ["native00", "smolcustom"])
            self.assertEqual(summary["incremental_model_calls"], 1)
            self.assertEqual(summary["cache_hits"], 1)
            self.assertAlmostEqual(summary["known_incremental_cost_usd"], 0.00515)
            with (
                patch.object(sys, "argv", command),
                redirect_stdout(io.StringIO()),
                patch.object(
                    judge, "create_judge_client", side_effect=AssertionError("Cached waves must work offline")
                ),
            ):
                judge.main()
            summary = json.loads(Path(str(output) + ".summary.json").read_text())
        self.assertEqual(summary["incremental_model_calls"], 0)
        self.assertEqual(summary["known_incremental_cost_usd"], 0)
        self.assertTrue(client.closed)
        self.assertEqual(len(client.requests), 1)


if __name__ == "__main__":
    unittest.main()
