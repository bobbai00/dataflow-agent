# Top-10 LongDS campaign — session vs versioned, 3 rounds + iteration

**2026-08-19/20 · gpt-5.6-luna (medium reasoning) · 10 longest LongDS tasks ·
judge: deepseek-v4-pro via OpenRouter (the paper's own judge)**

Goal (user): run the 10 longest tasks in both layouts 3×, collect
accuracy+cost correctly, deep-dive flips in both directions with direct trace
evidence on retrieval, and iterate to a versioned config **cheaper and better
than session**.

## 1. What ran

| round | session arm | versioned arm | packaging |
|---|---|---|---|
| r1 | Top10Session | Top10V32 (v3.2-fix) | legacy render (anchor) |
| r2 | +cacheAlignedContext | +cacheAlignedContext | frozen render + appends |
| r3 | *(skipped by user decision)* | +upstreamValueEcho +answerShapeRule ("fix pack") | cache-aligned |
| sub5 ×3 reps | SessionR3 (3rd session rep, subset) | **v33** = cacheAligned + answerShapeRule + **catalogDetail: "code"** | cache-aligned |

Sub5 subset = the 5 signal tasks (largest ses↔v32 diffs over r1–r2): kaggle
t3, nfl t1, acea2, acea3, wids1. The other five top-10 tasks (cdp, LA, cpe×2,
wids2) score at the floor in every arm (0–20) and carry no iteration signal.

## 2. Full top-10, per round (judged turn-share %, one run each)

| task | ses-r1 | v32-r1 | ses-r2 | v32-r2 | v32-r3fx |
|---|---|---|---|---|---|
| kaggle-survey t3 | 8.1 | 75.7 | 89.2 | 81.1 | 54.1 |
| acea2 | 50.0 | 55.3 | 81.1 | 65.8 | 50.0 |
| acea3 | 100.0 | 75.7 | 97.3 | 94.6 | 78.4 |
| cdp | 0.0 | 0.0 | 2.6 | 2.6 | 2.6 |
| wids1 | 60.0 | 35.0 | 42.5 | 48.7 | 42.5 |
| wids2 | 50.0 | 54.8 | 38.2 | 22.2 | 33.3 |
| cpe t1 | 19.4 | 5.6 | 2.8 | 19.4 | 19.4 |
| cpe t2 | 22.9 | 22.2 | 15.2 | 8.3 | 8.6 |
| LA city | 2.8 | 2.9 | 2.8 | 2.9 | 2.8 |
| nfl | 7.1 | 31.0 | 42.9 | 9.5 | 4.9 |
| **mean** | **32.0** | **35.8** | **41.5** | **35.5** | **29.7** |

- **cacheAlignedContext** (r2): cost mechanism, works — 85–99% cached/step,
  the luna deployment only cache-hits on whole-request extension (probed:
  append-only message array → hit; any intra-message change → 0).
- **Fix pack** (r3): net **negative** (29.7 vs r2's 35.5). answerShapeRule
  verified on its target (acea2 t1 flipped 0→1, flat verbatim keys);
  upstreamValueEcho fired correctly but bought nothing measurable — losses
  traced to ordinary cascade draws (e.g. kaggle t14 base-population choice
  with echo inactive). **Echo retired; shape rule kept.**

## 3. Randomness (the reps were bought to measure it)

Per-task rep spread (max−min) on the subset: session 2.7–81.1 pts (kaggle:
8.1 → 89.2 across reps!), v33 7.9–37.8. Single runs are lottery tickets;
per-task medians of ±10–20 pts are normal. This is cascade structure: 93–94%
of wrong turns inherit from an already-wrong upstream, median first error at
turn 2–3, so one early derivation draw decides dozens of turns.

## 4. Sub5 endpoint — 3 reps per arm

Per-task rep-means (3r except v32=2r):

| task | session | v32 | v33 |
|---|---|---|---|
| kaggle t3 | 57.7 | 78.4 | 51.4 |
| nfl | 22.4 | 20.2 | 17.7 |
| acea2 | 71.8 | 60.5 | **76.1** |
| acea3 | 98.2 | 85.1 | 91.9 |
| wids1 | 51.3 | 41.9 | 50.6 |
| **arm mean** | **60.2** | 57.2 | 57.5 |

Pooled turn-level (the tight comparison): **session 59.2% ± 4.0 (n=579),
v33 56.6% ± 4.0 (n=576), v32 56.1% ± 4.9 (n=387)** — all 95% CIs overlap.

Cost per task-run: **session $1.233 · v32 $1.042 · v33 $0.618**.

**Verdict: v33 reaches session-level accuracy (indistinguishable within CI)
at 50% of session's cost** — plus the versioned layout's structural
properties (exact version addressing, immutable history, recall). "Cheaper"
is decisively met; "better" on accuracy is parity-within-noise, not a win —
the honest reading at this sample size.

## 5. Flip evidence, both directions (trace-grounded)

**Versioned wins because of retrieval** (r2, full-10): cpe t4/t5 — the task
demands revising an earlier state; v32 pulled
`uof_common_results_revised (turn 4)` with `recallState`, applied the delta
against the exact recorded version and scored; session reconstructed the
state from its inline history and drifted. Direct: the recall call and the
correct delta are in the same turn's trace.

**Session wins because code was visible** (r2): the dominant versioned loss
class is **convention re-derivation** — rebuilding an inherited metric's
formula/denominator/normalization from the operator's *name*:
- nfl t3: 9 blind cross-turn writes, wrong denominator → 14 dependent turns
  lost;
- acea2 t6: feature-prep re-derived, RF test_rmse 0.5352 vs session's 0.3883;
- kaggle t18: population drift (Africa 10 vs 11 countries).
Session avoids all of these by reading prior turns' code inline.

**The v33 mechanism closes exactly that class** (`catalogDetail: "code"` —
each version's code rendered once, byte-stable, in its creating entry):
acea2 t6 across v33 reps = **0.3888 / 0.3883 / 0.3883, 3/3 correct, with
zero recalls in r1/r2** — the model read the convention off the printed
catalog code. v32-r2 (no code, also zero recalls) drifted to 0.5352. Causal
chain: same task, same layout, one knob, reproduced 3×.

## 6. Catalog detail knob (shipped)

`catalogDetail: ids | brief | schema (default) | code` on the versioned
catalog + `catalog-code.md` prompt fragment (read the printed code, keep its
conventions; recall is for values). Cache-aligned packaging keeps the extra
bytes mostly cached-priced — v33's cost is *below* plain v32-r1 despite the
bigger catalog.

## 7. Improvement plan

1. **Foundation turns are the remaining gap.** nfl-class cascades hit every
   arm (session included). The first-error turns are population/denominator
   choices at state creation. Prompt-only discipline (foundationVerify,
   r3 fix pack) did not measurably help; next candidate is a *mechanism*:
   auto-render the join/filter retention facts (rows in → rows out per
   upstream) in the delta entry itself, so a wrong foundation is visible the
   turn it is created.
2. **Rule pinning for late turns.** kaggle-class losses are binding
   conventions stated once at turn 2–3 and violated at turn 25+. Candidate:
   a `# Standing rules` line in the (already frozen) render, listing
   verbatim-quoted constraint sentences from earlier tasks — append-only,
   cache-friendly, no magic numbers.
3. **Decide on ≥3 reps.** The sub5 harness makes a full 3-rep arm ≈ $9.30 +
   ~6 h wall — always run 3 reps before believing any lever.
4. **Retired**: upstreamValueEcho (superseded by code-in-catalog, which
   attacks the same blindness pre-hoc, not post-hoc).

## 8. Ledger

Campaign spend: session 15 runs $18.50 · v32 10 runs $10.42 · v32fx 5 runs
$3.29 · v33 15 runs $9.27 · judge (OpenRouter deepseek) ≈ $4. All arms ran on
the dev/longds-multiturn worktree agent-service (:3005) against the shared
JVM stack; scratch under `benchmark/longds/system_scratch/LongDS_*`.

---

# FINAL: 3 reps x 10 tasks x 3 arms (2026-08-21)

Everything above was the iteration story. This is the endpoint: the ten
longest LongDS tasks, three independent reps, three arms, every turn judged by
deepseek-v4-pro. 90 task-runs, ~3,000 judged turns.

## The arms

| arm | layout | packaging | catalog entries | probe |
|---|---|---|---|---|
| **session** | `# Session` / `## Turn N` | cache-aligned | n/a | no |
| **v36** | versioned catalog | cache-aligned | code + full column stats | `queryResult`, ceiling 15 |
| **v37** | versioned catalog | cache-aligned | code + full column stats | **none** |

Both versioned arms also carry `answerShapeRule` and the literal-discipline
rule (`valueProbeRule`); v37 uses its no-tool variant, which points at the
entry's stats block and `recallState` instead of a probe. `recallState` is on
in every versioned arm and always was.

## Result

| task | session | v36 | v37 |
|---|---|---|---|
| kaggle-survey t3 | 8/89/76 → 57.7 | 78/41/69 → 62.8 | 81/54/86 → **73.7** |
| nfl big-data-bowl | 7/43/17 → 22.4 | 27/5/5 → 12.2 | 31/29/5 → 21.4 |
| acea water t2 | 50/81/84 → 71.8 | 89/84/68 → **80.7** | 82/76/74 → 77.2 |
| acea water t3 | 100/97/97 → **98.2** | 95/97/100 → 97.3 | 70/76/89 → 78.4 |
| wids datathon t1 | 60/42/51 → 51.3 | 45/50/36 → 43.6 | 68/62/46 → **58.7** |
| wids datathon t2 | 46/42/25 → **37.5** | 11/8/17 → 12.0 | 9/31/42 → 26.9 |
| cpe t1 | 19/3/19 → 13.9 | 25/14/25 → **21.3** | 19/17/17 → 17.8 |
| cpe t2 | 23/14/11 → **16.1** | 17/6/20 → 14.1 | 14/14/14 → 14.0 |
| LA city | 3/3/3 → 2.8 | 6/6/14 → **8.3** | 6/11/3 → 6.5 |
| **task-mean** | **41.3** | 39.2 | **41.6** |
| pooled turn accuracy | 41.5% ±3.0 | 39.3% ±3.0 | **42.0% ±3.0** |
| **cost / task-run** | $1.655 | $1.311 | **$1.158** |
| steps / turn | 3.4 | 6.1 | 4.7 |

(cdp is omitted: it scores 0-3 in every arm and its last run was still
executing at the time of writing. It cannot move a ranking.)

**v37 matches-to-slightly-beats the session baseline at 70% of its cost.** The
accuracy gap is inside the CI, so the defensible claim is parity on accuracy
and a real 30% saving — with the versioned layout's structural properties
(immutable versions, exact addressing, retrieval) on top.

## What each knob was worth

1. **cache-aligned packaging** — the cost mechanism. The luna deployment only
   cache-hits when a request extends the previous one, so freezing the render
   and appending per step took cached share from ~5% to 85-99%.
2. **code in catalog entries** (`catalogDetail: "code"`) — closed the dominant
   versioned-vs-session loss class, convention re-derivation. Causal evidence:
   acea2 t6 reproduced session's exact RMSE 3/3 reps with zero recalls, where
   the code-blind arm drifted to 0.5352.
3. **full column stats in entries** (`catalogDetail: "values"`) — value
   spellings, pushed. Cut probe volume 211 -> 63 per run.
4. **dropping the probe** (v37) — the census showed probes taking 43% of agent
   steps in v34 and 21% in v35 for a 28% reuse rate, while each probe costs a
   whole context re-send. Removing it took steps/turn 5.2 -> 4.3 and cost
   $1.02 -> $0.89 on the subset, and it won wids1 by ~20 points.
5. **retired**: `upstreamValueEcho` (net negative), the whole-stats trim (the
   stats are wanted), and the capped-probe arm (v38, stopped before it ran).

## Where the arms differ, and why

* **v37 wins kaggle (+16 over session)** — the salary-band vocabulary is in the
  catalog now, so the mapping dict matches the data's real spellings. Before
  any of this, that dict was typed from memory with `$` on every key against
  data that carries `$` on one band only, and it NaN'd every row silently.
* **v37 wins wids1 (+7.4)** — the most operator-heavy task, where probe-driven
  step inflation hurt most (one v34 turn took 48 minutes and 25 steps).
* **session wins acea3 (98.2 vs 78.4)** — the one durable win for the
  baseline. Traced to turn 23, an OLS predicted-mean the probe arms get right
  3/3 and probe-less arms get right 2/5. v37 rep 3 hit 89, so it narrows.
* **session wins wids2 (37.5 vs 26.9)** — not investigated; a candidate for
  the next round.

## Method notes worth keeping

* **Three reps is the minimum.** Session's kaggle went 8 / 89 / 76 across
  reps; v36's nfl went 27 / 5 / 5. Any single-rep comparison on this benchmark
  is noise.
* **Judge coverage must be checked, not assumed.** A credit outage left an
  eval file that looked complete but held one scored turn of 38, and the mean
  read 0.0. `judge_coverage.py` prints scored/total per task.
* **The engine can die mid-run and the transcripts still look normal.**
  ComputingUnitMaster stopped once; every execution after answered
  `{"error":"dataflow execution service unavailable"}` and a whole rep of two
  arms judged at 29 instead of ~65. `run_all.sh` only port-checks at launch,
  so liveness during a pool needs its own watch.
* **Parallelism has a ceiling.** ~10 concurrent task-runs across 3-4
  agent-service instances is comfortable on 24 cores; pushing to ~15 preceded
  the engine failure above.
