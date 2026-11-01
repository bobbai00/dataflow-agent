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
# One real smoke through the command line with Claude Haiku 5.5 (about $0.12): the tasks and arms the gate replays, on
# the stack's real gateway and judges, one run at a time, into $STACK_DIR/runs/<prefix>-{kb,kbflow,pb,kbsmol,pbsmol,longds}.
# compare_smoke.py compares two smokes, and a smoke can serve as the gate's baseline (GATE_PREFIX=<prefix>). It restarts
# the stack's agent from this checkout, so never run it during a campaign. The checkout must be clean: the runs record
# its revision.
# Usage: [STACK_DIR=/var/tmp/texera-stable] [GATEWAY=<offset + 4000>] [LONGDS_SESSION=<prepared session>] smoke.sh <prefix>
case "${1:-}" in ""|-h|--help) awk 'NR > 13 && /^#/ { sub(/^# ?/, ""); print; s = 1; next } s { exit }' "$0"; exit 2;; esac
set -uo pipefail
PREFIX=$1
W=$(cd "$(dirname "$0")/../../.." && pwd)
S=${STACK_DIR:-/var/tmp/texera-stable}
R=$S/runs
SES=${LONGDS_SESSION:-$W/benchmark/longds/prepared/business__netflix_movies_and_tv_shows__task2}
for r in kb kbflow pb kbsmol pbsmol longds; do [ -e "$R/$PREFIX-$r" ] && { echo "exists: $R/$PREFIX-$r"; exit 1; }; done
[ -z "$(git -C "$W" status --porcelain --ignore-submodules=dirty)" ] || { echo "the checkout is not clean"; exit 1; }
REV=$(git -C "$W" rev-parse HEAD)
set -a; . "$S/profile.sh"; set +a
GATEWAY=${GATEWAY:-$((TEXERA_LOCAL_DEV_PORT_OFFSET + 4000))}
PORT=$TEXERA_AGENT_SERVICE_PORT
export STACK_DIR=$S

pid=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null); [ -n "$pid" ] && kill "$pid" && sleep 2
"$W/benchmark/campaign/start-agent.sh"
for _ in $(seq 1 60); do curl -sf "localhost:$PORT/api/healthcheck" >/dev/null && break; sleep 1; done
echo "agent :$PORT from ${REV:0:9} ($(date +%H:%M))"

cd "$W"
BENCH=(setsid -w bash "$S/run-env.sh" benchmark/bench)
FLOW=(--models Haiku55 --agent-revision "$REV" --engine-revision "$REV")
SCRIPT=(--models Haiku55 --script-endpoint "http://localhost:$GATEWAY/v1")
KB_TASKS="archeology-easy-6 astronomy-easy-1 legal-easy-25"; PB_TASKS="prepbench-hard-1 prepbench-hard-50"
KBFLOW_TASKS="wildfire-easy-15 environment-easy-6 archeology-easy-11 wildfire-hard-17 legal-hard-15"
mkdir -p "$R"

"${BENCH[@]}" run kramabench bobflow --output "$R/$PREFIX-kb" "${FLOW[@]}" --workers 3 --tasks $KB_TASKS \
  --arms evidence_full_flow0 evidence_data1_flow0 evidence_data1_flow0_opt --selection "smoke at $REV" > "$R/$PREFIX-kb.log" 2>&1
echo "kb: $(tail -n 1 "$R/$PREFIX-kb.log" | cut -c1-140)"
"${BENCH[@]}" run kramabench bobflow --output "$R/$PREFIX-kbflow" "${FLOW[@]}" --workers 3 --tasks $KBFLOW_TASKS \
  --arms evidence_data1_flow1 evidence_full_flow1 --selection "smoke at $REV" > "$R/$PREFIX-kbflow.log" 2>&1
echo "kbflow: $(tail -n 1 "$R/$PREFIX-kbflow.log" | cut -c1-140)"
"${BENCH[@]}" run prepbench bobflow --output "$R/$PREFIX-pb" "${FLOW[@]}" --workers 2 --tasks $PB_TASKS \
  --arms evidence_full_flow0 evidence_data1_flow0_opt --selection "smoke at $REV" > "$R/$PREFIX-pb.log" 2>&1
echo "pb: $(tail -n 1 "$R/$PREFIX-pb.log" | cut -c1-140)"
"${BENCH[@]}" run kramabench scriptreact --output "$R/$PREFIX-kbsmol" "${SCRIPT[@]}" --workers 3 --tasks $KB_TASKS \
  > "$R/$PREFIX-kbsmol.log" 2>&1
echo "kbsmol: $(tail -n 1 "$R/$PREFIX-kbsmol.log" | cut -c1-140)"
"${BENCH[@]}" run prepbench scriptreact --output "$R/$PREFIX-pbsmol" "${SCRIPT[@]}" --workers 2 --tasks $PB_TASKS \
  > "$R/$PREFIX-pbsmol.log" 2>&1
echo "pbsmol: $(tail -n 1 "$R/$PREFIX-pbsmol.log" | cut -c1-140)"

L=$R/$PREFIX-longds
mkdir -p "$L"
for arm in catalog-gold transcript-depnote; do
  "${BENCH[@]}" longds run --prepared "$SES" --out "$L/$arm" --arm "$arm" --model claude-haiku-5.5 --turns 2 \
    --spend-limit 1 > "$L/$arm.log" 2>&1 < /dev/null
  echo "longds $arm: $(tail -n 1 "$L/$arm.log" | cut -c1-140)"
done
"${BENCH[@]}" longds smolagents --prepared "$SES" --out "$L/smolagents-depnote" --note dependencies \
  --model claude-haiku-5.5 --turns 2 --spend-limit 1 > "$L/smolagents-depnote.log" 2>&1 < /dev/null
echo "longds smolagents-depnote: $(tail -n 1 "$L/smolagents-depnote.log" | cut -c1-140)"
"${BENCH[@]}" longds judge --runs "$L" > "$L/judge.log" 2>&1
benchmark/bench longds report --runs "$L" --json "$L/summary.json" | tail -n 8 | cut -c1-160

benchmark/bench score prepbench "$R/$PREFIX-pb-scores.json" "$R/$PREFIX-pb" "$R/$PREFIX-pbsmol" | tail -n 4 | cut -c1-160
benchmark/bench report "$R/$PREFIX-kb" "$R/$PREFIX-kbflow" "$R/$PREFIX-kbsmol" "$R/$PREFIX-pb" "$R/$PREFIX-pbsmol" \
  --scores "$R/$PREFIX-pb-scores.json"
echo "done ($(date +%H:%M))"
