# Business-domain campaign — layout A/B at full domain scale (2026-08-14)

12 business tasks, 411 turns per arm, one rep each, judged by the paper's own
judge (deepseek-v4-pro via OpenRouter). Arms: `luna-biz-session`
(`# Session` push baseline) vs `luna-biz-v32-fix` (versioned `# Catalog` +
operator-level recall + fixed environment), byte-identical observation channel,
both served by one agent-service build on :3005, same era by construction
(pools interleaved). Analysis scripts referenced here live in the worktree's
`logs/` (gitignored scaffolding): `latency_decompose.py`, `write_census.py`,
`step_tokens.py`, `arm_stats.py`, `cascade_split.py`, `prefix_stability.py`.

## Headline

|                | turn-weighted | task-macro | cost | wall | judged |
|---|---|---|---|---|---|
| session        | 17.98 | 18.12 | $32.77 |  8.4 h | 406/411 |
| v32-fix        | 19.31 | 19.35 | $23.00 | 15.3 h | 404/411 |

## Is the difference real? (paired statistics, same 411 turns)

* **Accuracy: a tie, now with error bars.** 399 turns judged in both arms;
  discordant 51 (session-only right 23, v32-only right 28); McNemar exact
  **p = 0.576**. Task-level bootstrap on the macro delta:
  **+1.17 pts, 95% CI [−3.1, +5.4]**. No detectable accuracy effect at
  411-turn scale.
* **Cost: real.** Cheaper on 10/12 tasks (sign test **p = 0.039**), median
  per-task ratio 1.63×, total 1.42×. Cost per correct answer $0.449 → $0.295.
* **Wall-clock: real, the other way.** Slower on 12/12 tasks, ~1.8× total.
* Per-task accuracy deltas span −12.5 to +15.2 — the cascade lottery, exactly
  as the sports/education campaigns measured it. Nothing task-level is
  attributable at n=1.

## Why is the catalog arm slower — engine or LLM? Neither. It does 2× the steps.

Per-step timestamps decompose every between-step gap into LLM generation
(fit on tool-free steps: ~1.6 s base + ~6 s/1k output tokens) plus tool
execution attributed to the preceding step's calls:

|                        | session | v32-fix |
|---|---|---|
| LLM steps/turn         | 4.1     | **8.0** |
| engine time per write  | 14.8 s  | **14.8 s** (identical) |
| recallState per call   | —       | 0.9 s (0.17 h total — free) |
| LLM time total         | 3.0 h   | 6.0 h |
| engine (write) time    | 5.3 h   | 9.1 h |
| write-steps            | 1,262   | 2,188 |
| distinct operators     | 1,096   | 1,691 (+54%) |
| revisions              | 362     | 778 (+115%) |
| write rejections       | 8       | 73 (2.9% — not the driver) |
| uncached input/step    | 74 k    | 26 k (2.8× smaller) |

The engine is not slower and the LLM is not slower per step. The catalog arm
**writes 1.7× more operators** — state renders once at creation, so to see a
value later the model either recalls it (cheap, and it does: 1,865 pulls,
98.6% requesting values) or **re-materializes it by building and revising
operators** — and it does that heavily. Each such write costs one ~6 s LLM
round-trip plus 14.8 s of engine execution.

The economics, stated once: **token cost scales with prompt bytes; wall-clock
scales with step count.** The catalog shrinks prompts 2.8× (cheaper) and
doubles steps (slower). The session layout is the mirror image. Neither is
"the fast one" — they sit on opposite ends of one trade.

## Prompt caching is broken for both arms, and it is the largest cost lever found

`cachedInputTokens` is a constant per step — p50 = p90 = 5,409 (session) /
7,043 (v32) — i.e. only the system prompt + tool definitions ever cache,
reproducing the "~6k fixed" finding from the earlier campaigns. But measured
prefix stability between consecutive steps is **96.9–98.8%** on a 254 kB
single-user-message prompt: the prefix the provider could cache is there. If
provider-side prefix caching engaged, the session arm's input bill (123 M
uncached tokens ≈ $24.60 of its $32.77) would drop 5–10×, **which would
reverse the cost comparison between layouts**. This is a gateway/provider
issue (LiteLLM → `openai/gpt-5.6-luna`), not a render issue: no prompt change
can fix it, and any render conclusion about cost is provisional until it is
either fixed or shown impossible.

## Where the failure mass actually is (gold-based taxonomy)

Using the benchmark's own gold answers over every wrong turn:

* **93–94% of wrong turns declare a dependency on an already-wrong turn**;
  fresh errors (all upstreams right) are 5–6%; median first-error turn is
  2–3. Accuracy per arm is set by roughly a dozen early derivation events.
* Numeric overlap with gold (share of gold's numbers present in our answer,
  4-decimal): only **7–9%** of wrong turns are ≥80% overlap — the
  "state right, answer lost on representation/fields" class. **65–70%** are
  <40% overlap: the numbers genuinely diverged upstream. Presentation fixes
  cap out at a ≤9% slice; the cascade root is the ceiling for everything.
* The two all-zero-looking outliers decompose cleanly:
  `goodbooks_10k` t1 built the pool **exactly right** (top-5 book_keys and
  review_scores match gold to 3 decimals) and lost on reporting weighted
  contributions where gold reports raw percentiles; t2's "relative demand"
  formula then diverged and 33 dependent turns inherited it.
  `nyc/task3` t2 is the one confirmed **layout-caused** flip: v32 recalled
  three t1 versions including the full early-pressure list, then wired its
  computation to the recalled 5-row `top5_pressure` display table; the session
  arm, with t1's full log in view, recomputed from the base table and matched
  gold on all five rows. Pull-based context makes the small named artifact
  salient — retrieval anchoring.

## Verdict on "worth it"

The v32 catalog, as shipped, buys a statistically real ~1.4–1.6× cost
reduction, costs a statistically real ~1.8× wall-clock increase, and does not
move accuracy. Choose by which resource binds. Neither layout touches the
thing that sets the score: first-error rate on turns 1–3.

## What to build next (general mechanisms only, ordered by expected value)

1. **Fix prompt caching at the gateway** — infra, layout-independent, the
   single largest cost lever measured, and a prerequisite for honest cost
   comparisons between layouts.
2. **Verification at state creation** — 93–94% of wrong turns inherit. Every
   render experiment across three campaigns is accuracy-null; this is the only
   mechanism aimed at the root. General form: operators that later turns
   consume state their **population facts** (rows in, rows qualifying,
   denominator used) as observation lines, and foundational quantities get a
   second independent derivation with disagreement surfaced as a decision.
3. **Step-count reduction for the catalog arm** — wall-clock ∝ steps.
   Batch `recallState` (accept `refs: [...]`, one step) and keep multi-call
   steps first-class. Free pulls are already free; the step *around* them is
   not.
4. **Conditional value panes (hybrid push/pull)** — push sample rows inline
   for exactly: operators the current request references, outputs of declared
   dependency turns, and base tables; everything else stays catalog + recall,
   under a byte budget. Attacks both the extra-writes wall-clock mechanism
   (less re-materialization) and retrieval anchoring (the true population is
   in view). Off by default, byte-parity when off.
5. **Data-scaled turn budgets** — `goodbooks` v32 died at turn 1 on a 2,400 s
   budget while loading a 45 MB inventory (session did the same turn in
   1,206 s; every later turn inherits an empty foundation). Scale the per-turn
   budget by the task's file-inventory size instead of a constant.
6. **Raw-over-derived reporting rule** (one prompt line: report the raw
   component and the weight, not the product) — small, general, but capped by
   the ≤9% representation slice.
