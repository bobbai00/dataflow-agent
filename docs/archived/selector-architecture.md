# The context selector — what we built, and how it positions for training

*Companion to `summarize-tuning-intuitions.md` (the corpus analysis). This doc
is the architecture + the road from the rule-based selector we just shipped to a
trained one.*

---

## 1. The arc, in one picture

Everything we've discussed is one pipeline, built bottom-up:

```
 (1) summarize(dossier, params)      ← ONE centralized renderer; LATEST/DELTA are presets
        ▲                               [context/summarize/*]  — SHIPPED, golden-parity proven
        │ params : SummarizeParams      the ACTION SPACE (per-operator × trajectory × flow knobs)
        │
 (2) selectParams(dossier, config)   ← the SELECTOR: a policy that emits params per step
        ▲                               [context/selector/*]   — SHIPPED, rule-based expert policy
        │ config : SelectorConfig       the small TRAINABLE action vector (~12 scalars)
        │ features : per-operator role/state/data-shape  [selector/features.ts]
        │
 (3) SelectorConfig* = argmax_config  Σ_tasks [ correct − λ·tokens ]   ← TRAINING (next)
                                        the tuner searches config; features + reward are ready
```

Each layer is independently testable and already wired end-to-end: set
`settings.selectorConfig` on an agent and every `prepareStep` runs
`buildDossier → selectParams → summarize`. The training layer (3) doesn't exist
yet — but layers (1) and (2) were built precisely so that (3) is *just an
optimizer over `SelectorConfig`*, with the features and the reward already
computable.

---

## 2. Why this is the right shape for a trainable selector

A naive "let the model/tuner pick 30 context flags" is a bad learning problem:
huge action space, most combinations invalid or redundant, reward mostly flat.
We reduced it to a good one through three deliberate moves:

1. **Orthogonal, typed action space (layer 1).** `SummarizeParams` is a zod
   schema where every combination is valid and renderable; there are no "flag X
   only means something if Y" traps for the tuner to waste capacity learning.

2. **A fixed rule skeleton, parameterized by a small vector (layer 2).** The
   selector's *structure* (role → detail; data-shape → which cheap signal;
   thrash → history) is fixed and corpus-justified. What's left to learn is a
   handful of scalars in `SelectorConfig`:

   | knob | what it trades | corpus-informed default |
   |---|---|---|
   | `sourceDecaySteps` | when a consumed source drops its rows | 1 |
   | `frontier/nearFrontier/terminal/unsettledSourceRows` | frontier detail budget | 12/6/30/12 |
   | `thrashHistoryThreshold` | when code/result history turns on | 3 |
   | `historyDepth` | how much history | 2 |
   | `categoricalMaxDistinct` | when stats replace rows | 12 |
   | `insurance` | Tier-2 alarms on/off | true |
   | `reasoningReplayK` | plan-memory depth | 8 |
   | `frontierIncludeCode` | show current code | true |

   This is a ~12-dim mostly-continuous box — searchable by grid / Bayesian opt /
   CMA-ES / bandit, or differentiable-free RL. The expensive part of the
   objective (§tuning-doc Tier-3) is concentrated in `frontierSampleRows` and
   `thrashHistoryThreshold`; the rest are safe.

3. **Reward is already measurable.** `correct` = the KramaBench scorer
   (`adapter.evaluate`); `tokens` = `summarize().breakdown.totalTokens` per step
   (or Σ rendered-context chars ÷ 4, which the `selector-e2e.ts` harness already
   reports). No new instrumentation needed to compute `correct − λ·tokens`.

---

## 3. What the selector encodes (the intuitions, as code)

`selector.ts::buildOverride` is the expert policy — the intuitions from the
tuning doc, made executable, per operator:

- **Tier-1 free lunches:** consumed source → `shape` (drop rows); blocked/deleted
  → `omit`; settled interior → `shape`. (§3A/§3D)
