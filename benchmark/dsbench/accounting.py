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
"""Preserved native and script requests use one per-request pricing protocol."""

from collections import defaultdict
from pathlib import Path

from benchmark.runtime import AttemptMetrics, write_json_exclusive
from benchmark.runtime.native_accounting import record_native_requests
from benchmark.dsbench.metrics import read_events, read_json

SUPERVISED_WALL_BOUNDARY = (
    "supervisor timer start before measurement setup through child-tree exit and resource finalization"
)


def capture_model_accounting(
    directory,
    *,
    system,
    benchmark,
    resources,
    config_override=None,
    wall_boundary=SUPERVISED_WALL_BOUNDARY,
):
    directory = Path(directory)
    config = config_override if config_override is not None else read_json(directory / "config.json", {})
    accounting = read_json(directory / "model-accounting.json", None)
    trace = directory / "model-request-trace.jsonl"
    if system == "native" and not accounting or system != "native" and not trace.exists():
        return None
    metrics = AttemptMetrics(
        directory.name,
        benchmark=benchmark,
        system=system,
        task_id=config.get("task_id", directory.name),
        manifest={"pricing": config.get("pricing"), "source": "preserved_transport_requests"},
    )
    if system == "native":
        record_native_requests(metrics, accounting, pricing=config.get("pricing"))
    else:
        events = read_events(trace)
        requests = {event["call"]: event for event in events if event.get("phase") == "request"}
        responses = {event["call"]: event for event in events if event.get("phase") == "response"}
        errors = {event["call"]: event for event in events if event.get("phase") == "error"}
        transport, headers = defaultdict(list), defaultdict(list)
        for event in events:
            if event.get("phase") == "transport_request":
                transport[event["call"]].append(event)
            elif event.get("phase") == "transport_headers":
                headers[event["call"]].append(event)
        for identifier in sorted(requests.keys() | responses.keys() | errors.keys() | transport.keys()):
            attempts = transport.get(identifier) or [requests.get(identifier)]
            for index, attempt in enumerate(attempts):
                response = responses.get(identifier) if index == len(attempts) - 1 else None
                error = errors.get(identifier) if index == len(attempts) - 1 else "SDK_transport_retry"
                header = headers[identifier][index] if index < len(headers[identifier]) else None
                timing_event = response or (error if isinstance(error, dict) else None) or header or {}
                call = metrics.record_usage(
                    {"usage": response.get("usage")} if response else None,
                    provider="openai",
                    model=config.get("model"),
                    pricing=config.get("pricing"),
                    status="succeeded" if response else "failed",
                    error=error or (None if response else "interrupted_request"),
                    wall_seconds=timing_event.get("seconds"),
                )
                call["request_id"] = f"{identifier}:{index+1}"
                call["transport_request"] = attempt
                call["transport_response"] = response
                call["transport_headers"] = header
    status = read_json(directory / "status.json", {})
    supervision = read_json(directory / "supervision.json", {})
    preserved_interval = supervision.get("wall_interval") or {}
    wall_interval = {
        "source": preserved_interval.get("source")
        or (
            "supervision.json.wall_seconds"
            if "wall_seconds" in supervision
            else "status.json.runner_seconds (preserved supervised wall)"
        ),
        "boundary": (
            preserved_interval.get("boundary", wall_boundary)
            if wall_boundary == SUPERVISED_WALL_BOUNDARY
            else wall_boundary
        ),
        "started_at": preserved_interval.get("started_at"),
        "finished_at": preserved_interval.get("finished_at"),
        "wall_seconds": status.get("runner_seconds"),
        "phases": read_json(directory / "lifecycle.json", {}),
    }
    result = metrics.finish(
        status="completed" if status.get("completed") else "failed",
        error=status.get("error"),
        resources=resources,
        wall_interval=wall_interval,
    )
    metrics.write(directory / "accounting")
    write_json_exclusive(directory / "common-accounting.json", result)
    write_json_exclusive(directory / "accounting-provenance.json", metrics.manifest)
    return result
