# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.

"""Measure cache boundaries on recorded contexts; never execute agent tools.

The template supplies the frozen model, system message, and tool schema. Each
arm gets a fresh fixed-length numeric prefix, so earlier arms cannot warm its
history. Each request asks only for OK. This measures prompt reuse, not answer
accuracy or end-to-end agent performance. Credentials are read from the caller's
environment and never saved. Input rates are the milestone's accounting rates,
with the documented 1.25x cache-write multiplier included for these new probes.
"""

import argparse
import copy
import json
import os
import time
from pathlib import Path

import httpx


def first_messages(trace_root, task):
    steps = json.loads((trace_root / f"t{task:02}/react_steps.json").read_text())
    step = next(s for s in steps if s.get("role") == "agent" and (s.get("usage") or {}).get("inputTokens", 0))
    messages = step["inputMessages"]
    if not all(isinstance(m.get("content"), str) for m in messages):
        raise ValueError("This probe requires text-only first-step task contexts")
    return messages


def request_body(template, messages, nonce, mode):
    messages = copy.deepcopy([template["messages"][0], *messages])
    messages[0]["content"] = f"Cache measurement {nonce}.\n" + messages[0]["content"]
    messages.append({"role": "user", "content": "This request measures prefix caching only. Reply OK. Do not analyze the prior tasks."})
    body = {
        "model": template["model"],
        "input": [
            {"role": m["role"], "content": [{"type": "output_text" if m["role"] == "assistant" else "input_text", "text": m["content"]}]}
            for m in messages
        ],
        "tools": [{"type": "function", **tool["function"]} for tool in template["tools"]],
        "tool_choice": "none",
        "parallel_tool_calls": False,
        "max_output_tokens": 128,
        # This LiteLLM version drops the new top-level parameter. extra_body
        # explicitly forwards it to the provider; record the effective mode.
        "extra_body": {"prompt_cache_options": {"mode": "explicit" if mode == "explicit_only" else "implicit"}},
    }
    if mode != "implicit":
        catalog = next(i for i, m in enumerate(messages) if m["content"].startswith("# Current operator catalog"))
        # The previous marked user boundary must still be present after adding
        # a completed task. Two boundaries permit both reuse and a new write.
        history_users = [i for i in range(1, catalog) if messages[i]["role"] == "user"]
        for i in ([0] if not history_users else history_users[-2:]):
            body["input"][i]["content"][0]["prompt_cache_breakpoint"] = {"mode": "explicit"}
    return body


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trace-root", type=Path, required=True)
    parser.add_argument("--template", type=Path, required=True)
    parser.add_argument("--tasks", type=int, nargs="+", default=[14, 15])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repeats", type=int, default=2)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    template = json.loads(args.template.read_text())
    url = os.environ["CODE_AGENT_API_BASE"].rstrip("/").removesuffix("/v1") + "/v1/responses"
    results = []
    with httpx.Client(timeout=55) as client:
        for repeat in range(args.repeats):
            # Reverse order on alternate repetitions to expose ordering effects.
            modes = ["implicit", "marked_implicit", "explicit_only"]
            if repeat % 2:
                modes.reverse()
            for mode in modes:
                nonce = str(time.time_ns())
                assert len(nonce) == 19
                for task in args.tasks:
                    label = f"r{repeat + 1}-{mode}-task{task}"
                    body = request_body(template, first_messages(args.trace_root, task), nonce, mode)
                    (args.output / f"{label}-request.json").write_text(json.dumps(body, indent=2))
                    start = time.monotonic()
                    response = client.post(url, headers={"Authorization": "Bearer " + os.environ["LITELLM_MASTER_KEY"]}, json=body)
                    value = response.json()
                    # The body contains model output and usage, never auth headers.
                    (args.output / f"{label}-response.json").write_text(json.dumps(value, indent=2))
                    response.raise_for_status()
                    usage = value["usage"]
                    effective_options = value.get("prompt_cache_options")
                    if mode == "explicit_only" and (effective_options or {}).get("mode") != "explicit":
                        raise ValueError("Gateway did not apply explicit-only cache mode")
                    count = usage["input_tokens"]
                    cached = usage["input_tokens_details"].get("cached_tokens", 0)
                    written = usage["input_tokens_details"].get("cache_write_tokens", 0)
                    uncached = count - cached - written
                    if uncached < 0:
                        raise ValueError("Cache accounting classes overlap")
                    row = {
                        "label": label, "task": task, "mode": mode, "repeat": repeat + 1,
                        "input": count, "cached": cached, "written": written, "uncached": uncached,
                        "output": usage["output_tokens"], "seconds": time.monotonic() - start,
                        "input_cost_usd": (cached * .02 + written * .25 + uncached * .20) / 1_000_000,
                        "effective_cache_options": value.get("prompt_cache_options"),
                    }
                    results.append(row)
                    print(json.dumps(row), flush=True)
                    (args.output / "results.json").write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
