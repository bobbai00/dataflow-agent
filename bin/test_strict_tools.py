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

"""Regression tests for LiteLLM's Anthropic strict-tool route.

Run inside the pinned LiteLLM image, where the gateway dependency is installed:
  python -m unittest discover -s /app/compat -p test_strict_tools.py
"""

import copy
import unittest

from strict_tools import hook
from litellm.llms.anthropic.chat.transformation import AnthropicConfig


def request(model="claude-haiku-4.5", strict=True):
    return {
        "model": model,
        "messages": [{"role": "user", "content": "Inspect."}],
        "tools": [{"type": "function", "function": {
            "name": "dataflow", "description": "Edit a graph.", "strict": strict,
            "parameters": {
                "type": "object", "additionalProperties": False,
                "properties": {
                    "reasoning": {"type": "string", "minLength": 1, "pattern": r"\S"},
                    "actions": {"type": "array", "minItems": 1, "maxItems": 32,
                        "items": {"anyOf": [{"type": "object", "additionalProperties": False,
                            "properties": {"type": {"type": "string", "const": "execute"}},
                            "required": ["type"]}]}},
                }, "required": ["reasoning", "actions"],
            },
        }}],
    }


class StrictToolTests(unittest.IsolatedAsyncioTestCase):
    async def adapt(self, data):
        return await hook.async_pre_call_hook(None, None, data, "completion")

    async def test_strict_survives_actual_litellm_transformation(self):
        data = await self.adapt(request())
        tools, _ = AnthropicConfig()._map_tools(data["tools"])
        self.assertTrue(tools[0]["strict"])
        self.assertEqual(tools[0]["name"], "dataflow")
        self.assertEqual(tools[0]["description"], "Edit a graph.")
        schema = tools[0]["input_schema"]
        self.assertEqual(schema["required"], ["reasoning", "actions"])
        self.assertFalse(schema["additionalProperties"])
        actions = schema["properties"]["actions"]
        self.assertEqual(actions["minItems"], 1)
        self.assertNotIn("maxItems", actions)
        self.assertIn("maxItems: 32", actions["description"])
        self.assertNotIn("minLength", schema["properties"]["reasoning"])
        self.assertNotIn("pattern", schema["properties"]["reasoning"])
        self.assertIn("pattern:", schema["properties"]["reasoning"]["description"])
        branch = actions["items"]["anyOf"][0]
        self.assertEqual(branch["properties"]["type"]["const"], "execute")
        self.assertFalse(branch["additionalProperties"])

    async def test_no_mutation_and_stable_repeated_mapping(self):
        data = request()
        before = copy.deepcopy(data)
        mapped = await self.adapt(data)
        self.assertEqual(data, before)
        self.assertEqual(mapped, await self.adapt(before))
        self.assertEqual(mapped, await self.adapt(mapped))

    async def test_openai_non_strict_and_other_claude_models_are_unchanged(self):
        for data in [request("gpt-5.6-luna"), request(strict=False), request("claude-3-haiku")]:
            self.assertEqual(await self.adapt(data), data)
        data = request()
        del data["tools"][0]["function"]["strict"]
        self.assertEqual(await self.adapt(data), data)

    async def test_literal_values_and_constraint_named_properties_are_preserved(self):
        data = request()
        schema = data["tools"][0]["function"]["parameters"]
        schema["properties"]["maxItems"] = {"type": "string", "enum": ["minLength", "maxItems"]}
        schema["properties"]["literal"] = {"type": "string", "const": "maxItems"}
        schema["properties"]["small"] = {"type": "array", "items": {"type": "integer"}, "minItems": 2}
        original = copy.deepcopy(schema["properties"]["maxItems"])
        mapped = (await self.adapt(data))["tools"][0]["input_schema"]
        self.assertEqual(mapped["properties"]["maxItems"], original)
        self.assertEqual(mapped["properties"]["literal"]["const"], "maxItems")
        self.assertNotIn("minItems", mapped["properties"]["small"])
        self.assertIn("minItems: 2", mapped["properties"]["small"]["description"])

    async def test_already_native_strict_tools_are_supported(self):
        data = request()
        f = data["tools"][0]["function"]
        data["tools"] = [{"name": f["name"], "strict": True, "input_schema": f["parameters"]}]
        mapped = await self.adapt(data)
        self.assertTrue(mapped["tools"][0]["strict"])
        self.assertNotIn("maxItems", mapped["tools"][0]["input_schema"]["properties"]["actions"])


if __name__ == "__main__":
    unittest.main()
