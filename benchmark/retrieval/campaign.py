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
"""Resource limits and deterministic checks for long retrieval campaigns."""
import json
import threading
try:
    from .metrics import retrieval_results, tool_error_counts
    from .answer_diagnostics import diagnose_answer
    from .matrix_audit import audit_attempt as audit_wire_attempt
except ImportError:
    from metrics import retrieval_results, tool_error_counts
    from answer_diagnostics import diagnose_answer
    from matrix_audit import audit_attempt as audit_wire_attempt


def install_provider_prices(cost_module, models):
    """Freeze newly supported model prices inside this campaign process only.

    The pinned harness predates Sonnet 5.5 and otherwise reports its cost as
    zero. Extend its fallback table without modifying the KramaBench checkout
    or changing prices for historical models. Output already includes thinking.
    """
    frozen = {}
    for model in models:
        if model not in {"claude-sonnet-5.5", "claude-sonnet-5-5"}:
            continue
        rates = {"input": 2e-6, "output": 10e-6, "cache_read": 0.2e-6, "cache_creation": 2.5e-6}
        cost_module._FALLBACK[model] = tuple(rates.values())
        frozen[model] = {"rates": rates, "source": "https://platform.claude.com/docs/en/models/sonnet-5-5/overview",
                         "verified_on": "2026-10-01", "unit": "USD per token"}
    return frozen


class ResourceQueue:
    """Preserve shuffled order where possible, bounding large tasks in flight."""
    def __init__(self, jobs, large_tasks, large_limit):
        self.jobs = list(jobs)
        self.large_tasks = set(large_tasks)
        self.large_limit = large_limit
        self.large_active = 0
        self.condition = threading.Condition()

    def get(self):
        with self.condition:
            while self.jobs:
                for index, job in enumerate(self.jobs):
                    large = job["task"] in self.large_tasks
                    if not large or self.large_active < self.large_limit:
                        self.large_active += int(large)
                        return self.jobs.pop(index)
                self.condition.wait()
            return None

    def done(self, job):
        with self.condition:
            if job["task"] in self.large_tasks:
                self.large_active -= 1
            self.condition.notify_all()


def prepare_artifacts(scratch, archive, sut_names):
    """Let the unchanged harness write directly onto the selected artifact disk."""
    scratch.mkdir(parents=True, exist_ok=True)
    for name in sorted(set(sut_names)):
        source, target = scratch / name, archive / name
        if source.exists() or source.is_symlink() or target.exists():
            raise FileExistsError(f"Refusing to overwrite {name}")
    for name in sorted(set(sut_names)):
        target = archive / name
        target.mkdir(parents=True)
        (scratch / name).symlink_to(target.resolve(), target_is_directory=True)


def audit_attempt(path, settings):
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
    answered, text_replies = False, 0
    tool_errors = envelope_errors = 0
    # The turn transport answers with a final reply that calls no tool; any
    # earlier tool-less reply is still a lapse.
    turn_transport = settings.get("nativeTransport") == "turn" or read("config.json", {}).get("driver") == "turn-tool"
    agent_steps = [step for step in steps if step.get("role") == "agent"]
    final = agent_steps[-1] if agent_steps else None
    final_reply = (turn_transport and final is not None and final.get("isEnd") and not final.get("toolCalls")
                   and bool(final.get("content")) and not str(final["content"]).startswith("Error:"))
    for step in steps:
        messages = step.get("inputMessages")
        if (settings.get("agentMode") == "native" and step.get("role") == "agent" and messages is not None
                and not step.get("toolCalls") and step.get("content") and not (final_reply and step is final)):
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
                action, observed = item.get("action", {}), item.get("output", {})
                answered |= action.get("type") == "answer" and item.get("status") == "ok"
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
                    if action.get("view") != "sample_stats" and any(f.startswith("data.") for f in facts):
                        violations.append("data_evidence_leak")
    answered = answered or final_reply
    if settings.get("agentMode") == "native" and raw is not None:
        if text_replies:
            warnings.append("text_without_dataflow")
        if not answered:
            warnings.append("missing_answer_action")
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
            wire_audit = audit_wire_attempt(path, settings)
        except ValueError:
            warnings.append("unreadable_wire_audit_artifact")
        else:
            violations.extend(wire_audit["violations"])
            warnings.extend(wire_audit["warnings"])
    return {"answer_diagnostics": diagnostics, "wire_audit": wire_audit,
            "violations": sorted(set(violations)), "warnings": sorted(set(warnings)), "prefix_checks": prefix_checks,
            "action_errors": action_errors, "tool_errors": tool_errors, "envelope_errors": envelope_errors,
            "text_replies": text_replies, "retrievals": reads, "profiles": profiles, "columns": columns}
