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
"""Normalize preserved executor artifacts without replacing raw observations."""

from collections import Counter
import json
import re
from pathlib import Path


def read_json(path, default):
    return json.loads(path.read_text()) if path.is_file() else default


def read_events(path):
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def native_input_compliance(call, validator):
    """JSON syntax and payload schema are independent of runtime success."""
    syntax, schema = None, None
    parsed = None
    if isinstance(call, dict) and "input" in call:
        raw = call["input"]
        try:
            if isinstance(raw, str):
                parsed = json.loads(
                    raw,
                    parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
                )
            else:
                json.dumps(raw, allow_nan=False)
                parsed = raw
            syntax = True
        except (ValueError, TypeError):
            syntax = False
        if syntax and validator is not None:
            schema = validator.is_valid(parsed)
    return {
        "json_syntax": syntax,
        "schema_validation": schema,
        "semantic_validation": None,
        "operator_error": None,
    }


def native_schema_validator(schema):
    """Validate captured inline schemas locally; never resolve remote references."""
    if not isinstance(schema, dict):
        return None
    pending = [schema]
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            if "$ref" in value and not str(value["$ref"]).startswith("#"):
                return None
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
    try:
        from jsonschema import Draft7Validator, SchemaError
    except ImportError:
        return None
    try:

        Draft7Validator.check_schema(schema)
        return Draft7Validator(schema)
    except (ValueError, SchemaError):
        return None


