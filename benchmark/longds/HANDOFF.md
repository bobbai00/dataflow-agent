# LongDS Multi-Turn — Handoff (2026-08-22, end of session)

Everything below happened on branch `dev/longds-multiturn`, all committed and
pushed. All campaigns are STOPPED and the stack was restarted fresh (worktree
deploy) awaiting the next plan.

## 1. Results on the business-11 task set (clean, judged runs)

11 business tasks (goodbooks excluded — see whale debt), per-turn judge =
deepseek-v4-pro. Accuracy = mean per-turn score; cost = mean per run.

| arm | what it is | acc% | $/run | reps |
|---|---|---|---|---|
| session | full history (`# Session`) | 18.8 | 0.80 | 3 |
| v37 | versioned catalog, values detail, no query tool | 16.4 | 0.86 | 3 |
| question-only (QO) | past QUESTIONS only, no answers/steps | 19.3 | 0.67 | 3 (2 runs short, see debts) |
| v37f | v37 + catalog field-guide prompt (worked example) | ~17.8 | 0.92 | 2 (r1,r3) |
| v37f-rows | v37f + `catalogSampleRowsRatio=0.5` | ~20 (post-artifact, settling) | 0.91 | 1 (r2) |

Top-10 campaign context (10 longest tasks, done previously): session 41.5±3.0
@ $1.655/run vs v37 42.0±3.0 @ $1.158 — parity at 70% cost. v37f/rows have
NOT been run on the top-10 set.

### Turn-depth × cost × accuracy (business-only, 4,215 judged turns)

Accuracy by depth bucket (session / v37 / QO / v37f / v37f-rows):
- 1-5: 51.5 / 47.2 / 48.4 / 51.1 / **60.0**
- 6-15: 25.0 / 18.5 / 24.7 / 20.7 / **30.3**
- 16-25: 9.1 / 8.2 / 9.7 / 10.1 / **13.5**
- 26+: 4.3 / 6.0 / **7.5(QO)** / 3.6 / **9.8(rows)**

Cost/turn growth turn-1→turn-26+: session 4.3× ($0.0088→$0.0380), catalog
arms ~3.3×, **QO only 1.9×** ($0.0126→$0.0236; cache-hit flat 87-89% vs
session decaying 82→69%). State types: rows fixes the rollback weakness
(21.3 vs session 17.6 vs v37 12.8) and dominates counterfactuals (27.3 vs
7.7). Context sizes: catalog IS ~35% smaller than session per step
(netflix-t1 t25: 217k vs 341k chars); catalog arms cost more per TURN only
because they take 5.2-5.6 steps/turn vs session's 3.6.

## 2. The three studies (5-agent workflow, trace-grounded)

**Why rows help (Q1):** mixed. One headline was an artifact (see debts).
Task-level flips are cascade-dominated (single early bits re-judged many
times) — rep luck not excludable with 1 rows rep. BUT turn-level mechanism is
real: 48.6% of correct-answer literals appear verbatim in Sample-rows blocks
vs 21.4% permutation control (4.1× on high-entropy); +8.2pts grounding over
stats-only; 7.6% of literals reachable only via rows; zero strict reverse
flips in 70 turns; one documented case where visible rows would have caught a
silent join-NaN. Mechanism = value-grounding + self-state legibility. Needs 2
more rows reps to size.

**Avoidable steps (Q2):** <2% of ~1,250 recallState references were genuinely
necessary. 62-63% are a turn-start ritual recall of an operator fully
rendered in the same prompt — FORCED by the field-guide example's
"recallState it first" sentence. Plus failed self-recalls (~1 wasted step /
3 turns), row-reader probe operators, width-only re-pulls. Saveable 0.7-1.5
steps/turn = most of the step gap to session.

**Catalog slimming (Q3):** measured on 1.1MB of deep contexts — stats 30.7%,
code 23.0% (most-REUSED section: 40-75% of new agent code is verbatim catalog
code), rows 14.0%, headers 12.3%, answers 9.3%. Never-used: numeric top_10
(5.3%), Lineage lines (1.5%), the `— Schema:` tail (5.8%, printed 3× per op).
Recommended package ≈ -25-30% context, low risk. Do NOT clip answers further.

