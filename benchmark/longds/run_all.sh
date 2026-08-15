#!/bin/bash
# Run one LongDS arm over every prepared task.
#
# Ordering is LONGEST-FIRST. With a fixed number of lanes the makespan is set by
# the longest task, so starting the 42-turn task last would leave three idle
# lanes waiting on it; started first, it runs while the short tasks fill in
# around it.
#
# Concurrency is deliberately low. A LongDS task is not a KramaBench task: it
# holds ONE agent and ONE workflow alive for its whole length, so P is a count
# of live engine sessions, not of short-lived requests. Agents live only in
# agent-service process memory (server.ts: no session table), so a crash loses
# whole trajectories and the resume granularity is the task — which is also why
# nothing here may restart a service mid-pool.
#
# Resume-safe: `--skip-done` skips tasks that already have every turn, and the
# pool log is appended, never truncated.
#
# Paths are derived from this script's own location. They used to be relative to
# a cwd of the KramaBench root, from when the harness lived in `Kramabench/longds/`;
# after the move to `benchmark/longds/` that cwd became `benchmark/`, where none
# of `.env`, `.venv`, `longds/run_longds.py` or `system_scratch/` exist — so every
# lane died instantly on a missing interpreter.
set -u
LONGDS="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$LONGDS/../.." && pwd)"
PY="$REPO/benchmark/Kramabench/.venv/bin/python"
set -a; . "$REPO/.env"; set +a
[ -x "$PY" ] || { echo "ABORT: no venv at $PY — run bin/bench.sh setup"; exit 1; }

ARM="${ARM:-luna-turn-recall}"
SUT="${SUT:-LongDS_LongDSLunaTurnRecall}"
# Pools live under the repo's gitignored logs/ dir: a pool is run scaffolding,
# not a benchmark artifact (those go to system_scratch/).
POOL="${POOL:-$REPO/logs/longds-pool-$ARM}"
PAR="${PAR:-4}"
# Per-turn wall-clock budget. The default suits tasks whose data fits in a
# second or two; it is NOT enough for a task whose turn 1 loads hundreds of MB,
# because a DELTA edit re-executes the operator and everything downstream of it.
# Measured on kiva (a 195 MB kiva_loans.csv): ~170 s per step, four consecutive
# edits to one cleaning operator, and turn 1 hit the 1200 s budget at step 7 —
# which abandons the whole task, since turn 1 is the state every later turn
# inherits. Raise it per task rather than lowering it globally.
TURN_TIMEOUT="${TURN_TIMEOUT:-1200}"
# Outer per-TASK cap, distinct from the per-turn budget above. It was hardcoded
# at 21600 (6 h), which is not a safe constant: a 35-turn task whose late turns
# each take 10-20 minutes reaches it mid-run, and because agents live only in
# agent-service memory the partial task is unresumable — the kill costs the
# whole task, not the remaining turns. Raise it for a task known to be slow
# rather than discovering the ceiling by losing six hours to it.
TASK_TIMEOUT="${TASK_TIMEOUT:-21600}"
mkdir -p "$POOL"
PROG="$POOL/progress.log"

# Longest first (turn counts from the prepared manifests). `TASKS_OVERRIDE` is a
# space-separated subset — used to backfill one arm on the tasks another arm
# already has, so a comparison stays like-for-like.
TASKS=(
  sports__nfl_big_data_bowl_2023__task1                            # 42
  social_good__data_science_for_good_kiva_crowdfunding__task1      # 37
  business__my_uber_drivers__task1                                 # 36
  geoscience__water-potability__task3                              # 36
  geoscience__global-data-on-sustainable-energy__task1             # 36
  business__netflix_movies_and_tv_shows__task2                     # 34
  business__nyc_restaurants_data_food_ordering_and_delivery__task1 # 32
  social_good__passnyc__task1                                      # 30
  education__bi__task1                                             # 27
  education__world_university_rankings__task2                      # 21
  community__github_programming_languages_data__task1              # 15
)
if [ -n "${TASKS_OVERRIDE:-}" ]; then
  read -r -a TASKS <<< "$TASKS_OVERRIDE"
fi

# Engine guard (HANDOFF 4.8): never start a pool against a half-dead stack — an
# engine death once ran unnoticed for 20 minutes.
#
# This checks LISTENING PORTS, not a JVM count. The old guard wanted ">=8 java
# processes" counted through /proc/PID/exe, and that number is wrong twice over:
# `bin/local-dev.sh` runs the stack as 7 JVMs (two services share the
# WorkflowExecutionService process), and `readlink /proc/PID/exe` returns nothing
# for processes this shell may not introspect, which makes the count 0 and aborts
# every pool. A port is what a lane actually needs to reach, so a port is what is
# checked. `AGENT_PORT` additionally guards the agent-service the arm answers on;
# leave it unset to skip that check.
REQUIRED_PORTS="${REQUIRED_PORTS:-8080 8085 8888 9090 9092 9096 4000}"
engine_ok() {
  local p listening
  listening="$(ss -ltn 2>/dev/null)"
  for p in $REQUIRED_PORTS ${AGENT_PORT:-}; do
    case "$listening" in
      *":$p "*) ;;
      *) echo "  port $p not listening"; return 1 ;;
    esac
  done
  return 0
}

if ! engine_ok; then
  echo "ABORT: stack not healthy at launch (need: $REQUIRED_PORTS ${AGENT_PORT:-})" | tee -a "$PROG"
  exit 1
fi

echo "=== $(date -Is) launching $ARM over ${#TASKS[@]} tasks, P$PAR ===" >> "$PROG"

printf '%s\n' "${TASKS[@]}" | xargs -P "$PAR" -I{} bash -c '
  t="{}"
  log="'"$POOL"'/${t}.log"
  start=$(date +%s)
  timeout "'"$TASK_TIMEOUT"'" "'"$PY"'" -u "'"$LONGDS"'/run_longds.py" \
      --task "$t" --arm "'"$ARM"'" --turn-timeout "'"$TURN_TIMEOUT"'" --skip-done >> "$log" 2>&1
  rc=$?
  echo "$(date -Is) rc=$rc $((($(date +%s)-start)/60))min $t" >> "'"$PROG"'"
'

echo "=== $(date -Is) pool finished ===" >> "$PROG"

# Completeness gate (HANDOFF 4.9 rule 1): report turns present per task rather
# than trusting the pool to have finished. A partial score looks like a result,
# which is worse than no score.
{
  echo "--- turns present per task ---"
  for t in "${TASKS[@]}"; do
    want=$("$PY" -c "import json;print(len(json.load(open('$LONGDS/prepared/$t/manifest.json'))['turns']))" 2>/dev/null)
    got=$(ls -d "$LONGDS/system_scratch/$SUT/$t"/t[0-9]* 2>/dev/null | wc -l)
    printf '  %-64s %s/%s\n' "$t" "$got" "$want"
  done
} >> "$PROG"
