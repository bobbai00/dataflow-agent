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
"""Per-attempt checks that a run did what its arm says, apart from the answer's correctness.

- audit_dataflow (runner, every BobFlow attempt -> attempt-audit.json): settings as configured, the context only ever
  appended, retrieval views and evidence exposure as the arm allows, table-profile equations, answer diagnostics, and
  the wire audit (audit_wire) of every model request: one system prompt, tool schema and prompt sections per arm,
  displays without leaked evidence, execution telemetry, accounting.
- audit_script (runner, every Script ReAct attempt): stats equal to the usage the request trace recorded.
- audit_run (bench audit): every attempt of a finished run again, offline, with a summary in <run>/matrix-audit.json.

A violation pauses the runner (PAUSE); a warning does not. None of this calls a model, a service or the judge.

    python -m bobbench.audit <run>     (bench audit)
"""
import argparse
from collections import Counter, defaultdict
from decimal import Decimal, DecimalException, InvalidOperation, ROUND_HALF_EVEN, ROUND_HALF_UP, localcontext
import hashlib
import json
from pathlib import Path
import re

from bobbench.react_steps import final_reply, retrieval_results, tool_error_counts


# ---------------------------------------------------------------------------------------------------------------------
# Answer diagnostics: matches establish support, not correctness.

NUMBER = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?")

def number(text):
    text = str(text).strip()
    if not NUMBER.fullmatch(text):
        return None
    try:
        value = Decimal(text)
        return value if value.is_finite() else None
    except InvalidOperation:
        return None

def rounded_equal(candidate, target):
    if candidate == target:
        return True
    exponent = target.as_tuple().exponent
    # Integer/scientific notation must not turn a different integer into a
    # match by rounding to tens or larger powers. Only fractional precision
    # permits rounding; extreme exponents remain inconclusive with bounded work.
    if exponent >= 0 or abs(exponent) > 4096 or abs(candidate.adjusted()) > 4096:
        return False
    precision = max(50, len(candidate.as_tuple().digits), candidate.adjusted() - exponent + 2)
    if precision > 4096:
        return False
    try:
        with localcontext() as ctx:
            ctx.prec = precision
            quantum = Decimal((0, (1,), exponent))
            return any(candidate.quantize(quantum, rounding=mode) == target for mode in (ROUND_HALF_EVEN, ROUND_HALF_UP))
    except DecimalException:
        return False


def record_number(cell):
    value = number(cell)
    if value is not None:
        return value
    # The renderer JSON-quotes string cells. Accept a whole numeric string,
    # never a numeric substring of labels such as "Age 60".
    try:
        decoded = json.loads(cell)
        return number(decoded) if isinstance(decoded, str) else None
    except (TypeError, ValueError):
        return None


def visible_numbers(text):
    # Restrict to record cells. Shape counts, schema labels and flow facts are
    # not answer cells; matching one of their numbers would be a false positive.
    values = set()
    header_seen = False
    for line in text.splitlines():
        if line.startswith(("statistics:", "- flow", "- runtime stats", "- note:")):
            break
        if line.startswith("|") and line.endswith("|"):
            cells = line[1:-1].split("|")
        elif "\t" in line:
            cells = line.split("\t")
        else:
            continue
        if not header_seen:
            header_seen = True
            continue
        values.update(value for cell in cells if (value := record_number(cell)) is not None)
    return values


