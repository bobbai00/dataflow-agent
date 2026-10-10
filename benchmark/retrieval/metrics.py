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
"""Auditable native-run accounting from exact gateway response usage."""
from datetime import datetime
import json
import math
from pathlib import Path
import shutil


def current_price_schedule(model):
    """Frozen standard-tier token estimates, verified 2026-10-08; not invoices."""
    providers = {
        "gpt-5.6-luna": ((.2, 1.2, .02, .25), "https://developers.openai.com/api/docs/models/gpt-5.6-luna"),
        "gpt-5.6-terra": ((2, 12, .2, 2.5), "https://developers.openai.com/api/docs/models/gpt-5.6-terra"),
        "gpt-5.6-sol": ((4, 20, .4, 5), "https://developers.openai.com/api/docs/models/gpt-5.6-sol"),
        "claude-opus-4.8": ((5, 25, .5, 6.25), "https://platform.claude.com/docs/en/models/opus-4-8/overview"),
        "qwen3.8-27b": ((.425, 2.55, .085, .53125), "https://openrouter.ai/api/v1/models#qwen/qwen3.8-27b"),
        "deepseek-v4.1-flash": ((.3, 1.2, .006, None), "https://openrouter.ai/api/v1/models#deepseek/deepseek-v4.1-flash"),
    }
    if model not in providers:
        return None
    rates, source = providers[model]
    return {"model": model, "kind": "token_estimate", "currency": "USD", "unit": "per_token",
            "verified_on": "2026-10-08", "source": source,
            "rates": {k: v / 1e6 if v is not None else None for k, v in
                      zip(("input", "output", "cache_read", "cache_creation"), rates)},
            "long_context_threshold": 272000 if model.startswith("gpt-5.6-") else None,
            "input_includes_cached": True, "output_includes_reasoning": True}


def cache_usage_values(usage):
    """Keep absence distinct from an explicitly reported zero before normalization."""
    prompt = usage.get("prompt_tokens_details") or {}
    return {
        "cached_tokens": (prompt.get("cached_tokens"), usage.get("cachedInputTokens"), usage.get("cache_read_input_tokens")),
        "cache_creation_tokens": (prompt.get("cache_write_tokens"), prompt.get("cache_creation_tokens"),
            usage.get("cache_creation_input_tokens"), usage.get("cacheCreationInputTokens")),
    }


def normalize_usage(usage):
    completion = usage.get("completion_tokens_details") or {}
    def number(*values):
        return next((int(value) for value in values if value is not None), 0)
    inputs = number(usage.get("prompt_tokens"), usage.get("inputTokens"), usage.get("input_tokens"))
    outputs = number(usage.get("completion_tokens"), usage.get("outputTokens"), usage.get("output_tokens"))
    return {"input_tokens": inputs, "output_tokens": outputs, "total_tokens": inputs + outputs,
            **{key: number(*values) for key, values in cache_usage_values(usage).items()},
            "reasoning_tokens": number(completion.get("reasoning_tokens"), usage.get("reasoningTokens"))}


def cost_for_usage(usage, pricing):
    if pricing is None:
        return None
    counts = {"input": usage["input_tokens"] - usage["cached_tokens"] - usage["cache_creation_tokens"],
              "output": usage["output_tokens"], "cache_read": usage["cached_tokens"],
              "cache_creation": usage["cache_creation_tokens"]}
    if any(value < 0 for value in counts.values()):
        return None
    threshold = pricing.get("long_context_threshold")
    long_context = threshold is not None and usage["input_tokens"] > threshold
    total = 0.0
    for key, count in counts.items():
        rate = pricing["rates"].get(key)
        if rate is None and count:
            return None
        multiplier = (1.5 if key == "output" else 2) if long_context else 1
        total += count * (rate or 0) * multiplier
    return total


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


def edit_operations(output):
    """Normalize historical graph edits and registered-Python change reports."""
    return [change.get("operation") or ".".join((change.get("change", "unknown"), change.get("action", "unknown")))
            for change in output.get("changes", [])]


