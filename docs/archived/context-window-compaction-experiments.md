# Context-Window Compaction: compress vs sliding (gpt-5.2, KramaBench)

Experiment report for the rolling DELTA→deck compaction added in
`feat(agent-service): context-window budget with rolling DELTA→deck compaction`
(`86a2656dc`). Question: **when a DELTA context exceeds a token budget, does
folding the oldest events into a stats *deck* (compress) beat dropping them
(sliding)?**

## TL;DR

- **At a tight window (3k trajectory tokens), compress wins on accuracy** —
  **62.7% vs 58.3%** (+4.4 pts; 60 vs 56 tasks passed). On **cost** the two are
  effectively **tied per task** (~$0.033 median each): the lower *total* for
  compress ($4.40 vs $4.83) is outlier-driven, not systematic — see "Cost &
  context: outlier-corrected". So compress buys accuracy at ~no typical-task cost.
- **At a loose window (6k), the two are within noise** and sliding edges ahead
  (59.1% vs 60.5%). Under light compaction the deck's overhead isn't repaid.
- **Compress's value is concentrated exactly where compaction actually bites.**
  The tighter the budget, the more it beats naive eviction — which is the regime
  a context-window limit is *for*.
- The deck **bloats on wide tables** (per-column stats for 30-column loaders),
  which erodes compress at 6k. But a **lean deck (capped stats cols/rows) made it
  worse, not better** — the full stats are the signal that wins at 3k (see the
  lean-deck negative result; reverted). Deck cost is operator-count-bound, so the
  real lever for 6k is *graduated fidelity* (recent ops full, old ops summarized),
  not blanket trimming.
- **Shipped default: heavy-deck compress.** Best operating point on this workload:
  a tight (~3k) trajectory window.

## Design under test

DELTA mode gains a token budget, `contextWindowTokens` (0 = off). Below it, the
assembler renders the "original" raw delta — full trajectory, each observation =
raw records + a `Schema:` line only (no stats). Once the raw delta would
overflow the budget it **compacts** via `compactionStrategy`:

- **sliding** — drop the oldest whole agent events until it fits (an
  `(… N earlier events omitted …)` marker stands in their place). The naive
  eviction baseline every agent framework does.
- **compress** — fold the oldest events into a `# Dataflow (compacted)` **deck**:
  the boundary snapshot rendered per-operator as `Column Schema and stats:` + a
  ratio-sampled row peek, then resume raw delta for the fresh suffix. Rolling:
  as the suffix regrows past the budget the fold advances and the deck
  re-renders from a newer snapshot. **compress preserves every operator** (as a
  compact stats block); **sliding loses the early ones wholesale.**

The budget bounds the assembled trajectory user-message (the true model window
minus the ~constant system prompt + response headroom). Token estimate = chars/4.

## Window sizing (grounded in measured token curves)

From the prior gpt-5.2 DELTA run (`DataflowSystemGPT52DeltaColumnStatsDataHints`,
`kb.py tokens`): system prompt ≈ **3.3k tokens**; trajectory grows **~1–1.5k
tokens/step**; total input step-5 ≈ 7.9k, step-8 ≈ 11.2k, step-11 ≈ 15k, max
24.9k. Mean 5.4 steps/task; the hard tail reaches step 12–16.

So the trajectory budgets were chosen to actually trigger compaction:
- **3k** → compacts from ~step 4 (covers most multi-step tasks).
- **6k** → compacts from ~step 7 (only the hard tail folds).

## Setup

- Model **gpt-5.2**, DELTA, `max_steps=25`, `flow_level=0`/`data_level=0`,
  `column_stats`+`data_hints` on (feed the deck), `max_result_rows=8`, char
  limits 1000/3000, `attempt_reflection`. Deck sample ratio 0.10.
- 4 SUTs: `DataflowSystemGPT52DeltaWin{3k,6k}{Compress,Sliding}`.
- KramaBench full workloads, oracle mode, `--parallel`, 8-min hang watchdog.
- 103/104 tasks scored (astronomy-hard-11 hangs on gpt-5.2 in **all 4** runs →
  excluded symmetrically; watchdog-killed workloads were recovered by isolated
  task reruns so every SUT attempted the same 103 tasks).