def diagnose_answer(prompt, response, steps, snapshot):
    """Check the explicit KramaBench final-line contract and numeric cell support.

    Only successful, nonsuperseded reads of the same current result version
    qualify. Absence from bounded records is inconclusive, never an incorrect
    answer verdict. A matching value is not proof that the formula/population
    was correct. This does not alter official scores or rewrite responses.
    """
    final = response.strip().splitlines()[-1] if response.strip() else ""
    bold = re.fullmatch(r"\*\*Final Answer: (.+)\*\*", final)
    labelled = re.fullmatch(r"(?:\*\*)?Final Answer:\s*(.+?)(?:\*\*)?", final)
    value = bold.group(1) if bold else labelled.group(1) if labelled else final
    target = number(value)
    format_required = "**Final Answer:" in prompt
    observed = {}
    for step in steps:
        for result in step.get("toolResults", []):
            for item in (result.get("output") or {}).get("actions", []) if isinstance(result.get("output"), dict) else []:
                for read in retrieval_results(item):
                    if read.get("status") == "ok" and not read.get("superseded_in_call") and read.get("result_version"):
                        observed.setdefault((read.get("operator_id"), read["result_version"]), set()).update(visible_numbers(read.get("text", "")))
    matches = []
    if target is not None:
        for operator, info in snapshot.get("results", {}).items():
            version = (info.get("resultVersion") or {}).get("id")
            visible = observed.get((operator, version))
            if visible is None or info.get("error") or info.get("state") not in {"Completed", "CompletedFromCache"}:
                continue
            for row_index, row in enumerate(info.get("sampleRecords", info.get("result")) or []):
                for column, cell in row.items():
                    if isinstance(cell, bool) or cell is None:
                        continue
                    candidate = number(cell)
                    if candidate is None:
                        continue
                    # Require the cell itself to have been visible in the read,
                    # rather than merely present in a retained but hidden sample.
                    if not any(shown.as_tuple().exponent <= target.as_tuple().exponent and rounded_equal(candidate, shown) for shown in visible):
                        continue
                    if rounded_equal(candidate, target):
                        matches.append({"operator_id": operator, "result_version": version, "row": row_index, "column": column})
    return {"format_contract": "bold_final_answer_last_line" if format_required else None,
            "format_compliant": bool(bold) if format_required else None,
            "numeric_support": {"status": "not_numeric_scalar" if target is None else "observed_result_match" if matches else "not_found_in_observed_results",
                "matches": matches,
                "limitation": "Cell presence is support, not proof of the requested computation; absence from bounded records is inconclusive."}}


# ---------------------------------------------------------------------------------------------------------------------
# The wire audit: what every model request of a BobFlow attempt held.

