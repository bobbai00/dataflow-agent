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
"""Serve recorded model responses to a runner under test and log every request it sends (the $0 runner gate).

References are attempt folders of a baseline smoke: BobFlow attempts hold wire/NNNNNN-{request,response,meta}.json,
Script ReAct attempts hold model-request-trace.jsonl. Every recorded request is indexed by its whole body, normalized
(ids, timestamps and hashes that two runs cannot share), so a request is answered only if the runner sent exactly what
the baseline sent. Any other request gets a 500, which the comparison reports as a divergence.

    python3 -I replay_model.py --port 3192 --log requests.jsonl RUN_DIR...
"""
import argparse
import gzip
import hashlib
import json
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def wire_pairs(wire):
    """Recorded (request body, response body) pairs of an agent's wire folder, in call order."""
    for meta in sorted(wire.glob("*-meta.json")):
        if json.loads(meta.read_text()).get("status") != 200:
            continue
        stem = meta.name[: -len("-meta.json")]
        yield json.loads((wire / f"{stem}-request.json").read_text()), json.loads((wire / f"{stem}-response.json").read_text())


def session_outputs(arm):
    """A LongDS Script ReAct session: its first task and every step's recorded output as a response, in call order.
    The runner keeps no model inputs, so these are found by the session's first task and the call number."""
    steps = [step for turn in sorted(arm.glob("t[0-9]*")) for step in json.load(gzip.open(turn / "steps.json.gz", "rt"))]
    first = next(step["task"] for step in steps if step.get("type") == "task")
    outputs = []
    for n, step in enumerate(s for s in steps if s.get("type") == "action"):
        usage = step.get("token_usage") or {}
        outputs.append({"id": f"replay-{n}", "object": "chat.completion", "created": 0, "model": "replay",
                        "choices": [{"index": 0, "finish_reason": "stop",
                                     "message": {"role": "assistant", "content": step.get("model_output") or ""}}],
                        "usage": {"prompt_tokens": usage.get("input_tokens", 0), "completion_tokens": usage.get("output_tokens", 0),
                                  "total_tokens": usage.get("input_tokens", 0) + usage.get("output_tokens", 0)}})
    return first, outputs


def first_task(body):
    """The text of a smolagents request's first task (its second message, after "New task:")."""
    messages = body.get("messages") or []
    if len(messages) < 2:
        return None
    content = messages[1].get("content")
    text = content if isinstance(content, str) else "".join(part.get("text", "") for part in content or [] if isinstance(part, dict))
    return text.removeprefix("New task:\n").strip()


def pairs(attempt):
    """Recorded (request body, response body) pairs of one attempt, in call order."""
    if (attempt / "wire").is_dir():
        yield from wire_pairs(attempt / "wire")
    elif (attempt / "model-request-trace.jsonl").exists():
        lines = [json.loads(line) for line in (attempt / "model-request-trace.jsonl").read_text().splitlines() if line]
        requests = {line["call"]: line["request"] for line in lines if line.get("phase") == "request"}
        for line in lines:
            if line.get("phase") == "response" and line["call"] in requests:
                yield requests[line["call"]], {"id": f"replay-{line['call']}", "object": "chat.completion", "created": 0,
                                               "model": line.get("response_model"), "choices": line["choices"],
                                               "usage": line.get("usage")}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--log", type=Path, required=True)
    parser.add_argument("--tracker", type=Path, default=Path(__file__).resolve().parents[2] / "tracker",
                        help="benchmark/tracker, for compare_replays.Normalizer")
    parser.add_argument("--wire-root", type=Path, help="the stack's wire folder, for LongDS dataflow sessions")
    parser.add_argument("--arm", help="serve only this LongDS arm: arms whose first requests are identical would collide")
    parser.add_argument("runs", nargs="+", type=Path, help="KramaBench/PrepBench run folders or LongDS run roots")
    args = parser.parse_args()
    sys.path.insert(0, str(args.tracker))
    from compare_replays import Normalizer

    def key(body):
        whole = json.dumps(Normalizer().value(body), sort_keys=True)
        calls = sum(1 for message in body.get("messages") or [] if message.get("role") == "assistant")
        return hashlib.sha256(whole.encode()).hexdigest()[:16], calls

    def task_key(text):
        return hashlib.sha256(text.strip().encode()).hexdigest()[:16]

    index, by_task, attempts = {}, {}, 0
    for run in args.runs:
        for attempt in sorted(p for p in run.glob("system_scratch/*/*") if p.is_dir()):
            attempts += 1
            for request, response in pairs(attempt):
                index.setdefault(key(request), (str(attempt), response))
        for arm in sorted(p.parent for p in run.glob("*/protocol.json")):
            if args.arm and arm.name != args.arm:
                continue
            attempts += 1
            agent = (json.loads((arm / "resource.json").read_text()) if (arm / "resource.json").exists() else {}).get("agentId")
            if agent and args.wire_root:
                for request, response in wire_pairs(args.wire_root / agent):
                    index.setdefault(key(request), (str(arm), response))
            elif not agent:
                first, outputs = session_outputs(arm)
                for n, response in enumerate(outputs):
                    by_task[(task_key(first), n)] = (str(arm), response)
    print(f"{len(index) + len(by_task)} recorded calls from {attempts} attempts", flush=True)
    lock = threading.Lock()
    args.log.write_text("")

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            k = key(body)
            found = index.get(k)
            if not found and first_task(body):
                found = by_task.get((task_key(first_task(body)), k[1]))
            with lock, args.log.open("a") as log:
                log.write(json.dumps({"key": k[0], "call": k[1], "attempt": found and found[0], "body": body}) + "\n")
            payload, status = (json.dumps(found[1]).encode(), 200) if found else (b'{"error":"not recorded"}', 500)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_GET(self):
            # Runners wait for the gateway's health route before they start.
            payload = b'{"status":"ok"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *_):
            pass

    class DualStack(ThreadingHTTPServer):
        address_family = socket.AF_INET6  # "localhost" may resolve to ::1; IPv4 arrives mapped

        def server_bind(self):
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            super().server_bind()

    DualStack(("::", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
