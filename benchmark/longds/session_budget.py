#!/usr/bin/env python3
# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements. See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership. The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License. You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.

"""Apply an explicit, uniform wall budget to a local LongDS campaign.

This supervisor runs outside both sandboxes. It preserves completed answers and
captured usage, stops only matching runner trees and native agents, and records
unreached questions as empty answers. It does not expose future tasks to agents.
The resource policy and whether it was chosen after rollout began are recorded.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import json
import os
from pathlib import Path
import re
import signal
import time
import urllib.request

from _paths import PREPARED, SCRATCH
from official_protocol import extract_answer, write_records


def read(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def save(path, value):
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, indent=2, ensure_ascii=False))
    temp.replace(path)


def calls_stats(calls):
    totals = {k: sum(c.get(k, 0) or 0 for c in calls) for k in
              ("input_tokens", "cached_tokens", "cache_write_tokens", "output_tokens", "reasoning_tokens")}
    totals["llm_calls"] = len(calls)
    totals["cost_usd"] = ((totals["input_tokens"] - totals["cached_tokens"] - totals["cache_write_tokens"]) * 0.2
                          + totals["cached_tokens"] * 0.02 + totals["cache_write_tokens"] * 0.25
                          + totals["output_tokens"] * 1.2) / 1e6
    return totals


def budget_answers(directory, turns, trace):
    """Preserve actual answers; missing turns are failures, never omitted."""
    completed = read(directory / "turns/answers.json", read(directory / "agent/answers.json", []))
    by_id = {r["turn_id"]: dict(r) for r in completed}
    grouped = {}
    attempted = set()
    if trace is not None:
        messages = [s.get("messageId") for s in trace if s.get("role") == "user"]
        names = {"input_tokens": "inputTokens", "output_tokens": "outputTokens",
                 "cached_tokens": "cachedInputTokens", "cache_write_tokens": "cacheCreationInputTokens",
                 "reasoning_tokens": "reasoningTokens"}
        for index, message in enumerate(messages):
            attempted.add(index)
            grouped[index] = [{k: s["usage"].get(v, 0) for k, v in names.items()} for s in trace
                              if s.get("role") == "agent" and s.get("messageId") == message
                              and s.get("usage", {}).get("inputTokens")]
    else:
        checkpoint = directory / "agent/calls.jsonl"
        if checkpoint.exists():
            for line in checkpoint.read_text().splitlines(keepends=True):
                if line.endswith("\n"):
                    call = json.loads(line)
                    index = call["turn_index"]
                    attempted.add(index)
                    grouped.setdefault(index, []).append(call)
        for index, turn in enumerate(turns):
            bak = directory / "agent/bak" / f"turn_{index + 1}_result.json"
            if turn["turn_id"] in by_id or not bak.exists():
                continue
            conversation = read(bak, [])
            last = next((m.get("content", "") for m in reversed(conversation) if m.get("role") == "assistant"), "")
            answer = re.search(r"<answer>(.*?)</answer>", last, re.DOTALL)
            by_id[turn["turn_id"]] = {"turn_id": turn["turn_id"], "answer": answer.group(1).strip() if answer else ""}
            attempted.add(index)
    result = []
    for index, turn in enumerate(turns):
        existing = by_id.get(turn["turn_id"])
        row = dict(existing or {"turn_id": turn["turn_id"], "answer": "",
                               "error": "Complete-session wall budget exceeded"})
        row["answer"] = extract_answer(row.get("answer", ""))
        row["attempted"] = existing is not None or index in attempted
        if index in grouped:
            row["stats"] = {**row.get("stats", {}), **calls_stats(grouped[index])}
        else:
            row.setdefault("stats", calls_stats([]))
        row.setdefault("steps", row["stats"].get("llm_calls", 0))
        result.append(row)
    return result


def find_runner(sut, task, proc=Path("/proc")):
    found = []
    for path in proc.iterdir():
        if not path.name.isdigit():
            continue
        try:
            args = path.joinpath("cmdline").read_bytes().decode().split("\0")
            if not any(Path(arg).name == "run_official.py" for arg in args):
                continue
            if args[args.index("--sut") + 1] == sut and args[args.index("--task") + 1] == task:
                found.append(int(path.name))
        except (OSError, ValueError, IndexError, UnicodeError):
            continue
    return found


def signal_tree(roots, signals, expected=None):
    processes = {}
    for path in Path("/proc").iterdir():
        if not path.name.isdigit():
            continue
        try:
            fields = path.joinpath("stat").read_text().split(") ", 1)[1].split()
            processes[int(path.name)] = (int(fields[1]), fields[19])  # parent, start ticks
        except OSError:
            pass
    if expected is not None:
        # A paused runner can disappear during agent cleanup. Never signal a
        # different process that subsequently reused one of its PIDs.
        selected = {pid for pid, ticks in expected.items()
                    if pid in processes and processes[pid][1] == ticks}
    else:
        selected = set(roots)
        while True:
            more = {pid for pid, (parent, _) in processes.items() if parent in selected}
            if more <= selected:
                break
            selected |= more
    for sig in signals:
        for pid in sorted(selected, reverse=True):
            try:
                fields = Path(f"/proc/{pid}/stat").read_text().split(") ", 1)[1].split()
                if fields[19] == processes[pid][1]:
                    os.kill(pid, sig)
            except (OSError, KeyError):
                pass
        if sig == signal.SIGTERM:
            time.sleep(1)
    return {pid: processes[pid][1] for pid in selected if pid in processes}


def terminate_tree(roots, expected=None):
    signal_tree(roots, (signal.SIGTERM, signal.SIGKILL), expected)


def pause_tree(roots):
    return signal_tree(roots, (signal.SIGSTOP,))


def api(base, path, method="GET"):
    request = urllib.request.Request(base.rstrip("/") + "/api/agents" + path,
                                     data=b"{}" if method == "POST" else None, method=method,
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def stop_native(directory, protocol, budget, base):
    prompt = read(directory / "prompts.json", [{}])[0].get("prompt")
    matches = []
    for agent in api(base, "/")["agents"]:
        created = datetime.fromisoformat(agent["createdAt"].replace("Z", "+00:00")).timestamp()
        if not budget["started"] - 5 <= created <= budget["started"] + 180:
            continue
        registry_arms = {"react-registry", "react-registry-sig"}
        if agent["settings"].get("nativeAnalysisState", False) != (
            protocol["arm"] in {"react-analysis", "react-efficient", *registry_arms}
        ):
            continue
        if agent["settings"].get("nativeTaskEfficiency", False) != (
            protocol["arm"] in {"react-efficient", *registry_arms}
        ):
            continue
        if agent["settings"].get("nativeDefinitionRegistry", False) != (protocol["arm"] in registry_arms):
            continue
        if agent["settings"].get("nativeDefinitionSignatures", False) != (protocol["arm"] == "react-registry-sig"):
            continue
        steps = api(base, f'/{agent["id"]}/react-steps')["steps"]
        first = next((s.get("content") for s in steps if s.get("role") == "user"), None)
        if first == prompt:
            matches.append(agent)
    if len(matches) > 1:
        raise RuntimeError("Ambiguous native session identity; refusing to stop another agent")
    if not matches:
        return None
    agent = matches[0]
    identity = agent["id"]
    api(base, f"/{identity}/stop", "POST")
    deadline = time.time() + 300
    while time.time() < deadline:
        state = api(base, f"/{identity}")
        if state.get("state") == "AVAILABLE":
            break
        time.sleep(1)
    else:
        raise RuntimeError(f"Native agent {identity} did not drain after stop")
    for endpoint in ("react-steps", "workflow", "operator-results", "settings"):
        save(directory / f"interrupted-{endpoint}.json", api(base, f"/{identity}/{endpoint}"))
    save(directory / "interrupted-agent.json", state)
    budget["agent"] = identity
    budget["workflow"] = agent["delegate"]["workflowId"]
    return read(directory / "interrupted-react-steps.json")["steps"]


def expire(directory, budget, base):
    protocol = read(directory / "protocol.json")
    roots = find_runner(directory.parent.name, directory.name)
    paused = pause_tree(roots)
    try:
        expire_paused(directory, protocol, budget, base)
    finally:
        # Publishing results before subprocess exit prevents a controller from
        # starting its judge against a missing or incomplete result file.
        terminate_tree(roots, expected=paused)


def expire_paused(directory, protocol, budget, base):
    trace = None
    if protocol["arm"].startswith("react-"):
        trace = stop_native(directory, protocol, budget, base)
    # The runner may have finished normally during the identity check.
    if (directory / "summary.json").exists():
        return
    gold = read(PREPARED / directory.name / "gold.json")
    turns = read(PREPARED / directory.name / "manifest.json")["turns"][:protocol["turns"]]
    answers = budget_answers(directory, turns, trace)
    save(directory / "budget-answers.json", answers)
    write_records(directory, directory.name, protocol["arm"], protocol["model"], gold, answers)
    budget.update(expired=True, finished=time.time(), attempted=sum(r["attempted"] for r in answers),
                  answered=sum(bool(r["answer"]) for r in answers), planned=len(answers))
    save(directory / "session-budget.json", budget)
    summary = read(directory / "summary.json")
    summary.update(session_budget_exceeded=True, turns_attempted=budget["attempted"],
                   session_timeout_seconds=budget["seconds"])
    save(directory / "summary.json", summary)
    print(json.dumps({"budget_expired": directory.parent.name, "task": directory.name, **budget}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--seconds", type=int, required=True)
    parser.add_argument("--agent-base", default=os.getenv("TEXERA_AGENT_SERVICE_ENDPOINT", "http://localhost:3001"))
    parser.add_argument("--stop-file", type=Path, required=True)
    parser.add_argument("--policy-note", required=True)
    args = parser.parse_args()
    if args.seconds <= 0:
        parser.error("--seconds must be positive")
    pending = {}
    with ThreadPoolExecutor(max_workers=6) as workers:
        while not args.stop_file.exists():
            for directory, future in list(pending.items()):
                if future.done():
                    del pending[directory]
                    try:
                        future.result()
                    except Exception as error:
                        print(json.dumps({"budget_error": str(directory), "error": str(error)}), flush=True)
            for protocol in SCRATCH.glob(args.prefix + "*/*/protocol.json"):
                directory = protocol.parent
                path = directory / "session-budget.json"
                if not path.exists():
                    save(path, {"started": protocol.stat().st_mtime, "seconds": args.seconds,
                                "policy_note": args.policy_note, "poll_grace_seconds": 5})
                budget = read(path)
                if directory in pending or budget.get("expired") or (directory / "summary.json").exists():
                    continue
                if time.time() >= budget["started"] + budget["seconds"]:
                    pending[directory] = workers.submit(expire, directory, budget, args.agent_base)
            time.sleep(5)


if __name__ == "__main__":
    main()
