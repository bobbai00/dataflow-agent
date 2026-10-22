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

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from smolagents import OpenAIServerModel


@dataclass
class Config:
    data_dir: Path
    gateway_url: str = "http://localhost:4000"
    api_key: str = ""
    model_id: str = "claude-sonnet-5.5"
    instructions: str = ""  # appended to every agent's instructions: a study's rules for the agent, say
    notebook_instructions: str = ""  # told to the agent after a notebook is imported, for what follows
    max_steps: int = 20
    concurrency: int = 16  # agent runs in progress at once, across all users
    max_sessions: int = 32  # open chat sessions, each with its own worker process (~0.1-0.3 GB)
    exec_timeout: float = 300.0  # seconds one code execution may take
    idle_minutes: float = 60.0  # a chat session unused this long is closed
    disconnect_grace_seconds: float = 60.0  # a session whose tab has been gone this long is closed
    sandbox: str = "auto"  # "auto", "seatbelt" or "none"; see executor.py
    secret_files: tuple[Path, ...] = ()  # files model code must not read, such as the server's .env
    login_days: float = 7.0
    secure_cookies: bool = False  # set behind HTTPS
    model_factory: Callable[[], Any] | None = None  # tests swap in a scripted model

    def __post_init__(self):
        self.data_dir = Path(self.data_dir).resolve()

    def user_dir(self, user_id: int) -> Path:
        return self.data_dir / "users" / str(user_id)

    def make_model(self):
        if self.model_factory is not None:
            return self.model_factory()
        return OpenAIServerModel(model_id=self.model_id, api_base=self.gateway_url.rstrip("/") + "/v1",
                                 api_key=self.api_key)
