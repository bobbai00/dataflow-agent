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
"""Script ReAct (smolagents' CodeAgent) as a KramaBench system: the task prompt goes to the agent, which runs whole in
the bubblewrap sandbox on the locked interpreter (bobbench.scriptreact); its answer is the value it passes to
final_answer.

Artifacts in the attempt folder: settings.json, provenance.json, prompt.txt, and from the sandbox system-info.json,
model-request-trace.jsonl, executions.jsonl, steps.json, usage-accumulator.json, full-memory.json and result.json; then
response.txt, reasoning_trace.json, stats.json, answer.json and workspace-files.json (what the agent wrote, then
discarded). Cost is not computed here: the runner prices model-request-trace.jsonl.
"""
import json
import os
from pathlib import Path

from bobbench.kramabench.prompt import ANSWER_LINE, SCRIPT_LAST_LINE, dataset_files, file_paths, format_hints, \
    parse_answer, parse_explicit_answer, task_prompt
from bobbench.provenance import sha256
from bobbench.scriptreact import sandbox


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str) + "\n")


class ScriptReActSystem:
    """KramaBench's system protocol: `dataset_directory`, `process_dataset(directory)` and
    `serve_query(query, query_id, subset_files)`."""

    def __init__(self, *, model, settings, python, api_base, api_key, scratch, workspace, kb, provenance, hints=None,
                 before_agent=None, before_discard=None):
        """`hints` adds or replaces format hints (PrepBench's Script ReAct handover); `before_agent(workspace)` and
        `before_discard(workspace, attempt)` are the benchmark's handover hooks."""
        self.model, self.settings, self.python, self.api_base, self.api_key = model, dict(settings), python, api_base, api_key
        self.scratch, self.workspace, self.kb, self.provenance = Path(scratch), Path(workspace), Path(kb), provenance
        self.extra_hints, self.before_agent, self.before_discard = hints or {}, before_agent, before_discard
        self.dataset_directory = None

    def process_dataset(self, dataset_directory):
        self.dataset_directory = str(dataset_directory)
        self.files = dataset_files(self.dataset_directory)
        workload = Path(self.dataset_directory).parent.name
        self.hints = {**format_hints(self.kb / "format_hint" / f"{workload}.json"), **self.extra_hints}

    def prompt(self, query, query_id, subset_files):
        last = SCRIPT_LAST_LINE if self.settings.get("final_answer_tool_prompt") else ANSWER_LINE
        return task_prompt(query, file_paths(subset_files, self.dataset_directory, self.files, self.kb),
                           self.hints.get(query_id, ""), last)

    def serve_query(self, query, query_id="default-0", subset_files=None):
        folder = self.scratch / query_id
        save(folder / "settings.json", self.settings)
        save(folder / "provenance.json", {**self.provenance, "harness_sha256": {
            path.name: sha256(path) for path in (sandbox.CHILD, sandbox.AGENT)}})
        prompt = self.prompt(query, query_id, subset_files)
        (folder / "prompt.txt").write_text(prompt)
        if self.before_agent:
            self.before_agent(self.workspace)
        try:
            result = sandbox.run_sandboxed(
                prompt, python=self.python, model=self.model, api_base=self.api_base, api_key=self.api_key,
                # verbosity 2: smolagents' step log in the attempt log, as the benchmarks ran it.
                settings={"max_steps": self.settings["max_steps"], "verbosity_level": 2,
                          "use_custom_prompt": self.settings["use_custom_prompt"],
                          "max_print_outputs_length": self.settings["max_print_outputs_length"]},
                data_root=self.dataset_directory, data_relative=os.path.relpath(self.dataset_directory, self.kb),
                artifacts=folder, workspace=self.workspace)
        finally:
            if self.before_discard:
                self.before_discard(self.workspace, folder)
            sandbox.discard_workspace(self.workspace, folder)
        (folder / "response.txt").write_text(result["response"] or "(empty)")
        with open(folder / "reasoning_trace.json", "w") as stream:
            json.dump(result["reasoning_trace"], stream, indent=2, default=str)
        with open(folder / "stats.json", "w") as stream:
            json.dump({key: result[key] for key in ("input_tokens", "output_tokens", "total_tokens", "reasoning_tokens",
                                                    "cached_tokens", "cache_creation_tokens")}
                      | {"cost_usd": None, "num_steps": result["num_steps"],
                         "elapsed_seconds": round(result["elapsed_seconds"], 2), "state": result["state"]},
                      stream, indent=2)
        # A value passed to final_answer() is the answer itself; text written at the step limit is searched like any
        # free text.
        if self.settings.get("final_answer_tool_prompt") and result["state"] == "success":
            answer = parse_explicit_answer(result["response"])
        else:
            answer = parse_answer(result["response"])
        with open(folder / "answer.json", "w") as stream:
            json.dump({"answer": answer}, stream, indent=2)
        return {"explanation": {"id": "main-task", "answer": answer}, "pipeline_code": "",
                "token_usage": result["total_tokens"], "token_usage_input": result["input_tokens"],
                "token_usage_output": result["output_tokens"], "token_usage_reasoning": result["reasoning_tokens"],
                "token_usage_cached": result["cached_tokens"], "cost_usd": None}
