# Compaction case analysis — gpt-5.2, KramaBench (stats on, post-rerun)

Per-task differences across the 4 dataflow configs, chosen to illustrate two theses:
(1) **compaction *timing* matters** — "always compact" (LATEST) is not free; (2) the
**compaction *parameter* (5k vs 2k result char limit) matters** and interacts with
agent behavior. Framing: **LATEST = always-compact** (state snapshot, no trajectory);
**DELTA = never-compact** (full event log). Data: 104 tasks/SUT, gpt-5.2, stats on,
one monotonic rerun. `success==1` = right, `==0` = wrong.

Accuracy recap: **Delta-5k 69.7% > Delta-2k 65.2% > Latest-5k 64.8% > Latest-2k 60.7%**.

## Part A — the compaction PARAMETER (5k vs 2k)

### Accuracy flips
| case | task | gold | 2k | 5k | note (verified from traces) |
|---|---|---|---|---|---|
| a | environment-hard-7 | 10.87 | 0.11 ✗ | 10.87 ✓ | **CORRECTED after tracing: units artifact, not data loss.** D5k = `15.12%−4.25% = 10.87` (pct points); D2k computed the *same numbers* but reported `0.11` (raw proportion). Richer 5k result cued the % scale. Replicates in both modes, but it's a representation effect. |
| c (vice-a) | astronomy-easy-5 | 2 | 2 ✓ | 0 ✗ | D2k right, D5k empty(0) — the skyfield swallowed-exception pattern. Single-cell (L5k+D2k right) → run-variance, the honest non-example. |

### Token efficiency (both right) — the key insight
| case | task (delta) | 2k | 5k | |
|---|---|---|---|---|
| e | wildfire-easy-1 | 15 steps / 146k tok | **9 steps / 62k tok** | 2k truncation → **traced**: agent re-edited the `monthly_stats` op **8×** and spawned a duplicate `_fixed` op (4 ops, 13 calls) to recover what it couldn't see; 5k used 2 ops / 7 calls. Same answer, 2.4× tokens. The cleanest mechanism-confirmed case. |
| g (vice-e) | wildfire-easy-2 | **5 steps / 35k** | 8 steps / 78k | when 2k fits, it's genuinely leaner; 5k just adds cost. |

**e vs g = the parameter story:** 2k is cheaper *when it fits*, more expensive *when it
truncates something needed and the agent thrashes to recover*. Effect is behavior-dependent.

## Part B — compaction TIMING (delta vs latest)

### Accuracy flips
| case | task | gold | latest | delta | note |
|---|---|---|---|---|---|
| b | biomedical-hard-7 | 16 | 15 ✗ | 16 ✓ | always-compact (latest) lost trajectory detail → off-by-one. **Replicates in BOTH 2k & 5k** (robust timing effect). |
| d (vice-b) | environment-hard-13 | 11 | 11 ✓ | 12 ✗ | counterpoint: clean snapshot got 11; delta's long trajectory → 12. Sometimes compaction helps. |

### Token efficiency (both right)
| case | task | delta-5k | latest-5k | |
|---|---|---|---|---|
| f | wildfire-easy-2 | **8 steps / 78k** | 12 steps / 159k | delta cheaper (latest full-snapshot re-render heavier). |
| h (vice-f) | wildfire-easy-1 | 9 steps / 62k | **6 steps / 37k** | latest cheaper (bounded snapshot beat the growing log). |

## LATEST 2k vs 5k (compaction param, always-compact mode)
- L5k right, L2k wrong: environment-hard-7 (10.87 vs 0.11), -14, -15, -13. → too-tight compaction loses the answer.
- L2k right, L5k wrong: legal-easy-19 (0.523 vs 0.199), biomedical-easy-9. → the leanest view occasionally focuses the model better (or variance).

## Unique-winner illustration
`legal-hard-1` (gold 12964.8727): **Delta-5k uniquely right** (12964.8727); Latest-2k/5k=13902.24, Delta-2k=13778.13 all wrong. The winning config needs BOTH the full trajectory AND enough result chars — its wins are task-specific.

## Synthesis
1. **Timing isn't free either direction** — latest is right-where-delta-wrong (d) AND wrong-where-delta-right (b); the robust cases replicate across the char-limit axis. A fixed always/never policy leaves accuracy on the table both ways.
2. **The parameter interacts with behavior** — 2k→wrong-answer (a) and 2k→thrash-more-tokens (e), yet 2k-leaner-when-it-fits (g). Not "bigger is better"; task-dependent.
3. Best overall (delta-5k) wins *specifically*, not uniformly → argues for an **adaptive/learned** compaction policy (when to compact + how much to keep) over a fixed setting.

Honest caveat: single-cell flips (astronomy-easy-5) are run-variance; the load-bearing
cases (a, b) are the ones that replicate across the orthogonal dimension.

## Schema-only vs stats-on at 5k — the stats block's value is MODE-DEPENDENT

Two extra arms at 5k with **stats OFF, only the Schema line** (output column names +
types) kept, vs the stats-on 5k arms:

| config | acc% | $/task | in-tok | out-tok | cached | steps | acc/$ |
|---|---|---|---|---|---|---|---|
| Latest-5k **stats-on** | 64.8 | $0.039 | 5.16M | 119K | 4.39M | 6.5 | 17.2 |
| Latest-5k **schema-only** | **68.2** | $0.046 | 5.66M | 151K | 4.73M | 7.3 | 14.9 |
| Delta-5k **stats-on** | **69.7** | $0.044 | 6.03M | 122K | 5.02M | 6.4 | 16.0 |
| Delta-5k **schema-only** | 62.9 | **$0.037** | 4.20M | 98K | 3.52M | 6.3 | **19.9** |

**The per-column stats block flips sign by compaction mode:**
- **DELTA: stats HELP** — +6.8 acc (69.7 vs 62.9), worth the ~1.8M extra input tokens.
  In the never-compact trajectory the model already has context; the stats *sharpen*
  the decisive column choices (join keys, categoricals).
- **LATEST: stats HURT** — schema-only is +3.4 acc (68.2 vs 64.8). In the always-compact
  snapshot (every op re-rendered every step) the dense stats block appears to be
  distraction/noise; the lean schema line alone reads cleaner. But it costs MORE
  ($0.046, 7.3 steps) — accuracy up via more exploration, not less context.

Efficiency corners: **Delta-5k schema-only is the most cost-efficient** (19.9 acc/$,
cheapest $0.037) but not the most accurate; **Delta-5k stats-on is the accuracy peak**
(69.7). So even a single "compaction parameter" (show stats?) has no globally-right
setting — its value depends on whether you're compacting (latest) or not (delta).

**Caveat:** single run + one monotonic rerun per arm; the ±3–7pt magnitudes carry
sampling noise. The *direction* (stats help delta, not latest) is the reportable signal;
exact points would need reps to pin down.

## Overall takeaway for the compaction thesis
Across timing (latest/delta), the result char limit (2k/5k), AND the stats block, **no
setting is globally optimal** — each helps on some tasks/modes and hurts on others, and
the parameters interact with agent behavior (thrash, exploration). This is the empirical
case for an **adaptive / learned compaction policy** (choose *when* to compact and *what
fidelity* to keep per state) rather than any fixed configuration.
