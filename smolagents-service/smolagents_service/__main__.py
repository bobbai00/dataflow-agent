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

"""Run the server: `python -m smolagents_service` from smolagents-service/ (see README.md)."""

import argparse
import atexit
import logging
import os
from pathlib import Path

import uvicorn
from dotenv import load_dotenv

from .app import create_app, use_private_temp
from .config import Config

REPO_ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    parser = argparse.ArgumentParser(description="Multi-user smolagents data-analysis server with traces in SQLite.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7860)
    parser.add_argument("--data-dir", type=Path, default=REPO_ROOT / "logs" / "smolagents-service",
                        help="accounts, traces (traces.db) and every user's files")
    parser.add_argument("--model", default="claude-sonnet-5.5", help="a model id the gateway serves")
    parser.add_argument("--max-steps", type=int, default=20)
    parser.add_argument("--concurrency", type=int, default=16, help="agent runs in progress at once")
    parser.add_argument("--max-sessions", type=int, default=32, help="open chat sessions (worker processes)")
    parser.add_argument("--exec-timeout", type=float, default=300.0, help="seconds one code execution may take")
    parser.add_argument("--idle-minutes", type=float, default=60.0)
    parser.add_argument("--disconnect-grace", type=float, default=60.0,
                        help="seconds after a tab closes before its session and worker are closed")
    parser.add_argument("--sandbox", choices=["auto", "seatbelt", "none"], default="auto")
    parser.add_argument("--secure-cookies", action="store_true", help="when served over HTTPS")
    args = parser.parse_args()

    # Credentials as bin/local-dev.sh reads them: the repo-root .env, shell-exported values first.
    env_file = REPO_ROOT / ".env"
    load_dotenv(env_file)
    config = Config(
        data_dir=args.data_dir, gateway_url=os.environ.get("LITELLM_BASE_URL", "http://localhost:4000"),
        api_key=os.environ.get("LITELLM_MASTER_KEY", ""), model_id=args.model, max_steps=args.max_steps,
        concurrency=args.concurrency, max_sessions=args.max_sessions, exec_timeout=args.exec_timeout,
        idle_minutes=args.idle_minutes, disconnect_grace_seconds=args.disconnect_grace, sandbox=args.sandbox,
        secret_files=(env_file,), secure_cookies=args.secure_cookies)
    if not config.api_key:
        raise SystemExit("LITELLM_MASTER_KEY is not set (shell or repo-root .env)")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # one line per model call otherwise
    use_private_temp(config.data_dir)
    app = create_app(config)
    atexit.register(app.state.sessions.close_all, "server stopped")
    logging.getLogger("smolagents_service").info("serving http://%s:%d (data: %s, model: %s)", args.host, args.port,
                                                 config.data_dir, config.model_id)
    # Tabs still open hold heartbeat streams that never end on their own; without a
    # limit a graceful shutdown waits for them forever.
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning", timeout_graceful_shutdown=5)
    app.state.sessions.close_all("server stopped")


if __name__ == "__main__":
    main()
