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
"""The models a run can use: the gateway route behind each tag, and the frozen prices costs are computed with.

Prices are frozen standard-tier token rates with their source and the date they were checked; they estimate cost, they
are not invoices. A response that carries the provider's own charge (OpenRouter's usage.cost) is billed at that charge
instead (bobbench.profiling.usage).
"""

# Tag (the runner's --models) -> the gateway route the agent and Script ReAct call.
MODEL_TYPES = {
    "Luna": "gpt-5.6-luna", "Terra": "gpt-5.6-terra", "Sol": "gpt-5.6-sol", "Sol61": "gpt-6.1-sol",
    "Opus48": "claude-opus-4.8", "Opus55": "claude-opus-5.5",
    "Qwen38_27B": "qwen3.8-27b", "Qwen38_27B_NoThink": "qwen3.8-27b-nothink", "DeepSeek41Flash": "deepseek-v4.1-flash",
    "Haiku45": "claude-haiku-4.5", "Sonnet55": "claude-sonnet-5.5", "Haiku55": "claude-haiku-5.5",
    "Haiku55LowThink": "claude-haiku-5.5-lowthink", "Haiku55NoThink": "claude-haiku-5.5-nothink",
    "Gemini4Argon": "gemini-4-argon", "Gemini4ArgonMedium": "gemini-4-argon-medium", "Gemini38Flash": "gemini-3.8-flash",
    "Gemini38FlashVertex": "gemini-3.8-flash-vertex",
}

OPENROUTER = "rates fitted to the usage.cost_details OpenRouter returned on the campaign's responses"
GEMINI = "https://ai.google.dev/gemini-api/docs/pricing"
HAIKU = "https://platform.claude.com/docs/en/about-claude/pricing"
# Model id -> ((input, output, cache read, cache write) USD per million tokens, source, date checked).
PRICES = {
    "gpt-5.6-luna": ((.2, 1.2, .02, .25), "https://developers.openai.com/api/docs/models/gpt-5.6-luna", "2026-10-12"),
    "gpt-5.6-terra": ((2, 12, .2, 2.5), "https://developers.openai.com/api/docs/models/gpt-5.6-terra", "2026-10-12"),
    "gpt-5.6-sol": ((4, 20, .4, 5), "https://developers.openai.com/api/docs/models/gpt-5.6-sol", "2026-10-12"),
    "gpt-6.1-sol": ((2, 10, .1, 2.5), "https://developers.openai.com/api/docs/models/gpt-6.1-sol", "2026-10-16"),
    "claude-opus-4.8": ((5, 25, .5, 6.25), "https://platform.claude.com/docs/en/models/opus-4-8/overview", "2026-10-08"),
    "claude-opus-5.5": ((4, 20, .2, 5), "https://platform.claude.com/docs/en/models/opus-5-5/overview", "2026-10-12"),
    # OpenRouter models: the rates the routes' pinned providers billed (Parasail for Qwen, DeepInfra for DeepSeek), not
    # OpenRouter's listing, which was 1.2-2.9x higher per rate. Neither bills cache writes.
    "qwen3.8-27b": ((.24, 2.2, .05, None), OPENROUTER + " (Parasail)", "2026-10-12"),
    # The same model with thinking switched off at the gateway (qwen3.8-27b-nothink route).
    "qwen3.8-27b-nothink": ((.24, 2.2, .05, None), OPENROUTER + " (Parasail)", "2026-10-12"),
    "deepseek-v4.1-flash": ((.14, .42, .0042, None), OPENROUTER + " (DeepInfra)", "2026-10-12"),
    "claude-haiku-5.5": ((.1, .5, .01, .125), HAIKU, "2026-10-08"),
    # The same model with adaptive thinking at effort low (claude-haiku-5.5-lowthink route), and with thinking off.
    "claude-haiku-5.5-lowthink": ((.1, .5, .01, .125), HAIKU, "2026-10-17"),
    "claude-haiku-5.5-nothink": ((.1, .5, .01, .125), HAIKU, "2026-10-21"),
    # Only to re-price runs of September/early October: the rates the KramaBench harness and the Sonnet 5.5 campaign
    # override used then.
    "claude-haiku-4.5": ((1, 5, .1, 1.25), HAIKU, "2026-09-01"),
    "claude-sonnet-5.5": ((2, 10, .2, 2.5), "https://platform.claude.com/docs/en/models/sonnet-5-5/overview", "2026-10-01"),
    # Gemini 4 Argon through OpenRouter on Google AI Studio (standard tier); OpenRouter reports each response's charge,
    # so these rates only price a response without one. Implicit caching only; the rates double on 2026-12-01. The
    # -medium route is the same model with reasoning effort medium.
    "gemini-4-argon": ((2, 10, .1, None), GEMINI + " (through 2026-11-30)", "2026-10-16"),
    "gemini-4-argon-medium": ((2, 10, .1, None), GEMINI + " (through 2026-11-30)", "2026-10-16"),
    # Standard paid tier through 2026-12-31 (output includes thinking); explicit cache storage is billed per token-hour
    # on top and is not counted here.
    "gemini-3.8-flash": ((.75, 3.75, .075, None), GEMINI, "2026-10-02"),
    # The same model through OpenRouter on Vertex (gemini-3.8-flash-vertex route), which reports each response's charge.
    "gemini-3.8-flash-vertex": ((.75, 3.75, .075, None), GEMINI, "2026-10-24"),
}
HAIKU55 = ("claude-haiku-5.5", "claude-haiku-5.5-lowthink", "claude-haiku-5.5-nothink")


def price_schedule(model):
    """The frozen price schedule of a model id, or None (costs then stay unknown, never zero)."""
    if model not in PRICES:
        return None
    rates, source, verified = PRICES[model]
    # GPT-6.1 Sol follows GPT-5.6's billing rules: the 272K long-prompt rates, and every prompt written to its cache.
    gpt_cache_rules = model.startswith(("gpt-5.6-", "gpt-6.1-"))
    haiku55 = model in HAIKU55
    return {"model": model, "kind": "token_estimate", "currency": "USD", "unit": "per_token",
            "verified_on": verified, "source": source,
            "rates": {k: v / 1e6 if v is not None else None for k, v in
                      zip(("input", "output", "cache_read", "cache_creation"), rates)},
            "long_context_threshold": 272000 if gpt_cache_rules else 100000 if haiku55 else None,
            # Haiku 5.5 bills every token class at 5x once a prompt exceeds 100k tokens.
            **({"long_context_multiplier": 5} if haiku55 else {}),
            # GPT-5.6 and GPT-6.1 write every prompt to their cache (implicit mode) and bill writes at 1.25x input
            # (https://developers.openai.com/api/docs/guides/prompt-caching); usage that omits the write count still
            # incurred them. GPT-6.1 Sol's Responses usage reported 3,624 writes on a fresh 3,627-token prompt.
            **({"implicit_cache_writes": True} if gpt_cache_rules else {}),
            "input_includes_cached": True, "output_includes_reasoning": True}
