# Two-Ends Campaign — Final Report (2026-08-23)

10 tasks at the turn-count extremes of LongDS (5 longest: 37-42 turns; 5
shortest: 15-25), 3 arms x 3 reps, 63 runs, per-turn deepseek-v4-pro judging.
Arms: session (full history), question-only (QO), v38 (versioned catalog as a
verified extension cache: gradual entries with catalogFreshTurns=5, 50%
sample rows + thin stats on fresh entries, code+answers never age, structure-
preserving clips, recallState demoted to exceptional, extension rule).
Session's long-task reps reuse the top-10 campaign (user directive); QO ran
long only on nfl.

## Final table (per-rep accuracies, 3-rep mean, mean $/run)

LONG (37-42 turns)                 session              qo               v38
nfl_big_data_bowl        31/43/17 =30% $1.34   31 =31% $0.85   7/5/12 = 8% $1.06
phase-ii-wids            60/42/51 =51% $1.70               –  49/52/54 =52% $0.87
cdp-climate                 0/3/0 = 1% $3.65               –    3/0/0 = 1% $1.07
acea t2                  86/81/84 =84% $0.57               –  61/71/42 =58% $0.46
acea t3                 100/97/97 =98% $0.69               –  97/97/89 =95% $0.40
MEAN                         52.9% $1.59          31.0% $0.85      42.6% $0.77

SHORT (15-25 turns)                session              qo               v38
github_languages       100/93/100 =98% $0.07  93/93/93 =93% $0.09  93/93/93 =93% $0.08
univ_rankings t2         14/10/14 =13% $0.18  52/71/76 =67% $0.36  86/14/14 =38% $0.15
univ_rankings t3         83/78/78 =80% $0.17  70/83/78 =77% $0.15  87/83/91 =87% $0.15
kaggle-survey-2021       12/12/12 =12% $0.38   20/12/8 =13% $0.39   16/8/24 =16% $0.33
LearnPlatform             60/60/8 =43% $0.47  12/16/16 =15% $0.46  20/28/68 =39% $0.41
MEAN                         49.0% $0.26          53.0% $0.29      54.6% $0.22

steps/turn: session 3.43 | qo 8.88 | v38 4.25

## Findings

1. **Shorts: v38 wins both axes** (54.6% at $0.22 vs session 49.0% at $0.26);
   QO close behind on accuracy but 32% more expensive and 2.6x the steps.
2. **Longs: v38 = 48% of session's cost** (mean $0.77 vs $1.59; wids $0.87 vs
   $1.70 at accuracy parity; acea-t3 95% vs 98% at 58% the cost; cdp dead for
   every arm — session pays $3.65 to score 1%). Accuracy mean trails (42.6 vs
   52.9) — entirely attributable to two tasks, see (3).
3. **The v38 deficit is CONVENTION RE-INSTANTIATION DRIFT, not the catalog
   design** (3-agent trace study, all hypotheses tested):
   - nfl: turn 2 leaves percentile direction + grain implicit; 39/41 later
     turns extend its state. All 3 v38 reps rolled it wrong (differently);
     3/4 session reps carried their own turn-1 convention. Control: the one
     session rep that flipped turn 2 collapsed to 7.1% = exactly v38's score.
     The gate is arm-independent; a session rolls once, the catalog arm
     re-rolls per turn/rep.
   - acea-t2: ~15 per-waterbody convention-instantiation points per run;
     9 roll-errors across 3 v38 reps vs ~1 across 4 session reps.
   - Falsified: fresh-window starvation (v38's gap concentrates on FRESH
     turns, +40.6pp at span<=5 vs +10.9pp at span>5 — do NOT grow the
     window); extension-rule misuse (v38 recomputed, never blind-copied);
     recall under-use (anti-correlates: the heaviest-recall rep scored worst
     after re-reading its own code and still inverting the convention).
4. **QO's cascade immunity, cleanly isolated**: univ_rankings-t2 = the
   shared-ambiguity task where session (13%) and v38 (38%) inherit their own
   early error; QO re-rolls per turn and scores 67%. Mirror image: QO's
   LearnPlatform 15% (wide ingest re-paid every turn, budget-grazing) and
   8.9 steps/turn.
5. **Regime map for the paper**: short/low-state tasks — v38 or session, QO
   competitive; long tasks — v38 for cost (half of session) at parity except
   convention-gated tasks; convention-gated single-point tasks — session's
   continuation advantage is real but fragile (one bad roll and it equals the
   catalog arm).

## v39 candidate (specified, not built)

A never-aging **conventions record** per catalog entry (or per-session
ledger), captured at commit time: metric direction ("rank 1 = highest
mean_kick"), percentile grain, tie-breaks, split seeds ("default_rng(42),
n//3"). Turns the catalog arm's per-turn re-roll into session-style
continuation while keeping the cost profile. Evidence says recall cannot
substitute — it must live in the always-rendered entry.

## Provenance / hygiene

- v38 ran on the fixed renderer (structure-preserving clips; abort labeling)
  after the trace audit found 100% of code/rows flattened by clip() — all
  v38 data here is post-fix; the audit + fix are in commit history.
- Clean-run filter: infra-empty = empty answer with elapsed < 120s; empty
  answers at 300-1400s are model no-answer/budget turns and score 0
  legitimately (same turns hit multiple arms).
- Engine stable throughout: threads ~290 flat over 10h, FDs ~650, zero leak
  canary alerts, zero assertion-failures after the socket fix.
