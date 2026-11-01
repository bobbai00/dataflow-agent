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
# The benchmark stack: Texera's services, the agent and the model gateways of this checkout, with their own ports,
# containers, volumes and state under $STACK_DIR (default /var/tmp/bobflow-bench). Provider keys come from the
# checkout's .env. Only one stack per checkout can run at a time: they would share its build and its results folder
# ($TEXERA_HOME/amber/user-resources/workflow-results), so `up` refuses while another stack runs from this checkout.
#
# Usage: [STACK_DIR=<dir>] bench stack up       write the stack on first use, build, start everything (safe to repeat)
#        [STACK_DIR=<dir>] bench stack status   what is running
#        [STACK_DIR=<dir>] bench stack down     stop everything; the data stays in the stack's docker volumes
usage() { awk 'NR > 12 && /^#/ { sub(/^# ?/, ""); print; s = 1; next } s { exit }' "$0"; exit "${1:-0}"; }
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
export STACK_DIR="${STACK_DIR:-/var/tmp/bobflow-bench}"
S=$STACK_DIR

local_dev() { TEXERA_LOCAL_DEV_PROFILE="$S/profile.sh" bash "$S/run-env.sh" "$REPO/bin/local-dev.sh" "$@"; }

stop_port() {
  local pid
  pid=$(lsof -tiTCP:"$1" -sTCP:LISTEN || true)
  [ -z "$pid" ] || kill $pid
  for _ in $(seq 1 20); do lsof -tiTCP:"$1" -sTCP:LISTEN >/dev/null || return 0; sleep 1; done
  echo "port $1 is still busy" >&2; return 1
}

profile() { set -a; . "$S/profile.sh"; set +a; }

# JVMs that run from this checkout's build but belong to another stack (bin/local-dev.sh up, or another STACK_DIR).
other_stacks() {
  local pid
  for pid in $(pgrep -u "$(id -u)" java || true); do
    tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null | grep -qF -e "$REPO/target/" -e "$REPO/amber/target/" || continue
    tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -qx "TEXERA_LOCAL_DEV_DIR=$S" && continue
    echo "$pid"
  done
}

up() {
  [ -f "$REPO/.env" ] || { echo "no $REPO/.env: cp .env.example .env, then add the provider keys" >&2; exit 2; }
  [ -x "$REPO/.venv/bin/python" ] || { echo "no $REPO/.venv: run benchmark/bench setup first" >&2; exit 2; }
  if [ -n "$(other_stacks)" ]; then
    echo "another stack's services run from this checkout (JVM pids: $(other_stacks | tr '\n' ' '))." >&2
    echo "Two stacks on one checkout share its build and its results folder. Stop the other one first," >&2
    echo "for the default stack: bin/local-dev.sh down" >&2
    exit 2
  fi
  python3 -I "$HERE/stack/render.py" --stack-dir "$S"
  [ -d "$REPO/agent-service/node_modules" ] || (cd "$REPO/agent-service" && bun install --frozen-lockfile)
  local_dev up --build --skip=frontend,agent-service
  profile
  # The pgroonga index rejects workflows over ~1.8 MB (MeCab).
  docker exec "$TEXERA_POSTGRES_CONTAINER" psql -q -U texera -d texera_db \
    -c "DROP INDEX IF EXISTS texera_db.idx_workflow_pgroonga;"
  stop_port "$TEXERA_AGENT_SERVICE_PORT"
  "$HERE/start-agent.sh"
  for _ in $(seq 1 60); do curl -sf "localhost:$TEXERA_AGENT_SERVICE_PORT/api/healthcheck" >/dev/null && break; sleep 1; done
  curl -sf "localhost:$TEXERA_AGENT_SERVICE_PORT/api/healthcheck" >/dev/null || {
    echo "the agent did not start; see $S/logs/agent-$TEXERA_AGENT_SERVICE_PORT.log" >&2; exit 1; }
  "$HERE/start-smol-gateway.sh"
  if ! { [ -f "$S/guard.pid" ] && kill -0 "$(cat "$S/guard.pid")" 2>/dev/null; }; then
    nohup python3 -I "$HERE/guard.py" >/dev/null 2>&1 < /dev/null &
    echo $! > "$S/guard.pid"
  fi
  echo "stack up: agent on :$TEXERA_AGENT_SERVICE_PORT, runs in $S/runs"
}

down() {
  profile
  stop_port "$TEXERA_AGENT_SERVICE_PORT"
  if [ -f "$S/guard.pid" ]; then kill "$(cat "$S/guard.pid")" 2>/dev/null || true; rm -f "$S/guard.pid"; fi
  docker rm -f "$TEXERA_DOCKER_PROJECT-litellm-smol" >/dev/null 2>&1 || true
  local_dev down
}

case "${1:-}" in
  up) up ;;
  status) [ -f "$S/profile.sh" ] || { echo "no stack at $S: bench stack up writes one"; exit 1; }; local_dev status ;;
  down) [ -f "$S/profile.sh" ] || { echo "no stack at $S"; exit 0; }; down ;;
  -h|--help|help) usage ;;
  *) usage 2 ;;
esac
