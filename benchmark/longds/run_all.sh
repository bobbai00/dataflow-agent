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
set -u
cd "$(dirname "$0")/.." || exit 1
set -a; . ./.env; set +a

ARM="${ARM:-luna-turn-recall}"
SUT="${SUT:-LongDS_LongDSLunaTurnRecall}"
POOL="${POOL:-longds/pool_$(echo "$ARM" | tr -d -- -)}"
PAR="${PAR:-4}"
# Per-turn wall-clock budget. The default suits tasks whose data fits in a
# second or two; it is NOT enough for a task whose turn 1 loads hundreds of MB,
# because a DELTA edit re-executes the operator and everything downstream of it.
# Measured on kiva (a 195 MB kiva_loans.csv): ~170 s per step, four consecutive
# edits to one cleaning operator, and turn 1 hit the 1200 s budget at step 7 —
# which abandons the whole task, since turn 1 is the state every later turn
# inherits. Raise it per task rather than lowering it globally.
TURN_TIMEOUT="${TURN_TIMEOUT:-1200}"
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

# Engine guard (HANDOFF 4.8). Counted through /proc/PID/exe: a pattern match
# counts this very shell and lies — which is exactly how an engine death once
# ran unnoticed for 20 minutes.
engine_ok() {
  local n=0 d
  for d in /proc/[0-9]*; do
    case "$(readlink "$d/exe" 2>/dev/null)" in */java) n=$((n + 1)) ;; esac
  done
  [ "$n" -ge 8 ] && ss -ltn 2>/dev/null | grep -q ':8085 '
}

if ! engine_ok; then
  echo "ABORT: engine not healthy at launch (want >=8 JVMs and :8085 up)" | tee -a "$PROG"
  exit 1
fi

echo "=== $(date -Is) launching $ARM over ${#TASKS[@]} tasks, P$PAR ===" >> "$PROG"

printf '%s\n' "${TASKS[@]}" | xargs -P "$PAR" -I{} bash -c '
  t="{}"
  log="'"$POOL"'/${t}.log"
  start=$(date +%s)
  timeout 21600 .venv/bin/python -u longds/run_longds.py \
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
    want=$(.venv/bin/python -c "import json;print(len(json.load(open('longds/prepared/$t/manifest.json'))['turns']))" 2>/dev/null)
    got=$(ls -d "system_scratch/$SUT/$t"/t[0-9]* 2>/dev/null | wc -l)
    printf '  %-64s %s/%s\n' "$t" "$got" "$want"
  done
} >> "$PROG"