def native_action_details(steps, actions, coverage, *, native_format=None, schema=None):
    """Keep requested actions, returned outcomes and tool failures in distinct units."""
    receipt_protocols = [
        result["output"]["protocol"]
        for step in steps
        for result in step.get("toolResults", [])
        if isinstance(result, dict)
        and isinstance(result.get("output"), dict)
        and result["output"].get("protocol") in ("expression", "json")
    ]
    format = (
        native_format if native_format in ("expression", "json") else "json" if "json" in receipt_protocols else None
    )
    protocol_conflicts = sum(value != format for value in receipt_protocols) if format is not None else 0
    allowed_types = (
        {"inspect", "set", "delete", "read", "answer", "fork"}
        if format == "json"
        else {"inspect", "edit", "execute", "retrieve", "answer"}
    )
    validator = native_schema_validator(schema) if format is not None else None
    invalid_types = Counter({name: count for name, count in actions.items() if name not in allowed_types})
    calls, by_id = [], {}
    duplicate_calls, missing_call_ids = 0, 0
    global_ids = Counter()
    for step_index, step in enumerate(steps):
        for call in step.get("toolCalls", []):
            raw = call.get("input") if isinstance(call, dict) else None
            requested = raw.get("actions", []) if isinstance(raw, dict) else []
            entries = (
                {
                    index: action
                    for index, action in enumerate(requested, 1)
                    if isinstance(action, dict) and isinstance(action.get("type"), str)
                }
                if isinstance(requested, list)
                else {}
            )
            call_id = call.get("toolCallId") if isinstance(call, dict) else None
            item = {
                "id": call_id,
                "step": step_index,
                "actions": entries,
                "statuses": {},
                "seen": False,
                "compliance": (native_input_compliance(call, validator) if format is not None else {}),
                "execution_counts": {},
                "zero_execution": False,
                "arguments_complete": isinstance(requested, list)
                and isinstance(raw, dict)
                and len(entries) == len(requested),
            }
            calls.append(item)
            if isinstance(call_id, str) and call_id:
                key = (step_index, call_id)
                global_ids[call_id] += 1
                if key in by_id:
                    duplicate_calls += 1
                by_id.setdefault(key, []).append(item)
            else:
                missing_call_ids += 1

    tool_errors, tool_rejections, result_count = 0, 0, 0
    rejection_categories = Counter()
    seen_results = set()
    duplicates, orphan_results, unknown_error_flags, invalid_outcomes = 0, 0, 0, 0
    missing_result_ids = 0
    rejection_complete = True
    for step_index, step in enumerate(steps):
        results = step.get("toolResults", [])
        for result in results:
            result_count += 1
            if not isinstance(result, dict):
                invalid_outcomes += 1
                unknown_error_flags += 1
                continue
            result_id = result.get("toolCallId")
            if isinstance(result_id, str) and result_id:
                key = (step_index, result_id)
                if key in seen_results:
                    duplicates += 1
                    continue
                seen_results.add(key)
            else:
                missing_result_ids += 1
            matches = by_id.get((step_index, result_id), []) if isinstance(result_id, str) else []
            # Historical single-call records may omit IDs; multiple calls remain ambiguous.
            if not matches and not result_id and len(results) == 1:
                candidates = [call for call in calls if call["step"] == step_index and not call["id"]]
                if len(candidates) == 1:
                    matches = candidates
            call = matches[0] if len(matches) == 1 else None
            if call is None:
                orphan_results += 1
            else:
                call["seen"] = True
            output = result.get("output")
            batch = output if isinstance(output, dict) else {}
            flag = result.get("isError")
            batch_status = batch.get("status")
            valid_batch_status = isinstance(batch_status, str) and batch_status in {
                "completed",
                "error",
                "blocked",
            }
            if batch_status is not None and not valid_batch_status:
                invalid_outcomes += 1
            if type(flag) is not bool and not valid_batch_status:
                unknown_error_flags += 1
            if (
                type(flag) is bool
                and isinstance(batch_status, str)
                and batch_status in {"completed", "error"}
                and flag != (batch_status == "error")
            ):
                unknown_error_flags += 1
            tool_error = flag is True or batch_status == "error"
            tool_errors += tool_error
            returned = batch.get("actions", [])
            if not isinstance(returned, list):
                returned = []
                invalid_outcomes += 1
            nested_failure = False
            for position, entry in enumerate(returned, 1):
                if not isinstance(entry, dict) or not isinstance(entry.get("action"), dict):
                    invalid_outcomes += 1
                    continue
                status = entry.get("status")
                if not isinstance(status, str) or status not in {
                    "ok",
                    "error",
                    "skipped",
                }:
                    invalid_outcomes += 1
                    continue
                nested_failure |= status in {"ok", "error"}
                if call is None:
                    continue
                index = entry.get("index", position)
                if (
                    type(index) is not int
                    or index not in call["actions"]
                    or entry["action"].get("type") != call["actions"][index].get("type")
                    or index in call["statuses"]
                ):
                    invalid_outcomes += 1
                    continue
                call["statuses"][index] = {
                    "ok": "completed",
                    "error": "failed",
                    "skipped": "skipped",
                }[status]
                output = entry.get("output") if isinstance(entry.get("output"), dict) else {}
                counts = [source["executions"] for source in (entry, output) if "executions" in source]
                if counts:
                    value = counts[0]
                    call["execution_counts"][index] = (
                        value if all(type(count) is int and count >= 0 and count == value for count in counts) else None
                    )
            error = batch.get("error", output if isinstance(output, str) else "")
            error = error if isinstance(error, str) else ""
            category = None
            if error.startswith("Use one dataflow call per turn,") and "No actions were run." in error:
                category = "native_cardinality"
            elif error.startswith(
                (
                    "Invalid input for tool dataflow",
                    "Invalid tool arguments",
                    "Invalid dataflow arguments:",
                    "Invalid structured dataflow arguments:",
                )
            ) or re.match(r"^Action \d+: unknown action type ", error):
                category = "schema_validation"
            elif format == "json" and (
                error.startswith("One answer per call, as the last action.")
                or re.match(
                    r"^Action \d+: (selected IDs|selected columns) must be unique\.",
                    error,
                )
            ):
                category = "semantic_validation"
            elif "No actions were run." in error or "No actions ran." in error:
                category = "pre_execution"
            rejected = tool_error and category is not None and not nested_failure
            if rejected:
                tool_rejections += 1
                rejection_categories[category] += 1
                if call is not None:
                    call["zero_execution"] = True
                    for index in call["actions"]:
                        call["statuses"].setdefault(index, "rejected")
            elif tool_error and not nested_failure:
                rejection_complete = False
            if call is not None and format is not None:
                if rejected and category in {
                    "semantic_validation",
                    "pre_execution",
                    "native_cardinality",
                }:
                    call["compliance"]["semantic_validation"] = False
                elif nested_failure or (batch_status == "completed" and call["arguments_complete"]):
                    call["compliance"]["semantic_validation"] = True
                operator_groups = [batch.get("operators")]
                for entry in returned:
                    if isinstance(entry, dict) and isinstance(entry.get("output"), dict):
                        operator_groups.append(entry["output"].get("operators"))
                        execution = entry["output"].get("execution")
                        if isinstance(execution, dict):
                            operator_groups.append(execution.get("operators"))
                known_operators = [item for group in operator_groups if isinstance(group, list) for item in group]
                if any(isinstance(group, list) for group in operator_groups) and all(
                    isinstance(item, dict)
                    and item.get("status") in ("added", "modified", "deleted", "ok", "error", "blocked")
                    for item in known_operators
                ):
                    call["compliance"]["operator_error"] = any(item["status"] == "error" for item in known_operators)

    missing_results = sum(not call["seen"] for call in calls)
    outcomes = Counter(status for call in calls for status in call["statuses"].values())
    unknown = sum(len(call["actions"]) - len(call["statuses"]) for call in calls)
    requested_complete = coverage["complete"]
    association_complete = not (
        missing_results or duplicates or duplicate_calls or orphan_results or missing_call_ids or missing_result_ids
    )
    outcomes_complete = requested_complete and association_complete and not invalid_outcomes and unknown == 0
    trace_complete = coverage["trace_status"] in {"present", "not_launched"}
    error_complete = trace_complete and association_complete and unknown_error_flags == 0
    details = {
        "count_semantics": "total/by_type count requested entries; errors count nested failed action results; tool errors/rejections count calls",
        "requested": {
            "total": sum(actions.values()),
            "by_type": dict(actions),
            "complete": requested_complete,
        },
        "invalid_action_types": dict(invalid_types),
        "invalid_action_type_total": sum(invalid_types.values()),
        "action_type_validation": "Native v1 action discriminator only; full payload schema validity is not inferred",
        "tool_results": result_count,
        "tool_errors": tool_errors,
        "tool_rejections": tool_rejections,
        "tool_rejection_categories": dict(rejection_categories),
        "tool_rejection_count_complete": error_complete and rejection_complete,
        "tool_error_coverage": {
            "complete": error_complete,
            "missing_results": missing_results,
            "missing_call_ids": missing_call_ids,
            "missing_result_ids": missing_result_ids,
            "duplicate_call_ids": duplicate_calls,
            "duplicate_result_ids": duplicates,
            "global_call_id_reuse": sum(count - 1 for count in global_ids.values() if count > 1),
            "association_source": "step index and tool call ID; single-pair missing-ID fallback is observed only",
            "orphan_results": orphan_results,
            "unknown_error_flags": unknown_error_flags,
            "invalid_outcomes": invalid_outcomes,
        },
        "outcomes": {
            **{name: outcomes[name] for name in ("completed", "failed", "skipped", "rejected")},
            "unknown": unknown,
            "complete": outcomes_complete,
        },
        "final_answer_count_complete": coverage["final_answer_count_complete"]
        and association_complete
        and not invalid_outcomes,
        "complete": requested_complete
        and outcomes_complete
        and error_complete
        and not invalid_types
        and not protocol_conflicts,
    }
    if format is not None:
        call_complete = trace_complete and not duplicate_calls and not missing_call_ids

        def classification(name, yes, no):
            values = [call["compliance"][name] for call in calls]
            return {
                yes: sum(value is True for value in values),
                no: sum(value is False for value in values),
                "unknown": sum(value is None for value in values),
                "complete": call_complete and all(value is not None for value in values),
            }

        execution_total, unknown_execution = 0, 0
        for call in calls:
            if call["zero_execution"]:
                continue
            if not call["arguments_complete"]:
                unknown_execution += 1
            for index, action in call["actions"].items():
                status = call["statuses"].get(index)
                required = action["type"] in {"execute", "read"} or (
                    format == "json" and action["type"] == "answer" and "source" in action
                )
                if index in call["execution_counts"]:
                    value = call["execution_counts"][index]
                    if value is None:
                        unknown_execution += 1
                    else:
                        execution_total += value
                elif status in {"skipped", "rejected"}:
                    continue
                elif status is None or required or action["type"] not in allowed_types:
                    unknown_execution += 1
        executions_complete = (
            trace_complete
            and association_complete
            and not invalid_outcomes
            and unknown_execution == 0
            and not protocol_conflicts
        )
        details.update(
            native_format=format,
            protocol_coverage={
                "declared_format": native_format,
                "receipt_protocols": sorted(set(receipt_protocols)),
                "conflicting_receipts": protocol_conflicts,
                "complete": not protocol_conflicts,
            },
            action_type_validation=f"Native {format} action discriminator only; full payload schema validity is reported separately",
            call_compliance={
                "unit": "model-returned tool calls; runtime operator errors and nested action failures are separate units",
                "returned_calls_observed": len(calls),
                "distinct_identified_calls": len(by_id),
                "returned_calls_complete": call_complete,
                "json_syntax": classification("json_syntax", "valid", "invalid"),
                "schema_validation": classification("schema_validation", "valid", "invalid"),
                "semantic_validation": classification("semantic_validation", "accepted", "rejected"),
                "schema_source": (
                    "captured system-info.json dataflow inputSchema; local Draft7 validation" if validator else None
                ),
                "provider_grammar_enforcement": "unknown; advertised strict is not proof of provider enforcement",
                "operator_error_calls": sum(call["compliance"]["operator_error"] is True for call in calls),
                "operator_error_count_complete": error_complete
                and all(call["compliance"]["operator_error"] is not None for call in calls),
                "calls": [
                    {
                        "step_index": call["step"],
                        "tool_call_id": call["id"],
                        **call["compliance"],
                    }
                    for call in calls
                ],
            },
            executions={
                "total": execution_total if executions_complete else None,
                "observed_total": execution_total,
                "complete": executions_complete,
                "unknown_action_receipts": unknown_execution,
                "count_source": "per-action executeWorkflowAndPersist receipt; skipped/rejected actions and explicit pre-execution rejections invoke no helper",
                "unit": "executeWorkflowAndPersist invocations; one invocation may submit multiple independent backend workflows; requested execute/read actions are counted separately",
            },
        )
    return details


