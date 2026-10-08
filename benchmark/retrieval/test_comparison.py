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
"""Check accounting when script transport retries or a task reaches its limit."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_comparison import audit_script
from script_agent_child import save_full_memory


class ScriptAuditTests(unittest.TestCase):
    def write_fixture(self, path, stats, events):
        (path / "stats.json").write_text(json.dumps(stats))
        (path / "model-request-trace.jsonl").write_text(
            "\n".join(json.dumps(event) for event in events) + "\n")

    def test_transport_retry_does_not_double_count_returned_usage(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            stats = {"input_tokens": 1000, "output_tokens": 20,
                     "cached_tokens": 800, "cache_creation_tokens": 100}
            events = [{"phase": "request", "call": 1},
                      {"phase": "transport_request", "call": 1},
                      {"phase": "transport_request", "call": 1},
                      {"phase": "transport_headers", "call": 1, "status": 200},
                      {"phase": "response", "call": 1, "usage": {
                          "prompt_tokens": 1000, "completion_tokens": 20,
                          "prompt_tokens_details": {"cached_tokens": 800,
                                                    "cache_creation_tokens": 100}}}]
            self.write_fixture(path, stats, events)
            result = audit_script(path)
            self.assertEqual(result["violations"], [])
            self.assertEqual(result["provider_calls"], 1)
            self.assertEqual(result["input_tokens"], 1000)

    def test_wall_clock_stop_without_response_has_incomplete_usage(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            stats = {"input_tokens": 0, "output_tokens": 0,
                     "cached_tokens": 0, "cache_creation_tokens": 0}
            self.write_fixture(path, stats, [{"phase": "request", "call": 1},
                {"phase": "error", "call": 1, "exception": "SystemExit"}])
            (path / "wall-clock-stop.json").write_text(json.dumps({"signal": 15}))
            result = audit_script(path)
            self.assertEqual(result["violations"], [])
            self.assertIn("task_timeout_usage_incomplete", result["warnings"])
            self.assertEqual(result["provider_calls"], 0)

    def test_optional_memory_export_does_not_block_grading(self):
        class CyclicMemory:
            def get_full_steps(self):
                raise RecursionError("cyclic object in recorded variables")

        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            save_full_memory(path, CyclicMemory())
            diagnostic = json.loads((path / "trace-export-error.json").read_text())
            self.assertEqual(diagnostic["exception"], "RecursionError")
            self.assertFalse((path / "full-memory.json").exists())


if __name__ == "__main__":
    unittest.main()
