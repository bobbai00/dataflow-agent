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
"""Versioned metrics that preserve unknowns, raw responses, and cost provenance."""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import tempfile
import time
from typing import Any, Mapping, Optional

SCHEMA_VERSION = 1
TOKEN_FIELDS = (
    "input_tokens",
    "uncached_input_tokens",
    "cached_input_tokens",
    "cache_creation_tokens",
    "output_tokens",
    "reasoning_tokens",
    "total_tokens",
)


def _mapping(value):
    if isinstance(value, Mapping):
        return dict(value)
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if hasattr(value, "to_dict"):
        return value.to_dict()
    return {}


def _count(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = int(value)
        return number if number >= 0 and number == float(value) else None
    except (TypeError, ValueError, OverflowError):
        return None


def _pick(mapping, *keys):
    for key in keys:
        if key in mapping:
            return _count(mapping[key])
    return None


def _aliases(field, issues, *values, default=None):
    present = [value for value in values if value is not None]
    if not present:
        return default
    counts = [_count(value) for value in present]
    if any(value is None for value in counts):
        issues.append(field + "_invalid")
        return None
    if len(set(counts)) != 1:
        issues.append(field + "_conflicting_aliases")
        return None
    return counts[0]


def normalize_usage(raw_response, *, provider="openai", model=None):
    """Normalize SDK/wire responses, keeping absent usage/counts as null.

    Input and output totals include cache/reasoning subsets. Anthropic's
    cache counts and Gemini's separately reported thoughts need addition;
    OpenAI/AI SDK reasoning is already in the output total.
    """
    response = _mapping(raw_response)
    usage = _mapping(response.get("usage", response.get("tokenUsage", {})))
    provider = provider.lower()
    issues = []
    inp = out = cached = created = reasoning = None
    semantics = "input includes cached; output includes reasoning"
    if provider in ("gemini", "google"):
        usage = _mapping(response.get("usageMetadata", usage))
        inp = _pick(usage, "promptTokenCount")
        candidates = _pick(usage, "candidatesTokenCount")
        reasoning = _pick(usage, "thoughtsTokenCount")
        cached = _pick(usage, "cachedContentTokenCount")
        created = 0 if usage else None
        out = candidates + (reasoning or 0) if candidates is not None else None
        semantics = "prompt includes cache; candidates plus separately reported thoughts form output"
    elif (
        "prompt_tokens" not in usage
        and "input_tokens_details" not in usage
        and "inputTokens" not in usage
        and (provider == "anthropic" or "cache_read_input_tokens" in usage or "cache_creation_input_tokens" in usage)
    ):
        uncached = _pick(usage, "input_tokens")
        cached = _aliases(
            "cached_input_tokens", issues, usage.get("cache_read_input_tokens"), default=0 if usage else None
        )
        created = _aliases(
            "cache_creation_tokens",
            issues,
            usage.get("cache_creation_input_tokens"),
            usage.get("cache_creation_tokens"),
            usage.get("cache_write_tokens"),
            default=0 if usage else None,
        )
        inp = uncached + cached + created if all(value is not None for value in (uncached, cached, created)) else None
        out = _pick(usage, "output_tokens")
        reasoning = _pick(usage, "reasoning_tokens")
        semantics = "input_tokens excludes cache; cache read and creation added to input total"
    else:
        input_value = usage.get("inputTokens")
        output_value = usage.get("outputTokens")
        input_details = _mapping(usage.get("prompt_tokens_details", usage.get("input_tokens_details", {})))
        output_details = _mapping(usage.get("completion_tokens_details", usage.get("output_tokens_details", {})))
        if isinstance(input_value, Mapping):
            inp = _pick(input_value, "total")
            cached = _pick(input_value, "cacheRead")
            created = _pick(input_value, "cacheWrite")
        else:
            inp = _pick(usage, "prompt_tokens", "input_tokens", "inputTokens")
            cached = _aliases(
                "cached_input_tokens",
                issues,
                usage.get("cachedInputTokens"),
                usage.get("cached_tokens"),
                usage.get("cache_read_input_tokens"),
                usage.get("cache_read_tokens"),
                input_details.get("cached_tokens"),
                input_details.get("cacheReadTokens"),
            )
            created = _aliases(
                "cache_creation_tokens",
                issues,
                usage.get("cacheCreationInputTokens"),
                usage.get("cache_creation_input_tokens"),
                usage.get("cache_creation_tokens"),
                usage.get("cache_write_tokens"),
                input_details.get("cache_creation_tokens"),
                input_details.get("cache_write_tokens"),
                input_details.get("cacheWriteTokens"),
                default=0 if usage else None,
            )
        if isinstance(output_value, Mapping):
            out = _pick(output_value, "total")
            reasoning = _pick(output_value, "reasoning")
        else:
            out = _pick(usage, "completion_tokens", "output_tokens", "outputTokens")
            reasoning = _aliases(
                "reasoning_tokens",
                issues,
                usage.get("reasoningTokens"),
                usage.get("reasoning_tokens"),
                output_details.get("reasoning_tokens"),
                output_details.get("reasoningTokens"),
            )
    if not usage:
        issues.append("usage_missing")
    if cached is None:
        issues.append("cached_input_tokens_missing")
    if inp is not None and cached is not None and created is not None:
        uncached = inp - cached - created
        if uncached < 0:
            issues.append("cache_counts_exceed_input")
            uncached = None
    else:
        uncached = None
    if reasoning is not None and out is not None and reasoning > out:
        issues.append("reasoning_exceeds_output")
    total = inp + out if inp is not None and out is not None else None
    reported_total = _aliases(
        "total_tokens", issues, usage.get("total_tokens"), usage.get("totalTokens"), usage.get("totalTokenCount")
    )
    if reported_total is not None and total is not None and reported_total != total:
        issues.append("total_tokens_mismatch")
    return {
        "provider": provider,
        "model": model or response.get("model"),
        "input_tokens": inp,
        "uncached_input_tokens": uncached,
        "cached_input_tokens": cached,
        "cache_creation_tokens": created,
        "output_tokens": out,
        "reasoning_tokens": reasoning,
        "total_tokens": total,
        "semantics": semantics,
        "issues": issues,
        "complete": inp is not None and out is not None and uncached is not None and not issues,
    }


@dataclass(frozen=True)
class PricingSchedule:
    model: str
    input_per_token: float
    output_per_token: float
    cache_read_per_token: Optional[float] = None
    cache_write_per_token: Optional[float] = None
    source: Mapping[str, Any] = field(default_factory=dict)
    currency: str = "USD"
    version: int = 1
    provider_model: Optional[str] = None
    tiers: tuple = ()

    def __post_init__(self):
        for value in (
            self.input_per_token,
            self.output_per_token,
            self.cache_read_per_token,
            self.cache_write_per_token,
        ):
            if value is not None and (not math.isfinite(value) or value < 0):
                raise ValueError("Price rates must be finite and nonnegative")
        for tier in self.tiers:
            if _count(tier.get("min_input_tokens")) is None:
                raise ValueError("Price tiers require a nonnegative min_input_tokens threshold")
            for field in (
                "input_multiplier",
                "output_multiplier",
                "cache_read_multiplier",
                "cache_creation_multiplier",
            ):
                value = tier.get(field, 1)
                if not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                    raise ValueError("Price tier multipliers must be finite and nonnegative")

    @classmethod
    def from_dict(cls, value):
        if isinstance(value, cls):
            return value
        rates = value.get("rates", {})
        return cls(
            model=value["model"],
            input_per_token=rates["input"],
            output_per_token=rates["output"],
            cache_read_per_token=rates.get("cache_read"),
            cache_write_per_token=rates.get("cache_creation"),
            source=value.get("source", {}),
            currency=value.get("currency", "USD"),
            version=value.get("version", 1),
            provider_model=value.get("provider_model"),
            tiers=tuple(deepcopy(value.get("tiers", []))),
        )

    def as_dict(self):
        return {
            "version": self.version,
            "kind": "token_estimate",
            "model": self.model,
            "currency": self.currency,
            "unit": "per_token",
            "source": dict(self.source),
            "rates": {
                "input": self.input_per_token,
                "output": self.output_per_token,
                "cache_read": self.cache_read_per_token,
                "cache_creation": self.cache_write_per_token,
            },
            "input_includes_cached": True,
            "output_includes_reasoning": True,
            "provider_model": self.provider_model,
            "tiers": deepcopy(list(self.tiers)),
        }

    def estimate(self, usage):
        if (
            self.currency != "USD"
            or usage.get("issues")
            or usage.get("model") not in (None, self.model, self.provider_model)
        ):
            return None
        matching = [
            tier
            for tier in self.tiers
            if usage.get("input_tokens") is not None and usage["input_tokens"] >= tier["min_input_tokens"]
        ]
        tier = max(matching, key=lambda value: value["min_input_tokens"]) if matching else {}
        input_multiplier = tier.get("input_multiplier", 1)
        rates = [
            None if rate is None else rate * multiplier
            for rate, multiplier in (
                (self.input_per_token, input_multiplier),
                (self.cache_read_per_token, tier.get("cache_read_multiplier", input_multiplier)),
                (self.cache_write_per_token, tier.get("cache_creation_multiplier", input_multiplier)),
                (self.output_per_token, tier.get("output_multiplier", 1)),
            )
        ]
        terms = tuple(
            zip(
                (
                    usage["uncached_input_tokens"],
                    usage["cached_input_tokens"],
                    usage["cache_creation_tokens"],
                    usage["output_tokens"],
                ),
                rates,
            )
        )
        if any(count is None or (count and rate is None) for count, rate in terms):
            return None
        return sum(count * (rate or 0) for count, rate in terms)


def write_json_exclusive(path, data):
    """Atomically publish a new JSON artifact, never replace a previous attempt."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as output:
            temporary = output.name
            json.dump(data, output, indent=2, ensure_ascii=False, allow_nan=False, default=str)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, path)
    finally:
        if temporary is not None:
            os.unlink(temporary)


class AttemptMetrics:
    def __init__(self, attempt_id, *, benchmark, system, task_id, manifest=None):
        self.attempt_id, self.benchmark, self.system, self.task_id = attempt_id, benchmark, system, task_id
        self.manifest = deepcopy(dict(manifest or {}))
        self.started_at = datetime.now(timezone.utc).isoformat()
        self._start = time.monotonic()
        self._phases = {}
        self._calls = []
        self.resources = None
        self._finished = None

    @contextmanager
    def lifecycle_clock(self, name):
        if self._finished is not None:
            raise RuntimeError("Attempt already finished")
        start = time.monotonic()
        try:
            yield
        finally:
            phase = self._phases.setdefault(name, {"wall_seconds": 0, "count": 0, "intervals": []})
            duration = time.monotonic() - start
            phase["wall_seconds"] += duration
            phase["count"] += 1
            phase["intervals"].append({"start_offset_seconds": start - self._start, "wall_seconds": duration})

    def record_usage(
        self,
        raw_response=None,
        *,
        provider="openai",
        model=None,
        pricing=None,
        status="succeeded",
        error=None,
        wall_seconds=None,
    ):
        if self._finished is not None:
            raise RuntimeError("Attempt already finished")
        if status not in ("succeeded", "failed"):
            raise ValueError("Model call status must be succeeded or failed")
        usage = normalize_usage(raw_response, provider=provider, model=model)
        price = PricingSchedule.from_dict(pricing) if pricing is not None else None
        cost = price.estimate(usage) if price is not None else None
        raw = _mapping(raw_response)
        raw_usage = _mapping(raw.get("usage"))
        reported_cost = raw_usage.get("cost")
        if (
            isinstance(reported_cost, bool)
            or not isinstance(reported_cost, (int, float))
            or not math.isfinite(reported_cost)
            or reported_cost < 0
        ):
            reported_cost = None
        call = {
            "index": len(self._calls) + 1,
            "status": status,
            "error": error,
            "wall_seconds": wall_seconds,
            "usage": usage,
            "cost_usd": cost,
            "provider_reported_cost": {
                "cost_usd": reported_cost,
                "source": "response.usage.cost",
                "details": deepcopy(raw_usage.get("cost_details")),
            },
            "pricing": price.as_dict() if price else None,
            "response": deepcopy(_mapping(raw_response)) if raw_response is not None else None,
        }
        self._calls.append(call)
        return call

    def finish(self, *, status="completed", error=None, resources=None, wall_interval=None):
        if self._finished is not None:
            return self._finished
        external_interval = None
        if wall_interval is not None:
            external_interval = deepcopy(dict(wall_interval))
            if not external_interval.get("source") or not external_interval.get("boundary"):
                raise ValueError("Measured wall interval requires source and boundary")
            started_at = external_interval.get("started_at")
            finished_at = external_interval.get("finished_at")
            if (started_at is None) != (finished_at is None):
                raise ValueError("Measured wall interval requires paired UTC timestamps or neither")
            if started_at is not None:
                try:
                    parsed = [datetime.fromisoformat(value) for value in (started_at, finished_at)]
                    if any(value.utcoffset() is None or value.utcoffset().total_seconds() != 0 for value in parsed):
                        raise ValueError("UTC offset required")
                except (TypeError, ValueError) as exc:
                    raise ValueError("Measured wall interval requires UTC timestamp strings") from exc
            duration = external_interval.get("wall_seconds")
            if duration is not None and (
                isinstance(duration, bool)
                or not isinstance(duration, (int, float))
                or not math.isfinite(duration)
                or duration < 0
            ):
                raise ValueError("Measured wall duration must be nonnegative, finite, or unknown")
            external_interval["utc_status"] = "observed" if started_at is not None else "not_recorded"
        if resources is not None:
            self.resources = resources
        usage, coverage, observed = {}, {}, {}
        for name in TOKEN_FIELDS:
            known = [call["usage"][name] for call in self._calls if call["usage"][name] is not None]
            coverage[name] = {"known_calls": len(known), "attempted_calls": len(self._calls)}
            observed[name] = sum(known)
            usage[name] = sum(known) if len(known) == len(self._calls) else None
        costs = [call["cost_usd"] for call in self._calls if call["cost_usd"] is not None]
        reported_costs = [
            call["provider_reported_cost"]["cost_usd"]
            for call in self._calls
            if call["provider_reported_cost"]["cost_usd"] is not None
        ]
        finished_at = datetime.now(timezone.utc).isoformat()
        clocks = {
            "clock": "monotonic",
            "wall_seconds": time.monotonic() - self._start,
            "phases": self._phases,
            "measured_interval": {
                "source": "AttemptMetrics.monotonic",
                "boundary": "metrics construction through finish",
                "started_at": self.started_at,
                "finished_at": finished_at,
                "utc_status": "observed",
            },
        }
        if external_interval is not None:
            clocks["wall_seconds"] = external_interval.pop("wall_seconds", None)
            clocks["phases"] = external_interval.pop("phases", self._phases)
            clocks["boundary"] = external_interval["boundary"]
            clocks["measured_interval"] = external_interval
            clocks["measured_interval"].setdefault("started_at", None)
            clocks["measured_interval"].setdefault("finished_at", None)
        self._finished = {
            "schema_version": SCHEMA_VERSION,
            "attempt_id": self.attempt_id,
            "benchmark": self.benchmark,
            "system": self.system,
            "task_id": self.task_id,
            "status": status,
            "error": error,
            "started_at": self.started_at,
            "finished_at": finished_at,
            "receipt": {
                "constructed_at": self.started_at,
                "finalized_at": finished_at,
                "legacy_timestamp_fields": "started_at and finished_at describe receipt construction through finalization",
            },
            "clocks": clocks,
            "model_calls": {
                "attempted": len(self._calls),
                "succeeded": sum(call["status"] == "succeeded" for call in self._calls),
                "failed": sum(call["status"] == "failed" for call in self._calls),
            },
            "usage": usage,
            "usage_coverage": coverage,
            "observed_usage": observed,
            "usage_complete": all(call["usage"]["complete"] for call in self._calls),
            "normalization_issues": [
                {"index": call["index"], "issues": list(call["usage"]["issues"])}
                for call in self._calls
                if call["usage"]["issues"]
            ],
            "cost": {
                "kind": "token_estimate",
                "cost_usd": sum(costs) if len(costs) == len(self._calls) else None,
                "observed_cost_usd": sum(costs),
                "known_calls": len(costs),
                "attempted_calls": len(self._calls),
                "excludes": ["scoring", "infrastructure", "compute"],
            },
            "provider_reported_cost": {
                "cost_usd": sum(reported_costs) if len(reported_costs) == len(self._calls) else None,
                "observed_cost_usd": sum(reported_costs),
                "known_calls": len(reported_costs),
                "attempted_calls": len(self._calls),
                "source": "response.usage.cost",
            },
            "resources": self.resources or {"status": "unavailable", "reason": "collector_not_provided"},
        }
        return self._finished

    def as_dict(self):
        return self.finish()

    def write(self, directory):
        directory = Path(directory)
        if (directory / "metrics.json").exists() or (directory / "attempt-manifest.json").exists():
            raise FileExistsError("Attempt artifacts already exist")
        for call in self._calls:
            write_json_exclusive(directory / "model_calls" / ("%06d.json" % call["index"]), call)
        write_json_exclusive(
            directory / "attempt-manifest.json",
            {
                "schema_version": SCHEMA_VERSION,
                "attempt_id": self.attempt_id,
                "benchmark": self.benchmark,
                "system": self.system,
                "task_id": self.task_id,
                "manifest": self.manifest,
            },
        )
        write_json_exclusive(directory / "metrics.json", self.finish())
