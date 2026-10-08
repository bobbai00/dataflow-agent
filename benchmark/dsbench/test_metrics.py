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
"""Counters and unknown costs have the same meaning for both executors."""

import json

from benchmark.dsbench.metrics import normalize_attempt


def write(path, data):
    path.write_text(json.dumps(data))


def test_native_cardinality_rejections_are_separate_from_nested_action_errors(tmp_path):
    rejection = "Use one dataflow call per turn, with all actions in its ordered actions list. No actions were run."
    inspect = {"type": "inspect", "target": "graph"}
    scan = {"type": "scan", "files": "original.xlsx", "preview": 20}
    answer = {"type": "answer", "content": "Cannot verify"}
    steps = [
        {
            "id": "literal-cardinality-round",
            "role": "agent",
            "toolCalls": [
                {"toolName": "dataflow", "toolCallId": "invalid", "input": {"actions": [inspect, scan]}},
                {"toolName": "dataflow", "toolCallId": "inspect", "input": {"actions": [inspect]}},
            ],
            "toolResults": [
                {
                    "toolCallId": "invalid",
                    "isError": True,
                    "output": {"kind": "dataflow-actions", "status": "error", "actions": [], "error": rejection},
                },
                {
                    "toolCallId": "inspect",
                    "isError": True,
                    "output": {
                        "kind": "dataflow-actions",
                        "status": "error",
                        "actions": [{"index": 1, "action": inspect, "status": "skipped", "output": rejection}],
                        "error": rejection,
                    },
                },
            ],
        },
        {
            "id": "literal-answer-round",
            "role": "agent",
            "toolCalls": [{"toolName": "dataflow", "toolCallId": "answer", "input": {"actions": [answer]}}],
            "toolResults": [
                {
                    "toolCallId": "answer",
                    "isError": False,
                    "output": {
                        "kind": "dataflow-actions",
                        "status": "completed",
                        "actions": [{"index": 1, "action": answer, "status": "ok"}],
                    },
                }
            ],
        },
    ]
    write(tmp_path / "react_steps.json", steps)
    metrics = normalize_attempt(tmp_path, system="native", task_wall_seconds=1)
    actions = metrics["actions"]
    assert actions["total"] == actions["requested"]["total"] == 4
    assert actions["errors"] == 0  # Nested action errors retain their original unit.
    assert actions["tool_errors"] == actions["tool_rejections"] == 2
    assert actions["tool_rejection_categories"] == {"native_cardinality": 2}
    assert actions["invalid_action_types"] == {"scan": 1}
    assert actions["invalid_action_type_total"] == 1
    assert actions["requested"]["complete"] is True
    assert actions["outcomes"] == {
        "completed": 1,
        "failed": 0,
        "skipped": 1,
        "rejected": 2,
        "unknown": 0,
        "complete": True,
    }
    assert actions["complete"] is False  # Invalid requested types are never called valid/executed actions.
    assert json.loads((tmp_path / "react_steps.json").read_text()) == steps


def test_native_execution_error_is_not_double_counted_as_tool_rejection(tmp_path):
    requested = [{"type": "execute"}, {"type": "retrieve"}]
    write(
        tmp_path / "react_steps.json",
        [
            {
                "role": "agent",
                "toolCalls": [{"toolCallId": "execute", "input": {"actions": requested}}],
                "toolResults": [
                    {
                        "toolCallId": "execute",
                        "isError": True,
                        "output": {
                            "kind": "dataflow-actions",
                            "status": "error",
                            "error": "Execution failed",
                            "actions": [
                                {"index": 1, "action": requested[0], "status": "error"},
                                {"index": 2, "action": requested[1], "status": "skipped"},
                            ],
                        },
                    }
                ],
            }
        ],
    )
    actions = normalize_attempt(tmp_path, system="native", task_wall_seconds=1)["actions"]
    assert actions["errors"] == 1
    assert actions["tool_errors"] == 1
    assert actions["tool_rejections"] == 0
    assert actions["outcomes"] == {
        "completed": 0,
        "failed": 1,
        "skipped": 1,
        "rejected": 0,
        "unknown": 0,
        "complete": True,
    }
    assert actions["complete"] is True


