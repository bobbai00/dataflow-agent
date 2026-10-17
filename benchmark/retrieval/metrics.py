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
    """Frozen standard-tier token estimates; not invoices. Where a response carries the provider's own charge
    (OpenRouter), response_cost uses that charge and these rates only estimate responses without one."""
    openrouter = "rates fitted to the usage.cost_details OpenRouter returned on the campaign's responses"
    providers = {
        "gpt-5.6-luna": ((.2, 1.2, .02, .25), "https://developers.openai.com/api/docs/models/gpt-5.6-luna", "2026-10-12"),
        "gpt-5.6-terra": ((2, 12, .2, 2.5), "https://developers.openai.com/api/docs/models/gpt-5.6-terra", "2026-10-12"),
        "gpt-5.6-sol": ((4, 20, .4, 5), "https://developers.openai.com/api/docs/models/gpt-5.6-sol", "2026-10-12"),
        "gpt-6.1-sol": ((2, 10, .1, 2.5), "https://developers.openai.com/api/docs/models/gpt-6.1-sol", "2026-10-16"),
        "claude-opus-4.8": ((5, 25, .5, 6.25), "https://platform.claude.com/docs/en/models/opus-4-8/overview", "2026-10-08"),
        "claude-opus-5.5": ((4, 20, .2, 5), "https://platform.claude.com/docs/en/models/opus-5-5/overview", "2026-10-12"),
        # OpenRouter models: the rates the routes' pinned providers billed (Parasail for Qwen, DeepInfra for
        # DeepSeek), not OpenRouter's listing, which was 1.2-2.9x higher per rate. Neither bills cache writes.
        "qwen3.8-27b": ((.24, 2.2, .05, None), openrouter + " (Parasail)", "2026-10-12"),
        # The same model with thinking switched off at the gateway (qwen3.8-27b-nothink route).
        "qwen3.8-27b-nothink": ((.24, 2.2, .05, None), openrouter + " (Parasail)", "2026-10-12"),
        "deepseek-v4.1-flash": ((.14, .42, .0042, None), openrouter + " (DeepInfra)", "2026-10-12"),
        "claude-haiku-5.5": ((.1, .5, .01, .125), "https://platform.claude.com/docs/en/about-claude/pricing", "2026-10-08"),
        # The same model with adaptive thinking at effort low (claude-haiku-5.5-lowthink route).
        "claude-haiku-5.5-lowthink": ((.1, .5, .01, .125), "https://platform.claude.com/docs/en/about-claude/pricing", "2026-10-17"),
        # Gemini 4 Argon through OpenRouter on Google AI Studio (standard tier); OpenRouter reports each response's
        # charge, so these rates only price a response without one. Implicit caching only; the rates double on
        # 2026-12-01. The -medium route is the same model with reasoning effort medium.
        "gemini-4-argon": ((2, 10, .1, None), "https://ai.google.dev/gemini-api/docs/pricing (through 2026-11-30)", "2026-10-16"),
        "gemini-4-argon-medium": ((2, 10, .1, None), "https://ai.google.dev/gemini-api/docs/pricing (through 2026-11-30)", "2026-10-16"),
    }
    if model not in providers:
        return None
    rates, source, verified = providers[model]
    # GPT-6.1 Sol follows GPT-5.6's billing rules: the 272K long-prompt rates, and every prompt written to its cache.
    gpt_cache_rules = model.startswith(("gpt-5.6-", "gpt-6.1-"))
    haiku55 = model in ("claude-haiku-5.5", "claude-haiku-5.5-lowthink")
    return {"model": model, "kind": "token_estimate", "currency": "USD", "unit": "per_token",
            "verified_on": verified, "source": source,
            "rates": {k: v / 1e6 if v is not None else None for k, v in
                      zip(("input", "output", "cache_read", "cache_creation"), rates)},
            "long_context_threshold": 272000 if gpt_cache_rules else 100000 if haiku55 else None,
            # Haiku 5.5 bills every token class at 5x once a prompt exceeds 100k tokens.
            **({"long_context_multiplier": 5} if haiku55 else {}),
            # GPT-5.6 and GPT-6.1 write every prompt to their cache (implicit mode) and bill writes at 1.25x input
            # (https://developers.openai.com/api/docs/guides/prompt-caching); usage that omits the write count
            # still incurred them. GPT-6.1 Sol's Responses usage reported 3,624 writes on a fresh 3,627-token prompt.
            **({"implicit_cache_writes": True} if gpt_cache_rules else {}),
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


def cost_for_usage(usage, pricing, implicit_cache_writes=False):
    """Frozen-rate estimate for one normalized usage. With implicit_cache_writes, the uncached prompt tokens are
    priced as cache writes: the provider wrote them to its cache without reporting the count."""
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
    """Price a script-agent attempt from its model-request-trace.jsonl with the same per-response rules as
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


# The step the agent records when a turn is stopped, e.g. by the runner's
# wall-clock watchdog. It ends the turn but is not a reply.
STOPPED_STEP = "Generation stopped by user."


def final_reply(steps):
    """The answer: the last agent step ends the task with text and no tool call."""
    agents = [step for step in steps if step.get("role") == "agent"]
    final = agents[-1] if agents else None
    return bool(final and final.get("isEnd") and not final.get("toolCalls") and final.get("content")
                and not str(final["content"]).startswith("Error:") and final["content"] != STOPPED_STEP)


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


def recost(root):
    """Re-price a finished run's preserved attempts with the current per-response rules, changing only cost:
    each attempt's stats.json (and metrics-audit.json) and the progress rows' cost_usd. The first rewrite keeps
    the previous files as *.before-billing-fix.json. Dataflow attempts are priced from wire/, script-agent
    attempts from model-request-trace.jsonl."""
    manifest = json.loads((root / "manifest.json").read_text())
    progress = json.loads((root / "progress.json").read_text())
    backup_once(root / "progress.json")
    repriced = 0
    for row in progress["completed"]:
        path = root / "system_scratch" / row["sut"] / row["task"]
        model = manifest["models"][row["model"]]
        pricing = (current_price_schedule(model) or (manifest.get("pricing_schedules") or {}).get(model)
                   or manifest.get("price_schedule"))
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
    """Recompute accounting and invariant checks offline from preserved artifacts."""
    import argparse
    try:
        from .campaign import audit_attempt
    except ImportError:
        from campaign import audit_attempt
    parser = argparse.ArgumentParser(description=main.__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--costs-only", action="store_true",
                        help="Re-price with the current rules and change nothing but cost fields (any runner kind).")
    parser.add_argument("--stopped", action="store_true",
                        help="The run's progress still says running, but its runner is known to be gone.")
    args = parser.parse_args()
    root = args.directory
    manifest = json.loads((root / "manifest.json").read_text())
    progress = json.loads((root / "progress.json").read_text())
    if progress.get("status") == "running" and not args.stopped:
        parser.error("Wait for the campaign to finish before rewriting its accounting.")
    if args.costs_only:
        print(f"Re-priced {recost(root)} preserved attempts; no model or scorer calls.")
        return
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
