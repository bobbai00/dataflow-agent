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
later requests build on the Dataflow and functions earlier ones left. The
agent has the multi-request prompt section, function signatures in receipts
and notes on constant columns (`multiRequest: "transcript"`), and every
request ends with a line that names the earlier tasks it builds on (gold
depends_tasks). The arm fixes what a request sees of the earlier ones:
- transcript-depnote: the whole earlier transcript;
- catalog-gold: instead of the earlier requests, every earlier task by its
  request, dataflow changes and answer, with the ones the request builds on
  in detail (the agent's task catalog).

Every request is sent once; a request that ends without an answer is recorded
as incomplete and the session goes on. The stack comes from the environment
(the stack profile): TEXERA_DASHBOARD_SERVICE_ENDPOINT,
TEXERA_COMPUTING_UNIT_ENDPOINT, WORKFLOW_EXECUTION_SERVICE_ENDPOINT,
TEXERA_AGENT_SERVICE_ENDPOINT.

Output: protocol.json, resource.json, system-info.json, settings.json, then
per request tNN/record.json and tNN/steps.json.gz, and records.json.

Usage (from the repository root, inside the stack's environment):
    bench longds run --prepared R/prepared/<key> \\
        --out R/runs/<key>__catalog-gold__r1 --arm catalog-gold --model gpt-5.6-luna
"""
import argparse
from datetime import datetime, timezone
import gzip
import json
from pathlib import Path
import subprocess
import time

import requests

from bobbench import agent_client
from bobbench.longds.common import dependency_note, load, save
from bobbench.paths import REPO as ROOT
from bobbench.models import price_schedule
from bobbench.profiling.usage import cost_for_usage, normalize_usage
from bobbench.react_steps import final_reply

ARMS = {
    "transcript-depnote": {"multiRequest": "transcript"},
    "catalog-gold": {"multiRequest": "transcript"},
}
# Arms whose requests see the task catalog, the annotated dependencies in detail (gold_dependencies).
CATALOG_TASKS = {"catalog-gold"}
# Everything else is the agent's default (sample+stats retrieval, full-table profiles).
BASE_SETTINGS = {}
EMPTY_WORKFLOW = {"operators": [], "operatorPositions": {}, "links": [], "commentBoxes": [],
                  "settings": {"dataTransferBatchSize": 400}}


class Session:
    """The agent, workflow and computing unit one session owns (bobbench.agent_client, LongDS's own bodies)."""

    def __init__(self, endpoints, out, model, settings):
        self.endpoints, self.out = endpoints, out
        self.http = requests.Session()
        self.token = agent_client.login(endpoints.web, http=self.http)
        name = f"longds-{out.name}-{int(time.time())}"
        self.resource = {}
        try:
            self.resource["cuid"] = agent_client.create_computing_unit(endpoints, self.token, name, http=self.http,
                                                                       timeout=60)
            self.resource["wid"] = agent_client.create_workflow(endpoints, self.token, {
                "name": name, "description": "", "content": json.dumps(EMPTY_WORKFLOW), "isPublic": False},
                http=self.http, timeout=60)
            self.resource["agentId"] = agent_client.create_agent(endpoints, self.token, {
                "modelType": model, "name": name, "workflowId": self.resource["wid"],
                "computingUnitId": self.resource["cuid"], "settings": settings}, http=self.http)["id"]
        finally:
            save(out / "resource.json", self.resource)

    def get(self, path=""):
        return agent_client.get(self.endpoints, self.resource["agentId"], path, http=self.http, timeout=300)

    def wait_available(self, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if self.get().get("state") == "AVAILABLE":
                return True
            time.sleep(2)
        return False

    def ask(self, content, minutes, context_tasks=None):
        """Send one request and return the steps it added. A request still
        running after `minutes` is stopped: its steps so far are its record.
        `context_tasks` names the earlier tasks it builds on, for the task
        catalog."""
        before = {step["id"] for step in self.get("react-steps")["steps"]}
        watchdog = False
        body = {"content": content, **({"contextTasks": context_tasks} if context_tasks is not None else {})}
        try:
            agent_client.post_message(self.endpoints, self.resource["agentId"], body, timeout=(30, minutes * 60),
                                      http=self.http)
        except requests.exceptions.ReadTimeout:
            watchdog = True
            agent_client.stop(self.endpoints, self.resource["agentId"], http=self.http)
        except requests.exceptions.ConnectionError:
            # The reply was lost, not the request: never send it again.
            pass
        if not self.wait_available(minutes * 60 if not watchdog else 300):
            raise RuntimeError("The agent did not become available; stop the session")
        steps = [step for step in self.get("react-steps")["steps"] if step["id"] not in before]
        return steps, watchdog

    def close(self):
        report = {}
        for name, call in (
                ("agent", lambda: agent_client.delete_agent(self.endpoints, self.resource["agentId"], http=self.http,
                                                            timeout=60)),
                ("unit", lambda: agent_client.terminate_computing_unit(self.endpoints, self.token, self.resource["cuid"],
                                                                       http=self.http, timeout=60)),
                ("workflow", lambda: agent_client.delete_workflow(self.endpoints, self.token,
                                                                  {"wids": [self.resource["wid"]], "pid": None},
                                                                  http=self.http, timeout=60))):
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
    pricing = price_schedule(model)
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


def gold_dependencies(gold, turn):
    """The earlier tasks gold.json says `turn` builds on, in order."""
    depends = next((t.get("depends_tasks") or [] for t in gold["turns"] if t["turn_id"] == turn), [])
    return sorted({int(d) for d in depends if 1 <= int(d) < turn})


def run(prepared, out, arm, model, turns=None, spend_limit=5.0, minutes=30):
    out.mkdir(parents=True, exist_ok=False)
    prompts = load(prepared / "prompts.json")[:turns]
    settings = {**BASE_SETTINGS, **ARMS[arm]}
    gold = load(prepared / "gold.json")
    save(out / "protocol.json", {
        "prepared": str(prepared.resolve()), "arm": arm, "model": model, "settings": settings,
        "selection": "gold tasks in the task catalog" if arm in CATALOG_TASKS else None,
        "note": "gold dependencies",
        "turns": len(prompts), "spend_limit_usd": spend_limit, "question_minutes": minutes,
        "source_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "source_status": subprocess.check_output(["git", "status", "--short", "--", "agent-service", "benchmark"],
                                                 cwd=ROOT, text=True),
        "started": datetime.now(timezone.utc).isoformat()})
    session = Session(agent_client.Endpoints.from_env(), out, model, settings)
    records, spent = [], 0.0
    try:
        save(out / "system-info.json", session.get("system-info"))
        save(out / "settings.json", session.get("settings"))
        for entry in prompts:
            if spent >= spend_limit:
                print(json.dumps({"stopped": "spend limit", "spent_usd": spent}), flush=True)
                break
            started = time.monotonic()
            turn = entry["turn_id"]
            prompt = entry["prompt"] + dependency_note(gold, turn)
            tasks = gold_dependencies(gold, turn) if arm in CATALOG_TASKS and turn > 1 else None
            steps, watchdog = session.ask(prompt, minutes, tasks)
            record = request_record(turn, prompt, steps, model, time.monotonic() - started, watchdog)
            if tasks is not None:
                record["context_tasks"] = tasks
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
    if price_schedule(args.model) is None:
        raise SystemExit(f"No price schedule for {args.model}; costs would be unknown")
    run(args.prepared, args.out, args.arm, args.model, args.turns, args.spend_limit, args.question_minutes)


if __name__ == "__main__":
    main()
