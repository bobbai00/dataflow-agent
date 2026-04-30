#!/usr/bin/env bash
# Shut down the sbt-run services started by tests/run_services.sh.

set -uo pipefail
cd "$(dirname "$0")/.."

LOG_DIR="$(pwd)/tests/.logs"
PID_FILE="$LOG_DIR/services.pids"

if [ -f "$PID_FILE" ]; then
  while read -r pid; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "Killing $pid"
      kill "$pid" 2>/dev/null || true
    fi
  done < "$PID_FILE"
  rm -f "$PID_FILE"
fi

# Also kill any sbt-spawned JVMs bound to the four ports just in case.
for port in 9096 8888 8080 8085 8081 8082; do
  pid=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$pid" ]; then
    echo "Killing :$port pid $pid"
    kill "$pid" 2>/dev/null || true
  fi
done

# Stop the sbt server too.
sbt --client shutdown 2>/dev/null || true

echo "Done."