def read(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def read_trace(path):
    """The attempt's trace, and whether it is the runner's watchdog copy. A
    harness stopped at the wall clock leaves no trace, or a truncated one; the
    watchdog copy fetched before the stop is then the complete trace."""
    for name in ("react_steps.json", "watchdog-react_steps.json"):
        try:
            return json.loads((path / name).read_text()), name != "react_steps.json"
        except (FileNotFoundError, ValueError):
            continue
    return None, False


def content_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(part.get("text", "") for part in content if isinstance(part, dict))
    return ""


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


# Flow evidence lines: `- runtime stats:` since 2026-10-14, `- flow:` on earlier agents.
FLOW_LINE = re.compile(r"^\s*-\s*(?:flow|runtime stats)(?: \([^\n]*\))?:", re.MULTILINE)
DATA_LINE = re.compile(r"^\s*(?:-\s*)?statistics:", re.MULTILINE)
DATA_TABLE = re.compile(r"^\s*statistics: (?:full table|partial profile), [\d,]+ of ", re.MULTILINE)
RECEIPT_HEADING = re.compile(r"^## (edits (?:applied|rejected)|execute\b[^\n]*|show (?:result|schema|operator|function|builtin)\b[^\n]*|(?:call|turn) rejected)\s*$", re.MULTILINE)
STATEMENT_VIEW = re.compile(r"^[ \t]*show[ \t]+result[ \t]+[A-Za-z_]\w*[^\n]*[ \t]+(full|sample_stats|sample)[ \t]*$", re.MULTILINE)
FULL_STATISTICS = re.compile(r"statistics: full table, ([\d,]+) of ([\d,]+) rows, ([\d,]+) of ([\d,]+) columns")
# The evidence guidance sentences of the system prompt, current and earlier wordings.
DATA_PROMPT = re.compile(r"Column statistics (?:are collected|in `sample_stats`)")
# Flow guidance left the system prompt (2026-10-13): the prompt is the same with
# flow on or off, and these earlier wordings and the flow example must not appear.
FLOW_PROMPT = re.compile(r"Flow (?:statistics (?:describe measured|report measured)|lines report what upstream steps did)"
                         r"|Use upstream measurements to repair a condition")
# Earlier agents explained flow lines with a note in each tool result that carried one;
# since 2026-10-14 the system prompt explains runtime stats instead (flow on only).
FLOW_NOTE = re.compile(r"^note: (?:`- flow:` lines show|a `- flow:` line reports)", re.MULTILINE)
RUNTIME_PROMPT = re.compile(r"Runtime stats are very helpful for validating your result")
COMPLETE_RECORDS = re.compile(r"^records:.*\(complete(?:;|\))", re.MULTILINE)


def audit_wire(path, settings):
    path = Path(path)
    views = settings.get("retrievalViews", [])
    data_enabled, flow_enabled = "sample_stats" in views, bool(settings.get("flowEvidence"))
    violations, warnings, details = set(), set(), []
    counters = {key: Counter() for key in ("observations", "retrievals", "execution", "profiles")}

    def issue(kind, location, warning=False):
        (warnings if warning else violations).add(kind)
        details.append({"kind": kind, "location": location, "severity": "warning" if warning else "violation"})

    def display(text, location):
        if not isinstance(text, str):
            return
        if not flow_enabled and (FLOW_LINE.search(text) or FLOW_NOTE.search(text)):
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
        # The dataflow tool carries statements, so its schema names no
        # retrieval view; the model answers by replying without it.
        if not request.get("tools"):
            issue("missing_dataflow_tool", location)
        if request.get("tool_choice") not in (None, "auto"):
            issue("forced_tool_choice", location)
        if request.get("parallel_tool_calls") is not False:
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
        if "`statements`" not in system:
            issue("dataflow_prompt_missing", location)
        if bool(DATA_PROMPT.search(system)) != data_enabled:
            issue("data_prompt_mismatch", location)
        if FLOW_PROMPT.search(system) or bool(RUNTIME_PROMPT.search(system)) != flow_enabled:
            issue("flow_prompt_mismatch", location)
        example_views = STATEMENT_VIEW.findall(system)
        # Example calls carry their statements inside JSON strings.
        unquoted = re.sub(r'["}\]]+', "", system.replace("\\n", "\n"))
        example_views.extend(STATEMENT_VIEW.findall(unquoted))
        if any(view not in views for view in example_views):
            issue("disabled_view_in_prompt_example", location)
        for index, message in enumerate(messages):
            role = message.get("role")
            text = content_text(message.get("content"))
            if role != "tool":
                continue
            # The same tool receipt is replayed on every later model request.
            identity = (message.get("tool_call_id"), text)
            if identity in seen_observations:
                continue
            seen_observations.add(identity)
            counts = counters["observations"]
            counts["tool_messages"] += 1
            counts["characters"] += len(text)
            counts["max_characters"] = max(counts["max_characters"], len(text))
            counts["with_flow"] += bool(FLOW_LINE.search(text))
            counts["with_statistics_caption"] += bool(DATA_LINE.search(text))
            counts["with_table_statistics"] += bool(DATA_TABLE.search(text))
            for heading in RECEIPT_HEADING.findall(text):
                action = ("edit" if heading.startswith("edits ") else "retrieve" if heading.startswith("show result")
                          else "inspect" if heading.startswith("show ") else "rejected" if heading.endswith("rejected")
                          else heading.split()[0])
                counts[f"{action}_blocks"] += 1
            display(text, f"{location}:{role}:{message.get('tool_call_id', '?')}")
    if not requests:
        issue("missing_wire_requests", "wire", warning=True)

    snapshot = read(path / "snapshot.json", {})
    saved_results = snapshot.get("results", {})
    raw, watchdog_trace = read_trace(path)
    if raw is None:
        issue("missing_trace", "react_steps.json", warning=True)
    steps = raw if isinstance(raw, list) else (raw or {}).get("steps", [])
    action_failures = 0
    answers = int(final_reply(steps))
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
                    requested = action.get("operator_ids") or []
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
                    # dataHygiene's null-count line in a view without statistics is not a leak.
                    any_data = any(f.startswith("data.") and not (f == "data.nulls" and settings.get("dataHygiene"))
                                   for f in facts)
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
            "watchdog_trace": watchdog_trace,
            **{key: dict(counts) for key, counts in counters.items()}, "accounting": accounting}