def normalize_attempt(directory, *, system, task_wall_seconds, resources=None, benchmark="dsbench"):
    """Unknown failed-call usage stays unknown; requests are not memory steps."""
    directory = Path(directory)
    stats = read_json(directory / "stats.json", {})
    common = read_json(directory / "common-accounting.json", None)
    lifecycle = read_json(directory / "lifecycle.json", {})
    actions, action_errors, final_answers = Counter(), 0, 0
    action_details = {}
    action_trace = directory / ("react_steps.json" if system == "native" else "executions.jsonl")
    status = read_json(directory / "status.json", {})
    not_launched = status.get("state") == "preflight_blocked" and status.get("inference_requests_attempted") == 0
    action_trace_present = action_trace.is_file()
    action_export_failed = system == "native" and (directory / "trace-fetch-error.json").is_file()
    action_coverage = {
        "complete": (action_trace_present and not action_export_failed) or not_launched,
        "trace_status": (
            "export_failed"
            if action_export_failed
            else ("present" if action_trace_present else "not_launched" if not_launched else "missing")
        ),
        "count_source": (action_trace.name if action_trace_present else "provider_preflight" if not_launched else None),
        "final_answer_count_complete": (action_trace_present and not action_export_failed) or not_launched,
        "tool_calls": 0,
        "malformed_tool_calls": 0,
        "malformed_action_entries": 0,
        "malformed_result_entries": 0,
        "issues": [],
    }
    if not action_coverage["complete"]:
        action_coverage["issues"].append(
            {
                "artifact": str(action_trace),
                "reason": ("Action trace export failed" if action_export_failed else "Action trace is missing"),
            }
        )

    def malformed(step, call, category, reason):
        action_coverage["complete"] = False
        action_coverage[category] += 1
        if category == "malformed_result_entries":
            action_coverage["final_answer_count_complete"] = False
        action_coverage["issues"].append(
            {
                "step_id": step.get("id", step.get("stepId")),
                "tool_call_id": (call.get("toolCallId") if isinstance(call, dict) else None),
                "reason": reason,
            }
        )

    if system == "native":
        accounting = read_json(directory / "model-accounting.json", {})
        steps = read_json(directory / "react_steps.json", [])
        if isinstance(steps, dict):
            steps = steps.get("steps", [])
        model_steps = [step for step in steps if step.get("role") == "agent" and "inputMessages" in step]
        errors_without_request = [
            step
            for step in steps
            if step.get("role") == "agent"
            and "inputMessages" not in step
            and str(step.get("content", "")).startswith("Error:")
        ]
        succeeded = sum(isinstance(step.get("usage"), dict) for step in model_steps)
        attempted = len(model_steps) + len(errors_without_request)
        failed = attempted - succeeded
        usage_missing = failed + sum(
            not isinstance(step.get("usage"), dict) for step in model_steps if step.get("usage") is not None
        )
        for step in steps:
            for call in step.get("toolCalls", []):
                action_coverage["tool_calls"] += 1
                call_input = call.get("input") if isinstance(call, dict) else None
                if not isinstance(call_input, dict):
                    malformed(
                        step,
                        call,
                        "malformed_tool_calls",
                        f"input is {type(call_input).__name__}, expected object",
                    )
                    continue
                call_actions = call_input.get("actions", [])
                if not isinstance(call_actions, list):
                    malformed(step, call, "malformed_tool_calls", "actions is not an array")
                    continue
                for action in call_actions:
                    if not isinstance(action, dict) or not isinstance(action.get("type"), str):
                        malformed(
                            step,
                            call,
                            "malformed_action_entries",
                            "action is not an object with a string type",
                        )
                        continue
                    actions[action["type"]] += 1
            for result in step.get("toolResults", []):
                output = result.get("output", {}) if isinstance(result, dict) else None
                if isinstance(output, dict):
                    result_actions = output.get("actions", [])
                    if not isinstance(result_actions, list):
                        malformed(
                            step,
                            result,
                            "malformed_result_entries",
                            "result actions is not an array",
                        )
                        continue
                    for action in result_actions:
                        if not isinstance(action, dict) or not isinstance(action.get("action", {}), dict):
                            malformed(
                                step,
                                result,
                                "malformed_result_entries",
                                "result action is not an object",
                            )
                            continue
                        action_errors += action.get("status") == "error"
                        final_answers += (
                            action.get("status") == "ok" and action.get("action", {}).get("type") == "answer"
                        )
        config = read_json(directory / "config.json", {})
        info = read_json(directory / "system-info.json", {})
        schema = next(
            (
                tool.get("inputSchema")
                for tool in info.get("tools", [])
                if isinstance(tool, dict) and tool.get("name") == "dataflow"
            ),
            None,
        )
        action_details = native_action_details(
            steps,
            actions,
            action_coverage,
            native_format=config.get("native_format"),
            schema=schema,
        )
        action_coverage["complete"] = action_details["complete"]
        action_coverage["final_answer_count_complete"] = action_details["final_answer_count_complete"]
        trace_missing = not (directory / "react_steps.json").is_file() or bool(stats.get("usage_incomplete"))
        if accounting and all(
            name in accounting for name in ("attemptedRequests", "succeededRequests", "failedRequests")
        ):
            attempted = accounting["attemptedRequests"]
            succeeded = accounting["succeededRequests"]
            failed = accounting["failedRequests"]
            usage_missing = max(
                len(accounting.get("unknownUsageRequestIds", [])),
                accounting.get("pendingRequests", 0),
            )
            trace_missing = accounting.get("usageStatus") != "complete"
    else:
        events = read_events(directory / "model-request-trace.jsonl")
        requests = {event["call"] for event in events if event.get("phase") == "request"}
        responses = {event["call"]: event for event in events if event.get("phase") == "response"}
        succeeded, attempted = len(responses), len(requests | set(responses))
        failed = attempted - succeeded
        usage_missing = failed + sum(not isinstance(event.get("usage"), dict) for event in responses.values())
        executions = read_events(directory / "executions.jsonl")
        actions["python_execute"] = len(executions)
        action_errors = sum(bool(event.get("error")) for event in executions)
        final_answers = sum(event.get("is_final_answer") is True for event in executions)
        final_flags_complete = all(type(event.get("is_final_answer")) is bool for event in executions)
        if action_trace_present and final_flags_complete:
            final_answers = sum(event["is_final_answer"] for event in executions)
        elif action_trace_present:
            action_coverage["complete"] = False
            action_coverage["final_answer_count_complete"] = False
            action_coverage["issues"].append(
                {
                    "artifact": str(action_trace),
                    "reason": "Execution records omit an explicit final-answer flag",
                }
            )
        trace_missing = not (directory / "model-request-trace.jsonl").is_file() or bool(stats.get("usage_incomplete"))
    observed_final_answers = final_answers
    if not action_coverage["final_answer_count_complete"]:
        final_answers = None
    usage_complete = not trace_missing and usage_missing == 0
    known_cost = stats.get("successful_call_cost_usd", stats.get("cost_usd"))
    complete_cost = usage_complete and known_cost is not None
    if common:
        known_cost = common["cost"]["observed_cost_usd"]
        complete_cost = common["cost"]["cost_usd"] is not None
        usage_complete = common.get("usage_complete", False)
        attempted, succeeded, failed = (common["model_calls"][name] for name in ("attempted", "succeeded", "failed"))
        usage_missing = attempted - min(
            (
                entry["known_calls"]
                for name, entry in common["usage_coverage"].items()
                if name
                in {
                    "input_tokens",
                    "output_tokens",
                    "cached_input_tokens",
                    "cache_creation_tokens",
                }
            ),
            default=0,
        )
    resources = resources or {}
    native_scope = read_json(directory / "config.json", {}).get("resource_scope", {})
    native_owned = bool(
        native_scope.get("ownership_verified")
        and (native_scope.get("owned_service_pids") or native_scope.get("cgroup", {}).get("ownership_verified"))
    )
    measurement = resources.get("measurement", {})
    cpu_complete = bool(measurement.get("cpu", {}).get("complete"))
    memory_complete = bool(measurement.get("memory", {}).get("complete"))
    scope_complete = bool(resources.get("scope", {}).get("complete")) and (system != "native" or native_owned)
    resource_complete = scope_complete and cpu_complete and memory_complete
    reason = None
    if not resources:
        reason = "Resource collector unavailable; historical runs cannot be reconstructed."
    elif system == "native" and not native_owned:
        reason = (
            "Native service/engine workers are external to the runner tree; verified owned service scope is missing."
        )
    elif not resource_complete:
        reason = "Inspect scope and measurement metadata; sampled CPU/memory or incomplete scope cannot establish exact total resource usage."
    if system == "native" and read_json(directory / "status.json", {}).get("harness_timeout"):
        resource_complete = False
        reason = "Native watchdog stop/cleanup occurs outside the supervised measurement window; full lifecycle coverage is incomplete. Raw supervised-window counters retain their original exactness."
    token_names = (
        "input_tokens",
        "output_tokens",
        "cached_tokens",
        "cache_creation_tokens",
        "reasoning_tokens",
        "uncached_input_tokens",
        "total_tokens",
    )
    tokens = {
        name: (
            common["usage"].get("cached_input_tokens" if name == "cached_tokens" else name)
            if common
            else stats.get(name)
        )
        for name in token_names
    }
    observed = {
        name: (
            common["observed_usage"].get("cached_input_tokens" if name == "cached_tokens" else name)
            if common
            else stats.get(name)
        )
        for name in token_names
    }
    authoritative_missing = (
        system == "native"
        and (
            "expected_service_source_hashes" in read_json(directory / "config.json", {})
            or read_json(directory / "config.json", {}).get("require_model_accounting")
        )
        and not common
    )
    if authoritative_missing:
        usage_complete, complete_cost = False, False
        attempted, succeeded, failed, usage_missing = None, None, None, None
        observed = {name: stats.get("legacy_observed_totals", {}).get(name, value) for name, value in observed.items()}
        tokens = {name: None for name in token_names}
    if not common:
        for values in (tokens, observed):
            if all(values[name] is not None for name in ("input_tokens", "cached_tokens", "cache_creation_tokens")):
                values["uncached_input_tokens"] = (
                    values["input_tokens"] - values["cached_tokens"] - values["cache_creation_tokens"]
                )
            if values["input_tokens"] is not None and values["output_tokens"] is not None:
                values["total_tokens"] = values["input_tokens"] + values["output_tokens"]
    common_clocks = common.get("clocks", {}) if common else {}
    measured_interval = common_clocks.get("measured_interval")
    wall = {
        "task_seconds": task_wall_seconds,
        "boundary": common_clocks.get("boundary")
        or (measured_interval or {}).get("boundary")
        or "supervised child launch through child exit, including setup, artifact capture and cleanup; grading excluded",
        "phases": lifecycle,
    }
    if measured_interval is not None:
        wall["measured_interval"] = measured_interval
    return {
        "schema_version": 1,
        "benchmark": benchmark,
        "system": system,
        "wall": wall,
        "requests": {
            "attempted": attempted,
            "succeeded": succeeded,
            "failed": failed,
            "usage_missing": usage_missing,
        },
        "usage_complete": usage_complete,
        "request_accounting_source": (
            "unknown_required_transport_ledger"
            if authoritative_missing
            else "transport_ledger" if common else "historical_trace_inference"
        ),
        "normalization_issues": (common.get("normalization_issues", []) if common else []),
        "provider_reported_cost": (common.get("provider_reported_cost") if common else None),
        "tokens": tokens,
        "observed_tokens": observed,
        "token_breakdown_complete": usage_complete and all(value is not None for value in tokens.values()),
        "cost": {
            "known_usd": known_cost,
            "total_usd": known_cost if complete_cost else None,
            "complete": complete_cost,
            "scope": "API tokens only; reasoning included in output, cached tokens included in input",
        },
        "actions": {
            "total": sum(actions.values()),
            "by_type": dict(actions),
            "errors": action_errors,
            "final_answers": final_answers,
            "observed_final_answers": observed_final_answers,
            **action_coverage,
            **action_details,
        },
        "resources": resources,
        "resource_completeness": {
            "complete": resource_complete,
            "reason": reason,
            "scope_complete": scope_complete,
            "cpu_complete": cpu_complete,
            "memory_complete": memory_complete,
            "memory_note": (
                "Exact kernel peak charged memory includes page cache; sampled RSS remains separate."
                if memory_complete
                else "Sampled simultaneous memory is approximate; inspect collector measurement metadata."
            ),
        },
    }
