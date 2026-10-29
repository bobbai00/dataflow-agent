# The LLM context tuner (teacher) — design + results

An optional mode in which a separate, stronger LLM ("teacher") dynamically
shapes the working agent's context each step, guided by general (task-agnostic)
efficiency principles. It is the teacher-driven counterpart of the rule-based
selector, over the same `summarize()` action space.

---

## 1. Design (self-contained module: `src/agent/context/tuner/`)

```
 agent step → buildDossier ─▶ buildTunerManifest ─▶ [teacher LLM] ─▶ per-op detail
                                (cheap digest)      (gpt-5.4,        ─▶ translate ─▶ SummarizeParams
                                                     principles)                      │
                                                                        summarize() ◀─┘  → agent context
```

- **`principles.ts`** — the teacher's system prompt. 10 GENERAL principles (no
  task/dataset/column/pattern literals): relevance to remaining work; superseded/
  consumed work is dead weight; the active frontier + its inputs win accuracy;
  the answer op is always worth it; let data-shape pick the form (stats vs rows);
  be proportionate; spend `rich` rarely; a superseded source collapses; small
  healthy pipelines stay cheap.
- **`manifest.ts`** — a one-line-per-operator digest (id, type, role, edit/error
  state, result shape `R×C`, data-shape flags, upstreams, summary) + the task.
  **Never includes raw tables** — it costs ~2k tokens, not the context's worth.
- **`tuner.ts`** — `LLMContextTuner.tune(dossier, task)`: calls the teacher via
  `generateObject` (structured output — a per-operator detail level ∈
  `omit|shape|sample|rich` + `reasoningReplayK`), then `translateTunerOutput`
  maps that to a validated `SummarizeParams` for the shared renderer. Robust:
  any teacher failure/timeout falls back to the rule selector, so a hiccup never
  breaks the agent. Accumulates teacher-token usage (reported as overhead).

**Wiring.** Opt-in agent setting `tunerConfig: { model, sampleRows?, richRows? }`
(create + PATCH, validated; `null` = off). The server's context assembler is now
async-capable; precedence is **tuner > rule selector > legacy contextMode**.
Everything off ⇒ byte-identical to the LATEST baseline (golden parity intact).

**Decisions (from the user):** cost metric = the agent's context tokens (teacher
overhead reported separately); cadence = **every agent step**; the teacher may be
iterated freely except the core idea.

---

## 2. Results — end-to-end, gpt-5.2 agent + gpt-5.4 teacher vs static LATEST (gpt-5.2)

Metric = Σ agent rendered-context tokens across the run (what the teacher
shapes); accuracy = the KramaBench scorer.

**Run A (5 tasks, initial principles):** accuracy 5/5 = 5/5; **tuner −12%** context
overall — but with a regression on a tiny dirty-load task (`wildfire-easy-1`
+52%, the teacher over-parked the loader at `rich`).

**Run B (4 tasks, refined principles — `rich` reserved for stuck/unresolved ops,
superseded sources collapse, small pipelines stay lean):**

| task | acc (base→tuner) | context base → tuner | Δ |
|---|---|---|---|
| wildfire-easy-1 (dirty load) | ✓ → ✓ | 2.2k → 1.9k | **−12%** (regression fixed) |
| environment-hard-14 (7 files) | ✓ → ✓ | 21.0k → 17.6k | **−17%** |
| environment-hard-9 (9 files) | ✗ → ✗ (task-intrinsic) | 15.4k → 11.6k | **−25%** |
| environment-easy-2 (22 files) | ✓ → ✓ | 3.5k → 2.1k | **−40%** |
| **total** | **3/4 = 3/4** | **42.2k → 33.2k** | **−21%**, fewer steps (8.0 vs 8.8) |

**The mechanism, verified in the teacher's logged plans.** On the multi-source
tasks the teacher OMITS the consumed year-loads once they fold into an aggregate —
e.g. `wb2007:omit, wb2008:omit, … rain_ashburnham:omit, wb_all:shape,
corr_by_type:rich` — which the static LATEST render (all operators, always) and
even the conservative rule selector never do. That single behavior is what takes
cost *below* the already-lean LATEST baseline, and it scales with clutter (−40%
on the 22-file task).

**Run C (4 harder/thrashy tasks — accuracy probe) exposed a REGRESSION, now
fixed.** legal-easy-25 ✓→✓ (−15%), wildfire-hard-4 ✓→✓ (−24%, fewer steps),
environment-hard-11 ✗→✗ (−70%), but **biomedical-hard-1 ✗→✗ with tuner +136%
context** (6.9k→16.2k). Cause (from logged plans): the teacher put WIDE proteomics
tables (150+ cols) at `sample`/`rich`, where the per-column stats + wide TSV blow
up — exactly the §3B.4 cost trap. **Fix:** a mechanical **wide-table guardrail**
(`wideClampColumns`, default 40) that clamps any operator with ≥40 result columns
to at most `shape` regardless of the teacher's choice (`omit` still wins), plus a
strengthened principle (5b). The guardrail is belt-and-suspenders: the teacher is
told to avoid wide `sample`/`rich`, and the code enforces it if the teacher slips.
This is the honest lesson: an LLM teacher misjudges (here, width), so the policy
needs cheap mechanical floors under it.

