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
"""A fake Texera + agent service on one local port: REST routes and the agent's WebSocket turn, stdlib only.

Every request is logged as (method, path, JSON body); a WebSocket turn logs its message frame as ("WS", path, frame)
and answers with the scripted step and `complete` events."""
import base64
import hashlib
import json
import struct
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"  # RFC 6455


class FakeServices:
    def __init__(self, *, agent_id="agent-fake-1", wid=7, events=(), settings_extra=None, tools=None, steps=(),
                 settings_override=None):
        self.agent_id, self.wid, self.events = agent_id, wid, list(events)
        self.settings_extra, self.settings_override = settings_extra or {"contextMode": "delta"}, settings_override
        self.tools = tools or [{"name": "dataflow", "inputSchema": {"properties": {"python": {}, "statements": {}}}}]
        self.steps, self.log, self.created = list(steps), [], None
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def reply(self, payload, status=200):
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def body(self):
                length = int(self.headers.get("Content-Length") or 0)
                return json.loads(self.rfile.read(length)) if length else None

            def do_POST(self):
                body = self.body()
                fake.log.append(("POST", self.path, body, self.headers.get("Authorization")))
                if self.path == "/api/auth/login":
                    return self.reply({"accessToken": "token"})
                if self.path == "/api/workflow/create":
                    return self.reply({"workflow": {"wid": fake.wid}})
                if self.path == "/api/workflow/delete":
                    return self.reply({})
                if self.path == "/api/agents":
                    fake.created = body
                    return self.reply({"id": fake.agent_id, "name": "a", "modelType": body["modelType"], "state": "AVAILABLE",
                                       "createdAt": "now"})
                return self.reply({"error": "unknown"}, 404)

            def do_DELETE(self):
                fake.log.append(("DELETE", self.path, None, None))
                return self.reply({})

            def do_GET(self):
                if self.headers.get("Upgrade", "").lower() == "websocket":
                    return self.websocket()
                fake.log.append(("GET", self.path, None, None))
                route = self.path.split(f"/api/agents/{fake.agent_id}", 1)[-1]
                settings = {**fake.settings_extra, **(fake.created or {}).get("settings", {}), **(fake.settings_override or {})}
                pages = {"/settings": settings, "/system-info": {"tools": fake.tools, "systemPrompt": "s"},
                         "/react-steps": {"steps": fake.steps, "state": "AVAILABLE"}, "/workflow": {"operators": []},
                         "/snapshots/head": {"results": {}, "dataflow": {}}}
                return self.reply(pages[route]) if route in pages else self.reply({"error": "unknown"}, 404)

            def websocket(self):
                accept = base64.b64encode(hashlib.sha1((self.headers["Sec-WebSocket-Key"] + GUID).encode()).digest())
                self.send_response(101)
                self.send_header("Upgrade", "websocket")
                self.send_header("Connection", "Upgrade")
                self.send_header("Sec-WebSocket-Accept", accept.decode())
                self.end_headers()
                fake.log.append(("WS", self.path, json.loads(self.read_frame()), None))
                for event in fake.events:
                    self.send_frame(json.dumps(event).encode())
                self.wfile.write(b"\x88\x00")
                self.close_connection = True

            def read_frame(self):
                head = self.rfile.read(2)
                length = head[1] & 0x7F
                if length == 126:
                    length = struct.unpack(">H", self.rfile.read(2))[0]
                elif length == 127:
                    length = struct.unpack(">Q", self.rfile.read(8))[0]
                mask = self.rfile.read(4) if head[1] & 0x80 else b"\0\0\0\0"
                data = self.rfile.read(length)
                return bytes(b ^ mask[i % 4] for i, b in enumerate(data)).decode()

            def send_frame(self, data):
                if len(data) < 126:
                    header = struct.pack(">BB", 0x81, len(data))
                elif len(data) < 1 << 16:
                    header = struct.pack(">BBH", 0x81, 126, len(data))
                else:
                    header = struct.pack(">BBQ", 0x81, 127, len(data))
                self.wfile.write(header + data)
                self.wfile.flush()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
