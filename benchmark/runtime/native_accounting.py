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
"""Adapt the agent's durable request ledger to the common metrics schema."""

from copy import deepcopy
from contextlib import contextmanager, ExitStack
from dataclasses import dataclass
import os
import json
from hashlib import sha256
from pathlib import Path
from collections.abc import Mapping

from .metrics import AttemptMetrics, PricingSchedule, TOKEN_FIELDS, normalize_usage
from .resources import ProcessResourceCollector
from .components import ComponentResourceCollector


def record_native_requests(metrics: AttemptMetrics, accounting, *, pricing=None):
    """Record each transport request once, preserving unknown failed billing.

    The service already normalizes provider-specific wire totals into inclusive
    input/output counts. Normalize those canonical counts as AI SDK usage here;
    never interpret a LiteLLM chat response as native Anthropic usage. Pricing
    binds the recorded requested route; the provider-returned model is retained
    separately in the original transport record for audit.
    """
    if (
        not isinstance(accounting, Mapping)
        or accounting.get("version") != 1
        or accounting.get("source") != "transport"
    ):
        raise ValueError("Authoritative version-1 transport accounting is required")
    requests = accounting.get("requests")
    if not isinstance(requests, list):
        raise ValueError("Transport accounting requests must be a list")
    ids = [
        record.get("requestId") if isinstance(record, Mapping) else None
        for record in requests
    ]
    if any(
        not isinstance(identifier, str) or not identifier for identifier in ids
    ) or len(set(ids)) != len(ids):
        raise ValueError("Transport accounting requires unique stable request IDs")
    price = PricingSchedule.from_dict(pricing) if pricing is not None else None
    for record in requests:
        known = record.get("usage")
        # Missing raw usage on a failed/pending request remains unknown. The
        # normalized six classes are authoritative when raw usage was available.
        raw_usage = record.get("rawUsage")
        if isinstance(known, Mapping):
            canonical = deepcopy(dict(known))
            if isinstance(raw_usage, Mapping):
                for name in ("cost", "cost_details"):
                    if name in raw_usage:
                        canonical[name] = deepcopy(raw_usage[name])
                if any(
                    known.get(field) is None
                    for field in ("cachedInputTokens", "cacheCreationInputTokens")
                ):
                    # Unknown canonical cache classes may mean conflicting or
                    # malformed raw aliases. Carry their original evidence so
                    # the normalizer cannot replace an unknown write with 0.
                    for name in (
                        "prompt_tokens_details",
                        "input_tokens_details",
                        "cached_tokens",
                        "cache_read_tokens",
                        "cache_read_input_tokens",
                        "cache_creation_input_tokens",
                        "cache_creation_tokens",
                        "cache_write_tokens",
                    ):
                        if name in raw_usage:
                            canonical[name] = deepcopy(raw_usage[name])
            raw = {"usage": canonical}
        else:
            raw = (
                {"usage": deepcopy(raw_usage)}
                if isinstance(raw_usage, Mapping)
                else None
            )
        requested_model = record.get("requestedModel")
        call = metrics.record_usage(
            raw,
            provider="openai",
            model=requested_model,
            pricing=price,
            status="succeeded" if record.get("status") == "succeeded" else "failed",
            error=None if record.get("status") == "succeeded" else record.get("status"),
            wall_seconds=record["durationMs"] / 1000
            if isinstance(record.get("durationMs"), (int, float))
            else None,
        )
        call["request_id"] = record["requestId"]
        call["transport_request"] = deepcopy(dict(record))
    capture = {
        "source": "agent-service-transport",
        "status": "captured",
        "usage_status": accounting.get("usageStatus"),
        "message_id": accounting.get("messageId"),
        "request_ids": ids,
        "service_runtime": deepcopy(accounting.get("serviceRuntime")),
    }
    metrics.manifest["model_accounting"] = capture
    return capture


@dataclass
class NativeResourceMeasurement:
    resources: dict


@contextmanager
def native_resource_window(resource_scope=None):
    """Measure one serial native window using an explicit caller-owned scope.

    Reuse the common process/cgroup collector and report gateway components
    separately. No service is discovered, moved or terminated by this adapter.
    Each serial window may reset an explicitly owned cgroup peak; concurrent
    windows on the same scope are rejected by the shared collector's lock.
    """
    window = NativeResourceMeasurement(
        {
            "schema_version": 1,
            "status": "unavailable",
            "reason": "native_resource_scope_not_provided",
        }
    )
    if not resource_scope:
        yield window
        return
    scope = dict(resource_scope)
    with ExitStack() as stack:
        primary = stack.enter_context(
            ProcessResourceCollector(
                root_pids=scope.get("root_pids", [os.getpid()]),
                owned_service_pids=scope.get("owned_service_pids"),
                ownership_verified=scope.get("ownership_verified", False),
                required_service_labels=scope.get("required_service_labels"),
                scope_kind=scope.get("kind", "native_system"),
                cgroup=scope.get("cgroup"),
                sample_interval_seconds=scope.get("sample_interval_seconds", 0.05),
            )
        )
        shared = {
            label: stack.enter_context(
                ProcessResourceCollector(
                    root_pids=[component["metadata"]["pid"]]
                    if component.get("metadata", {}).get("pid")
                    else [],
                    cgroup=component,
                )
            )
            for label, component in scope.get("shared_components", {}).items()
        }
        whole_system = None
        if scope.get("cgroup") and shared:
            # Primary collectors own any kernel peak reset. This independent
            # bundle reads current charges and cannot reset their counters.
            components = {
                "native": scope["cgroup"],
                **scope.get("shared_components", {}),
            }
            readonly = {
                label: {**dict(component), "reset_peak": False, "fresh": False}
                for label, component in components.items()
            }
            whole_system = stack.enter_context(
                ComponentResourceCollector(
                    readonly,
                    sample_interval_seconds=scope.get("sample_interval_seconds", 0.05),
                )
            )
        try:
            yield window
        finally:
            window.resources = primary.finish()
            window.resources["shared_components"] = {
                label: collector.finish() for label, collector in shared.items()
            }
            if whole_system:
                window.resources["whole_system"] = whole_system.finish()


