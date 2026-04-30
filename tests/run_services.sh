#!/usr/bin/env bash
# Boot all required Texera scala services via sbt run.
# Each service runs in its OWN sbt JVM (cold-started in parallel), so the
# sbt-server-single-task limitation doesn't apply.
#
# Required services (per user instruction — skip FileService and
# WorkflowCompilingService):
#   1. AccessControlService          -> :9096 (login + JWT)
#   2. ComputingUnitManagingService  -> :8888 (computing-unit registration)
#   3. WorkflowExecutionService      -> :8080 (TexeraWebApplication)
#                                    -> :8085 (ComputingUnitMaster)
#
# Logs: tests/.logs/<service>.log
# PIDs: tests/.logs/services.pids

set -uo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

# shellcheck source=/dev/null
. "$REPO_ROOT/tests/.envrc"

LOG_DIR="$REPO_ROOT/tests/.logs"
mkdir -p "$LOG_DIR"

PID_FILE="$LOG_DIR/services.pids"
: > "$PID_FILE"

# Each service uses its own ~/.sbt/staging area to avoid lock contention
# between parallel sbt invocations. SBT_OPTS adds ample heap and a unique
# user-home so coursier/ivy locks don't collide.
SHARED_SBT_OPTS="-Dsbt.color=always -Xmx2g -Dsbt.boot.lock=false"

spawn_service() {
  local name=$1                  # log filename + display name
  local sbt_command=$2           # e.g. 'project AccessControlService' 'run'
  local port=$3

  local logfile="$LOG_DIR/${name}.log"
  echo "[spawn] $name -> $logfile (waiting for :$port)"
  (
    cd "$REPO_ROOT"
    SBT_OPTS="$SHARED_SBT_OPTS" \
      nohup sbt -no-colors $sbt_command </dev/null >"$logfile" 2>&1 &
    echo $! >>"$PID_FILE"
  )
}

wait_for_port() {
  local name=$1
  local port=$2
  local timeout_sec=${3:-300}
  for i in $(seq 1 "$timeout_sec"); do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "  [up] $name on :$port (after ${i}s)"
      return 0
    fi
    sleep 1
  done
  echo "  [FAIL] $name did not bind :$port within ${timeout_sec}s"
  echo "  Last log:"
  tail -25 "$LOG_DIR/${name}.log" 2>/dev/null || true
  return 1
}

# --- Spawn all sbt JVMs in parallel ---------------------------------------
# Each is independent; they cold-start concurrently.

spawn_service AccessControlService            \
  '"project AccessControlService" "run"'      9096
spawn_service ComputingUnitManagingService    \
  '"project ComputingUnitManagingService" "run"' 8888
spawn_service TexeraWebApplication            \
  '"project WorkflowExecutionService" "runMain org.apache.texera.web.TexeraWebApplication"' 8080
spawn_service ComputingUnitMaster             \
  '"project WorkflowExecutionService" "runMain org.apache.texera.web.ComputingUnitMaster"' 8085

echo
echo "Waiting for ports (cold-start can take 60-120s)..."
wait_for_port AccessControlService         9096 300 || exit 1
wait_for_port ComputingUnitManagingService 8888 300 || exit 1
wait_for_port TexeraWebApplication         8080 300 || exit 1
wait_for_port ComputingUnitMaster          8085 300 || exit 1

echo
echo "All services up. PIDs:"
cat "$PID_FILE"
echo "Logs: $LOG_DIR/"
echo "Stop: bash tests/stop_services.sh"
