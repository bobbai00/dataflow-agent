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

# Launch one detached dataflow KramaBench run on the stack in $STACK_DIR with the KramaBench campaign settings of the
# Gemini, runtime-stats and GPT-6.1 Sol / Gemini 4 Argon runs: 25 steps, 3 sample rows, full results 5,000 chars,
# samples and statistics 2,000 chars, statistics over full tables, 900 s per attempt, inputs over 100 MB one at a
# time, independent shuffled reps, no outcome-selected retries. Runner, agent and engine all come from the stack's
# checkout (TEXERA_HOME in its profile).
# Usage: [STACK_DIR=/var/tmp/texera-stable] [ARMS="evidence_full_flow0 evidence_data1_flow0"] [TIMEOUT=900] [SAMPLE=2000]
#        [CHECKOUT=<checkout>] launch.sh <run name> <model tag> <reps> <workers> [task ids...]   (no task ids = all
#        104 tasks; CHECKOUT runs the runner from another checkout, matching an agent started with the same CHECKOUT)
set -euo pipefail
S="${STACK_DIR:-/var/tmp/texera-stable}"
[ -f "$S/profile.sh" ] || { echo "no stack at $S (write one with benchmark/campaign/stack/render.py)"; exit 2; }
set -a; . "$S/profile.sh"; set +a
W="${CHECKOUT:-$TEXERA_HOME}"
OUT=$1 MODEL=$2 REPS=$3 WORKERS=$4; shift 4
ARMS=${ARMS:-"evidence_full_flow0 evidence_data1_flow0"}
TIMEOUT=${TIMEOUT:-900}
SAMPLE=${SAMPLE:-2000}
if [ $# -gt 0 ]; then
  TASKS="--tasks $*"; SEL="Smoke subset chosen before the run: $*"
else
  TASKS="--all-tasks"; SEL="All 104 original KramaBench top-level tasks; no task exclusions or outcome-selected retries."
fi
if [ -e "$S/runs/$OUT" ]; then echo "refusing: $S/runs/$OUT exists"; exit 1; fi
mkdir -p "$S/runs" "$S/logs"
cd "$W"
REV=$(git -C "$W" rev-parse HEAD)
setsid -f bash "$S/run-env.sh" env TEXERA_API_ENDPOINT="$TEXERA_DASHBOARD_SERVICE_ENDPOINT" \
  TEXERA_COMPUTING_UNIT_ENDPOINT="$TEXERA_COMPUTING_UNIT_ENDPOINT" TEXERA_WORKFLOW_EXECUTION_ENDPOINT="$WORKFLOW_EXECUTION_SERVICE_ENDPOINT" \
  benchmark/Kramabench/.venv/bin/python benchmark/retrieval/run.py --output "$S/runs/$OUT" \
  --endpoint "$TEXERA_AGENT_SERVICE_ENDPOINT" --models "$MODEL" --arms $ARMS $TASKS --repetitions "$REPS" \
  --large-workers 1 --large-input-bytes 100000000 --workers "$WORKERS" --timeout "$TIMEOUT" --direct-artifacts \
  --full-result-char-limit 5000 --sample-char-limit "$SAMPLE" --wire-dir "$S/wire" \
  --agent-revision "$REV" --engine-revision "$REV" --selection "$SEL" \
  > "$S/logs/$OUT.log" 2>&1 < /dev/null
echo "launched $OUT ($MODEL; arms $ARMS; reps $REPS; workers $WORKERS; timeout $TIMEOUT; samples $SAMPLE chars; checkout $W)"
