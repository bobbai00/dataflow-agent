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

# Launch one detached dataflow PrepBench run with the settings of the 2026-10-14 and 2026-10-17 PrepBench runs: 25 steps,
# 900 s per attempt, large inputs allowed (no one-at-a-time limit), full results 5,000 chars, samples 2,000 chars, 1 rep.
# ARMS defaults to the basic setting (evidence_full_flow0: statistics off, runtime stats off). Each attempt exports the
# output files the agent names from the engine's stored results (benchmark/prepbench/evaluate_task.py); score afterwards
# with benchmark/prepbench/score.py (PrepBench's own evaluator).
# Usage: [STACK_DIR=/var/tmp/texera-stable] [ARMS=evidence_full_flow0] [CHECKOUT=<checkout>] launch-prep.sh <run name> <model tag>
#        <workers> [task ids...]   (default: all 306 cases; CHECKOUT runs the runner from another checkout, matching an agent
#        started with the same CHECKOUT)
set -euo pipefail
S="${STACK_DIR:-/var/tmp/texera-stable}"
[ -f "$S/profile.sh" ] || { echo "no stack at $S (write one with benchmark/campaign/stack/render.py)"; exit 2; }
set -a; . "$S/profile.sh"; set +a
W="${CHECKOUT:-$TEXERA_HOME}"
OUT=$1 MODEL=$2 WORKERS=$3; shift 3
ARMS=${ARMS:-evidence_full_flow0}
if [ $# -gt 0 ]; then
  TASKS="$*"; SEL="PrepBench subset chosen before the run, 1 rep, arms $ARMS: $*"
else
  TASKS=$(python3 -I -c "import json, sys; print(' '.join(t['id'] for t in json.load(open(sys.argv[1]))))" "$W/benchmark/Kramabench/workload/prepbench.json")
  SEL="PrepBench, all 306 cases, 1 rep, arms $ARMS; no outcome-selected retries."
fi
if [ -e "$S/runs/$OUT" ]; then echo "refusing: $S/runs/$OUT exists"; exit 1; fi
mkdir -p "$S/runs" "$S/logs"
cd "$W"
REV=$(git -C "$W" rev-parse HEAD)
setsid -f bash "$S/run-env.sh" env TEXERA_API_ENDPOINT="$TEXERA_DASHBOARD_SERVICE_ENDPOINT" \
  TEXERA_COMPUTING_UNIT_ENDPOINT="$TEXERA_COMPUTING_UNIT_ENDPOINT" TEXERA_WORKFLOW_EXECUTION_ENDPOINT="$WORKFLOW_EXECUTION_SERVICE_ENDPOINT" \
  benchmark/Kramabench/.venv/bin/python benchmark/prepbench/prep_run.py --output "$S/runs/$OUT" \
  --endpoint "$TEXERA_AGENT_SERVICE_ENDPOINT" --agent-revision "$REV" --engine-revision "$REV" \
  --models "$MODEL" --arms $ARMS --repetitions 1 --workers "$WORKERS" --timeout 900 \
  --large-input-bytes 5000000000 --full-result-char-limit 5000 --sample-char-limit 2000 --direct-artifacts \
  --wire-dir "$S/wire" --selection "$SEL" \
  --tasks $TASKS > "$S/logs/$OUT.log" 2>&1 < /dev/null
echo "launched PrepBench dataflow $OUT ($MODEL; $ARMS; $WORKERS workers; checkout $W)"