def test_native_missing_result_keeps_unknown_action_disposition(tmp_path):
    write(
        tmp_path / "react_steps.json",
        [{"role": "agent", "toolCalls": [{"toolCallId": "missing", "input": {"actions": [{"type": "edit"}]}}]}],
    )
    actions = normalize_attempt(tmp_path, system="native", task_wall_seconds=1)["actions"]
    assert actions["requested"]["total"] == 1
    assert actions["requested"]["complete"] is True
    assert actions["outcomes"]["unknown"] == 1
    assert actions["outcomes"]["complete"] is False
    assert actions["tool_error_coverage"]["complete"] is False
    assert actions["tool_error_coverage"]["missing_results"] == 1
    assert actions["complete"] is False
    assert actions["final_answers"] is None


def test_native_schema_rejection_and_opaque_tool_error_have_separate_coverage(tmp_path):
    write(
        tmp_path / "react_steps.json",
        [
            {
                "role": "agent",
                "toolCalls": [{"toolCallId": "invalid", "input": {"actions": [{"type": "scan"}]}}],
                "toolResults": [
                    {
                        "toolCallId": "invalid",
                        "isError": True,
                        "output": "Invalid input for tool dataflow: Type validation failed",
                    }
                ],
            }
        ],
    )
    actions = normalize_attempt(tmp_path, system="native", task_wall_seconds=1)["actions"]
    assert actions["tool_rejections"] == 1
    assert actions["tool_rejection_categories"] == {"schema_validation": 1}
    assert actions["outcomes"]["rejected"] == 1
    assert actions["outcomes"]["complete"] is True
    write(
        tmp_path / "react_steps.json",
        [
            {
                "role": "agent",
                "toolCalls": [{"toolCallId": "opaque", "input": {"actions": [{"type": "execute"}]}}],
                "toolResults": [{"toolCallId": "opaque", "isError": True, "output": "Unknown tool execution failure"}],
            }
        ],
    )
    actions = normalize_attempt(tmp_path, system="native", task_wall_seconds=1)["actions"]
    assert actions["tool_errors"] == 1
    assert actions["tool_rejections"] == 0
    assert actions["tool_rejection_count_complete"] is False
    assert actions["outcomes"]["unknown"] == 1
    assert actions["outcomes"]["complete"] is False


def test_native_duplicate_ids_cannot_claim_complete_or_double_count_tool_errors(tmp_path):
    error = {"toolCallId": "duplicate", "isError": True, "output": "Invalid input for tool dataflow: malformed"}
    write(
        tmp_path / "react_steps.json",
        [
            {
                "role": "agent",
                "toolCalls": [{"toolCallId": "duplicate", "input": {"actions": [{"type": "edit"}]}}],
                "toolResults": [error, error],
            }
        ],
    )
    actions = normalize_attempt(tmp_path, system="native", task_wall_seconds=1)["actions"]
    assert actions["tool_results"] == 2
    assert actions["tool_errors"] == actions["tool_rejections"] == 1
    assert actions["tool_error_coverage"]["duplicate_result_ids"] == 1
    assert actions["tool_error_coverage"]["complete"] is False
    assert actions["complete"] is False


