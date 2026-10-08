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

import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from benchmark.model_registry import (
    ModelSpec,
    requested_models,
    resolve_model_facts,
    verify_probe_response,
    probe_model,
)


class ModelRegistryTest(unittest.TestCase):
    def test_requested_models_preserve_exact_provider_routes(self):
        specs = requested_models()
        self.assertEqual(len(specs), 6)
        self.assertEqual(specs[-2].provider_model_id, "qwen/qwen3.8-27b")
        self.assertEqual(specs[-1].provider_model_id, "deepseek/deepseek-v4.1-flash")
        self.assertEqual(specs[-2].provider, "openrouter")

    def test_model_parameters_preserve_sonnet_provider_defaults(self):
        facts = [resolve_model_facts(spec, gateway_ids={spec.native_model_id}) for spec in requested_models()]
        self.assertEqual(facts[3]["model_parameters"], {})
        for index in [0, 1, 2, 4, 5]:
            self.assertEqual(facts[index]["model_parameters"], {"reasoning_effort": "medium"})

    def test_explicit_model_capabilities_survive_fact_resolution(self):
        capabilities = {"forced_tool_choice": False, "structured_output_transport": "auto_tool"}
        sonnet = requested_models()[3]
        self.assertEqual(resolve_model_facts(sonnet, gateway_ids={sonnet.native_model_id})["model_capabilities"], capabilities)
        future = ModelSpec("Future", "future", "vendor/future", "gateway", model_capabilities=capabilities)
        self.assertEqual(resolve_model_facts(future, gateway_ids={"future"})["model_capabilities"], capabilities)
        luna = requested_models()[0]
        self.assertEqual(resolve_model_facts(luna, gateway_ids={luna.native_model_id})["model_capabilities"], {})

    def test_probe_requires_a_valid_tool_call(self):
        response = {
            "choices": [
                {"message": {"tool_calls": [{"function": {"name": "telemetry_probe", "arguments": '{"ok":true}'}}]}}
            ]
        }
        self.assertTrue(verify_probe_response(response))
        response["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"] = '{"ok":false}'
        self.assertFalse(verify_probe_response(response))
        self.assertFalse(verify_probe_response({"choices": [{"message": {"content": "ok"}}]}))
        self.assertFalse(verify_probe_response({"error": {"message": "access denied"}}))

    def test_an_arbitrary_provider_model_never_gets_substituted(self):
        spec = ModelSpec("FutureModel", "future-route", "newvendor/model-123", "openrouter")
        facts = resolve_model_facts(spec, gateway_ids={"future-route"}, openrouter_models=[])
        self.assertEqual(facts["provider_model_id"], "newvendor/model-123")
        self.assertFalse(facts["catalog_available"])
        self.assertIsNone(facts["pricing"])

    def test_failed_access_probe_preserves_unknown_billing_and_redacts_keys(self):
        spec = requested_models()[0]
        fact = resolve_model_facts(spec, gateway_ids={spec.native_model_id})
        secret = "fixture-provider-key"
        error = HTTPError(
            "http://gateway/v1/chat/completions",
            403,
            "Forbidden",
            {},
            io.BytesIO(json.dumps({"error": {"message": secret}}).encode()),
        )
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "probe"
            with (
                patch.dict("os.environ", {"OPENAI_API_KEY": secret}),
                patch("benchmark.model_registry.urlopen", side_effect=error),
            ):
                result = probe_model(
                    fact, gateway_url="http://gateway/v1", api_key="fixture-gateway-key", output=directory
                )
            self.assertFalse(result["available"])
            self.assertEqual(result["access_status"], "probe_failed")
            metrics = json.loads((directory / "metrics.json").read_text())
            self.assertIsNone(metrics["cost"]["cost_usd"])
            for artifact in directory.glob("*.json"):
                self.assertNotIn(secret, artifact.read_text())
                self.assertNotIn("fixture-gateway-key", artifact.read_text())

    def test_probe_does_not_overwrite_or_repeat_a_paid_request(self):
        spec = requested_models()[0]
        fact = resolve_model_facts(spec, gateway_ids={spec.native_model_id})
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "request.json").write_text("{}")
            with patch("benchmark.model_registry.urlopen") as transport, self.assertRaises(FileExistsError):
                probe_model(fact, gateway_url="http://gateway/v1", api_key="unused", output=directory)
            transport.assert_not_called()

    def test_catalog_presence_is_not_account_access(self):
        spec = requested_models()[-1]
        facts = resolve_model_facts(
            spec,
            gateway_ids={spec.native_model_id},
            openrouter_models=[
                {
                    "id": spec.provider_model_id,
                    "pricing": {"prompt": "0.0000003", "completion": "0.0000012"},
                    "supported_parameters": ["tools", "reasoning"],
                }
            ],
        )
        self.assertTrue(facts["catalog_available"])
        self.assertTrue(facts["gateway_configured"])
        self.assertIsNone(facts["available"])
        self.assertEqual(facts["access_status"], "unverified")

    def test_missing_cache_prices_remain_unknown(self):
        spec = requested_models()[-1]
        facts = resolve_model_facts(
            spec,
            gateway_ids=set(),
            openrouter_models=[
                {
                    "id": spec.provider_model_id,
                    "pricing": {"prompt": "0.0000003", "completion": "0.0000012"},
                }
            ],
        )
        self.assertIsNone(facts["pricing"]["rates"]["cache_read"])
        self.assertIsNone(facts["pricing"]["rates"]["cache_creation"])

    def test_official_openai_rates_and_large_context_tiers_are_frozen(self):
        facts = resolve_model_facts(requested_models()[0], gateway_ids={"gpt-5.6-luna"})
        self.assertAlmostEqual(facts["pricing"]["rates"]["input"], 0.2 / 1_000_000, delta=1e-15)
        self.assertEqual(facts["pricing"]["tiers"][0]["min_input_tokens"], 272001)
        self.assertEqual(facts["pricing"]["tiers"][0]["input_multiplier"], 2)

    def test_empty_or_credential_bearing_routes_are_rejected(self):
        for route in ["", "https://user:secret@example.com/model", "Bearer abc", "model\nsecret"]:
            with self.subTest(route=route), self.assertRaises(ValueError):
                ModelSpec("Example", route, "vendor/example", "gateway")


if __name__ == "__main__":
    unittest.main()
