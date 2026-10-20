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

# Dataflow agent for the stack in $STACK_DIR, served from the stack's checkout (TEXERA_HOME) on the profile's agent port.
# Stack profile plus the campaign agent overrides used since campaign 2: MODEL_RETRIES_PER_TURN=2, the checkout's
# validation sandbox, the stack's own wire and workspace dirs. Model calls go through the stack's
# access-control-service to its gateway. Non-watch mode: do not edit the checkout while runs are in flight.
# Usage: [STACK_DIR=/var/tmp/texera-stable] start-agent.sh
set -euo pipefail
S="${STACK_DIR:-/var/tmp/texera-stable}"
[ -f "$S/profile.sh" ] || { echo "no stack at $S (write one with benchmark/campaign/stack/render.py)"; exit 2; }
set -a; . "$S/profile.sh"; set +a
W="$TEXERA_HOME"
mkdir -p "$S/wire" "$S/native-workspaces-agent" "$S/logs"
cd "$W/agent-service"
setsid -f bash "$S/run-env.sh" env PORT="$TEXERA_AGENT_SERVICE_PORT" MODEL_RETRIES_PER_TURN=2 \
  UDF_PYTHON_PATH="$W/benchmark/retrieval/native_isolated_python.py" \
  TEXERA_LLM_TRACE_DIR="$S/wire" NATIVE_WORKSPACE="$S/native-workspaces-agent" \
  bun run src/server.ts >> "$S/logs/agent-$TEXERA_AGENT_SERVICE_PORT.log" 2>&1 < /dev/null
echo "agent starting on :$TEXERA_AGENT_SERVICE_PORT from $W (log $S/logs/agent-$TEXERA_AGENT_SERVICE_PORT.log)"