def test_native_literal_preparation_errors_are_known_pre_execution_rejections(tmp_path):
    for error, category in [
        ("Invalid dataflow arguments: actions must be a JSON array. No actions ran.", "schema_validation"),
        ('Action 1: unknown action type "scan". Use inspect, edit, execute, retrieve, or answer.', "schema_validation"),
        ("Retrieve view sample_stats is unavailable. Use full, sample. No actions ran.", "pre_execution"),
    ]:
        write(
            tmp_path / "react_steps.json",
            [
                {
                    "role": "agent",
                    "toolCalls": [{"toolCallId": "rejected", "input": {"actions": [{"type": "retrieve"}]}}],
                    "toolResults": [
                        {
                            "toolCallId": "rejected",
                            "isError": True,
                            "output": {"kind": "dataflow-actions", "status": "error", "actions": [], "error": error},
                        }
                    ],
                }
            ],
        )
        actions = normalize_attempt(tmp_path, system="native", task_wall_seconds=1)["actions"]
        assert actions["tool_rejections"] == 1
        assert actions["tool_rejection_categories"] == {category: 1}
        assert actions["outcomes"]["rejected"] == 1
        assert actions["tool_rejection_count_complete"] is True


def test_native_missing_ids_retain_observed_single_pair_but_flag_incomplete_coverage(tmp_path):
    action = {"type": "inspect"}
    write(
        tmp_path / "react_steps.json",
        [
            {
                "role": "agent",
                "toolCalls": [{"input": {"actions": [action]}}],
                "toolResults": [
                    {
                        "isError": False,
                        "output": {"status": "completed", "actions": [{"action": action, "status": "ok"}]},
                    }
                ],
            }
        ],
    )
    actions = normalize_attempt(tmp_path, system="native", task_wall_seconds=1)["actions"]
    assert actions["outcomes"]["completed"] == 1
    assert actions["outcomes"]["complete"] is False
    assert actions["tool_error_coverage"]["missing_call_ids"] == 1
    assert actions["tool_error_coverage"]["missing_result_ids"] == 1
    assert actions["complete"] is False


def test_native_reused_call_id_in_distinct_steps_is_an_unambiguous_pair(tmp_path):
    action = {"type": "inspect"}
    write(
        tmp_path / "react_steps.json",
        [
            {
                "id": f"step-{index}",
                "role": "agent",
                "toolCalls": [{"toolCallId": "reused", "input": {"actions": [action]}}],
                "toolResults": [
                    {
                        "toolCallId": "reused",
                        "isError": False,
                        "output": {"status": "completed", "actions": [{"index": 1, "action": action, "status": "ok"}]},
                    }
                ],
            }
            for index in range(2)
        ],
    )
    actions = normalize_attempt(tmp_path, system="native", task_wall_seconds=1)["actions"]
    assert actions["outcomes"]["completed"] == 2
    assert actions["tool_error_coverage"]["duplicate_call_ids"] == 0
    assert actions["tool_error_coverage"]["duplicate_result_ids"] == 0
    assert actions["tool_error_coverage"]["global_call_id_reuse"] == 1
    assert actions["complete"] is True


def test_native_preserves_failed_request_and_distinguishes_actions(tmp_path):
    write(tmp_path / "stats.json", {"cost_usd": 0.01, "input_tokens": 100, "output_tokens": 10})
    write(tmp_path / "status.json", {"completed": False})
    write(
        tmp_path / "react_steps.json",
        [
            {
                "role": "agent",
                "inputMessages": [],
                "usage": {"inputTokens": 100, "outputTokens": 10},
                "toolCalls": [{"input": {"actions": [{"type": "edit"}, {"type": "execute"}]}}],
            },
            {"role": "agent", "content": "Error: provider unavailable"},
        ],
    )
    metrics = normalize_attempt(tmp_path, system="native", task_wall_seconds=2.5)
    assert metrics["requests"] == {"attempted": 2, "succeeded": 1, "failed": 1, "usage_missing": 1}
    assert metrics["cost"]["known_usd"] == 0.01
    assert metrics["cost"]["complete"] is False
    assert metrics["cost"]["total_usd"] is None
    assert metrics["actions"]["by_type"] == {"edit": 1, "execute": 1}
    assert metrics["wall"]["task_seconds"] == 2.5


