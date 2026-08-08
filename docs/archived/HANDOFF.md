# Stack Handoff — dataflow-agent research environment

Operational guide: start everything, monitor everything, stop everything.
Experiment/eval methodology lives in `../Kramabench/EXPERIMENT_MANUAL.md` — this doc is
the ops layer under it. Everything below was verified working 2026-07-22.

---

## 0. Layout — who serves what

| Piece | Where | Branch (as of handoff) |
|---|---|---|
| JVM backend (8 services) | `~/Desktop/bobflow/dataflow-agent` (this repo) | `feat/lakeqa-venv` (has local `storage.conf`/`udf.conf` tweaks the running env needs) |
| **agent-service** (bun, :3001) | `~/Desktop/bobflow/dataflow-agent-worktrees/feat-agent-context-frontier-decay/agent-service` | `feat/agent-context-frontier-decay` ≡ **main** (`0fa3ffbbb`) |
| KramaBench harness | `~/Desktop/bobflow/Kramabench` | `experiments-deep-dive` ≡ **main** (`f1b01a8`) |
| litellm gateway (:4000) | process, run from this repo root | config `bin/litellm-config.yaml` |
| Infra containers | docker (**needs `sudo`** on this box) | `texera-lakefs-{lakefs,minio,postgres}`, `texera-dataflow-agent` (the :5432 postgres the stack uses) |

Both repos' `main` branches contain all research work; **nothing is pushed to origin**
(Kramabench main is ~40 commits ahead of origin/main).

---

## 1. Start the whole stack (cold machine → working)

Order matters: containers → litellm → JVM services → agent-service → warm-up.

### 1.1 Infra containers (stateful — usually already up)

```bash
sudo docker ps --format '{{.Names}}\t{{.Status}}'    # check first
# if missing:
sudo docker compose -f file-service/src/main/resources/docker-compose.yml up -d
# or restart previously-stopped containers:
sudo docker start texera-lakefs-lakefs texera-lakefs-minio texera-lakefs-postgres texera-dataflow-agent
```

> `texera-dataflow-agent` is the CORRECT :5432 postgres (user/pass `postgres/postgres`)
> — not any other postgres container that may exist.

### 1.2 litellm gateway (:4000) — needed by all benchmark runs

