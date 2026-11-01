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

# Launch one run, detached (WAIT=1: stay until it ends): a BobFlow PrepBench run with the paper's PrepBench settings: 25 steps, 900 s per attempt, large
# inputs allowed, whole results 5,000 characters, samples 2,000 characters, 1 repetition. Each attempt exports the
# output tables the agent names from the engine's stored results; score afterwards with `bench score prepbench`.
# Usage: [WAIT=1] [STACK_DIR=/var/tmp/bobflow-bench] [ARMS=evidence_full_flow0] [CHECKOUT=<checkout>] launch-prep.sh <run name>
#        <model tag> <workers> [task ids...]   (default: all 306 cases)
case "${1:-}" in ""|-h|--help) awk 'NR > 13 && /^#/ { sub(/^# ?/, ""); print; s = 1; next } s { exit }' "$0"; exit 2;; esac
set -euo pipefail
S="${STACK_DIR:-/var/tmp/bobflow-bench}"
[ -f "$S/profile.sh" ] || { echo "no stack at $S (write one with benchmark/campaign/stack/render.py)"; exit 2; }
set -a; . "$S/profile.sh"; set +a
W="${CHECKOUT:-$TEXERA_HOME}"
OUT=$1 MODEL=$2 WORKERS=$3; shift 3
ARMS=${ARMS:-evidence_full_flow0}
if [ $# -gt 0 ]; then TASKS="--tasks $*"; else TASKS="--all-tasks"; fi
if [ -e "$S/runs/$OUT" ]; then echo "refusing: $S/runs/$OUT exists"; exit 1; fi
mkdir -p "$S/runs" "$S/logs"
REV=$(git -C "$W" rev-parse HEAD)
echo "$S/runs/$OUT" >> "$S/runs.txt"   # the stack's memory guard watches this run
DETACH=-f WORD=launched
if [ -n "${WAIT:-}" ]; then DETACH=-w WORD=finished; fi
setsid $DETACH bash "$S/run-env.sh" "$W/benchmark/bench" run prepbench bobflow --output "$S/runs/$OUT" --models "$MODEL" \
  --arms $ARMS $TASKS --workers "$WORKERS" --agent-revision "$REV" --engine-revision "$REV" \
  > "$S/logs/$OUT.log" 2>&1 < /dev/null
echo "$WORD PrepBench BobFlow $OUT ($MODEL; $ARMS; $WORKERS workers; checkout $W)"
