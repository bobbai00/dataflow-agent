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
"""Exact model routes and immutable public capability/pricing snapshots.

Catalog membership is not proof that an account can run a model. Access is
verified by an actual request separately, never by substituting another model.
The matrix accepts arbitrary ModelSpec records; requested_models is the current
user-requested campaign, not an allowlist for benchmark infrastructure.
"""

import argparse
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
import json
import os
from pathlib import Path
import re
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


@dataclass(frozen=True)
class ModelSpec:
    requested_model: str
    native_model_id: str
    provider_model_id: str
    provider: str
    reasoning_effort: str | None = "medium"
    model_capabilities: dict = field(default_factory=dict)

    def __post_init__(self):
        for value in (self.native_model_id, self.provider_model_id, self.provider):
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]*", value) or "://" in value:
                raise ValueError("Model identifiers must be exact nonempty IDs, without credentials or whitespace")
        if not self.requested_model.strip() or any(ord(c) < 32 for c in self.requested_model):
            raise ValueError("Requested model name must be nonempty and contain no control characters")


def requested_models():
    return [
        ModelSpec("Luna", "gpt-5.6-luna", "gpt-5.6-luna", "openai"),
        ModelSpec("Terra", "gpt-5.6-terra", "gpt-5.6-terra", "openai"),
        ModelSpec("Sol", "gpt-5.6-sol", "gpt-5.6-sol", "openai"),
        ModelSpec(
            "Sonnet 5.5", "claude-sonnet-5.5", "claude-sonnet-5-5", "anthropic", None,
            {"forced_tool_choice": False, "structured_output_transport": "auto_tool"},
        ),
        ModelSpec("Qwen3.8-27B", "qwen3.8-27b", "qwen/qwen3.8-27b", "openrouter"),
        ModelSpec("DeepSeek V4.1-Flash", "deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash", "openrouter"),
    ]


def _schedule(spec, rates, source, *, tiers=None):
    return {
        "version": 1,
        "kind": "token_estimate",
        "model": spec.native_model_id,
        "provider": spec.provider,
        "provider_model": spec.provider_model_id,
        "currency": "USD",
        "unit": "per_token",
        "rates": dict(zip(("input", "output", "cache_read", "cache_creation"), rates)),
        "input_includes_cached": True,
        "output_includes_reasoning": True,
        "source": source,
        "tiers": tiers or [],
    }


def _official_schedule(spec):
    openai = {
        "gpt-5.6-luna": (0.2, 1.2, 0.02, 0.25),
        "gpt-5.6-terra": (2, 12, 0.2, 2.5),
        "gpt-5.6-sol": (4, 20, 0.4, 5),
    }
    if spec.provider == "openai" and spec.provider_model_id in openai:
        return _schedule(
            spec,
            [float(Decimal(str(rate)) / 1_000_000) for rate in openai[spec.provider_model_id]],
            {
                "url": f"https://developers.openai.com/api/docs/models/{spec.provider_model_id}",
                "verified_date": "2026-10-08",
                "policy": "standard; explicit cache writes at 1.25x input",
            },
            tiers=[{"min_input_tokens": 272001, "input_multiplier": 2, "output_multiplier": 1.5}],
        )
    if spec.provider == "anthropic" and spec.provider_model_id == "claude-sonnet-5-5":
        return _schedule(
            spec,
            [2e-6, 10e-6, 0.1e-6, 2.5e-6],
            {
                "url": "https://platform.claude.com/docs/en/models/sonnet-5-5/overview",
                "verified_date": "2026-10-08",
                "cache_write_ttl": "5m",
                "cache_write_1h_rate": 4e-6,
            },
        )
    return None


def resolve_model_facts(spec, *, gateway_ids, openrouter_models=()):
    facts = {
        **asdict(spec),
        "model_parameters": {"reasoning_effort": spec.reasoning_effort} if spec.reasoning_effort is not None else {},
        "gateway_configured": spec.native_model_id in gateway_ids,
        "available": None,
        "access_status": "unverified",
        "blocked_reason": None,
        "catalog_available": None,
        "pricing": _official_schedule(spec),
        "supported_parameters": None,
        "context_length": None,
    }
    if spec.provider == "openrouter":
        record = next((row for row in openrouter_models if row.get("id") == spec.provider_model_id), None)
        facts["catalog_available"] = record is not None
        if record:
            pricing = record.get("pricing", {})
            rates = [
                float(Decimal(pricing[key])) if pricing.get(key) is not None else None
                for key in ("prompt", "completion", "input_cache_read", "input_cache_write")
            ]
            facts["pricing"] = _schedule(
                spec,
                rates,
                {
                    "url": "https://openrouter.ai/api/v1/models",
                    "model_key": spec.provider_model_id,
                    "public_pricing": pricing,
                },
            )
            facts["supported_parameters"] = record.get("supported_parameters")
            facts["context_length"] = record.get("context_length")
        else:
            facts["blocked_reason"] = "Exact model absent from fetched OpenRouter catalog"
    if not facts["gateway_configured"]:
        facts["blocked_reason"] = "Exact native route absent from gateway catalog"
    return facts


def fetch_catalog(url, *, api_key=None):
    headers = {"Authorization": "Bearer " + api_key} if api_key else {}
    with urlopen(Request(url, headers=headers), timeout=30) as response:
        data = json.load(response)
    if not isinstance(data, dict) or not isinstance(data.get("data"), list):
        raise ValueError("Provider catalog must contain a data array")
    return data["data"]


