# V39 Gate Verdict + Early-Turn Determinism (2026-08-23)

V39 = v38 + terminal `answer(answer, conventions)` tool; catalog pins a
never-aging `### Conventions` line per entry. Probed on the two tasks where
v38 fell short of session: nfl (v38 8.0 vs session 30) and acea-t2 (58 vs 84).
3 reps each, fixed engine, all judged.

## Results

| task | session | v38 | **v39** |
|---|---|---|---|
| acea-t2 | 84% ($0.57) | 58.0% (61/71/42) | **72.0% (74/71/71, ±1.3)** |
| nfl | 30% ($1.34) | 8.0% (7/5/12) | 8.1% (12/5/7) |

Adherence was near-total: answer tool used 38/38 turns every rep; non-empty
conventions on 93% of turns; `### Conventions` rendered in 110/111 turn
openings; pinned split literals matched in 23/23 model turns per rep.

## Causal decomposition (trace-verified)

**acea +14.0pp = PARTIALLY causal.**
- ~+4pp confirmed verbatim: turns 19/24 — all three v39 reps' code quotes the
  pinned lines (n//3 + default_rng(42) split, canonical feature roster,
  Wet=Oct-Mar, recorded baselines) and answers agree to 4 decimals across
  reps, where v38 re-rolled and leaked sibling targets / drifted baselines.
- ~+6pp partial (anchoring): the t16 Luco-roster hinge and its t34/t38
  cascades — v39 rolled right 3/3 without a covering Conventions line.
- ~+10pp non-preventable first-roll variance (v38-r3's ceil(n/3) at t4 —
  conventions PIN a first roll, they cannot fix it; a v39 rep rolling ceil
  would have locked ceil).
- **-4pp mechanism cost**: t21 lost 3/3 — the never-aging turn-1
  complete-sample convention froze a definition the task text REDEFINES at
  t21; v38's re-derivation coin got it right 2/3. A convention must be
  supersedable when the task changes the rule.
- Containment bonus: v39-R3's t5 leak was pinned as a repair convention and
  never recurred; v38-r2's identical leak recurred in 16/23 model turns.

**nfl 8.1 = unmoved, and the analyst REFUTES "irreducible".** The turn-2 coin
(percentile direction 5/10 rolls wrong, grain 3/10) is an attention failure
with complete disambiguating evidence ON SCREEN: every agent read the
published ledger correctly for one purpose, then contradicted it in the
percentile formula — v38-r1 computed the exactly-correct answer and REVERTED
it after a rank-level comparison with the ledger (whose rank-1=highest
convention is the opposite of the formula's rank convention — the sample
PRIMES the flip). Catalog arms got ≥1 face wrong in 6/6 reps vs session 1/4
(Fisher p≈0.03): catalog salience is a secondary factor. Conventions failed
here because at t1 there was no decision to record and at t2 the agent
recorded outputs, not the percentile definition.

## Early-turn determinism (402 clean judged runs, all arms/campaigns)

| early turns 1-3 | late accuracy (t4+) | n |
|---|---|---|
| 0/3 | 11.1% | 75 |
| 1/3 | 10.3% | 82 |
| 2/3 | 24.9% | 106 |
| 3/3 | **51.7%** | 139 |

Pearson r(early, late) = 0.55. Only 35% of runs start 3/3; those average
51.8% on the rest vs 28.9% overall — the early-turn gate is worth ~+23pp,
larger than any layout effect measured. Per-arm late(early=3/3)/late(≤1/3)
ratio: session 4.3×, v37 5.9×, v38 4.4×, QO 2.9× (cascade immunity).

## V40 candidate (specified)

Two prompt changes on top of v39, probe = 3 reps on nfl + acea-t2:
1. **Ranking/percentile declaration + VALUE-level verification** (not
   rank-level — rank-level reconciliation is what flipped v38-r1): before
   answering any turn that computes a ranking/percentile, state which end is
   rank 1 / which value gets percentile 1.0 and over what population
   (defaulting to the full working table), then verify BY VALUE against any
   published sample — top-listed members must land at the top end of the
   computed measure; record the verified statement in conventions.
2. **Supersedable conventions**: when the task text redefines a rule, the new
   convention must explicitly supersede the old line ("supersedes T1's
   complete-sample definition"), and the render marks the old one stale —
   fixing the t21 freeze cost.

Fallback lever if the probe doesn't move nfl t2 to ~3/3: catalog rendering —
pin the turn-1 ground-rules paragraph (not prompting).