**v38 proposal (designed, NOT built):** slimmed entries (drop schema-tail /
numeric top_10 / lineage; age rows+full stats out of entries older than 5
turns keeping str top_5) + rewritten worked example (quote-from-entry, wire,
never confirm-recall) + recallState demoted to exceptional or removed.
Expected ~4 steps/turn, cost below session, accuracy ≥ rows variant.

## 3. Engine fixes landed today (all deployed via worktree dist)

1. **Native thread leak** (2f4d0cb1d): per-region JavaTimer never stopped;
   stats/console executors never shut down; PythonWorkflowWorker.postStop
   single-try skipped cleanup. ~8 leaked threads/exec → ~0.
2. **Flight-socket leak / port exhaustion**: postStop never closed
   `pythonProxyServer` — one bound TCP socket per python worker; at ~28k the
   ephemeral range died and `getFreeLocalPort`'s finally-assert MASKED the
   real exception as "assertion failed"; executions silently returned 0 rows
   for 2.5h while agents fabricated "unable to compute" answers. Both fixed.
3. **Fail-loud runner**: run_longds.py aborts a task (exit 3) after 2
   consecutive infra-signature turns (fast-fail empty answer, or trace
   dominated by "0 rows, 0 cols").
4. **Ops tooling**: logs/health-sentinel.sh (ceilings + leak-growth canaries
   + assertion-rate; TIME_WAIT excluded), logs/outage_scan.py (finds
   silently-poisoned runs by empty-execution signature in a time window),
   judge-all.sh now re-judges stale evals (eval shorter than run).

## 4. Service features added (agent-service, committed)

- `questionOnlyTurns` — question-only layout + `question-only.md` prompt.
- Catalog field guide + multi-turn worked example rides `versionedMode`
  (no knob) — `catalog-example.md`.
- `catalogSampleRowsRatio` (0..1) — fraction of the in-memory rows per
  finished entry, head/tail split, cell-clipped, 4k block cap; errored
  versions render code + `Error:` line, no stats/data.

## 5. Debts / incomplete

- **Whale lane (deferred by user)**: goodbooks×9 (needs `--turn-timeout
  3600`, ≤2 concurrent, nothing else running), march×5 + derby×4 (serial,
  default budget). Script ready: `logs/rerun-goodbooks.sh`.
- **2 QO reruns killed mid-flight by this shutdown**: qo-r1 + qo-r3
  `netflix_movies_and_tv_shows__task1` — partial dirs on disk, wipe + rerun.
- **uber-t1 v37f-r2 re-judge**: stale 2-turn eval deleted; full re-judge was
  in progress when judges were stopped — verify `results_eval.json` has 36
  entries before trusting the rows mean.
- **v37f grid**: r1+r3 fully run; ~5 cells were awaiting judge at stop.
  Run `logs/judge-all.sh` to finish scoring, then `logs/v37f_accuracy.py`.
- v37f/rows not run on the top-10 task set (likely strong paper result).

## 6. Runbook (fresh start)

```bash
# stack (from MAIN checkout script, deploys THIS worktree):
bash /home/bob/Desktop/dataflow-agent/bin/local-dev.sh up \
  --worktree=/home/bob/Desktop/dataflow-agent/.claude/worktrees/longds-multiturn
# master heap (not persisted across ups):
bash .../local-dev.sh down computing-unit-master
JAVA_OPTS="-Xms2g -Xmx20g" bash .../local-dev.sh up computing-unit-master
# campaign agent-service: NON-WATCH, never edit src while lanes run:
cd agent-service && PORT=3001 nohup bun run start > ../logs/agent-service-3001.log &
# runners need: export LONGDS_AGENT_ENDPOINT=http://localhost:3001
# judges: nohup bash logs/judge-all.sh &   (needs JUDGE_* in .env)
# health: run logs/health-sentinel.sh under a Monitor
# audits: benchmark/longds/bs_audit.py, logs/outage_scan.py,
#         logs/v37f_accuracy.py, benchmark/longds/difficulty_breakdown.py
```

Known traps: plain `up` resets deploy target to main checkout; goodbooks t1
never fits 1200s; march t13 + derby t1 need isolation; watch-mode bun on the
campaign port poisons runs on any source edit (verify exactly ONE listener).