def test_native_malformed_tool_input_is_preserved_as_partial_action_coverage(tmp_path):
    malformed = '{"reasoning">Scan: "Scan the CSV", "actions": []}'
    steps = [
        {
            "id": "malformed-step",
            "role": "agent",
            "inputMessages": [],
            "usage": {"inputTokens": 100, "outputTokens": 10},
            "toolCalls": [{"toolName": "dataflow", "toolCallId": "bad-call", "input": malformed}],
        },
        {
            "role": "agent",
            "inputMessages": [],
            "usage": {"inputTokens": 10, "outputTokens": 5},
            "toolCalls": [{"toolName": "dataflow", "input": {"actions": [{"type": "answer"}]}}],
        },
    ]
    write(tmp_path / "stats.json", {"cost_usd": 0.01})
    write(tmp_path / "react_steps.json", steps)
    metrics = normalize_attempt(tmp_path, system="native", task_wall_seconds=2)
    assert metrics["requests"] == {"attempted": 2, "succeeded": 2, "failed": 0, "usage_missing": 0}
    assert metrics["actions"]["by_type"] == {"answer": 1}
    assert metrics["actions"]["tool_calls"] == 2
    assert metrics["actions"]["malformed_tool_calls"] == 1
    assert metrics["actions"]["complete"] is False
    assert metrics["actions"]["issues"] == [
        {"step_id": "malformed-step", "tool_call_id": "bad-call", "reason": "input is str, expected object"}
    ]
    assert json.loads((tmp_path / "react_steps.json").read_text()) == steps


def test_native_malformed_actions_and_results_do_not_crash_metrics(tmp_path):
    write(
        tmp_path / "react_steps.json",
        [
            {
                "role": "agent",
                "toolCalls": [
                    {"input": None},
                    {"input": {"actions": "not an action array"}},
                    {"input": {"actions": ["bad action", {"type": ["edit"]}, {"type": "inspect"}]}},
                ],
                "toolResults": [
                    {"output": {"actions": ["bad result", {"status": "ok", "action": "not an object"}]}},
                ],
            }
        ],
    )
    metrics = normalize_attempt(tmp_path, system="native", task_wall_seconds=1)
    assert metrics["actions"]["by_type"] == {"inspect": 1}
    assert metrics["actions"]["malformed_tool_calls"] == 2
    assert metrics["actions"]["malformed_action_entries"] == 2
    assert metrics["actions"]["malformed_result_entries"] == 2
    assert metrics["actions"]["complete"] is False


def test_smol_counts_requests_not_task_memory_steps(tmp_path):
    write(tmp_path / "stats.json", {"cost_usd": 0.0, "num_steps": 3, "input_tokens": 0, "output_tokens": 0})
    write(tmp_path / "status.json", {"completed": True})
    (tmp_path / "model-request-trace.jsonl").write_text(
        "\n".join(
            json.dumps(event)
            for event in [
                {"phase": "request", "call": 1},
                {"phase": "response", "call": 1, "usage": {"prompt_tokens": 0, "completion_tokens": 0}},
                {"phase": "request", "call": 2},
                {"phase": "response", "call": 2, "usage": {"prompt_tokens": 0, "completion_tokens": 0}},
            ]
        )
    )
    (tmp_path / "executions.jsonl").write_text(json.dumps({"error": None, "is_final_answer": True}) + "\n")
    metrics = normalize_attempt(tmp_path, system="smolagents", task_wall_seconds=1)
    assert metrics["requests"] == {"attempted": 2, "succeeded": 2, "failed": 0, "usage_missing": 0}
    assert metrics["cost"]["total_usd"] == 0.0
    assert metrics["actions"]["by_type"] == {"python_execute": 1}


def test_native_without_owned_service_scope_is_incomplete(tmp_path):
    write(tmp_path / "stats.json", {"cost_usd": 0.0})
    write(tmp_path / "status.json", {"completed": False})
    write(tmp_path / "react_steps.json", [])
    metrics = normalize_attempt(
        tmp_path, system="native", task_wall_seconds=1, resources={"scope": {"kind": "process_tree"}}
    )
    assert metrics["resource_completeness"]["complete"] is False
    assert "native" in metrics["resource_completeness"]["reason"].lower()


