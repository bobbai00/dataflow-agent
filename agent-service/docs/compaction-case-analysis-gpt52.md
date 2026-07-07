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

## Where the code-agent wins and dataflow can't (deep trace analysis)

Cases where BOTH code-agent arms (2k & 5k) are right AND all 4 dataflow configs are
wrong (robust; not variance): **astronomy-hard-9, environment-hard-11, legal-hard-15**.
(Weaker, one code arm only: archeology-easy-11, archeology-hard-7.)

1. **legal-hard-15 — cross-file dedup discovered empirically.** "Total identity-theft
   reports from cross-state MSAs 2024." Gold 243,377; code 243,377; dataflow 593,524
   (D5k) / 1,124,157 (L5k) ≈ 2.4×/4.6×. Data = 52 per-state CSVs; a cross-state MSA
   (e.g. "Columbus, GA-AL") appears in EVERY state file it touches. The code agent's
   run→inspect loop saw the same metro across files and DEDUPED; the dataflow pipeline
   (`msa_files→msa_all→msa_clean→cross_state_2024_total`) correctly pattern-matched
   `, ST1-ST2` but never deduped → summed each ~2.4×. Not a paradigm limit — the REPL
   surfaced the duplication; declarative build-and-sum didn't.
2. **astronomy-hard-9 — heavy monolithic time-series.** "Best lag 0-48h maximizing r²
   between TLE-derived drag and OMNI AP index." Gold 24; code 24; dataflow produced NO
   output (empty dir — errored/timed out) in all 4. TLE parse → SMA-change → hourly
   round → align → 49-lag sweep → r². The DAG paradigm couldn't converge it; monolithic
   code did.
3. **environment-hard-11 — dirty multi-header file.** "Avg rainfall day-before failed
   Pleasure Bay samples." Gold 0.37; code 0.37; dataflow 0.40. Combined multi-header
   datasheet; the dataflow agent re-built `pbci_tidy` twice (header confusion) → off;
   the code agent's iterative inspection parsed it right.

**Common thread:** the code agent's tight write→run→inspect→adjust REPL (a) empirically
discovers data quirks (cross-file dup, multi-header) and corrects mid-solve, and (b)
expresses monolithic numerical pipelines (lag sweep) that are awkward as an operator DAG
and where the dataflow agent times out. The dataflow agent build-and-commits from its
plan; a missed empirical quirk gets baked in.

**Proportion / honest framing:** this is 3(-5)/104 tasks. In aggregate the dataflow agent
is BETTER — Delta-5k 69.7% vs code 65.7%, ~30% cheaper, ~1.6× better acc/$ (dataflow
context ~86% prompt-cached; code burns ~3× output tokens). So: operator paradigm wins the
median task + efficiency; code agent wins a specific tail (empirical-dedup / heavy-time-
series / dirty-multi-header). Actionable: dataflow closes most of the gap with (i) an
empirical dedup/inspection habit on multi-file loads and (ii) a code-escape hatch for
heavy numerical/time-series tasks.

## Rerun v2 — updated prompts (canonical pitfalls) + guided code agent

Setup: canonical 7-bullet data-pitfalls set live in the dataflow code-mode prompt
(service restarted) and in the code agent's CUSTOM_INSTRUCTIONS; two NEW guided
code-agent SUTs (Chars{2k,5k}Guided, full fresh 104-task runs); dataflow arms got
one `rerun-failed --isolate` pass under the new prompt (monotonic best-of).

| SUT | before | after v2 |
|---|---|---|
| Latest-5k schema-only | 68.2 | **75.6** ← leader |
| Delta-5k stats-on | 69.7 | 75.2 |
| Latest-5k stats-on | 64.8 | 72.2 |
| Latest-2k stats-on | 60.7 | 71.1 |
| CodeAgent-5k **Guided** | (new) | 71.0 (unguided 64.0) |
| Delta-5k schema-only | 62.9 | 71.0 |
| Delta-2k stats-on | 65.2 | 68.1 |
| CodeAgent-2k **Guided** | (new) | 67.0 (unguided 65.7) |

**Guided-vs-unguided code agent (the clean comparison — same tasks, fresh runs):**
at 5k the guidance is worth **+7.0 pts** (64.0→71.0; +9 tasks fixed, −2 broken) at
LOWER cost ($0.057 vs $0.063/task; 12.1 vs 9.8 acc/$) — more steps (7.3 vs 6.1) but
fewer output tokens and better cache reuse. At 2k it's ~flat (+1.3; +1/−5 flips) —
guidance doesn't compensate for a tight preview.

**Targeted case checks (did the bullets fix the diagnosed failures?):**
- environment-hard-11 (dup column names): FIXED in L5k, D5k, L5kSch (was 0 in all
  4 dataflow arms). Consistent with the new bullet, though retry randomness
  contributes — cannot cleanly attribute on n=1.
- legal-hard-15 (dedupe-concat): still 0 in all 4 stats arms; flipped only in
  D5kSch — and the guided code agent BROKE it at 5k (unguided had it right).
  Verdict: the dedupe bullet did NOT reliably rescue this; flips look noise-driven.
- environment-hard-7 (units): 5k arms right, 2k arms still wrong — unchanged; the
  units bullet didn't rescue the truncated-view arms.
- astronomy-hard-9..12: now attempted everywhere (isolation fixed the group-kill);
  hard-9 right in L5k/L5kSch + all code arms; hard-11/12 wrong everywhere
  (genuinely hard); hard-10 still unscored in all arms.

**Honest read:** the dataflow gains conflate the new prompt with one extra
monotonic recovery round — the guided-vs-unguided code agent is the clean signal,
and it says the pitfalls guidance is worth ~+7 pts at 5k, ~0 at 2k. Per-case, the
duplicate-columns bullet plausibly landed (env-hard-11); the dedupe and units
bullets did not demonstrably flip their target tasks. Prompt guidance helps in
aggregate but is not a targeted cure for specific diagnosed failures.
