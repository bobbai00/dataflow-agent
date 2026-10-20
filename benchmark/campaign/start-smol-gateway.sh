#!/usr/bin/env bash
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

# (Re)create the smolagents gateway: LiteLLM 1.83.10 with bin/single-node/litellm-config.smolagents.yaml and the
# strict-tools hook of the stack's checkout, on 127.0.0.1:$SMOL_GATEWAY_PORT (default 60001), container
# <project>-litellm-smol. Provider keys come from the checkout's .env. The gateway reads its config only at start:
# recreate it only between runs.
# Usage: [STACK_DIR=/var/tmp/texera-stable] [SMOL_GATEWAY_PORT=60001] start-smol-gateway.sh
set -euo pipefail
S="${STACK_DIR:-/var/tmp/texera-stable}"
[ -f "$S/profile.sh" ] || { echo "no stack at $S (write one with benchmark/campaign/stack/render.py)"; exit 2; }
set -a; . "$S/profile.sh"; set +a
W="$TEXERA_HOME"; PORT=${SMOL_GATEWAY_PORT:-60001}; NAME="$TEXERA_DOCKER_PROJECT-litellm-smol"
set -a; . "$W/.env" >/dev/null 2>&1; set +a
export OPENROUTER_BASE_URL=${OPENROUTER_BASE_URL:-https://openrouter.ai/api/v1}
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped -p "127.0.0.1:$PORT:4000" \
  -e OPENAI_API_KEY -e OPENROUTER_API_KEY -e OPENROUTER_BASE_URL -e ANTHROPIC_API_KEY -e GEMINI_API_KEY -e LITELLM_MASTER_KEY \
  -v "$W/bin/single-node/litellm-config.smolagents.yaml:/app/config.yaml:ro" \
  -v "$W/bin/strict_tools.py:/app/strict_tools.py:ro" \
  ghcr.io/berriai/litellm:v1.83.10-stable --config /app/config.yaml --port 4000 --host 0.0.0.0 >/dev/null
until curl -sf -o /dev/null "http://127.0.0.1:$PORT/health/liveliness"; do sleep 3; done
echo "smolagents gateway $NAME up on :$PORT (config from $W)"
