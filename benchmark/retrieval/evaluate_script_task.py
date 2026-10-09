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
"""Run the existing smolagents SUT with campaign settings and complete traces.

The instrumentation records request messages and usage without changing the
model responses, execution policy, prompt or official evaluator.
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import runpy
import signal
import sys
import time

from campaign import install_provider_prices


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str) + "\n")


def save_full_memory(base, memory):
    """Optional diagnostics must not prevent official grading of a saved answer."""
    try:
        save(base / "full-memory.json", memory.get_full_steps())
    except Exception as exc:
        save(base / "trace-export-error.json", {
            "exception": type(exc).__name__, "message": str(exc)[:1000],
        })


def main():
    sys.path.insert(0, str(Path.cwd()))
    import systems
    from systems import cost_utils
    from systems.code_agent_system import CodeAgentSystem

    manifest = json.loads(Path(os.environ["RETRIEVAL_MANIFEST"]).read_text())
    job = json.loads(os.environ["RETRIEVAL_JOB"])
    settings = manifest["script_settings"]
    model = manifest["models"][job["model"]]
    pricing = install_provider_prices(cost_utils, [model])
    assert pricing[model] == manifest["pricing_overrides"][model]
    stopped = False

    def stop_turn(signum, frame):
        nonlocal stopped
        stopped = True
        save(Path("system_scratch") / job["sut"] / job["task"] / "wall-clock-stop.json",
             {"reason": "Task wall-clock limit reached", "signal": signum})
        # The existing wrapper catches SystemExit and saves a failed response
        # with accumulated usage. The official evaluator can then score it.
        raise SystemExit("Task wall-clock limit reached")

    signal.signal(signal.SIGTERM, stop_turn)

    class ScriptSystem(CodeAgentSystem):
        def __init__(self, *args, **kwargs):
            super().__init__(
                *args, model_type=model, name=job["sut"],
                api_base=manifest["script_endpoint"],
                api_key=os.environ.get("CODE_AGENT_API_KEY") or os.environ["LITELLM_MASTER_KEY"],
                **settings, **kwargs,
            )

        def process_dataset(self, dataset_directory):
            super().process_dataset(dataset_directory)
            base = Path(self.output_dir) / job["task"]
            save(base / "settings.json", settings)
            save(base / "provenance.json", {
                "runner_revision": manifest["runner_revision"],
                "harness_revision": manifest["harness_revision"], "job": job,
                "model": model, "endpoint": manifest["script_endpoint"],
                "smolagents_version": __import__("smolagents").__version__,
                "adapter_sha256": __import__("hashlib").sha256(Path(__file__).read_bytes()).hexdigest(),
            })
            agent = self.agent._agent
            save(base / "system-info.json", {"systemPrompt": agent.system_prompt})
            # Reset preserves this model/client; intercept the actual normalized
            # OpenAI-compatible request, after smolagents' role conversions.
            original = self.agent._model.client.chat.completions.create
            call_number = 0
            trace_path = base / "model-request-trace.jsonl"

            def append(value):
                value["timestamp"] = datetime.now(timezone.utc).isoformat()
                with trace_path.open("a") as stream:
                    stream.write(json.dumps(value, ensure_ascii=False, default=str) + "\n")

            # SDK retries happen inside create(). Observe their HTTP headers
            # without reading response bodies or recording credentials.
            def transport_request(request):
                request.extensions["krama_trace_started"] = time.monotonic()
                append({"phase": "transport_request", "call": call_number,
                        "method": request.method, "path": request.url.path})

            def transport_response(response):
                started = response.request.extensions.get("krama_trace_started", time.monotonic())
                append({"phase": "transport_headers", "call": call_number,
                        "status": response.status_code, "seconds": time.monotonic() - started})

            http_client = self.agent._model.client._client
            http_client.event_hooks["request"].append(transport_request)
            http_client.event_hooks["response"].append(transport_response)

            def recorded_create(*args, **kwargs):
                nonlocal call_number
                if stopped:
                    raise SystemExit("Task wall-clock limit reached")
                call_number += 1
                number = call_number
                started = time.monotonic()
                fields = ["model", "messages", "stop", "max_tokens", "temperature",
                          "tools", "tool_choice", "response_format", "reasoning_effort"]
                append({"phase": "request", "call": number,
                        "request": {key: kwargs[key] for key in fields if key in kwargs}})
                try:
                    response = original(*args, **kwargs)
                except (Exception, SystemExit) as exc:
                    append({"phase": "error", "call": number,
                            "exception": type(exc).__name__,
                            "status_code": getattr(exc, "status_code", None),
                            "seconds": time.monotonic() - started})
                    raise
                append({"phase": "response", "call": number,
                        "response_model": response.model,
                        "usage": response.usage.model_dump(),
                        "choices": [choice.model_dump() for choice in response.choices],
                        "seconds": time.monotonic() - started})
                return response

            self.agent._model.client.chat.completions.create = recorded_create

        def serve_query(self, query, query_id="default-0", subset_files=None):
            result = super().serve_query(query, query_id, subset_files)
            base = Path(self.output_dir) / query_id
            # The inherited summary clips code and observations. Retain the
            # complete memory separately for manual auditing.
            save_full_memory(base, self.agent._agent.memory)
            save(base / "usage-accumulator.json", self.agent._model.usage_acc)
            return result

    setattr(systems, job["sut"], ScriptSystem)
    runpy.run_path("evaluate.py", run_name="__main__")


if __name__ == "__main__":
    main()
