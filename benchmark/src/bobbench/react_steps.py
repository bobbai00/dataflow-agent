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
"""Reading the agent's ReAct trace (GET /api/agents/<id>/react-steps): the final reply, retrieval results, tool errors."""

# The step the agent records when a turn is stopped, e.g. by the runner's wall-clock watchdog. It ends the turn but is
# not a reply.
STOPPED_STEP = "Generation stopped by user."


def final_reply(steps):
    """The answer: the last agent step ends the task with text and no tool call. A failed or stopped turn's last step
    says so in `endReason`; traces from before that field are recognized by their text."""
    agents = [step for step in steps if step.get("role") == "agent"]
    final = agents[-1] if agents else None
    return bool(final and final.get("isEnd") and not final.get("toolCalls") and final.get("content")
                and not final.get("endReason")
                and not str(final["content"]).startswith("Error:") and final["content"] != STOPPED_STEP)


def retrieval_results(item):
    """Expand both historical single reads and ordered multi-target reads."""
    action, output = item.get("action", {}), item.get("output")
    if action.get("type") != "retrieve" or not isinstance(output, dict):
        return []
    targets = output.get("results")
    if isinstance(targets, list):
        return [{**(target.get("output") or target), "operator_id": target.get("operator_id"),
                 "status": target.get("status", item.get("status"))} for target in targets]
    return [{**output, "operator_id": action.get("operator_id"), "status": item.get("status")}]


def tool_error_counts(result):
    """Count failed calls, including validation failures before any action runs."""
    output = result.get("output")
    output = output if isinstance(output, dict) else {}
    action_errors = sum(item.get("status") == "error" for item in output.get("actions", []))
    failed = bool(result.get("isError") or output.get("status") == "error" or output.get("error") or action_errors)
    return {"tool_errors": int(failed), "envelope_errors": int(failed and not action_errors),
            "action_errors": action_errors}