def test_missing_native_action_trace_does_not_claim_complete_zero(tmp_path):
    write(tmp_path / "stats.json", {"cost_usd": 0.01})
    write(
        tmp_path / "model-accounting.json",
        {"attemptedRequests": 1, "succeededRequests": 1, "failedRequests": 0, "usageStatus": "complete"},
    )
    metrics = normalize_attempt(tmp_path, system="native", task_wall_seconds=1)
    assert metrics["requests"]["attempted"] == 1
    assert metrics["usage_complete"] is True
    assert metrics["actions"]["total"] == 0
    assert metrics["actions"]["complete"] is False
    assert metrics["actions"]["trace_status"] == "missing"
    assert metrics["actions"]["final_answers"] is None


def test_missing_script_execution_trace_is_independent_of_complete_model_usage(tmp_path):
    write(tmp_path / "stats.json", {"cost_usd": 0.01})
    (tmp_path / "model-request-trace.jsonl").write_text(
        json.dumps({"phase": "request", "call": 1})
        + "\n"
        + json.dumps({"phase": "response", "call": 1, "usage": {"prompt_tokens": 10, "completion_tokens": 1}})
        + "\n"
    )
    metrics = normalize_attempt(tmp_path, system="smolagents", task_wall_seconds=1)
    assert metrics["usage_complete"] is True
    assert metrics["actions"]["complete"] is False
    assert metrics["actions"]["trace_status"] == "missing"
    assert metrics["actions"]["final_answers"] is None


def test_missing_legacy_execution_final_answer_flag_is_unknown_not_zero(tmp_path):
    (tmp_path / "executions.jsonl").write_text(json.dumps({"error": None}) + "\n")
    metrics = normalize_attempt(tmp_path, system="smolagents", task_wall_seconds=1)
    assert metrics["actions"]["total"] == 1
    assert metrics["actions"]["final_answers"] is None
    assert metrics["actions"]["complete"] is False
    assert metrics["actions"]["final_answer_count_complete"] is False


def test_explicit_provider_preflight_block_has_known_zero_actions_without_execution_trace(tmp_path):
    write(tmp_path / "status.json", {"state": "preflight_blocked", "inference_requests_attempted": 0})
    metrics = normalize_attempt(tmp_path, system="smolagents", task_wall_seconds=0)
    assert metrics["actions"]["complete"] is True
    assert metrics["actions"]["total"] == 0
    assert metrics["actions"]["final_answers"] == 0
    assert metrics["actions"]["trace_status"] == "not_launched"


def test_authoritative_ledger_keeps_hidden_retry_and_unknown_failed_tokens(tmp_path):
    from benchmark.dsbench.accounting import capture_model_accounting

    write(tmp_path / "stats.json", {"cost_usd": 0.01, "input_tokens": 100, "output_tokens": 10})
    write(tmp_path / "react_steps.json", [])
    write(tmp_path / "config.json", {"model": "exact", "task_id": "task"})
    write(
        tmp_path / "model-accounting.json",
        {
            "version": 1,
            "source": "transport",
            "attemptedRequests": 2,
            "succeededRequests": 1,
            "failedRequests": 1,
            "pendingRequests": 0,
            "usageStatus": "partial",
            "unknownUsageRequestIds": ["retry"],
            "requests": [
                {"requestId": "retry", "requestedModel": "exact", "status": "http_error", "usage": None},
                {
                    "requestId": "ok",
                    "requestedModel": "exact",
                    "status": "succeeded",
                    "usage": {
                        "inputTokens": 100,
                        "outputTokens": 10,
                        "cachedInputTokens": 0,
                        "cacheCreationInputTokens": 0,
                        "reasoningTokens": 0,
                    },
                },
            ],
        },
    )
    common = capture_model_accounting(tmp_path, system="native", benchmark="dsbench", resources={})
    assert common["model_calls"] == {"attempted": 2, "succeeded": 1, "failed": 1}
    assert common["usage"]["input_tokens"] is None
    assert common["observed_usage"]["input_tokens"] == 100
    metrics = normalize_attempt(tmp_path, system="native", task_wall_seconds=2)
    assert metrics["requests"]["attempted"] == 2
    assert metrics["tokens"]["input_tokens"] is None
    assert metrics["observed_tokens"]["input_tokens"] == 100


