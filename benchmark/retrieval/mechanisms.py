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
"""Check delivered evidence and profile omissions without judging model reasoning.

Run analyze.py first. Writes only to the explicitly supplied output file;
original benchmark artifacts and scores remain unchanged.
"""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path

try:
    from .metrics import final_reply
except ImportError:
    from metrics import final_reply


def audit(directory):
    analysis = json.loads((directory / "analysis.json").read_text())
    groups = defaultdict(Counter)
    delivery_errors, no_answers, casts = [], [], []
    budgets = Counter()
    for row in analysis["rows"]:
        path = directory / "system_scratch" / row["sut"] / row["task"]
        identity = {key: row[key] for key in ["model", "arm", "task", "sut"]}
        trace = path / "react_steps.json"
        if not trace.exists():
            trace = path / "watchdog-react_steps.json"
        if not trace.exists():
            raise FileNotFoundError(trace)
        raw = json.loads(trace.read_text())
        steps = raw if isinstance(raw, list) else raw["steps"]
        actual = [s for s in steps if s.get("role") == "agent" and s.get("inputMessages")]
        group = groups[row["model"], row["arm"]]
        group["tasks"] += 1
        # Traces before 2026-10-22 recorded corrections as "feedback".
        corrections = sum(s.get("messageSource") in ("feedback", "correction") and
                          (s.get("content") or "").startswith("That reply was text") for s in steps)
        completed_answer = final_reply(steps)
        group["missing_action_corrections"] += corrections
        group["tasks_with_missing_action_correction"] += bool(corrections)
        group["corrected_tasks_with_answer"] += bool(corrections) and completed_answer
        reached = set()
        if row["no_answer"]:
            settings = json.loads((path / "settings.json").read_text())
            kind = ("step_limit" if len(actual) >= settings["maxSteps"] else
                    "first_response_without_tool" if len(actual) == 1 and not actual[0].get("toolCalls") else
                    "later_response_without_tool")
            no_answers.append({**identity, "kind": kind, "model_calls": len(actual)})
            group[kind] += 1
        for i, step in enumerate(steps):
            following = next((s for s in steps[i + 1:] if s.get("role") == "agent" and s.get("inputMessages")), None)
            messages = following["inputMessages"] if following else []
            returned = {
                part["toolCallId"]: part.get("output", {}).get("value", "")
                for message in messages if message.get("role") == "tool" and isinstance(message.get("content"), list)
                for part in message["content"] if part.get("type") == "tool-result"
            }
            for tool in step.get("toolResults", []):
                output = tool.get("output")
                if not isinstance(output, dict):
                    continue
                for action in output.get("actions", []):
                    if action.get("action", {}).get("type") != "retrieve" or action.get("status") != "ok":
                        continue
                    observation = action.get("output")
                    if not isinstance(observation, dict):
                        continue
                    text, facts = observation.get("text", ""), observation.get("evidence", [])
                    sent = returned.get(tool["toolCallId"], "")
                    delivered = following is not None and isinstance(sent, str) and text in sent
                    flags = {
                        "data": any(f.startswith("data.") for f in facts),
                        "flow": any(f.startswith("flow.") for f in facts),
                        "upstream": any(f.startswith("flow.upstream.") for f in facts),
                        "ranges": any(f.startswith("data.") and f.endswith(".range") for f in facts),
                        "frequencies": any(f.startswith("data.") and f.endswith(".values") for f in facts),
                        "partial_stats": "Data statistics: partial prefix" in text,
                        "raw_no_stats": "Parse raw lines" in text,
                        "complete": observation.get("table", {}).get("complete", False),
                        "delivered": delivered,
                        "not_followed_by_model": following is None,
                    }
                    group["retrievals"] += 1
                    group.update(key for key, value in flags.items() if value)
                    if delivered:
                        reached.update(key for key, value in flags.items() if value)
                    elif following:
                        delivery_errors.append({**identity, "step": step["stepId"], "operator": action["action"]["operator_id"]})
        for key in ["data", "flow", "upstream", "ranges", "frequencies", "partial_stats"]:
            group["tasks_with_" + key] += key in reached
        snapshot = path / "snapshot.json"
        if not snapshot.exists():
            budgets["missing_final_snapshots"] += 1
            continue
        omitted, losses = False, []
        for operator, info in json.loads(snapshot.read_text())["results"].items():
            profile = info.get("tableProfile") or {}
            columns = profile.get("columns", {})
            dropped = [c for c in columns.values() if "frequency_payload_budget" in c.get("omissions", [])]
            if dropped:
                omitted = True
                budgets["profiles_frequency_budget"] += 1
                budgets["columns_frequency_budget"] += len(dropped)
                budgets["small_categories_dropped"] += sum(c["distinctCount"] is not None and 1 <= c["distinctCount"] <= 8 for c in dropped)
            failures = (profile.get("native") or {}).get("operations", {}).get("conversionFailures", {})
            failures = {name: count for name, count in failures.items() if count}
            if failures:
                losses.append({"operator": operator, "rows": info.get("totalRowCount"), "failures": failures})
        budgets["attempts_frequency_budget"] += omitted
        if losses:
            casts.append({**identity, "casts": losses})
    return {
        "source": str(directory.resolve()),
        "groups": [{"model": key[0], "arm": key[1], **value} for key, value in sorted(groups.items())],
        "delivery_errors": delivery_errors,
        "no_answers": no_answers,
        "profile_budget": dict(budgets),
        "attempts_with_conversion_failures": casts,
        "scope": "Delivery is checked against the next recorded model request, including watchdog traces. Profile omissions cover final snapshots only. Conversion failures can be intentional; these counts do not label analytical errors or explain score changes.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Refusing to overwrite an existing audit")
    result = audit(args.directory)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"delivery_errors": len(result["delivery_errors"]), "profile_budget": result["profile_budget"], "no_answers": dict(Counter(x["kind"] for x in result["no_answers"]))}, indent=2))


if __name__ == "__main__":
    main()
