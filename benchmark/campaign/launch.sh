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

# Launch one run, detached (WAIT=1: stay until it ends): a BobFlow KramaBench run on the stack in $STACK_DIR with the paper's KramaBench settings: 25 steps,
# 3 sample rows, whole results 5,000 characters, samples with statistics 2,000 characters, statistics over full tables,
# 900 s per attempt, inputs over 100 MB one at a time, independent shuffled repetitions, no outcome-selected retries.
# Runner, agent and engine all come from the stack's checkout (TEXERA_HOME in its profile).
# Usage: [WAIT=1] [STACK_DIR=/var/tmp/bobflow-bench] [ARMS="evidence_full_flow0 evidence_data1_flow0"] [TIMEOUT=900] [SAMPLE=2000]
#        [CHECKOUT=<checkout>] launch.sh <run name> <model tag> <reps> <workers> [task ids...]   (no task ids = all
#        104 tasks; CHECKOUT runs the runner from another checkout, matching an agent started with the same CHECKOUT)
case "${1:-}" in ""|-h|--help) awk 'NR > 13 && /^#/ { sub(/^# ?/, ""); print; s = 1; next } s { exit }' "$0"; exit 2;; esac
set -euo pipefail
S="${STACK_DIR:-/var/tmp/bobflow-bench}"
[ -f "$S/profile.sh" ] || { echo "no stack at $S (write one with benchmark/campaign/stack/render.py)"; exit 2; }
set -a; . "$S/profile.sh"; set +a
W="${CHECKOUT:-$TEXERA_HOME}"
OUT=$1 MODEL=$2 REPS=$3 WORKERS=$4; shift 4
ARMS=${ARMS:-"evidence_full_flow0 evidence_data1_flow0"}
if [ $# -gt 0 ]; then TASKS="--tasks $*"; else TASKS="--all-tasks"; fi
if [ -e "$S/runs/$OUT" ]; then echo "refusing: $S/runs/$OUT exists"; exit 1; fi
mkdir -p "$S/runs" "$S/logs"
REV=$(git -C "$W" rev-parse HEAD)
echo "$S/runs/$OUT" >> "$S/runs.txt"   # the stack's memory guard watches this run
DETACH=-f WORD=launched
if [ -n "${WAIT:-}" ]; then DETACH=-w WORD=finished; fi
setsid $DETACH bash "$S/run-env.sh" "$W/benchmark/bench" run kramabench bobflow --output "$S/runs/$OUT" --models "$MODEL" \
  --arms $ARMS $TASKS --repetitions "$REPS" --workers "$WORKERS" --timeout "${TIMEOUT:-900}" \
  --sample-char-limit "${SAMPLE:-2000}" --agent-revision "$REV" --engine-revision "$REV" \
  > "$S/logs/$OUT.log" 2>&1 < /dev/null
echo "$WORD $OUT ($MODEL; arms $ARMS; reps $REPS; workers $WORKERS; checkout $W)"
