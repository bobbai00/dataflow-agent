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
# The $0 runner gate: replay the baseline smokes' recorded model responses through this checkout's runners and compare
# every attempt with its baseline. A stub model (replay_model.py, :3192) serves the recorded responses; a gate agent
# from this checkout (:3152) sends its model calls to the stub; Script ReAct calls the stub directly.
# Usage: [STACK_DIR=/var/tmp/texera-cleanup] [GATE_BASELINE=$STACK_DIR/runs] rgate.sh <out dir>
#        [kb] [kbflow] [pb] [kbsmol] [pbsmol] [--allow key ...]   (default: all five runs; allow: allow-keys.txt)
# kbflow replays smk5-kbflow: both Flow Evidence arms on five tasks whose pipelines filter, join, group and window, so
# 7 of its 10 attempts carry runtime-stats lines (no paper arm turns Flow Evidence on).
set -euo pipefail
OUT=$1; shift
RUNS=(); ALLOW=()
while [ $# -gt 0 ]; do case $1 in --allow) shift; ALLOW+=("$@"); break;; *) RUNS+=("$1"); shift;; esac; done
[ ${#RUNS[@]} -gt 0 ] || RUNS=(kb kbflow pb kbsmol pbsmol)
HERE=$(cd "$(dirname "$0")" && pwd)
W=$(cd "$HERE/../../.." && pwd)
S=${STACK_DIR:-/var/tmp/texera-cleanup}
BASE=${GATE_BASELINE:-$S/runs}
[ ${#ALLOW[@]} -gt 0 ] || read -r -a ALLOW <<< "$(grep -v '^#' "$HERE/allow-keys.txt" | tr '\n' ' ')"
declare -A REF=([kb]=smk2-kb [kbflow]=smk5-kbflow [pb]=smk2-pb [kbsmol]=smk0-kbsmol [pbsmol]=smk0-pbsmol)
KB_TASKS="archeology-easy-6 astronomy-easy-1 legal-easy-25"; PB_TASKS="prepbench-hard-1 prepbench-hard-50"
KBFLOW_TASKS="wildfire-easy-15 environment-easy-6 archeology-easy-11 wildfire-hard-17 legal-hard-15"
[ -e "$OUT" ] && { echo "exists: $OUT"; exit 1; }
for p in 3152 3192; do ss -ltnH | awk '{print $4}' | grep -q ":$p$" && { echo "port $p busy"; exit 1; }; done
mkdir -p "$OUT/wire" "$OUT/workspace"
OUT=$(cd "$OUT" && pwd)
# The runners link KramaBench's system_scratch/<SUT> into the run folder and refuse an existing name: drop the links
# earlier gate runs left (only links into gate folders).
unlink_gate_suts() { find "$W/benchmark/Kramabench/system_scratch" -maxdepth 1 -type l -lname '*/rgate/*' -delete 2>/dev/null || true; }
unlink_gate_suts
set -a; . "$S/profile.sh"; set +a

python3 -I "$HERE/replay_model.py" --port 3192 --log "$OUT/model-requests.jsonl" \
  $(for r in "${RUNS[@]}"; do echo "$BASE/${REF[$r]}"; done) > "$OUT/stub.log" 2>&1 &
STUB=$!
(cd "$W/agent-service" && exec setsid bash "$S/run-env.sh" env PORT=3152 LLM_ENDPOINT=http://localhost:3192 \
  MODEL_RETRIES_PER_TURN=0 TEXERA_LLM_TRACE_DIR="$OUT/wire" NATIVE_WORKSPACE="$OUT/workspace" \
  AGENT_TRACE_DB="$OUT/traces.db" UDF_PYTHON_PATH="$W/benchmark/src/bobbench/sandbox/engine_python.py" \
  bun run src/server.ts > "$OUT/agent.log" 2>&1) &
AGENT=$!
cleanup() { kill $STUB 2>/dev/null; kill -- -$AGENT 2>/dev/null || kill $AGENT 2>/dev/null; unlink_gate_suts; true; }
trap cleanup EXIT
trap 'exit 143' TERM INT
for _ in $(seq 1 60); do curl -sf localhost:3152/api/healthcheck >/dev/null && break; sleep 1; done
grep -m1 'recorded calls' "$OUT/stub.log"

REV=$(git -C "$W" rev-parse HEAD)
# An invalid judge key (set after run-env.sh reads .env): a judge-cache miss scores as unscored, never as a paid call.
JUDGE=(env OPENAI_API_KEY=invalid-gate-key)
ENV=("${JUDGE[@]}" TEXERA_API_ENDPOINT="$TEXERA_DASHBOARD_SERVICE_ENDPOINT" TEXERA_COMPUTING_UNIT_ENDPOINT="$TEXERA_COMPUTING_UNIT_ENDPOINT"
     TEXERA_WORKFLOW_EXECUTION_ENDPOINT="$WORKFLOW_EXECUTION_SERVICE_ENDPOINT")
PY=benchmark/Kramabench/.venv/bin/python
cd "$W"
for r in "${RUNS[@]}"; do
  case $r in
    kb) setsid -w bash "$S/run-env.sh" "${ENV[@]}" PYTHONPATH="$W/benchmark/src" $PY benchmark/retrieval/run.py --output "$OUT/kb" \
          --endpoint http://localhost:3152 --models Haiku55 \
          --arms evidence_full_flow0 evidence_data1_flow0 evidence_data1_flow0_opt --tasks $KB_TASKS --repetitions 1 \
          --large-workers 1 --large-input-bytes 100000000 --workers 3 --timeout 900 --direct-artifacts \
          --full-result-char-limit 5000 --sample-char-limit 2000 --wire-dir "$OUT/wire" \
          --agent-revision "$REV" --engine-revision "$REV" --selection "rgate replay of ${REF[kb]}" > "$OUT/kb.log" 2>&1 ;;
    kbflow) setsid -w bash "$S/run-env.sh" "${ENV[@]}" PYTHONPATH="$W/benchmark/src" $PY benchmark/retrieval/run.py --output "$OUT/kbflow" \
          --endpoint http://localhost:3152 --models Haiku55 \
          --arms evidence_data1_flow1 evidence_full_flow1 --tasks $KBFLOW_TASKS --repetitions 1 \
          --large-workers 1 --large-input-bytes 100000000 --workers 3 --timeout 900 --direct-artifacts \
          --full-result-char-limit 5000 --sample-char-limit 2000 --wire-dir "$OUT/wire" \
          --agent-revision "$REV" --engine-revision "$REV" --selection "rgate replay of ${REF[kbflow]}" > "$OUT/kbflow.log" 2>&1 ;;
    pb) setsid -w bash "$S/run-env.sh" "${ENV[@]}" PYTHONPATH="$W/benchmark/src" $PY benchmark/retrieval/run.py --benchmark prepbench --output "$OUT/pb" \
          --endpoint http://localhost:3152 --agent-revision "$REV" --engine-revision "$REV" --models Haiku55 \
          --arms evidence_full_flow0 evidence_data1_flow0_opt --repetitions 1 --workers 2 --timeout 900 \
          --large-input-bytes 5000000000 --full-result-char-limit 5000 --sample-char-limit 2000 --direct-artifacts \
          --wire-dir "$OUT/wire" --selection "rgate replay of ${REF[pb]}" --tasks $PB_TASKS > "$OUT/pb.log" 2>&1 ;;
    kbsmol) setsid -w bash "$S/run-env.sh" "${JUDGE[@]}" PYTHONPATH="$W/benchmark/src" $PY benchmark/retrieval/run_baselines.py --output "$OUT/kbsmol" \
          --script-endpoint http://localhost:3192/v1 --model Haiku55 --systems smolagents --tasks $KB_TASKS \
          --repetitions 1 --large-workers 1 --large-input-bytes 100000000 --workers 3 --timeout 1200 \
          --max-steps 25 --output-chars 5000 --prompt custom > "$OUT/kbsmol.log" 2>&1 ;;
    pbsmol) setsid -w bash "$S/run-env.sh" "${JUDGE[@]}" PYTHONPATH="$W/benchmark/src" $PY benchmark/prepbench/smol_run.py --output "$OUT/pbsmol" \
          --script-endpoint http://localhost:3192/v1 --model Haiku55 --systems smolagents --repetitions 1 \
          --workers 2 --timeout 900 --large-input-bytes 5000000000 --tasks $PB_TASKS > "$OUT/pbsmol.log" 2>&1 ;;
  esac
  echo "$r: $(tail -n 1 "$OUT/$r.log")"
done
ARGS=(); for r in "${RUNS[@]}"; do ARGS+=("$BASE/${REF[$r]}" "$OUT/$r"); done
STATUS=0
python3 -I "$HERE/compare.py" "${ARGS[@]}" --allow "${ALLOW[@]}" | tee "$OUT/compare.txt" || STATUS=$?
UNMATCHED=$(grep -c '"attempt": null' "$OUT/model-requests.jsonl" || true)
echo "unmatched stub requests: $UNMATCHED"
[ "$UNMATCHED" = 0 ] || STATUS=1
exit $STATUS
