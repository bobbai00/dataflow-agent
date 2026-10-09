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
"""Native transport accounting shares cost/unknown semantics across benchmarks."""

from copy import deepcopy
import pytest

from .metrics import AttemptMetrics, PricingSchedule
from .native_accounting import record_native_requests


def request(identifier="r1", *, status="succeeded", usage=True):
    return {
        "requestId": identifier,
        "messageId": "turn1",
        "status": status,
        "requestedModel": "route",
        "returnedModel": "provider-model",
        "durationMs": 25,
        "usage": {
            "inputTokens": 100,
            "outputTokens": 20,
            "totalTokens": 120,
            "cachedInputTokens": 40,
            "cacheCreationInputTokens": 20,
            "reasoningTokens": 10,
        }
        if usage
        else None,
        "rawUsage": {
            "prompt_tokens": 100,
            "completion_tokens": 20,
            "prompt_tokens_details": {"cached_tokens": 40, "cache_write_tokens": 20},
        }
        if usage
        else None,
    }


def summary(*requests):
    return {
        "version": 1,
        "source": "transport",
        "messageId": "turn1",
        "requests": list(requests),
        "usageStatus": "complete"
        if all(r["usage"] is not None for r in requests)
        else "partial",
        "serviceRuntime": {
            "pid": 123,
            "startedAt": "startup",
            "sourceHashes": {"src/server.ts": "hash"},
        },
    }


def attempt():
    return AttemptMetrics(
        "a", benchmark="longds", system="native", task_id="session/t1"
    )


def prices():
    return PricingSchedule(
        "route",
        1e-6,
        2e-6,
        0.1e-6,
        1.25e-6,
        source={"url": "https://example.test/frozen-pricing"},
    )


def test_native_requests_use_canonical_inclusive_counts_and_preserve_wire_usage():
    metric = attempt()
    accounting = summary(request())
    original = deepcopy(accounting)
    capture = record_native_requests(metric, accounting, pricing=prices())
    result = metric.finish()
    assert result["usage"]["input_tokens"] == 100
    assert result["usage"]["uncached_input_tokens"] == 40
    assert result["usage"]["cache_creation_tokens"] == 20
    assert result["usage"]["output_tokens"] == 20
    assert result["cost"]["cost_usd"] == pytest.approx(109e-6)
    assert capture["service_runtime"]["sourceHashes"]["src/server.ts"] == "hash"
    assert (
        metric._calls[0]["transport_request"]["rawUsage"]
        == original["requests"][0]["rawUsage"]
    )
    accounting["requests"][0]["rawUsage"]["prompt_tokens"] = 999
    assert metric._calls[0]["transport_request"]["rawUsage"]["prompt_tokens"] == 100


def test_failed_and_pending_requests_remain_attempted_unknown_billing():
    metric = attempt()
    record_native_requests(
        metric,
        summary(
            request(),
            request("r2", status="http_error", usage=False),
            request("r3", status="pending", usage=False),
        ),
        pricing=prices(),
    )
    result = metric.finish(status="failed")
    assert result["model_calls"] == {"attempted": 3, "succeeded": 1, "failed": 2}
    assert result["usage"]["input_tokens"] is None
    assert result["observed_usage"]["input_tokens"] == 100
    assert result["cost"]["cost_usd"] is None
    assert result["cost"]["observed_cost_usd"] == pytest.approx(109e-6)


def test_known_usage_on_failed_response_is_still_charged():
    metric = attempt()
    record_native_requests(
        metric, summary(request(status="http_error")), pricing=prices()
    )
    assert metric.finish()["cost"]["cost_usd"] == pytest.approx(109e-6)


def test_missing_pricing_remains_unknown():
    metric = attempt()
    record_native_requests(metric, summary(request()))
    assert metric.finish()["cost"]["cost_usd"] is None


@pytest.mark.parametrize(
    "value", [None, {"requests": []}, summary(request(), request())]
)
def test_bad_or_missing_capture_fails_before_recording(value):
    metric = attempt()
    with pytest.raises(ValueError):
        record_native_requests(metric, value, pricing=prices())
    assert metric._calls == []


def test_requested_route_mismatch_never_borrows_another_models_price():
    metric = attempt()
    other = request()
    other["requestedModel"] = "different-route"
    record_native_requests(metric, summary(other), pricing=prices())
    assert metric.finish()["cost"]["cost_usd"] is None


def test_native_preserves_actual_gateway_reported_cost_separately_from_estimate():
    metric = attempt()
    row = request()
    row["rawUsage"]["cost"] = 0.0042
    row["rawUsage"]["cost_details"] = {"upstream_inference_cost": 0.0040}
    record_native_requests(metric, summary(row), pricing=prices())
    result = metric.finish()
    assert result["provider_reported_cost"]["cost_usd"] == pytest.approx(0.0042)
    assert result["cost"]["cost_usd"] == pytest.approx(109e-6)
    assert metric._calls[0]["provider_reported_cost"]["details"] == {
        "upstream_inference_cost": 0.0040
    }


def test_invalid_raw_classification_retains_known_raw_totals_and_issues():
    metric = attempt()
    row = request(usage=False)
    row["rawUsage"] = {
        "prompt_tokens": 100,
        "completion_tokens": 20,
        "cached_tokens": 10,
        "prompt_tokens_details": {"cached_tokens": 20},
    }
    record_native_requests(metric, summary(row), pricing=prices())
    result = metric.finish()
    assert result["observed_usage"]["input_tokens"] == 100
    assert result["cost"]["cost_usd"] is None
    assert (
        "cached_input_tokens_conflicting_aliases" in metric._calls[0]["usage"]["issues"]
    )


def test_resource_window_absent_scope_is_explicitly_unavailable():
    from .native_accounting import native_resource_window

    with native_resource_window() as window:
        pass
    assert window.resources["status"] == "unavailable"


def test_resource_window_collects_native_inventory_and_common_components(monkeypatch):
    from . import native_accounting

    created = []

    class Collector:
        def __init__(self, **settings):
            created.append(settings)
            self.settings = settings

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def finish(self):
            return {
                "status": "available",
                "cpu_total_seconds": 2,
                "scope": self.settings,
            }

    monkeypatch.setattr(native_accounting, "ProcessResourceCollector", Collector)
    scope = {
        "owned_service_pids": {"agent": 123},
        "ownership_verified": True,
        "required_service_labels": ["agent"],
        "shared_components": {
            "gateway": {"metadata": {"pid": 456}, "memory_path": "/fake"}
        },
    }
    with native_accounting.native_resource_window(scope) as window:
        pass
    assert created[0]["owned_service_pids"] == {"agent": 123}
    assert created[0]["scope_kind"] == "native_system"
    assert created[1]["root_pids"] == [456]
    assert window.resources["shared_components"]["gateway"]["cpu_total_seconds"] == 2


def test_partial_canonical_classification_preserves_raw_conflict_instead_of_defaulting_to_zero():
    metric = attempt()
    row = request()
    del row["usage"]["cacheCreationInputTokens"]
    row["rawUsage"]["prompt_tokens_details"].update(
        cache_write_tokens=20, cache_creation_tokens=21
    )
    record_native_requests(metric, summary(row), pricing=prices())
    result = metric.finish()
    assert result["observed_usage"]["input_tokens"] == 100
    assert result["cost"]["cost_usd"] is None
    assert not result["usage_complete"]
    assert (
        "cache_creation_tokens_conflicting_aliases"
        in metric._calls[0]["usage"]["issues"]
    )
