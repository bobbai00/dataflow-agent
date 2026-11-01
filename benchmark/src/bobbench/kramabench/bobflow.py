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
"""BobFlow, the dataflow agent, as a KramaBench system: one agent per task, created with the run's settings, sent the
task prompt over the agent's WebSocket, its reply parsed, its artifacts saved, and deleted.

Artifacts in the attempt folder: prompt.txt, resources.json (agent, workflow, computing unit), provenance.json (with the
agent listener's source), system-info.json and settings.json (as the agent reports them), response.txt,
react_steps.json, stats.json (the turn's usage as streamed), answer.json, ground_truth.json, workflow.json and
snapshot.json. A hook (PrepBench's output export) runs after snapshot.json, while the agent and its workflow still exist.
"""
import json
from pathlib import Path
import time

from bobbench import agent_client
from bobbench.agent_client import Turn
from bobbench.kramabench.prompt import ANSWER_LINE, answer_only, dataset_files, file_paths, format_hints, \
    parse_answer, task_prompt
from bobbench.provenance import inspect_listener

# The workflow an agent edits: empty, created per task.
WORKFLOW = {"name": "Benchmark Workflow", "content": json.dumps(
    {"operators": [], "operatorPositions": {}, "links": [], "commentBoxes": [], "settings": {}})}
TOOL_INPUTS = {"python", "statements"}


def save(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str) + "\n")


def dump(path, data, **options):
    with open(path, "w") as stream:
        json.dump(data, stream, indent=2, **options)


