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
"""Model usage and cost from the exact responses, per attempt: the source of every reported cost and model latency.

BobFlow attempts are reconciled from the agent's wire traces (TEXERA_LLM_TRACE_DIR/<agent id>/NNNNNN-{request,response,
meta}.json, copied into <attempt>/wire/); Script ReAct attempts from model-request-trace.jsonl. Each response is billed
at the provider's own charge when it reports one (OpenRouter's usage.cost), else at the frozen token rates
(bobbench.models). A run whose usage is incomplete keeps cost_usd null rather than calling unpriced work free.

    python -m bobbench.profiling.usage <run> [--stopped]     (bench recost)
"""
import argparse
from datetime import datetime
import json
import math
from pathlib import Path
import shutil

from bobbench.models import price_schedule


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


def cost_for_usage(usage, pricing, implicit_cache_writes=False):
    """Frozen-rate estimate for one normalized usage. With implicit_cache_writes, the uncached prompt tokens are priced
    as cache writes: the provider wrote them to its cache without reporting the count."""
    if pricing is None:
        return None
    counts = {"input": usage["input_tokens"] - usage["cached_tokens"] - usage["cache_creation_tokens"],
              "output": usage["output_tokens"], "cache_read": usage["cached_tokens"],
              "cache_creation": usage["cache_creation_tokens"]}
    if any(value < 0 for value in counts.values()):
        return None
    if implicit_cache_writes:
        counts["cache_creation"] += counts["input"]
        counts["input"] = 0
    threshold = pricing.get("long_context_threshold")
    long_context = threshold is not None and usage["input_tokens"] > threshold
    total = 0.0
    for key, count in counts.items():
        rate = pricing["rates"].get(key)
        if rate is None and count:
            return None
        multiplier = (pricing.get("long_context_multiplier") or (1.5 if key == "output" else 2)) if long_context else 1
        total += count * (rate or 0) * multiplier
    return total


def reported_charge(usage):
    """The provider's own charge for a response (OpenRouter's usage.cost, the upstream bill), or None."""
    cost = usage.get("cost")
    if isinstance(cost, (int, float)) and not isinstance(cost, bool) and math.isfinite(cost) and cost >= 0:
        return float(cost)
    return None


def cache_writes_reported(usage):
    return any(value is not None for value in cache_usage_values(usage)["cache_creation_tokens"])


def response_cost(usage, pricing, billed=True):
    """Cost of one response from its raw usage: the provider's charge when it reports one, else the frozen-rate
    estimate (billed=False always estimates). Reasoning is inside the output count and is not added again."""
    charge = reported_charge(usage) if billed else None
    if charge is not None:
        return charge
    implicit = bool(pricing and pricing.get("implicit_cache_writes")) and not cache_writes_reported(usage)
    return cost_for_usage(normalize_usage(usage), pricing, implicit_cache_writes=implicit)


def cost_basis(billed, responses):
    return "provider_reported" if responses and billed == responses else "token_estimate" if not billed else "mixed"


def unreported_cache_write_assumption(count, pricing):
    if pricing and pricing.get("implicit_cache_writes"):
        return (f"Cache-write tokens were not reported for {count} usage response(s); the provider writes every prompt "
                "to its cache, so their uncached prompt tokens are priced as cache writes.")
    return (f"Cache-creation tokens were not reported for {count} usage response(s); estimates assume zero "
            "cache-creation tokens and price remaining unclassified input at the input rate.")


def reconcile_trace(path, model, pricing):
    """Price a Script ReAct attempt from its model-request-trace.jsonl with the same per-response rules as
    reconcile_run, and write the result into stats.json (the harness's own figure stays as harness_cost_usd)."""
    path = Path(path)
    stats_path = path / "stats.json"
    stats = json.loads(stats_path.read_text()) if stats_path.exists() else {}
    trace = path / "model-request-trace.jsonl"
    if not trace.exists():
        return stats
    requests, usages = 0, []
    for line in trace.read_text().splitlines():
        event = json.loads(line)
        if event.get("phase") == "request":
            requests += 1
        elif event.get("phase") == "response" and isinstance(event.get("usage"), dict):
            usages.append(event["usage"])
    costs = [response_cost(usage, pricing) for usage in usages]
    estimates = [response_cost(usage, pricing, billed=False) for usage in usages]
    billed = sum(reported_charge(usage) is not None for usage in usages)
    complete = bool(usages) and len(usages) == requests
    unreported = sum(not cache_writes_reported(usage) and reported_charge(usage) is None for usage in usages)
    stats.setdefault("harness_cost_usd", stats.get("cost_usd"))
    stats.update({"cost_usd": sum(costs) if complete and None not in costs else None,
                  "reported_usage_cost_usd": sum(c for c in costs if c is not None) if any(c is not None for c in costs) else None,
                  "estimated_cost_usd": sum(estimates) if complete and None not in estimates else None,
                  "provider_reported_cost_usd": sum(reported_charge(usage) for usage in usages) if complete and billed == len(usages) else None,
                  "cost_basis": cost_basis(billed, len(usages)), "usage_complete": complete,
                  "model_requests": requests, "model_responses_with_usage": len(usages),
                  "cost_estimate_assumptions": [unreported_cache_write_assumption(unreported, pricing)] if unreported else [],
                  "pricing": pricing, "requested_model": model})
    stats_path.write_text(json.dumps(stats, indent=2) + "\n")
    return stats


