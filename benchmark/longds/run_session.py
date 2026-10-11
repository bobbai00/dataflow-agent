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
"""Run one LongDS session: every request, in order, to one native agent.

One agent, one workflow and one computing unit serve the whole session, so
later requests build on the Dataflow and functions earlier ones left. The arm
is the agent's `multiRequest` setting:
- off: the single-request agent, sent each request in turn (earlier requests
  stay in its transcript);
- transcript: the same layout, with the multi-request prompt section, function
  signatures in receipts, and notes on constant columns;
- catalog: as transcript, but each earlier request appears as its request and
  one catalog entry.

Every request is sent once; a request that ends without an answer is recorded
as incomplete and the session goes on. The stack comes from the environment
(the stack profile): TEXERA_DASHBOARD_SERVICE_ENDPOINT,
TEXERA_COMPUTING_UNIT_ENDPOINT, WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
TEXERA_AGENT_SERVICE_ENDPOINT.

Output: protocol.json, resource.json, system-info.json, settings.json, then
per request tNN/record.json and tNN/steps.json.gz, and records.json.

Usage (from the repository root, inside the stack's environment):
    python -m benchmark.longds.run_session --prepared R/prepared/<key> \\
        --out R/runs/<key>__catalog__r1 --arm catalog --model gpt-5.6-luna
"""
import argparse
from datetime import datetime, timezone
import gzip
import json
import os
from pathlib import Path
import subprocess
import time

import requests

from benchmark.longds.common import ROOT, load, save
from benchmark.retrieval.metrics import cost_for_usage, current_price_schedule, final_reply, normalize_usage

ARMS = {"off": "off", "transcript": "transcript", "catalog": "catalog"}
# Everything else is stable's default (native mode, delta context, native
# message layout, sample+stats retrieval, full-table profiles).
BASE_SETTINGS = {"agentMode": "native", "contextMode": "delta"}
EMPTY_WORKFLOW = {"operators": [], "operatorPositions": {}, "links": [], "commentBoxes": [],
                  "settings": {"dataTransferBatchSize": 400}}


def endpoints():
    names = {"web": "TEXERA_DASHBOARD_SERVICE_ENDPOINT", "units": "TEXERA_COMPUTING_UNIT_ENDPOINT",
             "engine": "WORKFLOW_EXECUTION_SERVICE_ENDPOINT", "agent": "TEXERA_AGENT_SERVICE_ENDPOINT"}
    missing = [name for name in names.values() if not os.environ.get(name)]
    if missing:
        raise SystemExit(f"Run inside the stack's environment; missing {', '.join(missing)}")
    return {key: os.environ[name].rstrip("/") for key, name in names.items()}


def checked(response):
    if not response.ok:
        raise RuntimeError(f"{response.request.method} {response.url}: {response.status_code} {response.text[:500]}")
    return response.json() if response.content else {}