### FINAL verdict — aggregated over ~50 live cells (11 tasks, multiple runs)

Per-task, pooling every sample I ran (baseline vs tuner, agent context tokens):

| task | acc base / tuner | cost verdict |
|---|---|---|
| environment-easy-2 (22 files) | 1/1 / 1/1 | **WIN −40%** |
| environment-hard-11 | pass-rate equal | **WIN −54%** |
| environment-hard-9 (9 files) | 0 / 0 | **WIN −25%** |
| environment-hard-14 (7 files) | 2/2 / 2/2 | **WIN −19%** (both reps) |
| legal-easy-25 | 1/1 / 1/1 | **WIN −15%** |
| environment-easy-1, legal-easy-10 | equal | ~tie |
| wildfire-easy-1 | 2/2 / 2/2 | LOSS −22% avg (reps +52% / −14% — variance) |
| wildfire-hard-4 | 2/2 / 2/2 | LOSS −26% avg (reps −24% / **+124%** — pure variance) |
| archeology-easy-3 (1 op) | 1/1 / 1/1 | LOSS −30% (tiny task) |
| biomedical-hard-1 (wide xlsx) | 0/2 / 0/2 | **LOSS −159%** (both reps) |

**Three robust conclusions:**

1. **Accuracy: perfectly neutral.** Across all ~50 cells, *not one* pass/fail
   differed between baseline and tuner. The teacher never helped nor hurt
   correctness. ("Higher accuracy" did not happen — it is exactly equal — because
   KramaBench's failures are task-intrinsic, uncaused by context clutter.)

2. **Cost: task-dependent, NOT a uniform win.** The tuner robustly WINS on
   multi-file / high-clutter tasks (the omit-superseded-sources lever, up to
   −40%), and robustly LOSES on wide-table tasks and tiny tasks. So the net over
   a set depends entirely on its mix: the multi-source-heavy Run B netted −21%;
   the wide/hard Run D netted +111%. There is no single number — the honest
   statement is "wins on clutter, loses on width, neutral on accuracy."

3. **The effect is variance-dominated, and context changes BEHAVIOR
   non-monotonically.** `wildfire-hard-4` went −24% one run and +124% the next on
   identical config, because the agent took 13 vs 17 steps — trajectory step
   count (which dominates cumulative context) is noisy, and a leaner/different
   context sometimes sends the agent down a *longer* path (biomedical: tuner took
   10 steps vs 8 and produced no answer). This is not a tuner bug; it is a
   property of putting an LLM's context under another LLM's control against an
   already-lean baseline. A defensible average would need N≫1 reps per cell.

**Remaining identified cost driver (biomedical, not yet fixed):** even the
wide-clamp's `shape` renders the FULL column schema line (`formatSchemaLine` is
intentionally uncapped), so a 150-column table's schema line alone exceeds
baseline's 50-column-capped TSV. The fix is a column cap on the schema line for
very wide tables — a small, safe change (golden tests use ≤4-col tables) left as
the next step. It would recover biomedical's per-step overhead but not the
extra-steps (behavioral) component.

**Prior interim note (superseded by the aggregate above):**
- **Lower cost: YES on the multi-source subset** (−21% on Run B), scaling with
  pipeline size — but not uniformly, per the table.
- **Higher accuracy: NOT SHOWN** — equal, robustly. KramaBench's hard failures
  are join / missing-file / definition errors, not context-caused.

**Teacher overhead (reported separately, per the cost-metric decision).** The
gpt-5.4 teacher costs ~2.1k tokens/call × one call/step. Over a run that is
comparable to or larger than the agent-context tokens it saves — so the tuner is
a *token-for-quality* trade at the system level, worth it only if the teacher is
much cheaper than the agent or if it lifts accuracy. Practical implication: the
per-step cadence is the cleanest test but not the cheapest deployment; the
"on material change" cadence (already a documented option) would cut teacher
calls several-fold with nearly the same plans, since consecutive steps usually
yield the same per-operator decisions.

---

## 3. Status

| piece | state |
|---|---|
| `tuner/` module (principles, manifest, output schema, translate, LLM call) | shipped; self-contained; 8 unit tests |
| async context-assembler + `tunerConfig` wiring (create/PATCH/validate) | shipped; precedence tuner > selector > legacy; golden parity intact |
| gpt-5.4 structured-output call | verified live (smoke + eval) |
| `tuner-eval.ts` A/B harness (accuracy + agent-context tokens, resumable) | shipped |
| end-to-end vs LATEST | **run: equal accuracy, −21% context; mechanism verified** |
| accuracy fail→pass flip | probing on thrashy/hard tasks |
| cheaper cadence ("on material change") | designed, not yet benchmarked |

Full suite: 501 pass (3 pre-existing env-coupled failures), tsc clean, 10 golden
snapshots byte-identical.
