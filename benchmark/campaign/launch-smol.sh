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

# Launch one detached smolagents KramaBench run with the smolagents baseline settings used since 2026-10-11 (campaign 2
# reps, Opus 5.5, Gemini 3.8 Flash, GPT-6.1 Sol, Gemini 4 Argon): custom prompt, 25 steps, 5,000 output characters per
# step, 1,200 s per attempt, inputs over 100 MB one at a time, the locked script-agent interpreter (checked against
# Texera's sandbox Python, numpy and pyarrow), bubblewrap sandbox. Model calls go straight to the smolagents gateway
# (start-smol-gateway.sh, :60001). Haiku runs used the main gateway: GATEWAY=60000.
# Usage: [STACK_DIR=/var/tmp/texera-stable] [GATEWAY=60001] launch-smol.sh <run name> <model tag> <reps> <workers> [task ids...]
#        (no task ids = all 104 tasks)
set -euo pipefail
S="${STACK_DIR:-/var/tmp/texera-stable}"
[ -f "$S/profile.sh" ] || { echo "no stack at $S (write one with benchmark/campaign/stack/render.py)"; exit 2; }
set -a; . "$S/profile.sh"; set +a
W="$TEXERA_HOME"; GATEWAY=${GATEWAY:-60001}
OUT=$1 MODEL=$2 REPS=$3 WORKERS=$4; shift 4
if [ $# -gt 0 ]; then TASKS="--tasks $*"; else TASKS="--all-tasks"; fi
if [ -e "$S/runs/$OUT" ]; then echo "refusing: $S/runs/$OUT exists"; exit 1; fi
mkdir -p "$S/runs" "$S/logs"
cd "$W"
setsid -f bash "$S/run-env.sh" benchmark/Kramabench/.venv/bin/python benchmark/retrieval/run_baselines.py \
  --output "$S/runs/$OUT" --script-endpoint "http://localhost:$GATEWAY/v1" --model "$MODEL" --systems smolagents $TASKS \
  --repetitions "$REPS" --large-workers 1 --large-input-bytes 100000000 --workers "$WORKERS" --timeout 1200 \
  --max-steps 25 --output-chars 5000 --prompt custom > "$S/logs/$OUT.log" 2>&1 < /dev/null
echo "launched smolagents $OUT ($MODEL; reps $REPS; workers $WORKERS; checkout $W; gateway :$GATEWAY)"
