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
"""The recorded conversations the overhead experiments replay, one JSON line each.

Dataflow agent: an attempt folder of a KramaBench run (react_steps.json, settings.json, wire/). A line holds the task
prompt, the settings, and every model response in call order, so replay-dataflow.ts can serve them to the agent.

smolagents: an attempt folder of the smolagents baseline (full-memory.json, model-request-trace.jsonl). A line holds
the task, every model response, and what each step's code printed, returned or raised, so replay_smolagents.py can
replay the agent without a model or an interpreter.

    python3 -I conversations.py dataflow OUT.jsonl RUN_DIR...
    python3 -I conversations.py smolagents OUT.jsonl RUN_DIR...
"""
import json
import sys
from pathlib import Path


def dataflow(attempt: Path):
    steps = json.loads((attempt / "react_steps.json").read_text())["steps"]
    calls = []
    for meta in sorted((attempt / "wire").glob("*-meta.json")):
        if json.loads(meta.read_text()).get("status") != 200:
            continue
        stem = meta.name[: -len("-meta.json")]
        request = json.loads((attempt / "wire" / f"{stem}-request.json").read_text())
        response = json.loads((attempt / "wire" / f"{stem}-response.json").read_text())
        calls.append({"response": response, "requestChars": len(json.dumps(request["messages"]))})
    user = next(step for step in steps if step["role"] == "user")
    agent_steps = [step for step in steps if step["role"] == "agent"]
    assert len(agent_steps) == len(calls), (attempt, len(agent_steps), len(calls))
    return {
        "prompt": user["content"],
        "settings": json.loads((attempt / "settings.json").read_text()),
        "calls": calls,
        # What the recorded run's tool results said, to check the replay against.
        "toolErrors": [bool(result.get("isError")) for step in agent_steps for result in step.get("toolResults") or []],
    }


def smolagents(attempt: Path):
    trace = [json.loads(line) for line in (attempt / "model-request-trace.jsonl").read_text().splitlines()]
    responses = [
        {"choices": line["choices"], "usage": line["usage"], "model": line["response_model"]}
        for line in trace
        if line.get("phase") == "response"
    ]
    if not (attempt / "full-memory.json").exists():
        # A run stopped by the wall clock, or whose memory export failed, kept no memory dump. Each request holds the
        # one before it plus the step's output and its observation, so request k+1's last message is step k's
        # observation; the last step's is unknown, and the replay ends there, as the run did.
        requests = [line["request"]["messages"] for line in trace if line.get("phase") == "request"]
        texts = ["".join(part["text"] for part in messages[-1]["content"]) for messages in requests[1:]] + [""]
        prompt = "".join(part["text"] for part in requests[0][1]["content"]).removeprefix("New task:\n")
        steps = [
            {"observations": text.removeprefix("Observation:\n"), "action_output": None, "is_final_answer": False,
             "error": None if text.startswith("Observation:") or not text else {"message": text}, "code_action": None}
            for text in texts[: len(responses)]
        ]
        steps[-1]["is_final_answer"] = True
        return {"prompt": prompt, "settings": json.loads((attempt / "settings.json").read_text()),
                "responses": responses, "steps": steps, "reconstructed": True}
    memory = json.loads((attempt / "full-memory.json").read_text())
    actions = [step for step in memory if "model_input_messages" in step]
    return {
        "prompt": next(step["task"] for step in memory if "task" in step),
        "settings": json.loads((attempt / "settings.json").read_text()),
        "responses": responses,
        "steps": [
            {
                "observations": step.get("observations"),
                "action_output": step.get("action_output"),
                "is_final_answer": bool(step.get("is_final_answer")),
                "error": step.get("error"),
                "code_action": step.get("code_action"),
            }
            for step in actions
        ],
    }


def main():
    kind, out, runs = sys.argv[1], Path(sys.argv[2]), [Path(run) for run in sys.argv[3:]]
    read = {"dataflow": dataflow, "smolagents": smolagents}[kind]
    marker = "react_steps.json" if kind == "dataflow" else "model-request-trace.jsonl"
    written = skipped = 0
    with out.open("w") as sink:
        for run in runs:
            for attempt in sorted(path for path in run.iterdir() if path.is_dir()):
                if not (attempt / marker).exists():
                    print(f"skip {attempt} (no {marker})", file=sys.stderr)
                    skipped += 1
                    continue
                line = {"id": f"{run.parts[-4] if kind == 'dataflow' else run.parts[-3]}/{attempt.name}", **read(attempt)}
                sink.write(json.dumps(line) + "\n")
                written += 1
    print(f"{written} conversations to {out} ({skipped} skipped)")


if __name__ == "__main__":
    main()
