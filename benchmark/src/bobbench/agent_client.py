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
"""The agent service and the Texera services an attempt or a session uses.

The REST lifecycle (login, computing unit, workflow, agent, teardown) is shared by KramaBench/PrepBench attempts and
LongDS sessions; request bodies stay the caller's and are sent as given (the two send different workflow and agent
bodies). A turn goes over the agent's WebSocket (`ws_turn`, which streams per-step usage) or REST (`post_message`, which
LongDS needs for the task catalog and its stop-on-timeout rule). Both end in the same server call, so what the model sees
does not depend on the transport.
"""
from dataclasses import dataclass
import json
import os

import requests

PROFILE = {"web": "TEXERA_DASHBOARD_SERVICE_ENDPOINT", "units": "TEXERA_COMPUTING_UNIT_ENDPOINT",
           "engine": "WORKFLOW_EXECUTION_SERVICE_ENDPOINT", "agent": "TEXERA_AGENT_SERVICE_ENDPOINT"}
USER = {"username": "texera", "password": "texera"}


@dataclass(frozen=True)
class Endpoints:
    web: str  # dashboard service: login and workflows
    units: str  # computing-unit manager
    engine: str  # workflow execution service (a computing unit's uri)
    agent: str  # agent service

    @classmethod
    def from_env(cls, agent=None):
        """The stack's endpoints from its profile (run-env.sh exports them); `agent` overrides the agent service."""
        missing = [name for key, name in PROFILE.items() if not os.environ.get(name) and not (key == "agent" and agent)]
        if missing:
            raise SystemExit(f"Run inside the stack's environment (run-env.sh); missing {', '.join(missing)}")
        values = {key: os.environ.get(name, "").rstrip("/") for key, name in PROFILE.items()}
        if agent:
            values["agent"] = agent.rstrip("/")
        return cls(**values)


def checked(response):
    """The response's JSON body (or {}), raising with the status and a body excerpt when it failed."""
    if not response.ok:
        raise RuntimeError(f"{response.request.method} {response.url}: {response.status_code} {response.text[:500]}")
    return response.json() if response.content else {}


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def login(web, http=requests, timeout=30):
    """A Texera access token for the local-dev user."""
    return checked(http.post(f"{web}/api/auth/login", json=USER, timeout=timeout))["accessToken"]


def create_computing_unit(endpoints, token, name, http=requests, timeout=30):
    """A local computing unit on the stack's engine; its cuid."""
    body = {"name": name, "unitType": "local", "cpuLimit": "NaN", "memoryLimit": "NaN", "gpuLimit": "NaN",
            "jvmMemorySize": "NaN", "shmSize": "NaN", "uri": endpoints.engine}
    unit = checked(http.post(f"{endpoints.units}/api/computing-unit/create", headers=bearer(token), json=body,
                             timeout=timeout))
    return (unit.get("computingUnit") or unit)["cuid"]


def terminate_computing_unit(endpoints, token, cuid, http=requests, timeout=30):
    return http.delete(f"{endpoints.units}/api/computing-unit/{cuid}/terminate", headers=bearer(token), timeout=timeout)


def create_workflow(endpoints, token, body, http=requests, timeout=30):
    """A workflow from `body` (sent as given); its wid."""
    data = checked(http.post(f"{endpoints.web}/api/workflow/create", json=body, timeout=timeout,
                             headers={**bearer(token), "Content-Type": "application/json"}))
    return (data.get("workflow") or {}).get("wid") or data.get("wid")


def delete_workflow(endpoints, token, body, http=requests, timeout=30):
    return http.post(f"{endpoints.web}/api/workflow/delete", json=body, timeout=timeout,
                     headers={**bearer(token), "Content-Type": "application/json"})


def create_agent(endpoints, token, body, http=requests, timeout=60):
    """An agent from `body` (sent as given); the service's agent record, whose `id` names it."""
    return checked(http.post(f"{endpoints.agent}/api/agents", headers=bearer(token), json=body, timeout=timeout))


def agent_url(endpoints, agent_id):
    return f"{endpoints.agent}/api/agents/{agent_id}"


