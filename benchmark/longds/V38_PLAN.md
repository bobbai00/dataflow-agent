# V38 Design + Two-Ends Campaign Plan (2026-08-22)

## 1. The question-only answer: history is a cache of EXTENSIONS

Paired per-turn analysis (session vs QO, business-11, majority over 3 reps:
26 session-only wins, 23 QO-only wins, 38 both, 289 neither) + trace autopsy
of both exception sets:

**History genuinely helps (S-wins)** exactly when a turn references a
previously COMPUTED artifact by name ("the portfolio leaders", "the
watchlist", "the current high-risk rows") and the answer depends on that
artifact's **extension** — its exact membership, order, or stored values —
not its definition. Session answers these as a lookup (3-4 steps); QO must
re-execute the whole convention chain and the chance of exact
extension-match decays with chain depth and every top-N truncation composed
along the way (62% of failures = boundary drift, e.g. rank-5 roster flips;
38% = extensions that are unrecoverable from questions, e.g. sets the task
text later freezes "do not rebuild"). Notably QO NEVER failed on budget
(0/62 failing rep-turns timed out — 35-412s, 8-17 steps): it fails on state
identity, not steps.

**History actively hurts (Q-wins)** when the turn is fully derivable from the
question text but references earlier-established state: the session resolves
the reference into its own stored artifacts — a trusted-but-possibly-CORRUPT
cache. Error-inheritance is ~60% of the damage (a wrong upstream poisons
every later lookup; QO re-rolls the chain each turn so errors don't
compound), anchoring ~22% (keeping an old convention exactly where the turn
demands deviating). Counterfactual/rollback-flavored turns are 10/22 Q-wins
(2× their base rate): they need BOTH sides of a comparison under ONE frame,
and sessions mix a fresh side with a stale inherited baseline. Late-session
context overload adds ~10% (270k-token prompts derailing final answers).

**So: do we need previous turns?** Yes — but only as a *verified extension
cache*, not as a transcript. Keep the computed extensions (answers, derived-
table snapshots) addressable; drop the trajectory; re-derive definitions
when the cache is suspect. That is precisely what the versioned catalog is
structurally positioned to be — v38's thesis.

## 2. V38 design

One new setting: **`catalogFreshTurns: K`** (int, default 0 = off, v38 uses
K=5). When K>0 the versioned catalog renders GRADUALLY:

| component | every entry (all ages) | entries ≤ K turns old |
|---|---|---|
| Task text (verbatim) | ✓ | ✓ |
| Answer (2400-char clip) | ✓ | ✓ |
| Summary + Upstream provenance | ✓ | ✓ |
| Result shape `N rows x M cols, ~size` | ✓ (schema tail DROPPED) | ✓ |
| Code (4000-char clip) | ✓ | ✓ |
| Thin stats: null, distinct, min/max, str top_5 | — | ✓ |
| Sample rows (ratio 0.5, head/tail, 4k cap) | — | ✓ |
| numeric top_10, Lineage line, `— Schema:` tail | never | never |

Measured effect (slim study, 1.1MB deep contexts): ≈ **-25-30% context**, no
demonstrably-used byte lost — code (the most-reused section, 40-75% verbatim
reuse) and answers (the extension cache) survive at every age; label
spellings survive in recent str top_5; old extensions survive in answers.

**recallState: kept, demoted to exceptional** (waste study: <2% of ~1,250
recalls were necessary; 62% were a ritual forced by the current example's
own "recallState it first" sentence). Prompt rewrite (catalog-example.md):

1. Method line becomes: *read entries, QUOTE conventions from the printed
   code, wire versions.* Recall is the exception: only for values beyond
   what the entry shows — full membership of a large set, mid-table records,
   or the rows/stats of an entry old enough to have aged out. A recall that
   confirms what an entry already shows is pure cost. Never recall an
   operator created this turn.
2. Worked example rewritten: the agent quotes the threshold from the
   ON-SCREEN turn-3 code block and wires both versions — zero recalls in the
   happy path; one added beat shows the legitimate case (aged-out entry →
   recall its rows).
3. **NEW extension rule** (the QO lesson, v38's edge over both extremes):
   when a task references a previously computed list/roster/top-N, take its
   members from the defining version or its recorded answer — never
   re-derive membership from scratch; re-derivation flips boundary members.
4. Keep: three guarantees, pin caution (last-rebuilt ≠ in-effect),
   both-endpoints-one-frame rollback discipline.

Expected: ~4 steps/turn (from 5.6), cost at/below session, accuracy ≥ the
rows probe (which hit these numbers with MORE bytes and the recall ritual).

## 3. Two-ends campaign (10 tasks × 3 arms)

Tasks (turn counts; ALL 10 prepared, data downloaded):
- LONG-5: sports/nfl_big_data_bowl_2023/t1 (42), geoscience/phase-ii-wids/t1
  (40), geoscience/cdp-climate/t1 (39), geoscience/acea/t2 (38),
  geoscience/acea/t3 (37 — tiebreak: top-10 overlap for comparability).
- SHORT-5: community/github_languages/t1 (15), education/univ_rankings/t2
  (21) + /t3 (23), community/kaggle-survey-2021/t1 (25),
  education/LearnPlatform/t1 (25).

Arms: `luna-te-session`, `luna-te-qo`, `luna-te-v38` (+ -r2/-r3 classes),
fresh SUT dirs (`LongDS_LongDSLunaTE*`). Option: the 5 long tasks already
have 3 clean session reps from the top-10 campaign — reusable to save ~$25
if we accept cross-campaign SUTs; default plan RUNS them fresh for a
single-campaign table.

Staging: **rep-1 of all 30 runs first** (signal, ≈$30, ~5-6h at 6 lanes,
long tasks isolated to ≤2 concurrent heavies), review together, then reps
2-3 (60 runs) for the paper table. Judges sweep continuously; tripwire +
health sentinel + 10-min reporter as before. No whale-class members (nfl and
wids ran clean at 1200s in the top-10 campaign at this parallelism).

## 4. Implementation checklist (est. ~1.5h, before any run)

1. context-utils: age-gating in `renderVersionedCatalog` (thin-stats
   formatter; rows/stats gated on `turnNo > currentTurn - K`; drop schema
   tail/top_10/lineage when K>0). Byte-parity when K=0 (test).
2. `catalogFreshTurns` through the 7 seams (types, server ×6 spots,
   updateSettings bare-assign, AssembleContextOptions, summarize params).
3. catalog-example.md rewrite per §2 (versionedMode-gated as today; v37f's
   version preserved in git history).
4. arms.py: TE arm classes + registry; v38 = v37 knobs +
   `catalogSampleRowsRatio=0.5` + `catalogFreshTurns=5`.
5. bun typecheck + tests + rendered-prompt checks + 3-turn live smoke
   verifying: aged entry thin, recent entry full, zero ritual recalls.
6. Extend judge-all SUT list + status/audit tooling to TE SUTs.