def load_pricing_snapshot(path, model):
    """Freeze an explicitly supplied exact route's schedule once per session."""
    if path is None:
        return None
    content = Path(path).read_bytes()
    snapshot = json.loads(content)
    if isinstance(snapshot, dict) and "models" in snapshot:
        records = [
            row for row in snapshot["models"] if row.get("native_model_id") == model
        ]
        if len(records) > 1:
            raise ValueError("Pricing snapshot is ambiguous for exact model " + model)
        value = records[0].get("pricing") if records else None
    else:
        value = (
            snapshot
            if isinstance(snapshot, dict) and snapshot.get("model") == model
            else None
        )
    if not value:
        return None
    value = deepcopy(value)
    if value.get("model") != model:
        raise ValueError("Frozen pricing must match the exact requested model")
    value.setdefault("source", {})["snapshot_sha256"] = sha256(content).hexdigest()
    return PricingSchedule.from_dict(value)


def select_new_requests(accounting, seen):
    """Filter a lifetime ledger into one turn's newly dispatched requests."""
    selected = deepcopy(accounting)
    requests = [
        request for request in selected["requests"] if request["requestId"] not in seen
    ]
    selected["requests"] = requests
    messages = {request.get("messageId") for request in requests}
    selected["messageId"] = next(iter(messages)) if len(messages) == 1 else None
    billing_fields = (
        "inputTokens",
        "outputTokens",
        "totalTokens",
        "cachedInputTokens",
        "cacheCreationInputTokens",
    )
    unknown_ids = [
        request["requestId"]
        for request in requests
        if not isinstance(request.get("usage"), Mapping)
        or any(request["usage"].get(field) is None for field in billing_fields)
    ]
    known = sum(request.get("usage") is not None for request in requests)
    selected["usageStatus"] = (
        "complete" if not unknown_ids else "partial" if known else "unknown"
    )
    selected["attemptedRequests"] = len(requests)
    selected["unknownUsageRequestIds"] = unknown_ids
    return selected


def finish_native_metrics(
    attempt,
    accounting,
    *,
    pricing=None,
    usage=None,
    stopped=False,
    error=None,
    resources=None,
    wall_interval=None,
):
    """Finish one request without claiming absent billing or shared CPU/RSS."""
    capture_error = None
    try:
        capture = record_native_requests(attempt, accounting, pricing=pricing)
    except ValueError as exc:
        capture_error = str(exc)
        capture = {
            "status": "unavailable",
            "reason": capture_error,
            "source": "legacy-step-usage",
        }
        attempt.manifest["model_accounting"] = capture
    result = attempt.finish(
        status="failed" if error else "stopped" if stopped else "completed",
        error=error,
        resources=resources
        or {
            "status": "unavailable",
            "reason": "shared_native_services_not_isolated",
            "cpu_seconds": None,
            "peak_rss_bytes": None,
        },
        wall_interval=wall_interval,
    )
    result["model_accounting"] = capture
    if capture_error:
        # Streaming/trace totals remain an observed lower bound. No request
        # count or complete total can be inferred when the transport ledger is
        # absent; do not synthesize a paid request or report zero cost.
        observed = normalize_usage(
            {
                "usage": {
                    "inputTokens": (usage or {}).get("input_tokens"),
                    "outputTokens": (usage or {}).get("output_tokens"),
                    "cachedInputTokens": (usage or {}).get("cached_input_tokens"),
                    "cacheCreationInputTokens": (usage or {}).get(
                        "cache_creation_input_tokens"
                    ),
                    "reasoningTokens": (usage or {}).get("reasoning_tokens"),
                }
            }
        )
        result["usage_complete"] = False
        result["normalization_issues"] = [
            {"issue": "transport_ledger_unavailable", "reason": capture_error}
        ]
        result["usage"] = {name: None for name in TOKEN_FIELDS}
        result["observed_usage"] = {name: observed[name] for name in TOKEN_FIELDS}
        result["usage_coverage"] = {
            name: {"known_calls": None, "attempted_calls": None}
            for name in TOKEN_FIELDS
        }
        result["model_calls"] = {"attempted": None, "succeeded": None, "failed": None}
        result["cost"] = {
            **result["cost"],
            "cost_usd": None,
            "observed_cost_usd": None,
            "known_calls": None,
            "attempted_calls": None,
        }
        result["provider_reported_cost"] = {
            **result["provider_reported_cost"],
            "cost_usd": None,
            "observed_cost_usd": None,
            "known_calls": None,
            "attempted_calls": None,
        }
    return result
