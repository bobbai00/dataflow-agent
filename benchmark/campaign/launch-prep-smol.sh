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

# Launch one detached smolagents PrepBench run with the settings of the 2026-10-14 and 2026-10-17 PrepBench smolagents
# runs: custom prompt, 25 steps, 5,000 output characters (the harness defaults), 900 s per attempt, large inputs
# allowed, 1 rep. The PrepBench handover (benchmark/prepbench/smol/evaluate_script_task.py) collects the output_NN.csv
# files the agent writes for PrepBench's evaluator. Model calls go to the smolagents gateway (:60001) unless GATEWAY is
# set; the Haiku runs used the main gateway (GATEWAY=60000), which carries the Haiku routes.
# Usage: [STACK_DIR=/var/tmp/texera-stable] [GATEWAY=60001] launch-prep-smol.sh <run name> <model tag> <workers> [task ids...]
#        (default: all 306 cases)
set -euo pipefail
S="${STACK_DIR:-/var/tmp/texera-stable}"
[ -f "$S/profile.sh" ] || { echo "no stack at $S (write one with benchmark/campaign/stack/render.py)"; exit 2; }
set -a; . "$S/profile.sh"; set +a
W="$TEXERA_HOME"; GATEWAY=${GATEWAY:-60001}
OUT=$1 MODEL=$2 WORKERS=$3; shift 3
TASKS=${*:-$(python3 -I -c "import json, sys; print(' '.join(t['id'] for t in json.load(open(sys.argv[1]))))" "$W/benchmark/Kramabench/workload/prepbench.json")}
if [ -e "$S/runs/$OUT" ]; then echo "refusing: $S/runs/$OUT exists"; exit 1; fi
mkdir -p "$S/runs" "$S/logs"
cd "$W"
setsid -f bash "$S/run-env.sh" benchmark/Kramabench/.venv/bin/python benchmark/prepbench/smol_run.py --output "$S/runs/$OUT" \
  --script-endpoint "http://localhost:$GATEWAY/v1" --model "$MODEL" --systems smolagents --repetitions 1 \
  --workers "$WORKERS" --timeout 900 --large-input-bytes 5000000000 --tasks $TASKS > "$S/logs/$OUT.log" 2>&1 < /dev/null
echo "launched PrepBench smolagents $OUT ($MODEL; $WORKERS workers; checkout $W; gateway :$GATEWAY)"