```bash
cd ~/Desktop/bobflow/dataflow-agent
setsid /home/bob/miniconda3/bin/litellm --config bin/litellm-config.yaml --port 4000 \
  > logs/litellm.log 2>&1 < /dev/null & disown
```
Only `OPENAI_API_KEY` needs to be present in the environment (Kramabench's `.env` has it).

### 1.3 The 8 JVM services (one detached sbt session)

```bash
cd ~/Desktop/bobflow/dataflow-agent && mkdir -p logs
GUI_WORKFLOW_WORKSPACE_COPILOT_ENABLED=true setsid bash -c 'exec sbt --no-colors -Dsbt.supershell=false --batch \
  "compile" \
  "ConfigService/bgRun" "AccessControlService/bgRun" "FileService/bgRun" \
  "ComputingUnitManagingService/bgRun" "WorkflowCompilingService/bgRun" \
  "WorkflowExecutionService/bgRunMain org.apache.texera.web.ComputingUnitMaster" \
  "WorkflowExecutionService/bgRunMain org.apache.texera.web.ComputingUnitWorker" \
  "WorkflowExecutionService/bgRunMain org.apache.texera.web.TexeraWebApplication" \
  "bgList" "bgWaitFor 1" "bgWaitFor 2" "bgWaitFor 3" "bgWaitFor 4" \
  "bgWaitFor 5" "bgWaitFor 6" "bgWaitFor 7" "bgWaitFor 8"' \
  > logs/sbt-services.log 2>&1 < /dev/null & disown
```
Boot takes ~2–6 min (compile cache dependent). The `bgWaitFor` tail keeps the sbt
process alive; killing it kills all forked services.

### 1.4 agent-service (:3001 main, :3002 worktree)

Each checkout serves its own port; the port comes from that checkout's `.env`. Run one per
checkout you need. `nohup env PATH=...` is the reliable form — a bare `bun` in a backgrounded
subshell exits 127 because bun is not on the default PATH.

```bash
# :3002 — the research worktree (most experiment arms point here)
cd ~/Desktop/bobflow/dataflow-agent-worktrees/feat-role-policy/agent-service
nohup env PATH="$HOME/.bun/bin:$PATH" bun run dev > ~/Desktop/bobflow/Kramabench/logs_agent3002.log 2>&1 &

# :3001 — main
cd ~/Desktop/bobflow/dataflow-agent/agent-service
nohup env PATH="$HOME/.bun/bin:$PATH" bun run dev > ~/Desktop/bobflow/Kramabench/logs_agent3001.log 2>&1 &

sleep 10; for p in 3001 3002; do printf "%s: %s\n" $p "$(lsof -tiTCP:$p -sTCP:LISTEN || echo DOWN)"; done
```
- `bun` is NOT on default PATH — it lives at `/home/bob/.bun/bin/bun`.
- `bun run dev` = `--watch`: `.ts` edits hot-reload, but **`src/agent/prompts/*.md` are NOT
  watched** — restart after editing a prompt file, or you will benchmark the old prompt.
- If a module-level error crashes it, `--watch` does NOT recover — relaunch.
- **Never restart while a benchmark pool is running** (see §4.6).
- Which arm hits which port: the SUT sets `agent_service_endpoint`; arms built on
  `ROLE_POLICY_ENDPOINT` use `:3002`. `dataflow_agent.py`'s own default is `:3001`, so pass
  `agent_endpoint=` explicitly in any ad-hoc probe.

### 1.5 Warm-up (mandatory)

The FIRST agent request after an agent-service start cold-fails (~0.05 s, empty, no
error). Eat it with a throwaway task before any pooled run:

```bash
cd ~/Desktop/bobflow/Kramabench && export $(grep -vE '^#' .env | sed 's/^export //' | xargs)
timeout 240 .venv/bin/python evaluate.py --sut DataflowSystemGPT5MiniLatest1kSchemaOnly \
  --workload legal --task_id legal-easy-11 --use_truth_subset --no_pipeline_eval >/dev/null 2>&1
```

---

## 2. Monitor

### 2.1 Services — the 30-second health sweep

```bash
# ports (expect 9 lines: 9094 9096 9092 8888 9090 8085 8080 + 3001 + 4000)
lsof -iTCP -sTCP:LISTEN -P -n | awk '$1=="java"||$1=="bun"||$1~/^python/{print $1, $9}' \
  | grep -E ':(3001|4000|8080|8085|8888|9090|9092|9094|9096)$'
curl -s -o /dev/null -w "agent-service %{http_code}\n" localhost:3001/api/agents      # 200
curl -s -o /dev/null -w "litellm %{http_code}\n" localhost:4000/health/liveliness    # 200
sudo docker ps --format '{{.Names}}\t{{.Status}}'                                    # 4 Up
```

Logs (tail these when something is off):
- `logs/sbt-services.log` — combined 8-service stream (grows large)
- `logs/computing-unit-master.log`, `logs/amber-server.log` — engine
- `<worktree>/logs/agent-service.log` — agent-service (per-agent step/error lines)
- `logs/litellm.log` — gateway

### 2.2 Engine health / senescence

Long-lived JVMs degrade ("senescence"): the tell is **mass no-response / instant-empty
agent runs while all health checks stay green**. Signals:
```bash
ps -eo pid,etimes,rss,comm | awk '$4=="java"{n++; rss+=$3; if($2>mx)mx=$2} END{printf "JVMs=%d oldest=%.1fh totalRSS=%.1fGB\n",n,mx/3600,rss/1024/1024}'
```
- Amber RSS climbing toward ~8 GB → restart the JVM layer soon (a big GC can also
  relieve it — don't panic on a single RSS *drop*).
- Hard tasks instant-failing (0.09 s, exit 0, no error) under a pool = **engine
  contention**, not senescence — drop pool concurrency to ≤4.

### 2.3 Agents (live)

```bash
curl -s localhost:3001/api/agents | head -c 400        # live agents list
# per agent: /api/agents/<id>/react-steps  (full trace), /workflow, /operator-results
```
`agent-service.log` prints per-step lines (`received message`, `agent run complete`,
`errorCount`). One KramaBench task = one fresh agent (created + destroyed per task).

### 2.4 Running benchmarks

```bash
pgrep -af 'evaluate.py --sut' | grep -v grep            # what's running
tail -f <pool-dir>/progress.log                          # per-task done lines (pool patterns)
ls -t ~/Desktop/bobflow/Kramabench/system_scratch/<ARM>/ | head   # results appearing
./kb.py scores --sut <ARM>                               # scores so far
```
Watch for: jobs finishing in <1 s with `Total score is: 0.0` and no `Answer:` line
(instant-fail — check warm-up/contention), and `xargs` pools respawning killed children
(kill the **xargs parent** first).

> Gotcha: `pkill -f 'pattern'` matches your own shell if the literal pattern is in your
> command line — the bracket trick (`pkill -f 'bun run [d]ev'`) protects the *grep* but NOT a
> command line that legitimately contains the script name. For stopping benchmark pools use
> the exact-args + age filter in **§4.4**; the bracket trick alone is not enough and has cost
> a self-killed shell plus a duplicate racing orchestrator.

---

## 3. Stop everything

Three layers; stop what you need, in this order:

```bash
# 1. agent-service
pkill -f 'bun run [d]ev'; pkill -f 'bun.*[s]erver.ts'

# 2. JVM services + sbt (escalate if needed)
pkill -f 'java @.*[s]bt-args'; pkill -f '[s]bt-launch.jar'; sleep 4
pkill -9 -f 'java @.*[s]bt-args' 2>/dev/null; pkill -9 -f '[s]bt-launch.jar' 2>/dev/null

# 3. litellm
kill $(lsof -tiTCP:4000 -sTCP:LISTEN) 2>/dev/null

# 4. infra containers (stateful! only when you want the machine quiet;
#    `stop` preserves containers+data, restart later with `sudo docker start ...`)
sudo docker stop texera-lakefs-lakefs texera-lakefs-minio texera-lakefs-postgres texera-dataflow-agent

# verify silence
lsof -iTCP -sTCP:LISTEN -P -n | awk '$1=="java"||$1=="bun"{print}' ; sudo docker ps
```

---

## 4. Running experiments efficiently (learned the hard way, 2026-07-29)

### 4.1 Concurrency — measured throughput, exclusive engine

| `xargs -P` | throughput | notes |
|---|---|---|
| P5 (engine shared with another pool) | 2.0 runs/min | |
| P8 | 1.9 /min | LLM-latency bound, not CPU |
| P12 | 3.5 /min | |
| P18 | 8.7 /min | |
| **P30** | **11–13 /min** | 24 cores, ~40/62 GB, load ~20–27 |

**The inherited "P6 causes instant-fails" note is STALE** — 0 instant-fails observed at P8,
P12, P18, P30 and briefly ~P30+orphans. Full-104 × 9 arms (936 runs) completes in ~75–95 min
at P30.

**But P is only safe relative to ENGINE AGE, and this table was measured on a fresh engine.**
On 2026-07-30 a P20 repair pass against a **10-hour-old** engine killed it with
`java.lang.OutOfMemoryError: unable to create native thread` — not RAM (9/62 GB free) and not
`ulimit -u` (255692, 136 procs), but thread-stack allocation failing under accumulated JVM
thread pressure. It took out ComputingUnitMaster + ComputingUnitWorker. The same P30 had run
520 runs clean two hours earlier on the same engine. So: **P30 on an engine <4 h old, P16 or
below after that, and restart the engine between pools rather than pushing P.**

Note also that a pool's *log message* is not its concurrency: `orchestratorN6.sh` logged
"P12" while the code ran `xargs -P 30`. Read the `xargs -P` line, not the banner.

**Ramp a LIVE pool with SIGUSR1 — do not start a second worker.** GNU xargs raises its own
parallelism by one per `SIGUSR1` (and lowers it per `SIGUSR2`), so a pool stuck behind slow
tasks can be widened in place:

```bash
ps -eo pid=,etimes=,comm= | awk '$3=="xargs" && $2>300 {print $1}'   # comm, never args
for i in $(seq 1 8); do kill -USR1 <PID>; sleep 0.3; done            # 16 -> 24
```

This is the fix for the task-major lockstep stall (4.2): when every slot is parked on the same
slow task, extra slots let other tasks proceed. Verified live — distinct in-flight tasks went
4 → 7 and throughput recovered immediately.

Do NOT instead launch a second `xargs` over the same pending list. Resume-skip keys on
`Total score` appearing in the pool log, which is only written when a run *finishes*, so two
workers will both pick up the same unfinished task and their answers will overwrite each
other. Ramping mid-run is otherwise free — the orchestrators skip already-scored pairs — but
see 4.4 for how to stop a pool without shooting yourself.

### 4.2 Orchestrator pattern

Copy an existing `judgment_runs/mini_star/orchestrator*.sh`. The shape that works:

```bash
emit_pending(){                     # resume-safe: only unscored (arm,task) pairs
  for T in "${TASKS[@]}"; do for A in "${ARMS[@]}"; do   # TASK-major: see below
    grep -q 'Total score' "judgment_runs/mini_star/pool<TAG>_${A}__${T}.log" 2>/dev/null \
      || echo "$A ${T%%-*} $T"
  done; done
}
emit_pending | xargs -P 30 -L 1 bash -c 'timeout 900 .venv/bin/python -u evaluate.py \
  --sut "$0" --workload "$1" --task_id "$2" --use_truth_subset --no_pipeline_eval \
  > "judgment_runs/mini_star/pool<TAG>_$0__$2.log" 2>&1'
# then a repair pass at lower P, then per-arm `./kb.py reeval --sut $A`, then a DONE marker
```

Launch detached via a tiny wrapper script — inline `nohup setsid bash -c '...'` with quotes
inside a compound command silently fails:

```bash
printf '#!/bin/bash\nexec bash ~/Desktop/bobflow/Kramabench/judgment_runs/mini_star/orchestratorX.sh\n' > /tmp/launchX.sh
chmod +x /tmp/launchX.sh && nohup setsid /tmp/launchX.sh > /tmp/orchX_boot.log 2>&1 < /dev/null &
```

**Emit TASK-major (`for T; for A`), not arm-major.** Every orchestrator before
`orchestratorLayout.sh` looped arm-major, which means arm 1 runs on a younger engine than the
last arm — and engine age is worth ~2.3 pt (§4.6). For a pool comparing arms to each other
that silently builds the confound into the design. Task-major makes consecutive lines alternate
arms, so under `xargs -P` all arms advance in lockstep and engine age is held constant *by
construction* instead of corrected for afterwards. Verify it took by watching the arm mix:
`ps -eo args= | grep -oE 'sut [A-Za-z0-9]+' | sort | uniq -c` should show all arms at once.

**It costs wall-clock, though — choose deliberately.** Arm-major smears the slow tasks across
the whole run; task-major makes every arm hit the same slow task at the same moment, so
throughput collapses to that task's latency and then recovers. On the layout pool, reaching
the astronomy-hard cluster (`-7`, `-11`, `-8`, `-12`, several of them 900 s timeouts) dropped
throughput from ~8/min to ~1/min for roughly 15 minutes with all 16 slots parked on 4 tasks.
So: **task-major when arms are being compared to each other** (any A/B — the era control is
worth it), **arm-major when arms are independent** and you just want them all finished.

Gate a follow-on pool on a running one **by PID**, never by name:
`while kill -0 "$GATE_PID" 2>/dev/null; do sleep 60; done`

### 4.3 THE health check that matters: `scored == answers == dirs`

```bash
cd ~/Desktop/bobflow/Kramabench            # ALWAYS in the same command as any glob/grep
for a in <ARMS>; do d=system_scratch/$a
  printf "%-34s scored=%-4s answers=%-4s dirs=%s\n" "$a" \
    "$(grep -l 'Total score' judgment_runs/mini_star/pool*_${a}__*.log 2>/dev/null|wc -l)" \
    "$(ls $d/*/response.txt 2>/dev/null|wc -l)" "$(ls -d $d/*/ 2>/dev/null|wc -l)"
done
```

**A killed/failed run still writes `Total score is: 0.0`**, so every orchestrator's
resume-skip treats it as complete. Counting scored logs proves nothing. Two failure modes
hid behind this today and cost ~200 runs each. Repairs must key on a **missing or
`(empty response)` `response.txt`**, and you must `rm` the stale pool log first or the
resume-skip will swallow the repair.

Per-run trace health (run this every cycle, not just when suspicious):

```bash
python3 - <<'EOF'
import json,glob,os,statistics as st
for f in glob.glob('system_scratch/<ARM>*/*/stats.json'):
    d=os.path.dirname(f); n=json.load(open(f)).get('num_steps',0)
    # collect: mean steps, count n>=25 (cap), '(empty response)' in response.txt,
    # 'Error:' prefix, and 'Output Table:' present in react_steps.json
EOF
```

Healthy: mean **~6 steps**, ≤3 % at the 25-step cap, ≤3 % empty, **100 % of traces contain
`Output Table:`** (proof operators actually EXECUTED, not merely got created).

### 4.4 Stopping a pool without shooting yourself

```bash
# STEP 1 — LIST candidates. Never pipe straight into kill.
ps -eo pid,etimes,comm --no-headers | awk '$3=="xargs" && $2>15 {print $1}'   # comm, not args
ps -eo pid,etimes,args --no-headers | awk '$2>15 && /orchestratorX/ {print $1}'
# STEP 2 — eyeball the list, then kill those literal numbers:
kill 12345 12346 12347
```

- **Never `grep`/`pkill` a pattern that appears in your own command line.** Did this **five**
  times in one session. `pgrep -f 'xargs -P 20 -L 1'` matches the bash that is running that
  very command, so it kills your own shell (exit 144) — which on one occasion left the original
  orchestrator falling through to its repair pass and let a **duplicate orchestrator race the
  original** on the same task set. Even the "safe" `awk '/orchestratorX/'` form above matches
  your own shell if you type that name in the same command. **The only reliable pattern is:
  list first, then kill literal PIDs.**
- **`awk '$3=="xargs"'` on `comm` is safe; `$2>15` on `args` is not** — an `args` field can
  contain the pattern you are testing for.
- Killing only the orchestrator shell leaves `xargs` spawning at the old concurrency
  (this doubled concurrency to ~P30 unintentionally).
- Orphaned in-flight evals finish on their own and are not replaced — fine to leave, unless
  the engine is broken, in which case kill them too (they write garbage).

### 4.5 Scoring — only after reeval, and only KramaBench's numbers

Per-task `evaluate.py --task_id` runs write **1-task** measures CSVs. Full-workload CSVs
appear only after `./kb.py reeval --sut <ARM>`. Score before that and you get "no data" (if
your script guards) or a fake average over one task (if it doesn't).

`judgment_runs/mini_star/cseries_sweep.py` is the current sweep tool: it includes a `WL_N`
guard that **refuses to score an arm unless all 6 workloads have a full CSV**, and reports
excluded reps instead of silently averaging partials. Its reduction was validated 12/12
against `.venv/bin/python compute_scores.py --sut <ARM>`; easy/hard splits recombine exactly
to the official OVERALL. Never self-invent a metric.

### 4.6 Vintage discipline

- **Restarting the JVM stack changes results.** Identical config scored **69.0 before / 71.3
  after** a restart (+2.3). Treat every stack restart as an era boundary; never compare across
  one. Run a **same-era control alongside every new arm** — that is why the A7 test was paired.
- Agent-service commits are a vintage too. `bun --watch` reloads `.ts` but **NOT**
  `src/agent/prompts/*.md` — restart `:3002` after prompt-file edits.
- Stamp provenance: every run's `config.json` carries `agent_service_endpoint`,
  `agent_service_git_sha`, `agent_service_src_dirty`. Check `dirty=False` before trusting an
  arm.
- **NEVER restart `:3001`/`:3002` or the JVM stack while any pool is running.** Gating a new
  pool on an old pool's PID does *not* protect the old pool from a service restart — doing
  this killed 58 in-flight runs with `Connection to remote host was lost`.

### 4.7 Failure modes seen, with their signatures

| symptom | cause | fix |
|---|---|---|
| `Error: Forbidden`, run ends in ~0.5 s | stack launched without `GUI_WORKFLOW_WORKSPACE_COPILOT_ENABLED=true` (`gui.conf` ships `copilot-enabled = false`; `llm.conf` documents the 403) | relaunch with the flag (§1.3) |
| mean steps ~26, runs hit the 25-step cap, answers `(empty response)`, **no tool errors** | **ComputingUnitMaster (`:8085`) died** — operators still get *created*, nothing *executes* | restart stack; guard with JVM count = 8 and `:8085` up |
| all-zero scores for one arm while a concurrent arm is fine | not infrastructure — check that arm's answers | — |
| `(empty response)` mid-pool, gateway healthy | in-flight runs killed by an agent-service restart | never restart mid-pool; repair by `(empty response)` marker |
| an arm scores ~5 pt low with no model change; `Error: Unable to connect` in some response.txt | **infra-killed runs scored as zeros**: an engine recycle kills in-flight runs, the agent call fails, the harness writes `Error: Unable to connect...` as the RESPONSE, and evaluate.py still prints `Total score is: 0.0` — so a score-only resume-skip counts the dead run as done and the repair pass never retries it. On 2026-08-01 this accumulated ~6.5 zeros/arm over 6 recycles and masqueraded as a −5 pt "model endpoint drift" for a full day | emit_pending must treat `response.txt` starting with `Error:` as pending (patched into orchestrator{TC5,C5,R45}.sh; copy forward); orchestratorFIX.sh sweeps historical pools |
| tasks always timing out (`astronomy-hard-11`, `biomedical-hard-1`) | genuine heavy-task tail vs `timeout 900`; wall-times p50 70 s / p95 372 s / max 842 s | pre-existing, fails uniformly across arms — leave it |
| render silently changes mid-pool, no restart in the log | **`git commit`/`checkout` alone is enough** — agent-service runs `bun run --watch src/server.ts`, so any write to the checkout's `agent-service/` hot-reloads the live server in place (PID unchanged, so `ps` looks untouched) | never edit or merge into a checkout whose agent-service is serving a pool; §4.6 |
| `Files read:` never appears though `fileIoFacts` is on | A7 needs **both halves**: the pandas-patching worker (`amber/.../file_io_telemetry.py`) *and* the renderer (`FILE_IO_KEY` in `RESERVED_STATS_KEYS`). Engine and agent-service launched from different checkouts can hold one each | launch both from one checkout; post-merge `main` has both. Reverse split leaks `__file_io__` as a fake data column |

### 4.8 Engine guards — check these FIRST, every cycle

```bash
# Count java by its REAL binary. A pattern match counts your own shell and LIES.
n=0; for d in /proc/[0-9]*; do
  case "$(readlink "$d/exe" 2>/dev/null)" in */java) n=$((n+1));; esac
done; echo "java=$n"        # 9 = 8 services + the sbt launcher
lsof -tiTCP:8085 -sTCP:LISTEN >/dev/null && echo up || echo DOWN
free -g | awk 'NR==2{print $3"/"$2" GB"}'                     # collapse 35→9 GB = JVMs dying
curl -s -m 8 -o /dev/null -w '%{http_code}\n' localhost:4000/health
```

**The `grep -c '[j]ava @'` form that used to be here is what let the 2026-07-30 engine death
run unnoticed for 20 minutes.** `pgrep -fc 'java @.*sbt-args'` (and any `-f`/args variant)
matches *your own shell's command line*, because the pattern is in it. It reported **8 while
only 6 JVMs were alive** — so the guard built to catch exactly this failure was blind to it.
Count via `/proc/PID/exe`: a symlink to the real executable, which no command-line text can
forge. `orchestratorLayout.sh` has a working version of this guard, including the pool-abort.

The engine died once after ~27 h uptime under sustained load: **2 of 9 JVMs gone, `:8085`
down, memory 35 → 9 GB**. Nothing else reported an error. Had these four lines been in the
30-minute loop from the start it would have been caught hours earlier instead of costing a
whole 936-run pool.

Add one more line when a pool is live, because a *code* change can move the render without
touching a process:

```bash
git -C <checkout-serving-the-pool> status --short   # must be clean of agent-service/
```

`bun run dev` is `bun run --watch src/server.ts`. Watch mode reloads on any write to the
served tree, so committing, merging, or switching branches in that checkout silently changes
the render for in-flight runs — with **no restart line in any log and the same PID**, which is
strictly worse than a visible restart. Merging `feat/role-policy` into `main` on 2026-07-30
hot-reloaded `:3001` mid-pool this way; it was harmless only because every arm in that pool
pins `:3002` (`ROLE_POLICY_ENDPOINT`). Confirm which port the arm actually targets before
assuming an edit is safe — read the SUT class, don't trust the `"http://localhost:3001"`
default.

Also beware false positives when grepping logs: `429` matches inside timing values like
`0.0126545429…`, and a bare `grep -c error` matches benign field names such as
`errorReflection`. Both sent me chasing phantom rate-limits. Grep for the specific string
(`RateLimitError`, `Forbidden`, `ECONNRESET`), not the number or the word.

### 4.9 Automated recovery: what broke, and the four rules

A memory watchdog (`memwatchQ.sh`) recycled a leaking engine correctly — 17 GB → 56 GB
reclaimed, engine back with java=9 — and then destroyed the pool's bookkeeping anyway. Four
rules came out of it, all now implemented in `orchestrator{P,Q}.sh` / `memwatch{,Q}.sh`:

1. **Gate scoring on COMPLETENESS, never on a marker.** A relaunched instance reached the
   reeval loop with ~29 of 104 answers per arm and scored them: `9.6%`, `12.5%`, written to
   measures CSVs as though complete. Partial scores are worse than no scores because they look
   like results. The orchestrator now refuses to reeval unless every arm has ≥100/104 answers.
2. **Never trust a completion marker for monitoring.** The bogus `ALL DONE` above then made the
   watchdog think the pool had finished, so it exited and disarmed itself. Monitor on
   `min_answers` across arms instead.
3. **A watchdog must confirm the old process is DEAD before relaunching.** Killing the
   orchestrator's PIDs without verifying left a survivor that raced the replacement. The
   relaunch path now polls `orch_pids()` and refuses to start a second instance rather than
   race one.
4. **Append to the progress log; never `: > "$PROG"`.** Truncating on start erased the previous
   instance's audit trail, which is why the log showed 2 arms when 6 had been processed — and
   made the incident much harder to reconstruct than it needed to be.

**And: never edit a shell script while an instance is executing it.** Bash reads scripts
incrementally by file offset, so an in-place edit can corrupt a running instance mid-loop. This
was done live to `orchestratorQ.sh` and survived only because the script is small enough to
have been fully parsed already. Copy to a new filename and launch that instead.

---

## 5. Current state at handoff (2026-07-29)

- **Stack UP**: 8 JVM services (launched **with** the copilot flag), `:3001` + `:3002`
  agent-services, litellm `:4000`, infra containers. Engine era 2 (restarted ~13:20).
- `:3002` serves the `feat-role-policy` worktree; `:3001` serves main.
- **Running**: N4/N5 pool (624 runs, P30) — `judgment_runs/mini_star/orchestratorN45.sh`.
- Research state: ~5,500 benchmark runs today. Headline result — an engine-side
  `Files read: N [names]` fact (worker-side `file_io_telemetry.py`, reserved key
  `__file_io__`, coupled to `stats`) is worth **+5.0 pt at 3.3× SE with hard tasks +7.3**
  when the render budget is tight (1 k), and is **free-to-cheaper on every arm** (−11 % at
  5 k). Best arm overall: LATEST 5 k + code + fact — **71.2 @ $0.0154**, cheaper than the
  anchor. Full tables + verdicts in `../Kramabench/judgment_runs/mini_star/`:
  `A7_PAIRED_REPORT.md`, `CHAR_BUDGET_REPORT.md`, `HINTS_ISOLATION_REPORT.md`,
  `STATS_DENSITY_REPORT.md`, `RULE_A_FINAL.md`, `COMBINE_ROUND_REPORT.md`.
- Known stale (pre-existing): `bun run e2e:errors` + 3 texera-agent delegate-bootstrap tests;
  `bun run e2e` is the reliable smoke.
- Full experiment methodology: `../Kramabench/EXPERIMENT_MANUAL.md`.
