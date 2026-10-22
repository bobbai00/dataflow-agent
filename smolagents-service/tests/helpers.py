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

"""A scripted stand-in for the LLM, and a server running in a thread, for tests that need no gateway."""

import re
import socket
import threading
import time

import uvicorn
from smolagents.models import ChatMessage, ChatMessageStreamDelta, MessageRole
from smolagents.monitoring import TokenUsage


def last_task(messages) -> str:
    """The text of the newest user task in the messages the agent sent."""
    for message in reversed(messages):
        role = getattr(message, "role", None) or message.get("role")
        content = getattr(message, "content", None) if not isinstance(message, dict) else message.get("content")
        if str(getattr(role, "value", role)) == "user" and content:
            text = content if isinstance(content, str) else " ".join(
                part.get("text", "") for part in content if isinstance(part, dict))
            if "New task:" in text:
                return text.split("New task:", 1)[1]
    return ""


def file_in(task: str) -> str:
    """The first file path the task mentions."""
    match = re.search(r"'(/[^']+\.csv)'", task)
    return match.group(1) if match else ""


SUM_AND_CHART = [
    lambda task: ("Thought: Load the file and chart it.\n<code>\nimport pandas as pd\n"
                  f"df = pd.read_csv({file_in(task)!r})\nprint(df.shape)\n"
                  "import matplotlib.pyplot as plt\nplt.hist(df['x'])\n</code>"),
    lambda task: "Thought: Done.\n<code>\nfinal_answer(int(df['x'].sum()))\n</code>",
]


class ScriptedModel:
    """Replies from a script of functions of the newest task, one per call, cycling.

    Streams each reply in pieces spread over `latency` seconds, then reports token
    usage the way OpenAI-compatible streams do: in a final, contentless delta.
    """

    def __init__(self, script=SUM_AND_CHART, latency: float = 0.0, pieces: int = 5):
        self.script = script
        self.latency = latency
        self.pieces = pieces
        self.model_id = "scripted"
        self.calls = 0

    def _reply(self, messages) -> tuple[str, TokenUsage]:
        text = self.script[self.calls % len(self.script)](last_task(messages))
        self.calls += 1
        size = sum(len(str(m.get("content") if isinstance(m, dict) else m.content)) for m in messages)
        return text, TokenUsage(input_tokens=size // 4, output_tokens=len(text) // 4)

    def generate(self, messages, stop_sequences=None, **kwargs) -> ChatMessage:
        time.sleep(self.latency)
        text, usage = self._reply(messages)
        return ChatMessage(role=MessageRole.ASSISTANT, content=text, token_usage=usage)

    def generate_stream(self, messages, stop_sequences=None, **kwargs):
        text, usage = self._reply(messages)
        step = max(1, len(text) // self.pieces)
        for start in range(0, len(text), step):
            time.sleep(self.latency / self.pieces)
            yield ChatMessageStreamDelta(content=text[start:start + step])
        yield ChatMessageStreamDelta(content="", token_usage=usage)


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class ServerThread:
    """The real app under uvicorn, on a free localhost port, in a background thread."""

    def __init__(self, app):
        self.port = free_port()
        self.url = f"http://127.0.0.1:{self.port}"
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=self.port, log_level="warning"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def __enter__(self):
        self.thread.start()
        deadline = time.monotonic() + 30
        while not self.server.started:
            if time.monotonic() > deadline:
                raise RuntimeError("the test server did not start")
            time.sleep(0.05)
        return self

    def __exit__(self, *exc):
        self.server.should_exit = True
        self.thread.join(timeout=10)