def reconcile_run(path, model, pricing, wire_root=None):
    """Preserve harness stats, verify observed usage, and never call unpriced work free."""
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    stats_path = path / "stats.json"
    stats = json.loads(stats_path.read_text()) if stats_path.exists() else {}
    if stats_path.exists() and not (path / "harness-stats.json").exists():
        shutil.copyfile(stats_path, path / "harness-stats.json")
    original_path = path / "harness-stats.json"
    original = json.loads(original_path.read_text()) if original_path.exists() else stats
    resources = path / "resources.json"
    if wire_root and resources.exists():
        agent_id = json.loads(resources.read_text()).get("agent_id")
        if agent_id and Path(agent_id).name == agent_id:
            source = Path(wire_root) / agent_id
            if source.is_dir():
                shutil.copytree(source, path / "wire", dirs_exist_ok=True)
    wire = path / "wire"
    warnings, mismatches, usages, durations, response_models = [], [], [], [], set()
    provider_costs, providers = [], set()
    cache_reports = {key: 0 for key in cache_usage_values({})}
    metas = sorted(wire.glob("*-meta.json"))
    totals = {key: 0 for key in normalize_usage({})}
    complete = bool(metas)
    for meta_path in metas:
        meta = json.loads(meta_path.read_text())
        try:
            durations.append((datetime.fromisoformat(meta["finished_at"].replace("Z", "+00:00")) -
                              datetime.fromisoformat(meta["started_at"].replace("Z", "+00:00"))).total_seconds())
        except (KeyError, ValueError):
            complete = False
        response_path = meta_path.with_name(meta_path.name.replace("-meta.json", "-response.json"))
        try:
            response = json.loads(response_path.read_text())
        except (OSError, ValueError):
            complete = False
            continue
        if meta.get("status") != 200 or not isinstance(response.get("usage"), dict):
            complete = False
            continue
        if response.get("model"):
            response_models.add(response["model"])
        if response.get("provider"):
            providers.add(response["provider"])
        reported_cost = response["usage"].get("cost")
        if isinstance(reported_cost, (int, float)) and not isinstance(reported_cost, bool) and math.isfinite(reported_cost) and reported_cost >= 0:
            provider_costs.append(reported_cost)
        usage = normalize_usage(response["usage"])
        for key, values in cache_usage_values(response["usage"]).items():
            cache_reports[key] += any(value is not None for value in values)
        if usage["cached_tokens"] + usage["cache_creation_tokens"] > usage["input_tokens"]:
            warnings.append("cache_classes_exceed_input")
            complete = False
        usages.append(usage)
        for key, value in usage.items():
            totals[key] += value
    if metas:
        for key, value in totals.items():
            if key in original and original[key] != value:
                mismatches.append({"field": key, "harness": original[key], "wire": value})
        stats.update(totals)
    else:
        warnings.append("missing_wire_usage")
    if not complete:
        warnings.append("usage_incomplete")
    costs = [cost_for_usage(usage, pricing) for usage in usages]
    known = bool(costs) and all(cost is not None for cost in costs)
    provider_complete = complete and len(provider_costs) == len(metas)
    cache_reporting = {key: {"reported_responses": count, "unreported_responses": len(usages) - count,
                            "complete": complete and count == len(metas)}
                       for key, count in cache_reports.items()}
    assumptions = []
    for key, label in (("cached_tokens", "cache-read"), ("cache_creation_tokens", "cache-creation")):
        missing = cache_reporting[key]["unreported_responses"]
        if missing:
            assumptions.append(f"{label.capitalize()} tokens were not reported for {missing} usage response(s); "
                               f"estimates assume zero {label} tokens and price remaining unclassified input at the input rate.")
    stats.update({"cost_usd": sum(costs) if complete and known else None,
                  "reported_usage_cost_usd": sum(c for c in costs if c is not None) if any(c is not None for c in costs) else None,
                  "provider_reported_cost_usd": sum(provider_costs) if provider_complete else None,
                  "partial_provider_reported_cost_usd": sum(provider_costs) if provider_costs else None,
                  "provider_cost_complete": provider_complete,
                  "model_responses_with_provider_cost": len(provider_costs), "response_providers": sorted(providers),
                  "pricing": pricing, "usage_complete": complete,
                  "cache_usage_reporting": cache_reporting, "cost_estimate_assumptions": assumptions,
                  "model_requests": len(metas), "model_responses_with_usage": len(usages),
                  "model_latency_seconds": round(sum(durations), 3) if metas and len(durations) == len(metas) else None,
                  "response_models": sorted(response_models), "requested_model": model})
    if pricing is None:
        warnings.append("unknown_price")
    audit = {"warnings": sorted(set(warnings)), "usage_mismatches": mismatches,
             "cache_usage_reporting": cache_reporting, "cost_estimate_assumptions": assumptions,
             "costs": {"cost_usd": "Frozen public token-rate estimate; not an invoice.",
                       "reported_usage_cost_usd": "Partial frozen-rate estimate for responses with known usage and pricing.",
                       "provider_reported_cost_usd": "Sum of response usage.cost only when every gateway request reports cost; not combined with estimates."},
             "timing": {"elapsed_seconds": "Agent turn wall time, including model and tools; excludes scoring.",
                        "model_latency_seconds": "Sum of captured gateway request durations; includes transport and gateway overhead."}}
    stats_path.write_text(json.dumps(stats, indent=2) + "\n")
    (path / "metrics-audit.json").write_text(json.dumps(audit, indent=2) + "\n")
    return stats, audit


def main():
    """Recompute accounting and invariant checks offline from preserved artifacts."""
    import argparse
    try:
        from .campaign import audit_attempt
    except ImportError:
        from campaign import audit_attempt
    parser = argparse.ArgumentParser(description=main.__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    root = args.directory
    manifest = json.loads((root / "manifest.json").read_text())
    progress = json.loads((root / "progress.json").read_text())
    if progress.get("status") == "running":
        parser.error("Wait for the campaign to finish before rewriting its accounting.")
    for row in progress["completed"]:
        path = root / "system_scratch" / row["sut"] / row["task"]
        model = manifest["models"][row["model"]]
        stats, _ = reconcile_run(path, model, manifest.get("pricing_schedules", {}).get(model))
        row["audit"] = audit_attempt(path, {**manifest["settings"], **manifest["arms"][row["arm"]]})
        row["cost_usd"] = stats["cost_usd"]
        (path / "attempt-audit.json").write_text(json.dumps(row["audit"], indent=2) + "\n")
    (root / "progress.json").write_text(json.dumps(progress, indent=2) + "\n")
    print(f"Reconciled {len(progress['completed'])} preserved attempts; no model or scorer calls.")


if __name__ == "__main__":
    main()