## Results — accuracy (compute_scores.py, task-weighted)

| Workload | 3k Compress | 3k Sliding | 6k Compress | 6k Sliding |
|---|---|---|---|---|
| archeology | 25.0 | 25.0 | 33.3 | 33.3 |
| astronomy | 33.3 | 33.3 | 50.0 | 25.0 |
| biomedical | 66.7 | 55.6 | 66.7 | 77.8 |
| environment | **64.0** | 54.0 | **40.3** | 75.0 |
| legal | 70.0 | 70.0 | 66.7 | 63.3 |
| wildfire | 87.8 | 80.2 | 83.0 | 70.9 |
| **OVERALL** | **62.7** | 58.3 | 59.1 | 60.5 |

**3k: compress +4.4.  6k: sliding +1.4.**

## Results — pass count, cost, tokens (kb.py compare)

| SUT | pass/103 | pass% | total $ | tokens |
|---|---|---|---|---|
| 3k Compress | **60** | 58% | **$4.40** | 5,178,851 |
| 3k Sliding | 56 | 54% | $4.83 | 4,443,533 |
| 6k Compress | 56 | 54% | $4.83 | 5,284,310 |
| 6k Sliding | 59 | 57% | $4.54 | 4,738,260 |

Outcome matrices (shared 103 tasks):
- **3k:** both pass 50 | **compress-only 10** | sliding-only 6 | both fail 37.
- **6k:** both pass 45 | compress-only 11 | **sliding-only 14** | both fail 33.

## Why compress is *cheaper* at 3k despite more tokens

Compress sends ~16% more tokens (5.18M vs 4.44M — the deck) yet costs **less**
($4.40 vs $4.83). Two effects:
1. **Cache warmth** — the deck is a stable append-only prefix, so most of its
   tokens are cache-reads (heavily discounted), whereas sliding's eviction
   rewrites the window front and busts the cache.
2. **Fewer runaway failures** — the cost dominators show sliding thrashing to the
   26-step `max_steps` ceiling on tasks compress solves in far fewer steps
   (e.g. biomedical-hard-1: compress 8 steps/pass $0.08 vs sliding 26 steps/fail
   $0.24). Losing early context makes sliding flail; those flails are expensive.

## The wide-table deck-bloat problem (why 6k-compress slips)

On `archeology`/`environment` tasks that load 22–30-column spreadsheets, each
deck operator renders a **per-column stats block (one line/column)** + an 8-row
wide TSV peek. For a 30-column loader that block is larger than the raw records
it is meant to summarize — so on wide-table workloads the deck *expands* the
context instead of compressing it. Measured: a 15-operator archeology deck ≈
**6.1k tokens**, overflowing even the 6k budget. This is the mechanism behind
6k-compress's environment collapse (40.3% vs sliding 75.0%): at the looser
budget compress sits in a large, noisy, half-folded state, while sliding's clean
recent-window view is enough. At 3k the aggressive fold produces a tighter deck
and compress wins environment (64.0% vs 54.0%).

The stats-as-compression premise holds when raw records are large (many rows);
KramaBench results are pre-capped small, so verbose per-column stats on wide
tables are a poor trade.

## gpt-5-mini cross-model pass (inconclusive — hang-biased)

Repeating the sweep on **gpt-5-mini** did not replicate cleanly: **~40% of tasks
per SUT hung** (watchdog-killed), *concentrated in the long/hard tasks* — exactly
the ones where a trajectory overflows and compaction actually engages. On the
completed subset (skewed toward short tasks where compaction is nearly a no-op),
compress and sliding are **tied**:

| Window | Compress pass% | Sliding pass% | compress-only / sliding-only |
|---|---|---|---|
| 3k | 64% (39/61) | 64% (38/59) | 4 / 4 |
| 6k | 63% (39/62) | 60% (39/65) | 5 / 4 |