def test_common_smol_pricing_is_per_request_for_tiers_and_unknown_rate(tmp_path):
    from benchmark.dsbench.accounting import capture_model_accounting

    write(
        tmp_path / "config.json",
        {
            "model": "exact",
            "task_id": "task",
            "pricing": {
                "model": "exact",
                "rates": {"input": 1, "output": 2, "cache_read": None, "cache_creation": None},
                "tiers": [{"min_input_tokens": 200, "input_multiplier": 2}],
            },
        },
    )
    events = [{"phase": "request", "call": n} for n in [1, 2]] + [
        {
            "phase": "response",
            "call": 1,
            "usage": {"prompt_tokens": 150, "completion_tokens": 10, "prompt_tokens_details": {"cached_tokens": 0}},
        },
        {
            "phase": "response",
            "call": 2,
            "usage": {"prompt_tokens": 150, "completion_tokens": 10, "prompt_tokens_details": {"cached_tokens": 1}},
        },
    ]
    (tmp_path / "model-request-trace.jsonl").write_text("".join(json.dumps(event) + "\n" for event in events))
    common = capture_model_accounting(tmp_path, system="smolagents", benchmark="dsbench", resources={})
    assert common["cost"]["cost_usd"] is None
    assert common["cost"]["observed_cost_usd"] == 170
    assert common["cost"]["known_calls"] == 1


def test_script_sdk_retry_is_two_transport_attempts_with_unknown_first_billing(tmp_path):
    from benchmark.dsbench.accounting import capture_model_accounting

    write(tmp_path / "config.json", {"model": "exact", "task_id": "task"})
    events = [
        {"phase": "request", "call": 1},
        {"phase": "transport_request", "call": 1},
        {"phase": "transport_headers", "call": 1, "status": 429},
        {"phase": "transport_request", "call": 1},
        {"phase": "transport_headers", "call": 1, "status": 200},
        {
            "phase": "response",
            "call": 1,
            "usage": {"prompt_tokens": 100, "completion_tokens": 10, "prompt_tokens_details": {"cached_tokens": 0}},
        },
    ]
    (tmp_path / "model-request-trace.jsonl").write_text("".join(json.dumps(event) + "\n" for event in events))
    common = capture_model_accounting(tmp_path, system="smolagents", benchmark="kramabench", resources={})
    assert common["model_calls"] == {"attempted": 2, "succeeded": 1, "failed": 1}
    assert common["usage"]["input_tokens"] is None
    assert common["observed_usage"]["input_tokens"] == 100
    metrics = normalize_attempt(tmp_path, system="smolagents", task_wall_seconds=1)
    assert metrics["requests"]["attempted"] == 2


def test_required_new_native_ledger_cannot_fall_back_to_clean_trace(tmp_path):
    write(tmp_path / "config.json", {"expected_service_source_hashes": {"src/server.ts": "frozen"}})
    write(tmp_path / "stats.json", {"input_tokens": 100, "output_tokens": 10, "cost_usd": 0.01})
    write(
        tmp_path / "react_steps.json",
        [{"role": "agent", "inputMessages": [], "usage": {"inputTokens": 100, "outputTokens": 10}}],
    )
    metrics = normalize_attempt(tmp_path, system="native", task_wall_seconds=1)
    assert metrics["usage_complete"] is False
    assert metrics["requests"]["attempted"] is None
    assert metrics["tokens"]["input_tokens"] is None
    assert metrics["observed_tokens"]["input_tokens"] == 100
    assert metrics["cost"]["total_usd"] is None


