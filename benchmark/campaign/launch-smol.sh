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

# Launch one run, detached (WAIT=1: stay until it ends): a Script ReAct (smolagents) KramaBench run with the paper's settings: custom instructions, 25 steps,
# 5,000 output characters per step, 1,200 s per attempt, inputs over 100 MB one at a time, the locked interpreter
# (checked against Texera's sandbox Python, numpy and pyarrow), bubblewrap sandbox. Model calls go straight to a
# gateway: the smolagents gateway (start-smol-gateway.sh, offset + 4001) for the models it carries (GPT-6.1 Sol,
# Gemini 4 Argon), the main gateway (offset + 4000) for the rest, as in the paper's runs. GATEWAY=<port> overrides.
# Usage: [WAIT=1] [STACK_DIR=/var/tmp/bobflow-bench] [GATEWAY=<port>] launch-smol.sh <run name> <model tag> <reps>
#        <workers> [task ids...]   (no task ids = all 104 tasks)
case "${1:-}" in ""|-h|--help) awk 'NR > 13 && /^#/ { sub(/^# ?/, ""); print; s = 1; next } s { exit }' "$0"; exit 2;; esac
set -euo pipefail
S="${STACK_DIR:-/var/tmp/bobflow-bench}"
[ -f "$S/profile.sh" ] || { echo "no stack at $S (write one with benchmark/campaign/stack/render.py)"; exit 2; }
set -a; . "$S/profile.sh"; set +a
W="$TEXERA_HOME"
if [ -z "${GATEWAY:-}" ]; then
  # The smolagents gateway carries only the routes Script ReAct needs set up differently (GPT-6.1 Sol, Gemini 4 Argon);
  # every other model's Script ReAct runs used the main gateway, as the paper's did.
  ROUTE=$(PYTHONPATH="$W/benchmark/src" "$W/benchmark/envs/kramabench/.venv/bin/python" -c \
    'import sys; from bobbench.models import MODEL_TYPES; print(MODEL_TYPES[sys.argv[1]])' "$2")
  for suffix in -high -medium -low; do ROUTE=${ROUTE%"$suffix"}; done
  if grep -qx "  - model_name: $ROUTE" "$W/bin/single-node/litellm-config.smolagents.yaml"; then
    GATEWAY=$((TEXERA_LOCAL_DEV_PORT_OFFSET + 4001))
  else
    GATEWAY=$((TEXERA_LOCAL_DEV_PORT_OFFSET + 4000))
  fi
fi
OUT=$1 MODEL=$2 REPS=$3 WORKERS=$4; shift 4
if [ $# -gt 0 ]; then TASKS="--tasks $*"; else TASKS="--all-tasks"; fi
if [ -e "$S/runs/$OUT" ]; then echo "refusing: $S/runs/$OUT exists"; exit 1; fi
mkdir -p "$S/runs" "$S/logs"
echo "$S/runs/$OUT" >> "$S/runs.txt"   # the stack's memory guard watches this run
DETACH=-f WORD=launched
if [ -n "${WAIT:-}" ]; then DETACH=-w WORD=finished; fi
setsid $DETACH bash "$S/run-env.sh" "$W/benchmark/bench" run kramabench scriptreact --output "$S/runs/$OUT" --models "$MODEL" \
  $TASKS --repetitions "$REPS" --workers "$WORKERS" --script-endpoint "http://localhost:$GATEWAY/v1" \
  > "$S/logs/$OUT.log" 2>&1 < /dev/null
echo "$WORD Script ReAct $OUT ($MODEL; reps $REPS; workers $WORKERS; checkout $W; gateway :$GATEWAY)"
