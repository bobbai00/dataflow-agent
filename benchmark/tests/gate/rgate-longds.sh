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
# The $0 runner gate for LongDS: replay the baseline session smk2-longds (netflix task2, 2 requests, Haiku 5.5) through
# this checkout's session runners and compare each arm with its baseline. The dataflow arms' every model request must
# match (the session agent's wire traces); the Script ReAct arm, which keeps no model inputs, is served its recorded
# outputs in order and compared by its answers. Ports 3153/3193 (rgate.sh uses 3152/3192).
# Usage: [STACK_DIR=/var/tmp/texera-cleanup] [GATE_BASELINE=$STACK_DIR/runs] [LONGDS_SESSION=<prepared session>]
#        rgate-longds.sh <out dir> [--allow key ...]   (allow: allow-keys.txt)
set -euo pipefail
OUT=$1; shift
ALLOW=(); [ "${1:-}" = "--allow" ] && { shift; ALLOW=("$@"); }
HERE=$(cd "$(dirname "$0")" && pwd)
W=$(cd "$HERE/../../.." && pwd)
S=${STACK_DIR:-/var/tmp/texera-cleanup}
BASE=${GATE_BASELINE:-$S/runs}
SES=${LONGDS_SESSION:-/home/bob/Desktop/longds-lite-experiments-20261015/sessions/business__netflix_movies_and_tv_shows__task2}
[ ${#ALLOW[@]} -gt 0 ] || read -r -a ALLOW <<< "$(grep -v '^#' "$HERE/allow-keys.txt" | tr '\n' ' ')"
AGENT_PORT=3153; STUB_PORT=3193
[ -e "$OUT" ] && { echo "exists: $OUT"; exit 1; }
for p in $AGENT_PORT $STUB_PORT; do ss -ltnH | awk '{print $4}' | grep -q ":$p$" && { echo "port $p busy"; exit 1; }; done
mkdir -p "$OUT/wire" "$OUT/workspace" "$OUT/longds"
OUT=$(cd "$OUT" && pwd)
set -a; . "$S/profile.sh"; set +a

stub() {  # one stub per arm: catalog-gold and transcript-depnote send identical first requests
  python3 -I "$HERE/replay_model.py" --port $STUB_PORT --log "$OUT/model-requests-$1.jsonl" \
    --wire-root "$S/wire" --arm "$1" "$BASE/smk2-longds" > "$OUT/stub-$1.log" 2>&1 &
  STUB=$!
  for _ in $(seq 1 30); do curl -sf localhost:$STUB_PORT/health/liveliness >/dev/null && break; sleep 1; done
}
STUB=
(cd "$W/agent-service" && exec setsid bash "$S/run-env.sh" env PORT=$AGENT_PORT LLM_ENDPOINT=http://localhost:$STUB_PORT \
  MODEL_RETRIES_PER_TURN=0 TEXERA_LLM_TRACE_DIR="$OUT/wire" NATIVE_WORKSPACE="$OUT/workspace" \
  AGENT_TRACE_DB="$OUT/traces.db" UDF_PYTHON_PATH="$W/benchmark/src/bobbench/sandbox/engine_python.py" \
  bun run src/server.ts > "$OUT/agent.log" 2>&1) &
AGENT=$!
cleanup() { kill $STUB 2>/dev/null; kill -- -$AGENT 2>/dev/null || kill $AGENT 2>/dev/null; true; }
trap cleanup EXIT
trap 'exit 143' TERM INT
for _ in $(seq 1 60); do curl -sf localhost:$AGENT_PORT/api/healthcheck >/dev/null && break; sleep 1; done

cd "$W"
for arm in catalog-gold transcript-depnote; do
  stub $arm
  setsid -w bash "$S/run-env.sh" env TEXERA_AGENT_SERVICE_ENDPOINT=http://localhost:$AGENT_PORT PYTHONPATH="$W/benchmark/src" \
    .venv/bin/python -m benchmark.longds.run_session --prepared "$SES" --out "$OUT/longds/$arm" --arm $arm \
    --model claude-haiku-5.5 --turns 2 --spend-limit 1 > "$OUT/$arm.log" 2>&1 || echo "$arm runner failed"
  echo "$arm: $(tail -n 1 "$OUT/$arm.log" | cut -c1-120)"
  kill $STUB; wait $STUB 2>/dev/null || true
done
stub smolagents-depnote
setsid -w bash "$S/run-env.sh" env LITELLM_BASE_URL=http://localhost:$STUB_PORT PYTHONPATH="$W/benchmark/src" \
  .venv/bin/python -m benchmark.longds.smolagents_session --prepared "$SES" --out "$OUT/longds/smolagents-depnote" \
  --model claude-haiku-5.5 --turns 2 --spend-limit 1 --note dependencies > "$OUT/smolagents-depnote.log" 2>&1 \
  || echo "smolagents-depnote runner failed"
echo "smolagents-depnote: $(tail -n 1 "$OUT/smolagents-depnote.log" | cut -c1-120)"

STATUS=0
python3 -I "$HERE/compare.py" --wire "$S/wire" "$OUT/wire" "$BASE/smk2-longds" "$OUT/longds" --allow "${ALLOW[@]}" \
  | tee "$OUT/compare.txt" || STATUS=$?
UNMATCHED=$(cat "$OUT"/model-requests-*.jsonl | grep -c '"attempt": null' || true)
echo "unmatched stub requests: $UNMATCHED"
[ "$UNMATCHED" = 0 ] || STATUS=1
exit $STATUS