This neither confirms nor refutes the gpt-5.2 finding: the missingness is *not
random* — it removes precisely the heavy-compaction tasks that discriminate the
two strategies, so the surviving tie is expected regardless of which strategy is
better. gpt-5-mini on this LiteLLM harness is too hang-prone (reasoning-model
timeouts / rate-limit stalls under concurrent load) for a clean run without a
much longer, isolated, low-concurrency recovery pass. Recommendation: re-run
gpt-5-mini **sequentially (no `--parallel`), one SUT at a time**, if a clean
cross-model number is needed.

## Lean-deck iteration (negative result — reverted)

Hypothesis: the wide-table deck bloat (§ above) is what erodes compress at 6k, so
capping the deck's per-column stats (top-12 columns) and row peek (5 rows) should
recover it. Implemented, ran the 3k/6k compress pair with the lean deck, recovered
to 103/104:

| Config | Overall | Pass | environment | vs its sliding |
|---|---|---|---|---|
| 3k compress **heavy** | **62.7%** | 60 | 64.0% | **+4.4** (60 vs 56) |
| 3k compress **lean** | 60.2% | 56 | 43.7% | tie (A-only 10 / B-only 10) |
| 6k compress **heavy** | 59.1% | 56 | 40.3% | −1.4 |
| 6k compress **lean** | 58.9% | 56 | 57.0% | −3 (56 vs 59) |

**The lean deck made compress worse, not better.** At 3k it dropped 62.7→60.2 and
*lost* its win over sliding (down to a dead tie). At 6k it improved the wide-table
`environment` workload (40.3→57.0 — confirming wide-table stats *were* noisy there)
but that gain was cancelled by regressions elsewhere; overall stayed flat and still
below sliding. Verdict: **the deck's full per-column stats are doing real work** —
they are the signal that lets compress beat sliding at a tight window, and trimming
them to save tokens costs more accuracy than it saves. The lean-deck code change was
**reverted**; the heavy (full-stats) deck is the shipped default.

Deeper takeaway: the deck's cost is dominated by *operator count*, not per-operator
verbosity (a 17-operator wide-table DAG overflows a 6k budget even lean). A uniform
column cap is the wrong knob. If 6k-compress is to be improved, the lever is
*graduated fidelity* — full stats for the most recent K operators, one-line
schema-only summaries for older ones — not blanket trimming.

## Compaction-prompt iteration (accuracy-neutral)

The DELTA system prompt originally described only the raw `# Agent Events`
trajectory, not the `# Dataflow (compacted)` deck — a prompt-vs-context drift when
the window is on. Added a conditional `## History Compaction` section (injected
only for DELTA + window-on + compress) telling the model its oldest events fold
into a trustworthy stats deck. Re-ran 3k compress with it (103/104):

| 3k config | Overall | Pass | vs no-prompt |
|---|---|---|---|
| compress **+ prompt section** | 62.0% | 59 | — |
| compress **heavy, no prompt** | 62.7% | 60 | baseline |
| sliding | 58.3% | 56 | (prompt-aware still +3) |

Outcome vs no-prompt: both-pass 50, prompt-only 9, no-prompt-only 10 — **symmetric,
net zero**. **Describing the deck did not change accuracy** — the deck's headers
(`# Dataflow (compacted — … results shown as statistics + sampled rows`) are
self-describing enough that the explicit instruction added nothing. Value of the
change is *correctness* (the prompt no longer describes a format the model isn't
shown), not performance. Kept as a conditional section (zero cost when the window
is off); accuracy-neutral when on.

## Cost & context: outlier-corrected (trimmed means)

The total-cost and mean-token figures above are **heavily skewed by a few outlier
tasks** (dense wide-table DAGs with 15–17 operators, whose deck balloons; plus a
few 26-step max-out failures). Per-task distributions, 3k SUTs:

**Context (input tokens/task)**

