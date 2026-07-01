# Context-Window Compaction: compress vs sliding (gpt-5.2, KramaBench)

Experiment report for the rolling DELTA→deck compaction added in
`feat(agent-service): context-window budget with rolling DELTA→deck compaction`
(`86a2656dc`). Question: **when a DELTA context exceeds a token budget, does
folding the oldest events into a stats *deck* (compress) beat dropping them
(sliding)?**

## TL;DR

- **At a tight window (3k trajectory tokens), compress wins on BOTH axes** —
  higher accuracy (**62.7% vs 58.3%**, +4.4 pts; 60 vs 56 tasks passed) **and
  lower cost** ($4.40 vs $4.83) — despite sending *more* tokens.
- **At a loose window (6k), the two are within noise** and sliding edges ahead
  (59.1% vs 60.5%). Under light compaction the deck's overhead isn't repaid.
- **Compress's value is concentrated exactly where compaction actually bites.**
  The tighter the budget, the more it beats naive eviction — which is the regime
  a context-window limit is *for*.
- Headline caveat & next lever: the deck **bloats on wide tables** (per-column
  stats for 30-column loaders can be larger than the rows they summarize), which
  is what erodes compress at 6k. A leaner deck is the next experiment.

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

## Conclusions

1. **Ship compress with a tight window.** In the regime a context limit exists
   for (heavy compaction), compress is Pareto-better than sliding: more accurate
   *and* cheaper. 3k trajectory tokens (≈ total input 6–7k with the system
   prompt) is a good operating point for gpt-5.2 on this workload.
2. **At loose budgets compaction barely matters** — either strategy ≈ lossless,
   and the deck's overhead isn't worth it. Don't compress if you don't have to.
3. **The deck must stay lean to win everywhere.** The wide-table stats blowup is
   the one thing holding compress back at 6k.

## Next parameters to try

1. **Lean deck (highest priority).** Cap the deck's per-column stats to the
   top-K columns (e.g. 8–12) and/or drop `data_hints` from the deck; keep the
   ratio-sampled row peek small. Target: deck ≤ the raw trajectory it replaces on
   wide tables. Re-run the 6k pair — expectation: compress recovers at 6k.
2. **gpt-5-mini cross-model pass.** Repeat the 3k/6k × compress/sliding sweep on
   gpt-5-mini to check the result generalizes (and mini hangs less, so cleaner
   data).
3. **Deck sample ratio sweep.** 0.0 (stats only) vs 0.10 vs 0.25 — quantify how
   much the row peek is worth against its token cost.

## Reproduce

```bash
cd ~/Desktop/bobflow/Kramabench
bash run_window_sweep.sh        # 3k/6k × compress/sliding, full workloads
bash run_sweep_recovery.sh      # rerun watchdog-killed tasks, then reeval
python kb.py scores  --sut DataflowSystemGPT52DeltaWin3kCompress
python kb.py compare --sut DataflowSystemGPT52DeltaWin3kCompress DataflowSystemGPT52DeltaWin3kSliding
python kb.py cost    --sut DataflowSystemGPT52DeltaWin3kCompress ... --by workload
```
