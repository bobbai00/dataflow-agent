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

# One arm of the overhead experiments: a fresh agent service of this checkout (start-agent.sh), the replay of every
# conversation through it (replay-dataflow.ts), then the service stopped. Output in RUN_DIR: replay.jsonl, agent.log,
# replay.log, traces.db. The stack is $STACK_DIR's (default /var/tmp/texera-stable).
#
#   benchmark/tracker/run-arm.sh RUN_DIR AGENT_PORT MODEL_PORT CONVERSATIONS [replay-dataflow.ts options...]
case "${1:-}" in ""|-h|--help) awk 'NR > 13 && /^#/ { sub(/^# ?/, ""); print; s = 1; next } s { exit }' "$0"; exit 2;; esac
set -euo pipefail
run="$1" port="$2" model_port="$3" conversations="$4"
shift 4
here="$(cd "$(dirname "$0")" && pwd)"
texera="$(. "${STACK_DIR:-/var/tmp/texera-stable}/profile.sh" && echo "$TEXERA_DASHBOARD_SERVICE_ENDPOINT")"
mkdir -p "$run"
git -C "$here" rev-parse HEAD > "$run/revision.txt"
git -C "$here" diff HEAD > "$run/uncommitted.diff"
setsid "$here/start-agent.sh" "$port" "$model_port" "$run" > "$run/agent.log" 2>&1 &
agent=$!
trap 'kill -- -$agent 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -sf "localhost:$port/api/healthcheck" > /dev/null && break; sleep 1; done
bun "$here/replay-dataflow.ts" --conversations "$conversations" --out "$run/replay.jsonl" \
  --agent "http://localhost:$port" --model-port "$model_port" --texera "$texera" "$@" 2>&1 | tee "$run/replay.log"
