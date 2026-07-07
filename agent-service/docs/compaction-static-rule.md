# Static compaction rule (DELTA-only)

A deterministic, flag-gated compaction trigger for DELTA context mode, derived
from the Latest-vs-Delta 5K trace comparison. Its purpose is to **demonstrate
that folding settled trajectory history pays off** — it is intentionally simple
(ad-hoc thresholds), not a learned policy.

## Why DELTA, and why a trigger at all

At a 5000-char result limit, DELTA already beats LATEST on the long tasks because
LATEST re-renders the full snapshot every turn (token growth compounds with steps)
while DELTA only appends the per-step change. The saving is concentrated in
**long trajectories** — where both the thrash-saves and the both-right-cheaper
cases live:

| kind | task | LATEST | DELTA |
|---|---|---|---|
| thrash-save (D right, L wrong) | legal-hard-1 | 14 steps / 158k tok | 10 steps / 142k tok |
| thrash-save | biomedical-hard-7 | 7 / 65k | 6 / 31k |
| cheaper-both | wildfire-easy-2 | 12 / 159k | 8 / 78k |
| cheaper-both | wildfire-hard-4 | 12 / 115k | 6 / 56k |
| cheaper-both | environment-hard-19 | 8 / 98k | 4 / 40k |

But DELTA's own event log still grows linearly with steps, so on the long tail its
context also gets large. By mid-trajectory the earliest events are **settled** —
source loads and their consumed inspection scaffolds, resolved error attempts —
their facts already flow downstream into the kept snapshots. Folding them into a
compact `# Dataflow (compacted)` deck recovers the tail cost with no loss the agent
can act on. Short tasks (≤5 steps) show no such tail and folding there only risks
dropping still-relevant context — hence a trigger.

## The rule — a TOKEN trigger, not a step count

The 14-task trace analysis (workflow `wf_59287b8c`) was decisive that the trigger
must be the **rendered event-log token count, not step count**. Two reasons a
step-count trigger is wrong:

- **It misfires.** `biomedical-hard-7` is 6 steps but only ~1.1k tokens; its
  step-3 single-column sheet stats are the exact evidence that makes DELTA answer
  16 (not 15). A `>5 steps` rule would fold that block and flip the answer back to
  wrong. Accuracy regression.
- **It misses.** The biggest savers are *short*: `environment-hard-8` (5 steps,
  ~9.4k saved) and `environment-hard-15` (~6k) — a step gate set high enough to
  skip biomedical-hard-7 also skips these.

The token distribution has a **clean gap**: traces that must NOT fold peak at
~2.18k rendered tokens; genuine savers start at ~3.55k. So the trigger is a token
floor at **3,500**, which sits in the gap (~1.3k margin) and captures ~95% of the
savable tokens (~74k of 78k across the sample).

Behind the `staticCompaction` flag (DELTA mode only; ignored in LATEST and when an
explicit agent `compactContext` mark is present):

- **TRIGGER** — compact once the rendered lossless DELTA event log is **≥ 3,500
  tokens**. Self-guards short fast-converging traces (they never reach it).
- **KEEP** — keep the last **2** steps raw (recent working set); fold everything
  older into the compact deck.
- **GUARD** — do **not** compact while mid-error-recovery: if the newest agent
  step left any operator in an errored state, the agent is actively debugging and
  needs its recent raw attempts, so the rule holds off until the error clears.

Constants: `STATIC_COMPACT_TRIGGER_TOKENS = 3500`, `STATIC_COMPACT_KEEP_LAST = 2`
(`context-utils.ts`). Mechanism renders the lossless delta once to measure it,
then — if over the floor and past the guards — reuses the existing deck+raw-suffix
renderer (`renderAgentCompacted` / `renderCompressed`); `staticCompactionFoldMark`
only computes the fold boundary. Recomputed each turn (monotonic).

**Expected on the analysis sample:** fires on 9/14 traces, 8 realize savings
(~74k tokens total; biggest legal-hard-1 ~30k, biomedical-hard-1 ~16k,
environment-hard-8 ~9.4k), skips all 4 must-not-fire traces incl. the sole
accuracy-critical one. Known caveats: the sliding recompute busts the prompt-cache
prefix each turn (dollar savings trail raw-token savings, since 73–91% of input is
cached), and the 3,500 floor is tuned to KramaBench + gpt-5.2 with the current deck
verbosity — re-tune if the deck rendering changes.

## Wiring

`staticCompaction` travels the standard settings path: Kramabench `AgentSettings`
(`static_compaction` → wire `staticCompaction`) → server → `mapLegacyToParams`
(`params.trajectory.staticCompaction`) → `paramsToRenderOptions` → `renderContextCore`
DELTA branch. SUT `DataflowSystemGPT52DeltaStats5kCompact` is byte-identical to
`DataflowSystemGPT52DeltaStats5k` except the flag is ON, isolating its effect.

## Expected effect

Fold-at-safe-step on the long tasks (wildfire-easy-2, wildfire-hard-4,
environment-hard-19, legal-hard-1) recovers tens of thousands of tokens per task;
the guard keeps the thrash-recovery cases (legal-hard-1's error loop) intact until
resolved. Accuracy is expected neutral-to-slightly-positive (folding removes only
settled history). Verified empirically by the DeltaStats5kCompact vs DeltaStats5k
A/B (see compaction-case-analysis-gpt52.md, v3 section).