def verify_probe_response(response):
    """Require usable tool calling, rather than accepting a successful HTTP alone."""
    try:
        calls = response["choices"][0]["message"].get("tool_calls", [])
        return any(
            call["function"]["name"] == "telemetry_probe" and json.loads(call["function"]["arguments"]) == {"ok": True}
            for call in calls
        )
    except (KeyError, TypeError, ValueError, IndexError):
        return False


def probe_model(facts, *, gateway_url, api_key, output):
    """One immutable, paid tool-call access probe, outside scored task attempts."""
    from benchmark.runtime import AttemptMetrics, write_json_exclusive

    output = Path(output)
    body = {
        "model": facts["native_model_id"],
        "messages": [
            {"role": "user", "content": "Call telemetry_probe once with ok=true. This is a tool compatibility check."}
        ],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "telemetry_probe",
                    "description": "Record a successful compatibility check.",
                    "parameters": {
                        "type": "object",
                        "properties": {"ok": {"type": "boolean"}},
                        "required": ["ok"],
                        "additionalProperties": False,
                    },
                },
            }
        ],
        "tool_choice": "auto",
        "max_tokens": 2048,
        **facts["model_parameters"],
    }
    write_json_exclusive(output / "request.json", body)
    metrics = AttemptMetrics(
        output.name, benchmark="model_preflight", system="gateway_tool_probe", task_id=facts["native_model_id"]
    )
    write_json_exclusive(
        output / "started.json",
        {"created_at": metrics.started_at, "gateway_url": gateway_url, "request_model": body["model"]},
    )
    headers = {"Content-Type": "application/json", "Authorization": "Bearer " + api_key}
    start = time.monotonic()
    response, http_status, error_type = None, None, None
    with metrics.lifecycle_clock("model_request"):
        try:
            with urlopen(
                Request(gateway_url.rstrip("/") + "/chat/completions", data=json.dumps(body).encode(), headers=headers),
                timeout=180,
            ) as wire:
                http_status = wire.status
                response = json.load(wire)
        except HTTPError as error:
            http_status, error_type = error.code, "http_error"
            # Providers may echo configuration details; remove known secrets before persistence.
            text = error.read().decode(errors="replace")
            for name, value in os.environ.items():
                if value and (name.endswith("API_KEY") or name.endswith("MASTER_KEY")):
                    text = text.replace(value, "[REDACTED]")
            try:
                response = json.loads(text)
            except ValueError:
                response = {"error": {"message": text}}
        except (TimeoutError, OSError, ValueError) as error:
            error_type = type(error).__name__
    usable = http_status == 200 and verify_probe_response(response)
    metrics.record_usage(
        response,
        provider="openai",
        model=facts["native_model_id"],
        pricing=facts.get("pricing"),
        status="succeeded" if usable else "failed",
        error=error_type,
        wall_seconds=time.monotonic() - start,
    )
    write_json_exclusive(
        output / "response.json", {"http_status": http_status, "error_type": error_type, "response": response}
    )
    write_json_exclusive(output / "metrics.json", metrics.finish(status="completed" if usable else "failed"))
    return {
        **facts,
        "available": usable,
        "access_status": "verified_tool_call" if usable else "probe_failed",
        "blocked_reason": (
            None
            if usable
            else f"Tool compatibility probe failed (HTTP {http_status}, {error_type or 'invalid tool response'})"
        ),
        "probe_directory": str(output.resolve()),
        "returned_model": response.get("model") if isinstance(response, dict) else None,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gateway-url", default="http://localhost:18000/v1")
    parser.add_argument("--openrouter-catalog-url", default="https://openrouter.ai/api/v1/models")
    parser.add_argument(
        "--specs", type=Path, help="JSON list of exact ModelSpec records; defaults to requested campaign"
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--probe-output-dir",
        type=Path,
        help="Perform one paid tool-call access probe per exact route and preserve its artifacts",
    )
    args = parser.parse_args()
    specs = [ModelSpec(**record) for record in json.loads(args.specs.read_text())] if args.specs else requested_models()
    gateway = fetch_catalog(args.gateway_url.rstrip("/") + "/models", api_key=os.environ.get("LITELLM_MASTER_KEY"))
    router = fetch_catalog(args.openrouter_catalog_url) if any(spec.provider == "openrouter" for spec in specs) else []
    models = [
        resolve_model_facts(spec, gateway_ids={row["id"] for row in gateway}, openrouter_models=router)
        for spec in specs
    ]
    if args.probe_output_dir:
        if args.output.exists():
            raise FileExistsError(args.output)
        models = [
            probe_model(
                facts,
                gateway_url=args.gateway_url,
                api_key=os.environ["LITELLM_MASTER_KEY"],
                output=args.probe_output_dir / facts["native_model_id"],
            )
            for facts in models
        ]
    snapshot = {"schema_version": 1, "created_at": datetime.now(timezone.utc).isoformat(), "models": models}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x") as file:
        json.dump(snapshot, file, indent=2, allow_nan=False)
        file.write("\n")
    print(
        json.dumps(
            {
                "models": len(models),
                "configured": sum(row["gateway_configured"] for row in models),
                "output": str(args.output),
            }
        )
    )


if __name__ == "__main__":
    main()