def test_native_outer_timeout_cannot_claim_complete_watchdog_lifecycle(tmp_path):
    write(
        tmp_path / "config.json",
        {"resource_scope": {"ownership_verified": True, "owned_service_pids": {"agent-service": 1}}},
    )
    write(tmp_path / "status.json", {"completed": False, "harness_timeout": True})
    resources = {
        "scope": {"complete": True},
        "measurement": {"cpu": {"complete": True, "exact": True}, "memory": {"complete": True, "exact": True}},
        "cpu_total_seconds": 3,
        "peak_memory_bytes": 1000,
    }
    metric = normalize_attempt(tmp_path, system="native", task_wall_seconds=10, resources=resources)
    assert metric["resource_completeness"]["complete"] is False
    assert "watchdog" in metric["resource_completeness"]["reason"]
    assert metric["resources"]["cpu_total_seconds"] == 3
    assert metric["resources"]["measurement"]["cpu"]["exact"] is True


def test_failed_native_trace_export_retains_observed_actions_but_marks_coverage_unknown(tmp_path):
    write(tmp_path / "trace-fetch-error.json", {"error": "Trace endpoint failed"})
    write(
        tmp_path / "react_steps.json",
        [
            {
                "role": "agent",
                "toolCalls": [{"input": {"actions": [{"type": "answer"}]}}],
                "toolResults": [{"output": {"actions": [{"status": "ok", "action": {"type": "answer"}}]}}],
            }
        ],
    )
    metrics = normalize_attempt(tmp_path, system="native", task_wall_seconds=1)
    assert metrics["actions"]["total"] == 1
    assert metrics["actions"]["complete"] is False
    assert metrics["actions"]["trace_status"] == "export_failed"
    assert metrics["actions"]["final_answers"] is None
    assert metrics["actions"]["observed_final_answers"] == 1


def test_normalized_wall_uses_preserved_measured_boundary_and_utc(tmp_path):
    from benchmark.dsbench.accounting import capture_model_accounting

    write(tmp_path / "config.json", {"model": "exact", "task_id": "task"})
    interval = {
        "started_at": "2026-10-08T12:00:00+00:00",
        "finished_at": "2026-10-08T12:00:02+00:00",
        "boundary": "supervisor starts before resource setup through process exit",
        "source": "supervision.json.wall_seconds",
        "utc_status": "observed",
    }
    write(tmp_path / "supervision.json", {"wall_seconds": 2, "wall_interval": interval})
    (tmp_path / "model-request-trace.jsonl").write_text("")
    capture_model_accounting(tmp_path, system="smolagents", benchmark="dsbench", resources={})
    metrics = normalize_attempt(tmp_path, system="smolagents", task_wall_seconds=2)
    assert metrics["wall"]["task_seconds"] == 2
    assert metrics["wall"]["boundary"] == interval["boundary"]
    assert metrics["wall"]["measured_interval"]["started_at"] == interval["started_at"]


def test_partial_execution_final_flags_preserve_only_observed_final_answers(tmp_path):
    (tmp_path / "executions.jsonl").write_text(
        json.dumps({"is_final_answer": True}) + "\n" + json.dumps({"error": None}) + "\n"
    )
    metrics = normalize_attempt(tmp_path, system="smolagents", task_wall_seconds=1)
    assert metrics["actions"]["final_answers"] is None
    assert metrics["actions"]["observed_final_answers"] == 1
    assert metrics["actions"]["complete"] is False


def test_malformed_native_result_preserves_observed_final_count_without_claiming_complete(tmp_path):
    write(
        tmp_path / "react_steps.json",
        [
            {
                "role": "agent",
                "toolResults": [{"output": {"actions": ["malformed", {"status": "ok", "action": {"type": "answer"}}]}}],
            }
        ],
    )
    metrics = normalize_attempt(tmp_path, system="native", task_wall_seconds=1)
    assert metrics["actions"]["final_answers"] is None
    assert metrics["actions"]["observed_final_answers"] == 1
    assert metrics["actions"]["final_answer_count_complete"] is False