def get(endpoints, agent_id, route="", http=requests, timeout=30):
    """GET /api/agents/<id>[/route]: settings, system-info, react-steps, workflow, snapshots/head, ..."""
    return checked(http.get(agent_url(endpoints, agent_id) + (f"/{route}" if route else ""), timeout=timeout))


def stop(endpoints, agent_id, http=requests, timeout=30):
    return http.post(agent_url(endpoints, agent_id) + "/stop", timeout=timeout)


def delete_agent(endpoints, agent_id, http=requests, timeout=30):
    return http.delete(agent_url(endpoints, agent_id), timeout=timeout)


def post_message(endpoints, agent_id, body, timeout, http=requests):
    """One turn over REST: POST /message with `body` ({"content": ..., ["contextTasks": ...]}). The read timeout
    raises requests' ReadTimeout; the caller decides what a lost reply means."""
    return checked(http.post(agent_url(endpoints, agent_id) + "/message", json=body, timeout=timeout))


@dataclass
class Turn:
    """What one WebSocket turn returned: the final reply, the usage totals and the agent steps it streamed."""
    response: str
    usage: dict
    steps: int
    stopped: bool
    error: str = None
    completed: bool = False


USAGE_FIELDS = (("input_tokens", "inputTokens"), ("output_tokens", "outputTokens"), ("total_tokens", "totalTokens"),
                ("reasoning_tokens", "reasoningTokens"), ("cached_input_tokens", "cachedInputTokens"),
                ("cache_creation_input_tokens", "cacheCreationInputTokens"))


def ws_url(endpoint):
    for http, ws in (("https://", "wss://"), ("http://", "ws://")):
        if endpoint.startswith(http):
            return ws + endpoint[len(http):]
    return endpoint


def ws_turn(endpoints, agent_id, content, receive_timeout=600):
    """Send one chat message over /api/agents/<id>/react and read events until `complete` or `error`.

    Usage is summed over the streamed agent steps (the final step is re-broadcast with isEnd and counted once) and
    replaced by the `complete` event's totals, which include retries and work done before a stop. One attempt, no
    resend: a receive that waits longer than `receive_timeout` seconds ends the turn with an error.
    """
    import websocket  # websocket-client, in the KramaBench venv

    ws = websocket.create_connection(f"{ws_url(endpoints.agent)}/api/agents/{agent_id}/react", timeout=receive_timeout)
    try:
        ws.send(json.dumps({"type": "message", "content": content, "messageSource": "chat"}))
        response, usage, seen, step_usage = "", {target: 0 for target, _ in USAGE_FIELDS}, set(), {}
        stopped, error, complete = False, None, False
        while not complete:
            try:
                raw = ws.recv()
            except websocket.WebSocketTimeoutException:
                error = f"WebSocket recv timed out after {receive_timeout}s"
                break
            if not raw:
                break
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = event.get("type")
            if kind == "step":
                step = event.get("step") or {}
                if step.get("role") != "agent":
                    continue
                key = step.get("id") or ("unidentified", len(seen))
                seen.add(key)
                if step.get("isEnd") and step.get("content"):
                    response = step["content"]
                current = {target: int((step.get("usage") or {}).get(source) or 0) for target, source in USAGE_FIELDS}
                previous = step_usage.get(key, {})
                for name, value in current.items():
                    usage[name] += value - previous.get(name, 0)
                step_usage[key] = current
            elif kind == "complete":
                if isinstance(event.get("usage"), dict):
                    usage = {target: int(event["usage"].get(source) or 0) for target, source in USAGE_FIELDS}
                stopped = bool(event.get("stopped", stopped))
                error = event.get("error") or error
                complete = True
            elif kind == "error":
                error = event.get("error") or "unknown WebSocket error"
                break
            elif kind == "state" and event.get("state") == "STOPPING":
                stopped = True
        return Turn(response=response, usage=usage, steps=len(seen), stopped=stopped, error=error, completed=complete)
    finally:
        try:
            ws.close()
        except Exception:  # noqa: BLE001 - closing a dead socket
            pass
