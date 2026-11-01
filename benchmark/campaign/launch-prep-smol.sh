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

# Launch one run, detached (WAIT=1: stay until it ends): a Script ReAct (smolagents) PrepBench run with the paper's settings: custom instructions, 25 steps,
# 5,000 output characters, 900 s per attempt, large inputs allowed, 1 repetition. The agent writes each output table to
# result/output_NN.csv; the files are collected for PrepBench's evaluator (`bench score prepbench`). Model calls go to
# the smolagents gateway (offset + 4001) unless GATEWAY is set; the Haiku runs used the main
# gateway (offset + 4000), which carries the Haiku routes.
# Usage: [WAIT=1] [STACK_DIR=/var/tmp/bobflow-bench] [GATEWAY=<offset + 4001>] launch-prep-smol.sh <run name> <model tag>
#        <workers> [task ids...]   (default: all 306 cases)
case "${1:-}" in ""|-h|--help) awk 'NR > 13 && /^#/ { sub(/^# ?/, ""); print; s = 1; next } s { exit }' "$0"; exit 2;; esac
set -euo pipefail
S="${STACK_DIR:-/var/tmp/bobflow-bench}"
[ -f "$S/profile.sh" ] || { echo "no stack at $S (write one with benchmark/campaign/stack/render.py)"; exit 2; }
set -a; . "$S/profile.sh"; set +a
W="$TEXERA_HOME"; GATEWAY=${GATEWAY:-$((TEXERA_LOCAL_DEV_PORT_OFFSET + 4001))}
OUT=$1 MODEL=$2 WORKERS=$3; shift 3
if [ $# -gt 0 ]; then TASKS="--tasks $*"; else TASKS="--all-tasks"; fi
if [ -e "$S/runs/$OUT" ]; then echo "refusing: $S/runs/$OUT exists"; exit 1; fi
mkdir -p "$S/runs" "$S/logs"
echo "$S/runs/$OUT" >> "$S/runs.txt"   # the stack's memory guard watches this run
DETACH=-f WORD=launched
if [ -n "${WAIT:-}" ]; then DETACH=-w WORD=finished; fi
setsid $DETACH bash "$S/run-env.sh" "$W/benchmark/bench" run prepbench scriptreact --output "$S/runs/$OUT" --models "$MODEL" \
  $TASKS --workers "$WORKERS" --script-endpoint "http://localhost:$GATEWAY/v1" > "$S/logs/$OUT.log" 2>&1 < /dev/null
echo "$WORD PrepBench Script ReAct $OUT ($MODEL; $WORKERS workers; checkout $W; gateway :$GATEWAY)"