- **Tier-2 cheap insurance:** schema always; low-card categorical → `stats`;
  numeric-as-text → `valueFormatHints` + the new **dtype-anomaly** hint (surfaces
  the contaminant tokens that forced a string dtype — your "reload with more
  samples", done surgically); flow alarms on. (§3B/§3E)
- **Tier-3 the trade-off:** frontier gets `sample` + current code; a thrashing
  operator (edit-count ≥ threshold) gets code + result history. (§3C)

`features.ts` computes the state these rules read: operator **role**
(source/interior/frontier/near-frontier/terminal/blocked/deleted from the leaf
DAG + edit history), **thrash** (edit-count), **staleness** (steps-since-edit ×
has-healthy-consumer), and **data-shape flags** (wide / dirtyLoad /
categoricalLowCard / numericAsText) read from each operator's own result
annotations. These features are the shared substrate a *learned* policy would
consume too — swapping `buildOverride` for a network leaves everything else
intact.

---

## 4. The three ways to train it (increasing ambition)

All three reuse the exact same `features → config → summarize → reward` loop; they
differ only in how `config` (or its per-op generalization) is produced.

**(A) Config search — the immediate, cheap win.** Treat `SelectorConfig` as
hyperparameters; run the `selector-e2e.ts` sweep over the 26 thrashy / multi-file
tasks (where §tuning-doc says the tokens live); pick the config maximizing
`Σ(correct) − λ·Σ(tokens)`. This is a ~12-dim black-box optimization — a few
hundred task-runs with Bayesian opt / CMA-ES. Output: a better *global* config.
No model training. **This is the recommended first step** and needs only a driver
loop around the harness that already exists.

**(B) Pull-to-push distillation — the supervised route (needs the `inspectResult`
tool).** Add the on-demand result-inspection tool we discussed; let the agent
*pull* extra detail when the default render under-serves it; log every pull as a
labeled example "(state features) → (operator, column, detail) was needed."
Train a per-operator classifier `features → override` on those labels so the
*push* selector pre-renders what the agent would have asked for. This upgrades
`buildOverride` from hand-rules to a learned map while keeping the same interface.
The labels are free (a byproduct of running the agent) and directly optimize the
thing that matters: don't-make-the-agent-ask.

**(C) RL over the per-step policy — the full version.** State = per-operator
feature vectors + trajectory features; action = the per-op override menu choice
(a small discrete set per operator) + the global scalars; reward =
`correct − λ·tokens`, credit-assigned across steps. Initialize from the rule
policy (behavior cloning of `buildOverride`) so RL starts from a strong baseline
and only has to improve the Tier-3 margins. This is where the "let a smart model
decide whether to call summarize and with what params" idea fully lands — the
policy *is* that decision, learned.

The ladder is deliberate: (A) validates the reward and banks the free-lunch
savings with zero ML; (B) makes the policy data-driven using labels the agent
generates for free; (C) closes the loop with RL from a warm start. Each rung
de-risks the next.

### What we actually ran, per direction (§7)

- **(A) config search — DONE, verdict in §6.** The harness works and gave a
  clean answer: accuracy-safe, not cost-superior to LATEST as parameterized.
- **(B) pull tool — BUILT + PROVEN, distillation not yet trained.** `inspectResult`
  is shipped, unit-tested, and demonstrated end-to-end through the live agent
  (it re-rendered a cached result filtered to distinct values, read-only). The
  label-collection mechanism (every call = a "(state)→(op,detail) needed"
  example) is in place; training the classifier on those labels needs a corpus
  of agent runs *with the tool enabled and the model actually calling it* — a
  data-collection campaign we have the pieces for but did not run.
- **(C) RL — NOT feasible to train at scale in this environment, by design.**
  Each RL rollout is a real multi-minute gpt-5.2 agent run; on-policy RL needs
  hundreds–thousands of them (× the per-step credit assignment), which is
  cost- and wall-clock-prohibitive here. The *substrate* C needs is ready —
  reward (`correct − λ·tokens`, computed by the harness), per-operator features
  (`features.ts`), a behavior-cloning target (the rule policy), and a rollout
  logger (the search harness) — so C is a matter of compute budget, not missing
  machinery. Given the §6 finding (cost is already captured by LATEST), the
  higher-EV path is **(A′) a conditional-annotation config search on the thrashy
  tail measuring fail→pass and step-count**, then **(B)** distillation — not
  jumping to full RL.

---

## 5. Status

| layer | state |
|---|---|
| `summarize()` centralized renderer + params | shipped; 10 golden-parity snapshots; LATEST/DELTA byte-identical |
| dossier (code/result versions, code↔result correspondence) | shipped + unit-tested |
| dtype-anomaly hint (str-typed-numeric) | shipped + tested |
| `features.ts` (per-op role/state/data-shape) | shipped + tested |
| `selector.ts` (rule policy + `SelectorConfig`) | shipped + 18 unit tests |
| end-to-end wiring (`settings.selectorConfig`, per-step) | shipped; runs on the live stack |
| `selector-e2e.ts` A/B + `selector-search.ts` grid harness | shipped; resumable; 34 live cells run |
| **(A) config search** | **RUN — verdict in §6: accuracy-safe, cost-neutral/negative under LATEST** |
| `inspectResult` pull tool (Direction B enabler) | shipped; 8 unit tests + live WS demo (read-only, no re-exec) |
| **(B) pull-to-push distillation** | tool + label mechanism ready; classifier training not started (needs label volume) |
| **(C) RL over live rollouts** | not runnable at scale here (see §7); substrate (reward+features+harness) ready |

Full test suite: 485 pass (3 pre-existing env-coupled failures unrelated to this
work); typecheck clean; golden parity intact.

## 6. RESULTS — config search (Direction A), run for real

Two grids on the live stack (gpt-5.2), **34 end-to-end cells** total. Token
proxy = Σ rendered-context chars ÷ 4 across agent steps.

**Grid 1 — 5 configs × 5 tasks (easy-weighted):**

| config | accuracy | Σtokens | vs baseline |
|---|---|---|---|
| **baseline** (selector off) | **5/5** | **27.3k** | — (sole Pareto-optimal) |
| frugal (insurance off, trim) | 5/5 | 29.3k | +7% |
| expert (default policy) | 5/5 | 31.6k | +16% |
| rich | 5/5 | 32.1k | +18% |
| trim | 5/5 | 38.3k | +40% |

**Grid 2 — 3 configs × 3 multi-file tasks:** baseline 2/3 @ 46.9k (Pareto-optimal);
expert 2/3 @ +3%; frugal 2/3 @ +6%. (The lone failure, `environment-hard-9`,
fails for *every* config incl. baseline — a task-intrinsic join dead-end.)

**The honest verdict:**

1. **Accuracy is never harmed.** Across both grids every config matched baseline
   exactly (5/5, then 2/3). This robustly confirms the corpus claim that context
   re-shaping / reduction is accuracy-safe.
2. **The selector does NOT beat the lean LATEST baseline on cost** — it costs
   +3% to +40%. It won on exactly one task-run (`environment-hard-14/frugal`,
   −16%, fewer steps) but lost every aggregate. `frugal` (insurance + frontier-code
   off) is consistently closest to baseline, so **the selector's added per-op
   annotations — schema lines, frontier `Code:` block, structural hints — are the
   overhead**, and they aren't offset by source-decay under LATEST.
3. **Why:** the 13.6% stale-source waste was measured on **DELTA-mode** traces.
   Under **LATEST** (today's default) the event log is already gone and each step
   re-renders only the current snapshot — so there is little stale re-render left
   to reclaim, and the selector is net-additive. Choosing LATEST already banked
   the savings; **the residual lever is accuracy, not cost.**
4. **Single-sample tokens are noisy** — trajectory step-count varies run to run
   (env-hard-14 baseline came in at 14 steps/27k one run, 12–13 steps/20–24k
   another), which swamps the per-render deltas. A real tuner needs repeats.

**What this means for the program.** The config search did its job: it produced a
clear, falsifiable verdict — *this* selector, as parameterized, is an
accuracy-safe but cost-neutral-to-negative reshaping under LATEST. The value of
the whole apparatus therefore lands on **accuracy on the hard/thrashy tail**
(convert a fail→pass, or cut steps on a thrash loop), not on shaving tokens off
already-cheap tasks. Two concrete next moves the data points to:
- **Make the annotations conditional, not default.** Turn `frontierIncludeCode`
  and structural hints ON only under thrash/error (frugal already hints this).
  That removes the overhead on the 65% of tasks that don't need it.
- **Evaluate on the thrashy tail with repeats.** The accuracy/step-count payoff
  (if any) lives on the 26 thrashy tasks; measure fail→pass and step-count deltas
  there, N≥3 per cell to beat the variance. The training objective (`− λ·tokens` summed over tasks) will therefore
naturally tune the selector to spend insurance where it pays and trim hard where
it doesn't — which is exactly the behavior a single global config can't capture
but a per-feature policy (route B/C) can.
