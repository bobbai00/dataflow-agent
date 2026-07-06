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
| case | task | gold | 2k | 5k | note |
|---|---|---|---|---|---|
| a | environment-hard-7 | 10.87 | 0.11 ✗ | 10.87 ✓ | 2k truncated the result → wrong by ~100×. **Replicates in BOTH latest & delta** (robust parameter effect). |
| c (vice-a) | astronomy-easy-5 | 2 | 2 ✓ | 0 ✗ | D2k right, D5k empty(0). Single-cell (L5k+D2k right) → run-variance on a known-flaky task. |

### Token efficiency (both right) — the key insight
| case | task (delta) | 2k | 5k | |
|---|---|---|---|---|
| e | wildfire-easy-1 | 15 steps / 146k tok | **9 steps / 62k tok** | 2k truncation → reload/re-inspect thrash → 2.4× tokens for the SAME answer. |
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

_Schema-only 5k experiments (stats off, schema line only) running separately to isolate
the value of the per-column stats block — appended when complete._