class BobFlowSystem:
    """KramaBench's system protocol: `dataset_directory`, `process_dataset(directory)` and
    `serve_query(query, query_id, subset_files)`, which returns the reply dict KramaBench's Executor reads."""

    def __init__(self, *, model, settings, endpoints, computing_unit, scratch, kb, provenance, after_reply=None,
                 receive_timeout=600):
        self.model, self.settings, self.endpoints, self.computing_unit = model, dict(settings), endpoints, computing_unit
        self.scratch, self.kb, self.provenance, self.after_reply = Path(scratch), Path(kb), provenance, after_reply
        self.receive_timeout = receive_timeout
        self.dataset_directory = None

    def process_dataset(self, dataset_directory):
        self.dataset_directory = str(dataset_directory)
        self.files = dataset_files(self.dataset_directory)
        workload = Path(self.dataset_directory).parent.name
        self.hints = format_hints(self.kb / "format_hint" / f"{workload}.json")
        self.tasks = {task["id"]: task for task in json.loads((self.kb / "workload" / f"{workload}.json").read_text())}

    def prompt(self, query, query_id, subset_files):
        prompt = task_prompt(query, file_paths(subset_files, self.dataset_directory, self.files, self.kb),
                             self.hints.get(query_id, ""), ANSWER_LINE)
        return answer_only(prompt) if self.settings.get("answerOnlyReply") else prompt

    def serve_query(self, query, query_id="default-0", subset_files=None):
        folder = self.scratch / query_id
        folder.mkdir(parents=True, exist_ok=True)
        prompt = self.prompt(query, query_id, subset_files)
        (folder / "prompt.txt").write_text(prompt)
        listener = inspect_listener(self.endpoints.agent)
        token = agent_client.login(self.endpoints.web)
        workflow = agent_client.create_workflow(self.endpoints, token, WORKFLOW)
        agent = None
        try:
            agent = agent_client.create_agent(self.endpoints, token, {
                "modelType": self.model, "workflowId": workflow, "computingUnitId": self.computing_unit,
                "settings": self.settings})["id"]
            save(folder / "resources.json", {"agent_id": agent, "workflow_id": workflow,
                                             "computing_unit_id": self.computing_unit})
            save(folder / "provenance.json", {**self.provenance, "agent_listener": listener})
            for route in ["system-info", "settings"]:
                save(folder / f"{route}.json", agent_client.get(self.endpoints, agent, route))
            recorded = json.loads((folder / "settings.json").read_text())
            assert all(recorded.get(key) == value for key, value in self.settings.items()), "Settings drift"
            tools = json.loads((folder / "system-info.json").read_text())["tools"]
            schema = next(tool for tool in tools if tool["name"] == "dataflow")["inputSchema"]["properties"]
            assert set(schema) == TOOL_INPUTS, sorted(schema)
            return self._turn(folder, agent, prompt, query_id)
        finally:
            if agent:
                try:
                    agent_client.delete_agent(self.endpoints, agent)
                except Exception as error:  # noqa: BLE001 - teardown never hides the attempt's own outcome
                    print(f"[BobFlow] agent {agent} was not deleted: {error}", flush=True)
            try:
                agent_client.delete_workflow(self.endpoints, token, {"wids": [workflow]})
            except Exception as error:  # noqa: BLE001
                print(f"[BobFlow] workflow {workflow} was not deleted: {error}", flush=True)

    def _turn(self, folder, agent, prompt, query_id):
        started = time.monotonic()
        try:
            turn = agent_client.ws_turn(self.endpoints, agent, prompt, self.receive_timeout)
        except Exception as error:  # noqa: BLE001 - a failed turn is a failed task, never a crashed workload
            print(f"[BobFlow] Error running agent: {error}", flush=True)
            turn = Turn(response=f"Error: {error}", usage={}, steps=0, stopped=True, error=str(error))
        elapsed = time.monotonic() - started
        (folder / "response.txt").write_text(turn.response or "(empty response)")
        steps = []
        try:
            trace = agent_client.get(self.endpoints, agent, "react-steps", timeout=120)
            steps = trace.get("steps", []) or []
            dump(folder / "react_steps.json", trace, default=str)
        except Exception as error:  # noqa: BLE001
            print(f"[BobFlow] Could not save react steps: {error}", flush=True)
        usage = {key: turn.usage.get(key) or 0 for key in ("input_tokens", "output_tokens", "reasoning_tokens",
                                                             "cached_input_tokens", "cache_creation_input_tokens")}
        total = usage["input_tokens"] + usage["output_tokens"]
        dump(folder / "stats.json", {
            "input_tokens": usage["input_tokens"], "output_tokens": usage["output_tokens"], "total_tokens": total,
            "reasoning_tokens": usage["reasoning_tokens"], "cached_tokens": usage["cached_input_tokens"],
            "cache_creation_tokens": usage["cache_creation_input_tokens"], "cost_usd": None,
            "stopped": turn.stopped, "error": turn.error,
            "num_steps": turn.steps or sum(1 for step in steps if step.get("role") == "agent" and step.get("toolCalls")),
            "elapsed_seconds": round(elapsed, 2)})
        explanation = {"id": "main-task", "answer": parse_answer(turn.response)}
        dump(folder / "answer.json", explanation)
        task = self.tasks.get(query_id)
        if task:
            dump(folder / "ground_truth.json", {key: task.get(key, [] if key == "data_sources" else None)
                                                for key in ("id", "query", "answer", "answer_type", "data_sources")})
        try:
            dump(folder / "workflow.json", agent_client.get(self.endpoints, agent, "workflow", timeout=120))
        except Exception as error:  # noqa: BLE001
            print(f"[BobFlow] Could not save workflow: {error}", flush=True)
        try:
            save(folder / "snapshot.json", agent_client.get(self.endpoints, agent, "snapshots/head", timeout=120))
        except Exception as error:  # noqa: BLE001
            print(f"[BobFlow] Could not save the snapshot: {error}", flush=True)
        if self.after_reply:
            self.after_reply(folder)
        return {"explanation": explanation, "pipeline_code": "", "token_usage": total,
                "token_usage_input": usage["input_tokens"], "token_usage_output": usage["output_tokens"],
                "token_usage_reasoning": usage["reasoning_tokens"], "token_usage_cached": usage["cached_input_tokens"],
                "cost_usd": None}
