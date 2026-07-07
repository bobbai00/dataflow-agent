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

## Post-v2 case studies (guided code agent + updated prompt + isolated recovery)

### 1. Code vs dataflow — the v1 "paradigm gap" evaporated
- **ZERO tasks now where both code arms beat all 6 dataflow arms** (v1 had 3). All three
  v1 mechanisms got solved by dataflow: env-hard-11 (3 arms), legal-hard-15 (D5kSch),
  astronomy-hard-9 (L5k/L5kSch, once isolation let it run).
- **2 robust dataflow-wins** (all 6 dataflow right, both code arms wrong):
  `astronomy-easy-5` — dataflow 2✓ (6 steps); both code arms answer 0✗ — the code agent
  returns the empty-result/swallowed-exception answer, the SAME pathology dataflow showed
  in v1. `environment-hard-19` — delta 4 steps False✓; code 11 steps True✗.
- Read: neither paradigm holds a structural edge on this benchmark; run-quality and
  recovery rounds dominate. (Fairness: dataflow had 1 extra recovery round.)

### 2. LATEST parameters
- **Char limit (5k vs 2k, stats on)**: 5 flips each way now — balanced, not "5k wins".
  5k-side keeps env-hard-7 (units) + env-hard-11/13; 2k-side gained a cluster:
  legal-easy-19, legal-hard-22, biomedical-easy-9, environment-hard-8.
- **Stats vs schema-only (at 5k)**: schema-only right where stats wrong on 6 tasks —
  nearly the SAME cluster as the 2k-wins (legal-easy-19, legal-hard-22, biomedical-easy-9,
  environment-hard-8 + astronomy-hard-7, environment-hard-17); stats wins only 3.
  **A replicated "leaner LATEST is more accurate" cluster** across two orthogonal knobs.
- Flagship mechanism `legal-easy-19` (proportion $1–$500, gold 0.523): L5k-stats → 0.199 ✗
  while L2k, L5kSch, AND D5k → 0.523 ✓. The stats block on the ragged multi-block CSV
  misleads latest into summing the wrong sub-block; leaner views (or the trajectory) get it.
- **Cost (both-right, n=47): schema-only cheaper on 33/47.** `wildfire-easy-2`:
  stats 159.5k tok vs schema-only 68.8k — same answer, stats block costs 2.3×.

### 3. DELTA vs LATEST (5k, stats on)
- Flips: D5k wins 6 (legal-easy-19, legal-hard-1, legal-hard-22, biomedical-easy-9,
  biomedical-hard-7, environment-hard-8) vs L5k wins 3 (astronomy-hard-9,
  biomedical-easy-2, environment-hard-10). Delta's wins overlap the "stats-misleads-
  latest" cluster — the trajectory rescues what the snapshot+stats view fumbles.
- **Cost (both-right, n=47): DEAD EVEN — delta cheaper on 24, latest on 23.**
  `wildfire-easy-2`: delta 78k vs latest 160k (latest re-render bloat).
  `environment-hard-13`: latest 5 steps/33k vs delta 10 steps/91k, both right (delta's
  trajectory dragged exploration). Neither mode dominates cost; whichever avoids the
  task's failure mode (re-render bloat vs trajectory thrash) wins — task-dependent,
  the adaptive-policy argument again.

## Failure autopsy — would on-demand compaction / param tuning fix the failures?

Deep autopsy of all 21 scored dataflow failures (15 core = fail in all 6 configs; 6
mode-sensitive), agents reproducing gold computations from the raw data to pin root
causes. Deterministic profile first: mode-sensitive failures run ~2× median tokens
(77–96k vs 43–48k); core failures include the 26-step/260–500k tail — but median
failure is 6 steps, i.e. most failures are NOT thrash.

**Taxonomy (n=21):** data-intrinsic 12 · action-reasoning 5 · scoring-artifact 2 ·
context-render 1 · infra-hang 1. Thrash flagged on 7/21.

**Lever verdicts (strict, evidence-cited):**
- **On-demand compaction: 0/21 flips (yes 0, plausibly 0).** The "thrash → compaction
  helps" intuition is directly falsified: all 7 thrash cases are within-task churn
  (wrong globs, misleading loader hint, messy Excel headers, engine '(not executed)',
  filter re-edits) — folding old trajectory removes none of the root causes. Counter-
  evidence: in environment-hard-10 the FAILING delta arms had the SHORTEST contexts
  (13.8k chars, 4 steps). Compaction stays a COST/robustness lever, not accuracy.