class Session:
    """The agent, workflow and computing unit one session owns."""

    def __init__(self, urls, out, model, settings):
        self.urls, self.out = urls, out
        self.http = requests.Session()
        self.token = checked(self.http.post(f"{urls['web']}/api/auth/login", timeout=30, json={
            "username": os.environ.get("TEXERA_USERNAME", "texera"),
            "password": os.environ.get("TEXERA_PASSWORD", "texera")}))["accessToken"]
        auth = {"Authorization": f"Bearer {self.token}"}
        name = f"longds-{out.name}-{int(time.time())}"
        self.resource = {}
        try:
            unit = checked(self.http.post(f"{urls['units']}/api/computing-unit/create", headers=auth, timeout=60, json={
                "name": name, "unitType": "local", "cpuLimit": "NaN", "memoryLimit": "NaN", "gpuLimit": "NaN",
                "jvmMemorySize": "NaN", "shmSize": "NaN", "uri": urls["engine"]}))
            self.resource["cuid"] = (unit.get("computingUnit") or unit)["cuid"]
            workflow = checked(self.http.post(f"{urls['web']}/api/workflow/create", headers=auth, timeout=60, json={
                "name": name, "description": "", "content": json.dumps(EMPTY_WORKFLOW), "isPublic": False}))
            self.resource["wid"] = workflow["workflow"]["wid"]
            agent = checked(self.http.post(f"{urls['agent']}/api/agents", headers=auth, timeout=60, json={
                "modelType": model, "name": name, "workflowId": self.resource["wid"],
                "computingUnitId": self.resource["cuid"], "settings": settings}))
            self.resource["agentId"] = agent["id"]
        finally:
            save(out / "resource.json", self.resource)
        self.base = f"{urls['agent']}/api/agents/{self.resource['agentId']}"

    def get(self, path=""):
        return checked(self.http.get(self.base + path, timeout=300))

    def wait_available(self, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if self.get().get("state") == "AVAILABLE":
                return True
            time.sleep(2)
        return False

    def ask(self, content, minutes):
        """Send one request and return the steps it added. A request still
        running after `minutes` is stopped: its steps so far are its record."""
        before = {step["id"] for step in self.get("/react-steps")["steps"]}
        watchdog = False
        try:
            checked(self.http.post(self.base + "/message", json={"content": content}, timeout=(30, minutes * 60)))
        except requests.exceptions.ReadTimeout:
            watchdog = True
            self.http.post(self.base + "/stop", timeout=30)
        except requests.exceptions.ConnectionError:
            # The reply was lost, not the request: never send it again.
            pass
        if not self.wait_available(minutes * 60 if not watchdog else 300):
            raise RuntimeError("The agent did not become available; stop the session")
        steps = [step for step in self.get("/react-steps")["steps"] if step["id"] not in before]
        return steps, watchdog

    def close(self):
        auth = {"Authorization": f"Bearer {self.token}"}
        report = {}
        for name, call in (
                ("agent", lambda: self.http.delete(self.base, timeout=60)),
                ("unit", lambda: self.http.delete(
                    f"{self.urls['units']}/api/computing-unit/{self.resource['cuid']}/terminate", headers=auth, timeout=60)),
                ("workflow", lambda: self.http.post(f"{self.urls['web']}/api/workflow/delete", headers=auth, timeout=60,
                                                    json={"wids": [self.resource["wid"]], "pid": None}))):
            try:
                report[name] = call().status_code
            except Exception as error:  # noqa: BLE001 - cleanup reports, never raises
                report[name] = str(error)
        save(self.out / "cleanup.json", report)


def request_record(turn, prompt, steps, model, elapsed, watchdog):
    """One request's outcome from the steps it added: the answer (a reply after
    the work, not an error or a stop), usage and estimated cost."""
    agents = [step for step in steps if step.get("role") == "agent"]
    completed = final_reply(steps) and not watchdog
    pricing = current_price_schedule(model)
    usages = [normalize_usage(step["usage"]) for step in agents if step.get("usage")]
    costs = [cost_for_usage(usage, pricing) for usage in usages]
    totals = {key: sum(usage[key] for usage in usages)
              for key in ("input_tokens", "output_tokens", "cached_tokens", "cache_creation_tokens", "reasoning_tokens")}
    last = agents[-1] if agents else {}
    return {
        "turn_id": turn, "prompt": prompt, "completed": completed,
        "answer": last.get("content", "") if completed else "",
        "end": "answer" if completed else "watchdog" if watchdog else last.get("endReason") or "no answer",
        "llm_calls": len(usages), "usage": totals,
        "cost_usd": sum(costs) if usages and None not in costs else None,
        "max_input_tokens": max((usage["input_tokens"] for usage in usages), default=0),
        "dataflow_calls": sum(1 for step in agents for call in step.get("toolCalls") or []
                              if call.get("toolName") == "dataflow"),
        "elapsed_seconds": round(elapsed, 1),
    }


def run(prepared, out, arm, model, turns=None, spend_limit=5.0, minutes=30):
    out.mkdir(parents=True, exist_ok=False)
    prompts = load(prepared / "prompts.json")[:turns]
    settings = {**BASE_SETTINGS, "multiRequest": ARMS[arm]}
    save(out / "protocol.json", {
        "prepared": str(prepared.resolve()), "arm": arm, "model": model, "settings": settings,
        "turns": len(prompts), "spend_limit_usd": spend_limit, "question_minutes": minutes,
        "source_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "source_status": subprocess.check_output(["git", "status", "--short", "--", "agent-service", "benchmark"],
                                                 cwd=ROOT, text=True),
        "started": datetime.now(timezone.utc).isoformat()})
    session = Session(endpoints(), out, model, settings)
    records, spent = [], 0.0
    try:
        save(out / "system-info.json", session.get("/system-info"))
        save(out / "settings.json", session.get("/settings"))
        for entry in prompts:
            if spent >= spend_limit:
                print(json.dumps({"stopped": "spend limit", "spent_usd": spent}), flush=True)
                break
            started = time.monotonic()
            steps, watchdog = session.ask(entry["prompt"], minutes)
            record = request_record(entry["turn_id"], entry["prompt"], steps, model, time.monotonic() - started, watchdog)
            folder = out / f"t{entry['turn_id']:02d}"
            save(folder / "record.json", record)
            with gzip.open(folder / "steps.json.gz", "wt") as stream:
                json.dump(steps, stream)
            records.append(record)
            save(out / "records.json", records)
            spent += record["cost_usd"] or 0.0
            print(json.dumps({"turn": entry["turn_id"], "completed": record["completed"], "end": record["end"],
                              "calls": record["llm_calls"], "cost_usd": record["cost_usd"],
                              "seconds": record["elapsed_seconds"]}), flush=True)
    finally:
        session.close()
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--prepared", type=Path, required=True, help="a prepared session folder")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--arm", choices=sorted(ARMS), required=True)
    parser.add_argument("--model", default="gpt-5.6-luna")
    parser.add_argument("--turns", type=int, help="only the first N requests")
    parser.add_argument("--spend-limit", type=float, default=5.0, help="USD; no request starts beyond it")
    parser.add_argument("--question-minutes", type=float, default=30, help="a request running longer is stopped")
    args = parser.parse_args()
    if current_price_schedule(args.model) is None:
        raise SystemExit(f"No price schedule for {args.model}; costs would be unknown")
    run(args.prepared, args.out, args.arm, args.model, args.turns, args.spend_limit, args.question_minutes)


if __name__ == "__main__":
    main()