def reconcile_run(path, model, pricing, wire_root=None):
    """Price a BobFlow attempt from its wire traces (copied from `wire_root`/<agent id> when given): per-response usage,
    cost and latency into stats.json (the harness's streamed figures stay in harness-stats.json), and the usage audit
    into metrics-audit.json."""
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
    provider_costs, providers, raw_usages = [], set(), []
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
        charge = reported_charge(response["usage"])
        if charge is not None:
            provider_costs.append(charge)
        raw_usages.append(response["usage"])
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
    costs = [response_cost(usage, pricing) for usage in raw_usages]
    estimates = [response_cost(usage, pricing, billed=False) for usage in raw_usages]
    known = bool(costs) and all(cost is not None for cost in costs)
    provider_complete = complete and len(provider_costs) == len(metas)
    cache_reporting = {key: {"reported_responses": count, "unreported_responses": len(usages) - count,
                             "complete": complete and count == len(metas)}
                       for key, count in cache_reports.items()}
    assumptions = []
    missing = cache_reporting["cached_tokens"]["unreported_responses"]
    if missing:
        assumptions.append(f"Cache-read tokens were not reported for {missing} usage response(s); "
                           "estimates assume zero cache-read tokens and price remaining unclassified input at the input rate.")
    missing = cache_reporting["cache_creation_tokens"]["unreported_responses"]
    if missing:
        assumptions.append(unreported_cache_write_assumption(missing, pricing))
    stats.update({"cost_usd": sum(costs) if complete and known else None,
                  "reported_usage_cost_usd": sum(c for c in costs if c is not None) if any(c is not None for c in costs) else None,
                  "estimated_cost_usd": sum(estimates) if complete and estimates and None not in estimates else None,
                  "cost_basis": cost_basis(len(provider_costs), len(raw_usages)),
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
             "costs": {"cost_usd": "Per response, the provider's reported charge where it sends one (OpenRouter usage.cost), else the frozen public token-rate estimate; null when any request lacks usage.",
                       "reported_usage_cost_usd": "The same per-response cost over the responses with known usage and pricing.",
                       "estimated_cost_usd": "Frozen public token-rate estimate for every response; not an invoice.",
                       "cost_basis": "provider_reported, token_estimate, or mixed across the attempt's responses.",
                       "provider_reported_cost_usd": "Sum of response usage.cost only when every gateway request reports cost."},
             "timing": {"elapsed_seconds": "Agent turn wall time, including model and tools; excludes scoring.",
                        "model_latency_seconds": "Sum of captured gateway request durations; includes transport and gateway overhead."}}
    stats_path.write_text(json.dumps(stats, indent=2) + "\n")
    (path / "metrics-audit.json").write_text(json.dumps(audit, indent=2) + "\n")
    return stats, audit


def backup_once(path, suffix=".before-billing-fix.json"):
    if path.exists() and not path.with_name(path.stem + suffix).exists():
        shutil.copyfile(path, path.with_name(path.stem + suffix))


def run_pricing(manifest, model):
    """The schedule an attempt of `model` is priced with: today's frozen rates, else the ones the run recorded."""
    return (price_schedule(model) or (manifest.get("pricing_schedules") or {}).get(model)
            or manifest.get("price_schedule"))


def recost(root):
    """Re-price a finished run's preserved attempts with the current per-response rules, changing only cost: each
    attempt's stats.json (and metrics-audit.json) and the progress rows' cost_usd. The first rewrite keeps the previous
    files as *.before-billing-fix.json. BobFlow attempts are priced from wire/, Script ReAct attempts from
    model-request-trace.jsonl. No model or judge is called."""
    root = Path(root)
    manifest = json.loads((root / "manifest.json").read_text())
    progress = json.loads((root / "progress.json").read_text())
    backup_once(root / "progress.json")
    repriced = 0
    for row in progress["completed"]:
        path = root / "system_scratch" / row["sut"] / row["task"]
        model = manifest["models"][row["model"]]
        pricing = run_pricing(manifest, model)
        if (path / "wire").is_dir():
            backup_once(path / "stats.json")
            backup_once(path / "metrics-audit.json")
            stats, _ = reconcile_run(path, model, pricing)
        elif (path / "model-request-trace.jsonl").exists():
            backup_once(path / "stats.json")
            stats = reconcile_trace(path, model, pricing)
        else:
            continue
        row["cost_usd"] = stats.get("cost_usd")
        repriced += 1
    (root / "progress.json").write_text(json.dumps(progress, indent=2) + "\n")
    return repriced


def main():
    parser = argparse.ArgumentParser(prog="bench recost", description=recost.__doc__)
    parser.add_argument("run", type=Path)
    parser.add_argument("--stopped", action="store_true",
                        help="the run's progress still says running, but its runner is known to be gone")
    args = parser.parse_args()
    progress = json.loads((args.run / "progress.json").read_text())
    if progress.get("status") == "running" and not args.stopped:
        parser.error("Wait for the run to finish before re-pricing it (or pass --stopped).")
    print(f"Re-priced {recost(args.run)} preserved attempts; no model or judge calls.")


if __name__ == "__main__":
    main()
