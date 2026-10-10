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
"""Audit saved evidence-matrix wire prompts, displays, telemetry and accounting.

This makes no service, provider or scoring calls. It complements campaign.py's
profile invariants and official evaluation; it does not judge answer correctness.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import re

try:
    from .metrics import retrieval_results
except ImportError:
    from metrics import retrieval_results


def read(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def content_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(part.get("text", "") for part in content if isinstance(part, dict))
    return ""


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def retrieval_enums(value):
    """Find action variants without depending on JSON Schema wrapper depth."""
    if isinstance(value, dict):
        properties = value.get("properties", {})
        if properties.get("type", {}).get("const") == "retrieve":
            yield properties.get("view", {}).get("enum")
        for child in value.values():
            yield from retrieval_enums(child)
    elif isinstance(value, list):
        for child in value:
            yield from retrieval_enums(child)


FLOW_LINE = re.compile(r"^\s*-\s*flow(?: \([^\n]*\))?:", re.MULTILINE)
DATA_LINE = re.compile(r"^\s*(?:-\s*)?statistics:", re.MULTILINE)
DATA_TABLE = re.compile(r"^\s*statistics: (?:full table|partial profile), [\d,]+ of ", re.MULTILINE)
ACTION_HEADING = re.compile(r"^### \d+\. (inspect|edit|execute|retrieve|answer)\b", re.MULTILINE)
TEXT_HEADING = re.compile(r"^## (edits (?:applied|rejected)|execute\b[^\n]*|show (?:result|schema|operator|function|builtin)\b[^\n]*|turn rejected|answer)\s*$", re.MULTILINE)
TEXT_RETRIEVAL_VIEW = re.compile(r"^[ \t]*show[ \t]+result[ \t]+[A-Za-z_]\w*[^\n]*[ \t]+(full|sample_stats|sample)[ \t]*$", re.MULTILINE)
FULL_STATISTICS = re.compile(r"statistics: full table, ([\d,]+) of ([\d,]+) rows, ([\d,]+) of ([\d,]+) columns")
COMPLETE_RECORDS = re.compile(r"^records:.*\(complete(?:;|\))", re.MULTILINE)


def audit_attempt(path, settings):
    path = Path(path)
    views = settings.get("retrievalViews", [])
    config = read(path / "config.json", {})
    driver = settings.get("driver", config.get("driver"))
    text_transport = settings.get("nativeTransport") == "text" or driver == "text-turn"
    # The turn tool carries statements, so its schema names no retrieval view;
    # the receipt (a tool message) uses the text transport's headings.
    turn_transport = settings.get("nativeTransport") == "turn" or driver == "turn-tool"
    data_enabled, flow_enabled = "sample_stats" in views, bool(settings.get("flowEvidence"))
    violations, warnings, details = set(), set(), []
    counters = {key: Counter() for key in ("observations", "retrievals", "execution", "profiles")}

    def issue(kind, location, warning=False):
        (warnings if warning else violations).add(kind)
        details.append({"kind": kind, "location": location, "severity": "warning" if warning else "violation"})

    def display(text, location):
        if not isinstance(text, str):
            return
        if not flow_enabled and FLOW_LINE.search(text):
            issue("flow_markdown_leak", location)
        if not data_enabled and DATA_LINE.search(text):
            issue("data_markdown_leak", location)
        if any(key in text for key in ("execution_runs", "compilationDurationMs", "runtimeStartAttempted")):
            issue("internal_telemetry_in_observation", location)
        for match in FULL_STATISTICS.finditer(text):
            rows, total, columns, total_columns = [int(value.replace(",", "")) for value in match.groups()]
            if rows != total or columns > total_columns:
                issue("false_full_statistics_caption", location)

    requests = sorted((path / "wire").glob("*-request.json"))
    previous = tools_hash = system_hash = None
    wire_prefix_checks = 0
    seen_observations = set()
    system_hashes = set()
    for request_path in requests:
        request = read(request_path, {})
        location = request_path.name
        messages = request.get("messages", [])
        if previous is not None:
            wire_prefix_checks += 1
            if messages[:len(previous)] != previous:
                issue("wire_prefix_changed", location)
        previous = messages
        current_tools = digest(request.get("tools"))
        if tools_hash is not None and current_tools != tools_hash:
            issue("tool_schema_changed", location)
        tools_hash = current_tools
        enums = list(retrieval_enums(request.get("tools", [])))
        if text_transport:
            if request.get("tools"):
                issue("tools_in_text_transport", location)
        elif turn_transport:
            if not request.get("tools"):
                issue("missing_turn_tool", location)
            if request.get("tool_choice") not in (None, "auto"):
                issue("forced_tool_choice_in_turn_transport", location)
        elif not enums:
            issue("missing_retrieval_schema", location)
        elif any(enum != views for enum in enums):
            issue("retrieval_schema_mismatch", location)
        if not text_transport and request.get("parallel_tool_calls") is not False:
            issue("parallel_tool_calls_not_disabled", location)
        # OpenAI-compatible gateways may encode the same application system
        # prompt as a developer message. Audit both high-priority wire roles.
        system = "\n".join(content_text(m.get("content")) for m in messages if m.get("role") in ("system", "developer"))
        current_system = digest(system)
        system_hashes.add(current_system)
        if system_hash is not None and current_system != system_hash:
            issue("system_prompt_changed", location)
        system_hash = current_system
        if not (re.search(r"Python functions you (?:can )?register", system) and
                re.search(r"(?:isolated environment|execution runs in isolation)", system)):
            issue("registered_prompt_missing", location)
        if text_transport and "summary:" not in system and "Each message you send is one turn" not in system:
            issue("text_prompt_missing", location)
        if turn_transport and "`statements`" not in system:
            issue("turn_prompt_missing", location)
        if bool(re.search(r"Column statistics (?:are collected|in `sample_stats`)", system)) != data_enabled:
            issue("data_prompt_mismatch", location)
        if bool(re.search(r"Flow statistics (?:describe measured|report measured)", system)) != flow_enabled:
            issue("flow_prompt_mismatch", location)
        example_views = re.findall(r'"view"\s*:\s*"(full|sample_stats|sample)"', system)
        if text_transport or turn_transport:
            example_views.extend(TEXT_RETRIEVAL_VIEW.findall(system))
            # Turn-tool examples carry their statements inside JSON strings.
            unquoted = re.sub(r'["}\]]+', "", system.replace("\\n", "\n"))
            example_views.extend(TEXT_RETRIEVAL_VIEW.findall(unquoted))
        if any(view not in views for view in example_views):
            issue("disabled_view_in_prompt_example", location)
        for index, message in enumerate(messages):
            role = message.get("role")
            text = content_text(message.get("content"))
            # Text receipts follow an assistant turn; a task containing a quoted
            # receipt is not itself an environment observation. Adjacent feedback
            # messages are left out. Position is stable in the append-only wire log.
            text_receipt = (text_transport and role == "user" and index > 0 and
                            messages[index - 1].get("role") == "assistant" and TEXT_HEADING.search(text))
            if role != "tool" and not text_receipt:
                continue
            # The same tool receipt is replayed on every later model request.
            identity = (index if text_receipt else message.get("tool_call_id"), text)
            if identity in seen_observations:
                continue
            seen_observations.add(identity)
            counts = counters["observations"]
            counts["text_receipts" if text_receipt else "tool_messages"] += 1
            counts["characters"] += len(text)
            counts["max_characters"] = max(counts["max_characters"], len(text))
            counts["with_flow"] += bool(FLOW_LINE.search(text))
            counts["with_statistics_caption"] += bool(DATA_LINE.search(text))
            counts["with_table_statistics"] += bool(DATA_TABLE.search(text))
            for action in ACTION_HEADING.findall(text):
                counts[f"{action}_blocks"] += 1
            if text_receipt or turn_transport:
                for heading in TEXT_HEADING.findall(text):
                    action = "edit" if heading.startswith("edits ") else "retrieve" if heading.startswith("show result") else "inspect" if heading.startswith("show ") else heading.split()[0]
                    counts[f"{action}_blocks"] += 1
            display(text, f"{location}:{role}:{index if text_receipt else message.get('tool_call_id', '?')}")
    if not requests:
        issue("missing_wire_requests", "wire", warning=True)

    snapshot = read(path / "snapshot.json", {})
    saved_results = snapshot.get("results", {})
    raw = read(path / "react_steps.json", None)
    if raw is None:
        issue("missing_trace", "react_steps.json", warning=True)
    steps = raw if isinstance(raw, list) else (raw or {}).get("steps", [])
    answers = action_failures = 0
    for step in steps:
        for result in step.get("toolResults", []):
            output = result.get("output")
            if not isinstance(output, dict):
                continue
            if output.get("actions") and output.get("protocol") != "registered-python-v1":
                issue("wrong_action_protocol", f"step:{step.get('stepId')}")
            for index, item in enumerate(output.get("actions", []), 1):
                action, observed = item.get("action", {}), item.get("output") or {}
                location = f"step:{step.get('stepId')}/action:{index}"
                action_failures += item.get("status") == "error"
                answers += action.get("type") == "answer" and item.get("status") == "ok"
                if not isinstance(observed, dict):
                    continue
                # These fields form Markdown even for execute and inspect, where
                # retrieval evidence IDs alone cannot detect an exposure leak.
                for block in observed.get("operator_blocks", []):
                    display("\n".join(block.get("issues", [])), location)
                if action.get("type") == "execute":
                    counts = counters["execution"]
                    counts["actions"] += 1
                    operators = observed.get("operators", [])
                    counts.update(f"operators_{op.get('state', 'unknown')}" for op in operators)
                    runs = observed.get("execution_runs")
                    if runs is None and any(op.get("state") == "executed" for op in operators):
                        issue("missing_execution_runs", location)
                    for run in runs or []:
                        counts["runs"] += 1
                        counts["succeeded" if run.get("success") else "failed"] += 1
                        phases = run.get("phaseMetrics")
                        if not phases:
                            counts["phase_metrics_unknown"] += 1
                            issue("execution_phase_metrics_unknown", location, warning=True)
                            continue
                        counts["with_phase_metrics"] += 1
                        for name, value in phases.items():
                            if name.endswith("DurationMs") and isinstance(value, (float, int)):
                                if value < 0:
                                    issue("negative_execution_duration", location)
                                counts[name] += value
                if action.get("type") == "retrieve":
                    counts = counters["retrievals"]
                    requested = action.get("operator_ids") or ([action["operator_id"]] if action.get("operator_id") else [])
                    counts["actions_requested"] += 1
                    counts["targets_requested"] += len(requested)
                    if action.get("view") == "sample_stats":
                        counts["stats_actions_requested"] += 1
                        counts["stats_targets_requested"] += len(requested)
                for target in retrieval_results(item):
                    if target.get("status") != "ok":
                        continue
                    counts = counters["retrievals"]
                    counts["targets"] += 1
                    counts[f"view_{action.get('view')}"] += 1
                    text, facts, table = target.get("text", ""), target.get("evidence", []), target.get("table", {})
                    counts["characters"] += len(text)
                    counts["max_characters"] = max(counts["max_characters"], len(text))
                    any_data = any(f.startswith("data.") for f in facts)
                    # Exposure markers describe why data was not shown; they
                    # are not measurements and must not inflate treatment use.
                    data_facts = any(f.startswith("data.") and f not in ("data.complete", "data.status") for f in facts)
                    flow_facts = any(f.startswith("flow.") for f in facts)
                    counts["with_data_facts"] += data_facts
                    counts["with_statistics_caption"] += bool(DATA_LINE.search(text))
                    counts["with_table_statistics"] += bool(DATA_TABLE.search(text))
                    counts["statistics_suppressed_complete"] += "data.complete" in facts or "statistics: not shown; the complete records" in text
                    counts["statistics_unavailable"] += "statistics: unavailable" in text
                    counts["statistics_omitted_budget"] += "statistics: omitted (budget)" in text
                    counts["with_flow_facts"] += flow_facts
                    target_location = f"{location}/{target.get('operator_id')}"
                    display(text, target_location)
                    if action.get("view") not in views:
                        issue("unexpected_retrieval_view", target_location)
                    if action.get("view") != "sample_stats" and any_data:
                        issue("data_evidence_leak", target_location)
                    if not flow_enabled and flow_facts:
                        issue("flow_evidence_leak", target_location)
                    if table.get("complete"):
                        counts["complete"] += 1
                        if table.get("returnedRows") != table.get("totalRows") or table.get("columnsShown") != table.get("totalColumns"):
                            issue("false_complete_result", target_location)
                        if action.get("view") == "sample_stats" and not data_facts and not DATA_TABLE.search(text):
                            counts["complete_small_without_stats"] += 1
                    elif COMPLETE_RECORDS.search(text):
                        issue("false_complete_caption", target_location)
                    elif action.get("view") == "full":
                        counts["partial_full"] += 1
                    for match in FULL_STATISTICS.finditer(text):
                        rows, total_rows, columns, total_columns = (int(n.replace(",", "")) for n in match.groups())
                        if rows != total_rows or columns > total_columns or total_rows != table.get("totalRows"):
                            issue("false_full_statistics_caption", target_location)
                        current = saved_results.get(target.get("operator_id"), {})
                        same_version = target.get("result_version") and target["result_version"] == current.get("resultVersion", {}).get("id")
                        if same_version and current.get("tableProfile", {}).get("coverage", {}).get("complete") is False:
                            issue("full_statistics_for_partial_profile", target_location)
                    if action.get("view") == "sample_stats" and not table.get("complete") and not DATA_LINE.search(text):
                        # Unavailable/suppressed/budgeted data is not automatically a bug.
                        counts["partial_without_statistics_caption"] += 1
                        issue("partial_stats_coverage_requires_review", target_location, warning=True)

    for operator, info in saved_results.items():
        profile = info.get("tableProfile")
        if not profile:
            continue
        counts = counters["profiles"]
        counts["retained"] += 1
        counts[profile.get("status", "unknown")] += 1
        counts["schema_fields"] += len(info.get("resultSchema", [])) if isinstance(info.get("resultSchema"), list) else 0
        scan = (profile.get("native") or {}).get("operations", {}).get("scan")
        if not isinstance(scan, dict):
            continue
        counts["scans"] += 1
        sources = scan.get("sources", [])
        counts["source_identities"] += len(sources)
        counts["source_details_omitted"] += scan.get("sourceDetailsOmitted", 0)
        counts["source_identities_omitted"] += scan.get("sourcesOmitted", 0)
        if not sources and (scan.get("selectedFiles", 0) > 0 or scan.get("sourcesOmitted", 0) > 0):
            issue("scan_source_identity_missing", f"snapshot:{operator}")
        if sources and any(not isinstance(source, dict) or not source.get("path") for source in sources):
            issue("scan_source_path_missing", f"snapshot:{operator}")

    stats = read(path / "stats.json", {})
    accounting = {key: stats.get(key) for key in (
        "model_requests", "input_tokens", "output_tokens", "cached_tokens", "cache_creation_tokens", "reasoning_tokens",
        "cost_usd", "provider_reported_cost_usd", "usage_complete", "provider_cost_complete",
        "cache_usage_reporting", "cost_estimate_assumptions", "elapsed_seconds", "model_latency_seconds")}
    cache_reads = stats.get("cache_usage_reporting", {}).get("cached_tokens", {})
    reads_complete = cache_reads.get("complete")
    known_reads_complete = reads_complete or (
        cache_reads.get("reported_responses", 0) > 0 and cache_reads.get("unreported_responses") == 0)
    known_fraction = (
        stats["cached_tokens"] / stats["input_tokens"]
        if known_reads_complete and stats.get("input_tokens") and stats.get("cached_tokens") is not None else None)
    accounting["known_usage_cache_read_fraction"] = known_fraction
    accounting["cache_read_fraction"] = known_fraction if reads_complete and stats.get("usage_complete") is True else None
    if stats and not stats.get("cache_usage_reporting"):
        issue("cache_class_reporting_unknown", "stats.json", warning=True)
    return {"violations": sorted(violations), "warnings": sorted(warnings), "details": details,
            "wire_requests": len(requests), "wire_prefix_checks": wire_prefix_checks,
            "system_prompt_hashes": sorted(system_hashes), "answers": answers, "action_failures": action_failures,
            **{key: dict(counts) for key, counts in counters.items()}, "accounting": accounting}


def audit_matrix(directory):
    directory = Path(directory)
    manifest = read(directory / "manifest.json", {})
    rows = []
    groups = defaultdict(list)
    for job in manifest.get("jobs", []):
        path = directory / "system_scratch" / job["sut"] / job["task"]
        present = (path / "react_steps.json").exists()
        settings = {**manifest.get("settings", {}), **manifest.get("arms", {}).get(job["arm"], {})}
        if manifest.get("driver"):
            settings["driver"] = manifest["driver"]
        row = {**job, "audit": audit_attempt(path, settings) if present else None,
               "official_evaluation": read(path / "evaluation.json")}
        rows.append(row)
        groups[(job["model"], job["arm"])].append(row)
    summary = []
    for (model, arm), items in sorted(groups.items()):
        audits = [row["audit"] for row in items if row["audit"] is not None]
        summary.append({"model": model, "arm": arm, "expected": len(items), "present": len(audits),
                        "violation_attempts": sum(bool(a["violations"]) for a in audits),
                        "warning_attempts": sum(bool(a["warnings"]) for a in audits),
                        "answers": sum(a["answers"] for a in audits),
                        "wire_requests": sum(a["wire_requests"] for a in audits),
                        "wire_prefix_checks": sum(a["wire_prefix_checks"] for a in audits),
                        "execution_runs": sum(a["execution"].get("runs", 0) for a in audits),
                        "phase_metrics_unknown": sum(a["execution"].get("phase_metrics_unknown", 0) for a in audits)})
    return {"attempts_expected": len(rows), "attempts_present": sum(row["audit"] is not None for row in rows),
            "violation_attempts": sum(bool(row["audit"] and row["audit"]["violations"]) for row in rows),
            "summary": summary, "rows": rows,
            "interpretation": "Offline contract audit, not an answer judge. Missing observations and telemetry remain unknown. "
            "Profiles cover retained final results; wire display checks cover receipts actually sent to a later model request. "
            "A complete small result may suppress statistics. Source provenance is collected independently of display settings. "
            "Costs are frozen-rate estimates, with provider-reported costs and absent cache classifications kept separate."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--output", type=Path, help="Defaults to DIRECTORY/matrix-audit.json")
    args = parser.parse_args()
    result = audit_matrix(args.directory)
    output = args.output or args.directory / "matrix-audit.json"
    output.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({key: result[key] for key in ("attempts_expected", "attempts_present", "violation_attempts", "summary")}, indent=2))


if __name__ == "__main__":
    main()