def audit_matrix(directory):
    directory = Path(directory)
    manifest = read(directory / "manifest.json", {})
    rows = []
    groups = defaultdict(list)
    for job in manifest.get("jobs", []):
        path = directory / "system_scratch" / job["sut"] / job["task"]
        present = any((path / name).exists() for name in ("react_steps.json", "watchdog-react_steps.json"))
        settings = {**manifest.get("settings", {}), **manifest.get("arms", {}).get(job["arm"], {})}
        row = {**job, "audit": audit_wire(path, settings) if present else None,
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
                        "watchdog_traces": sum(a["watchdog_trace"] for a in audits),
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


# ---------------------------------------------------------------------------------------------------------------------
# BobFlow

def audit_dataflow(path, settings):
    """Flag engine/context invariants separately from normal model mistakes."""
    violations, warnings = [], []

    def read(name, default):
        file = path / name
        if not file.exists():
            return default
        try:
            return json.loads(file.read_text())
        except ValueError:
            # A harness terminated at the wall clock can leave a truncated dump;
            # the runner's watchdog copy of the trace is complete.
            fallback = path / "watchdog-react_steps.json" if name == "react_steps.json" else None
            if fallback is not None and fallback.exists():
                try:
                    return json.loads(fallback.read_text())
                except ValueError:
                    pass
            warnings.append(f"unreadable_{name}")
            return default
    recorded = read("settings.json", None)
    if recorded is None:
        warnings.append("missing_settings")
    elif any(recorded.get(key) != value for key, value in settings.items()):
        violations.append("settings_drift")
    raw = read("react_steps.json", None)
    if raw is None:
        warnings.append("missing_trace")
    steps = raw if isinstance(raw, list) else (raw or {}).get("steps", [])
    previous, prefix_checks, action_errors, reads = None, 0, 0, 0
    text_replies = 0
    tool_errors = envelope_errors = 0
    # The agent answers with a final reply that calls no tool; any earlier
    # tool-less reply is a lapse.
    agent_steps = [step for step in steps if step.get("role") == "agent"]
    final = agent_steps[-1] if agent_steps else None
    answered = final_reply(steps)
    for step in steps:
        messages = step.get("inputMessages")
        if (step.get("role") == "agent" and messages is not None
                and not step.get("toolCalls") and step.get("content") and not (answered and step is final)):
            text_replies += 1
        if step.get("role") == "agent" and messages:
            if previous is not None:
                prefix_checks += 1
                if messages[:len(previous)] != previous:
                    violations.append("context_prefix_changed")
            previous = messages
        for result in step.get("toolResults", []):
            counts = tool_error_counts(result)
            tool_errors += counts["tool_errors"]
            envelope_errors += counts["envelope_errors"]
            output = result.get("output")
            if not isinstance(output, dict):
                continue
            for item in output.get("actions", []):
                action_errors += item.get("status") == "error"
                action = item.get("action", {})
                if action.get("type") != "retrieve":
                    continue
                for target in retrieval_results(item):
                    if target.get("status") != "ok":
                        continue
                    reads += 1
                    if action.get("view") not in settings["retrievalViews"]:
                        violations.append("unexpected_retrieval_view")
                    facts = target.get("evidence", [])
                    if not settings["flowEvidence"] and any(f.startswith("flow.") for f in facts):
                        violations.append("flow_evidence_leak")
                    # dataHygiene deliberately names the columns holding nulls in a view without
                    # statistics; every other data fact there is a leak.
                    allowed = {"data.nulls"} if settings.get("dataHygiene") else set()
                    if action.get("view") != "sample_stats" and any(
                            f.startswith("data.") and f not in allowed for f in facts):
                        violations.append("data_evidence_leak")
    if raw is not None:
        if text_replies:
            warnings.append("text_without_dataflow")
        if not answered:
            warnings.append("missing_answer")
    profiles = columns = 0
    for result in read("snapshot.json", {}).get("results", {}).values():
        profile = result.get("tableProfile")
        if not profile:
            continue
        profiles += 1
        version = result.get("resultVersion")
        if version and profile.get("resultVersion") != version["id"]:
            violations.append("profile_version_mismatch")
        for data in profile.get("columns", {}).values():
            columns += 1
            if data["nullCount"] + data["nonnullCount"] != data["rowsProcessed"]:
                violations.append("column_count_equation")
            if data["distinctCount"] is not None and data["distinctCount"] > data["nonnullCount"]:
                violations.append("distinct_exceeds_nonnull")
            frequencies = data.get("frequencies")
            if frequencies and sum(v["count"] for v in frequencies["values"]) + frequencies["otherCount"] != data["nonnullCount"]:
                violations.append("frequency_equation")
    diagnostics = diagnose_answer(
        (path / "prompt.txt").read_text() if (path / "prompt.txt").exists() else "",
        (path / "response.txt").read_text() if (path / "response.txt").exists() else "",
        steps, read("snapshot.json", {}))
    wire_audit = None
    if any((path / "wire").glob("*-request.json")):
        try:
            wire_audit = audit_wire(path, settings)
        except ValueError:
            warnings.append("unreadable_wire_audit_artifact")
        else:
            violations.extend(wire_audit["violations"])
            warnings.extend(wire_audit["warnings"])
    return {"answer_diagnostics": diagnostics, "wire_audit": wire_audit,
            "violations": sorted(set(violations)), "warnings": sorted(set(warnings)), "prefix_checks": prefix_checks,
            "action_errors": action_errors, "tool_errors": tool_errors, "envelope_errors": envelope_errors,
            "text_replies": text_replies, "retrievals": reads, "profiles": profiles, "columns": columns}

# ---------------------------------------------------------------------------------------------------------------------
# Script ReAct

def audit_script(path):
    """The attempt's stats must equal the usage its request trace recorded."""
    violations, warnings = [], []
    stats_file, trace_file = path / "stats.json", path / "model-request-trace.jsonl"
    if not stats_file.exists() or not trace_file.exists():
        return {"violations": [], "warnings": ["missing_script_stats_or_trace"]}
    stats = json.loads(stats_file.read_text())
    events = [json.loads(line) for line in trace_file.read_text().splitlines()]
    responses = [e for e in events if e["phase"] == "response"]
    totals = {"input_tokens": 0, "output_tokens": 0, "cached_tokens": 0, "cache_creation_tokens": 0}
    for response in responses:
        usage = response["usage"]
        details = usage.get("prompt_tokens_details") or {}
        totals["input_tokens"] += usage["prompt_tokens"]
        totals["output_tokens"] += usage["completion_tokens"]
        totals["cached_tokens"] += details.get("cached_tokens", 0) or 0
        totals["cache_creation_tokens"] += details.get("cache_creation_tokens", 0) or 0
    for key, value in totals.items():
        if value != stats[key]:
            violations.append("script_usage_mismatch:" + key)
    if (path / "wall-clock-stop.json").exists():
        warnings.append("task_timeout_usage_incomplete")
    elif not responses:
        violations.append("no_successful_provider_calls")
    if any(e["phase"] == "error" for e in events):
        warnings.append("provider_request_error")
    return {"violations": violations, "warnings": warnings, "provider_calls": len(responses), **totals}


def audit_run(run):
    """Audit every attempt of a finished run again (attempt-audit.json) and summarize the wire audits."""
    run = Path(run)
    manifest = read(run / "manifest.json", {})
    progress = read(run / "progress.json", {})
    summary = audit_matrix(run) if manifest.get("arms") else None
    rows = []
    for row in progress.get("completed", []):
        path = run / "system_scratch" / row["sut"] / row["task"]
        if manifest.get("arms"):
            checks = audit_dataflow(path, {**manifest.get("settings", {}), **manifest["arms"][row["arm"]]})
        else:
            checks = audit_script(path)
        (path / "attempt-audit.json").write_text(json.dumps(checks, indent=2) + "\n")
        rows.append({"task": row["task"], "sut": row["sut"], "violations": checks["violations"], "warnings": checks["warnings"]})
    if summary is not None:
        (run / "matrix-audit.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n")
    return rows


def main():
    parser = argparse.ArgumentParser(prog="bench audit", description=audit_run.__doc__)
    parser.add_argument("run", type=Path)
    args = parser.parse_args()
    rows = audit_run(args.run)
    flagged = [row for row in rows if row["violations"]]
    for row in flagged:
        print(f"{row['sut']} {row['task']}: {', '.join(row['violations'])}")
    print(f"{len(rows)} attempts audited, {len(flagged)} with violations, "
          f"{sum(bool(row['warnings']) for row in rows)} with warnings")


if __name__ == "__main__":
    main()
