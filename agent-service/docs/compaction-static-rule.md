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

## The rule

Behind the `staticCompaction` flag (DELTA mode only; ignored in LATEST and when an
explicit agent `compactContext` mark is present):

- **TRIGGER** — compact once the trajectory has **> 5** snapshot-bearing agent
  events. Below that the log is small and the tail benefit is nil.
- **KEEP** — keep the last **3** steps raw (the recent working set); fold
  everything older into the compact deck.
- **GUARD** — do **not** compact while mid-error-recovery: if the newest agent
  step left any operator in an errored state, the agent is actively debugging and
  needs its recent raw attempts, so the rule holds off until the error clears.

Constants: `STATIC_COMPACT_TRIGGER_STEPS = 5`, `STATIC_COMPACT_KEEP_LAST = 3`
(`context-utils.ts`). Mechanism reuses the existing deck+raw-suffix renderer
(`renderAgentCompacted` / `renderCompressed`) — the static rule only computes the
fold boundary from trajectory shape (`staticCompactionFoldMark`) instead of from an
agent mark or a token window.

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