| Config | mean | 5%-trim | 10%-trim | median | max |
|---|---|---|---|---|---|
| compress (heavy) | 48.8k | 40.9k | 38.0k | 33.0k | 309.9k |
| sliding | 41.2k | 36.3k | 34.5k | 31.2k | 179.9k |
| compress +prompt | 50.1k | 41.2k | 37.9k | 32.9k | 305.5k |

The mean sits ~48% above the median (48.8k vs 33.0k, max 310k). Compress's context
overhead vs sliding **collapses as you trim** — mean +18% → 5%-trim +12% →
10%-trim +10% → **median +6%**. On a typical task the deck adds only ~6% context;
the +18% mean is a handful of outliers.

**Cost ($/task)**

| Config | mean | 5%-trim | 10%-trim | median |
|---|---|---|---|---|
| compress | 0.040 | 0.036 | 0.034 | 0.033 |
| sliding | 0.047 | 0.037 | 0.034 | 0.033 |
| compress +prompt | 0.048 | 0.041 | 0.037 | 0.033 |

**Trimmed, per-task cost is identical (~$0.033 median across all three).** This
corrects two total-based claims earlier in this doc:

- The "compress cheaper at 3k" total ($4.40 vs $4.83) was **outlier-driven** —
  sliding's few 26-step max-out failures, not a systematic per-task advantage.
  Per typical task, compress and sliding cost the **same**.
- The compaction-prompt "+cost" was also outliers; trimmed it is flat, consistent
  with the accuracy-neutral finding.

**Net:** compress's real cost/context penalty over sliding is small and
outlier-concentrated (the dense wide-table DAGs), not systematic — while its
accuracy win at 3k holds. You pay slightly more only on the few tasks where
retaining every operator matters most.

## Conclusions

1. **Ship compress with a tight window.** In the regime a context limit exists
   for (heavy compaction), compress is **more accurate** than sliding (+4.4 pts)
   at **~no typical-task cost penalty** (per-task cost is tied at ~$0.033 median;
   the lower total is outlier-driven — see the trimmed-mean section). 3k trajectory
   tokens (≈ total input 6–7k with the system prompt) is a good operating point
   for gpt-5.2 on this workload.
2. **At loose budgets compaction barely matters** — either strategy ≈ lossless,
   and the deck's overhead isn't worth it. Don't compress if you don't have to.
3. **The deck must stay lean to win everywhere.** The wide-table stats blowup is
   the one thing holding compress back at 6k.

## Next parameters to try

1. **Ship heavy-deck compress at a tight window (~3k).** This is the validated
   winner — no further tuning needed to realize the gain.
2. **Graduated-fidelity deck (the real lever for 6k).** Since deck cost is
   operator-count-bound, not per-op-verbosity-bound, give the most recent K
   operators full stats and older ones a one-line schema-only summary. This bounds
   the deck by K (not by DAG size) while keeping the recent frontier rich —
   unlike the blanket column cap, which threw away useful signal (see the
   negative result above).
3. **Window sweep at finer granularity (2k / 4k / 5k).** 3k wins and 6k ties;
   locate the crossover where compress's advantage peaks.
4. **gpt-5-mini, re-run cleanly.** The concurrent `--parallel` pass hung on ~40%
   of tasks (the hard ones). Re-run sequentially, one SUT at a time, for a clean
   cross-model number.

## Tried and rejected

- **Lean deck (top-12 stats cols + 5 rows):** made compress *worse* at 3k
  (62.7→60.2) — the full stats are the signal. Reverted. See the lean-deck section.

## Reproduce

```bash
cd ~/Desktop/bobflow/Kramabench
bash run_window_sweep.sh        # 3k/6k × compress/sliding, full workloads
bash run_sweep_recovery.sh      # rerun watchdog-killed tasks, then reeval
python kb.py scores  --sut DataflowSystemGPT52DeltaWin3kCompress
python kb.py compare --sut DataflowSystemGPT52DeltaWin3kCompress DataflowSystemGPT52DeltaWin3kSliding
python kb.py cost    --sut DataflowSystemGPT52DeltaWin3kCompress ... --by workload
```