- **Param tuning: 1 yes + 2 plausibly, 18 no — and ~0 headroom beyond the oracle.**
  The confirmed case: astronomy-hard-9 — the deciding 'ap-index' spec line sits at
  char ~8.8k of omni2.text, outside BOTH the 2k and 5k windows (raise char limit on
  long text-spec loads). Plausible: legal-hard-1 (2k truncation churn), biomedical-
  hard-7 (header-is-a-value hint). All 3 are already solved by some existing config,
  so per-state tuning mainly makes wins robust across configs rather than unlocking
  new tasks.
- **Where flexibility DOES pay for accuracy: per-task CONFIG SELECTION.** The oracle
  that picks the best existing fixed config per task = +6 exact-solve tasks (+5.8 pts)
  over the best single arm — that is real, measured headroom, and choosing
  latest-vs-delta / stats-vs-schema per task IS parameter flexibility at task grain.

**The hard core (15/21) needs non-context fixes:** benchmark bugs (legal-easy-21's
gold parser drops the first data row; legal-hard-24's gold strips a comma the prompt
required — 2 free tasks benchmark-side), question disambiguation (the unguessable
year=1950−Age_ky.1.round(0)*1000 mapping drives 3 archeology-hard fails; capital-tier
definition; Euclidean-vs-box '0.1 degrees'), infra (gpt-5.x pre-step hang; engine
'(not executed)'; NRLMSISE-00 absent), and agent verification behaviors for the 5
action-reasoning cases (dedup checks, exact-name checks) — policy, not rendering.

**Bottom line:** flexibility helps accuracy at TASK grain (config selection, +5.8pts
oracle) and helps COST at state grain (19–40% render savings, the 2.3× stats-block
waste) — but mid-run compaction and fine param twiddling have ≈zero additional
accuracy headroom on this benchmark's failures. This replicates the 60-trace haiku
finding ("context is a cost lever; accuracy ceiling ~1 task") on fresh gpt-5.2 data
across 6 configs.

## v3 results (2026-07-07): data_level=2, 10K, static-compaction A/B, code-agent 10K

Oracle-mode accuracy (/74 truth-subset; note the string-approx metric has ±1-2 task
LLM-judge variance, so treat small absolute gaps cautiously — the compaction A/B is
paired and robust):

| SUT | acc (/74) | $/task | cache% |
|---|---|---|---|
| Delta5k baseline (d1, flag off) | 74.3% | $0.054 | 82% |
| **Delta5k + static COMPACT** | **68.9%** | **$0.066** | **73%** |
| Latest10k + d2 | 71.6% | $0.061 | 80% |
| Delta10k + d2 | 67.6% | $0.061 | 76% |
| CodeAgent 10k guided | 66.2% | $0.063 | 78% |

**1. Static compaction A/B — BACKFIRED (headline).** Paired on 104 tasks: −4 accuracy
(broke 6 incl. legal-hard-1 — the analysis's top "safe fold" — env-hard-7/8,
legal-hard-8/22, env-easy-6; fixed 2), and +22% cost. Mechanism: DELTA is 82%
prompt-cached; folding rewrites the cached prefix every turn (cache 82%→73%), so raw
tokens stay flat but billed cost rises, while the fold perturbs downstream reasoning.
The static token-savings estimate (~74k, ~0 risk) was a counterfactual that assumed a
fixed trajectory and uncached billing — both false live. **Lesson: compaction on a
prompt-cached agent is counterproductive; the cache already compacts for free.**
See compaction-static-rule.md for the full A/B table.

**2. data_level=2 recovery (Output Table profile).** Ran the d1 5K failures at d2:
LATEST recovered 2/22 (legal-easy-19, legal-hard-22), DELTA recovered 1/19
(legal-hard-15 — the `duplicate rows:` fact drove the dedup, the intended mechanism).
Modest but real; the profile helps a few dedup/units cases, no free lunch.

**3. 10K + d2 did not help.** Latest10k+d2 (71.6%) and Delta10k+d2 (67.6%) are at or
below the 5K d1 baseline (~74%) and cost more ($0.061 vs $0.054) — a bigger result
window + structural profile bought nothing here (consistent with the earlier
leaner-LATEST finding: more context ≠ more accuracy).

**4. CodeAgent 10k guided: 66.2% / $0.063** — in line with the 5k guided arm; the
larger stdout cap didn't move it.
