# Agent-triggered context compaction — implementation plan (evidence-driven)

Refines `AGENT_TRIGGERED_COMPACTION_PLAN.md` with what the DELTA traces actually
say. Grounded in `compaction-analysis.ts` (deterministic, all 60 DELTA traces) +
a per-domain agent mining pass (6 domain inspectors + synthesis).

---

## 0. Bottom line

1. **Fold the event-log — it's ~70% of DELTA context** (88–95% on long traces).
   Trimming settled operators' result bodies is only ~10%. The big win is coarse
   ("freeze the trajectory into a deck"), so it needs little parameterization.
2. **But the trigger is NOT "sources-consumed."** That heuristic fires in 47/60
   traces and averages ~1.1 steps after optimal — yet it is *unreliable on the ~13
   high-cost thrash traces where the tokens actually are* (it fires early, late, or
   never: `environment-hard-9`, `biomedical-hard-4`, `wildfire-hard-21` have no
   boundary at all). On those, the token-optimal point lands **inside an active
   error loop whose failed-attempt memory must survive.** So the trigger must key
   on **fold-pressure + loop-type**, with sources-consumed as a *lower bound only*.
3. **Decouple two operations** (the key design move): a continuous **safe trim**
   (Lever B, ~10%, applied only to deleted/consumed-stable/settled ops — safe any
   step) separated from the gated **event-log fold** (Lever A, 70–95%, gated on
   loop-type). Bank the safe savings always; gate the big fold.
4. **Compaction is a tail mechanism.** ~43k tok/trace saveable, entirely in the
   17–47-step runs; short runs (≤ ~4 steps) save nothing — skip them.

## 1. The analytical foundation (deterministic, 60 DELTA traces)

Every recorded DELTA step re-rendered 3 ways with the real `summarize()`:
`deltaTok` (full trajectory), `deckHeavy` (snapshot, no event log), `deckLean`
(deck + static fold rule).

| metric | value |
|---|---|
| mean final trajectory | 12,057 tok |
| **fold-event-log lever** (A) | **70.5%** of context (88–95% on long traces) |
| **trim-settled lever** (B) | **9.9%** |
| mean optimal cumulative savings | ~43,206 tok/trace |
| sources-consumed boundary present | 47/60 (but unreliable on the costly 13) |
| boundary lag behind optimal (when present) | ~1.1 steps |

Top savers are all long/thrashy: astronomy-easy-5 (47 steps, 94.5% event-log,
414k saveable), wildfire-hard-17 (36 steps, 388k), environment-hard-9 (17 steps,
235k). A notable Lever-B sub-finding the mining surfaced: **legal traces carry
13–17 near-duplicate loader *code* bodies** — dropping settled code (`codeOn=false`
per-op) is a big safe saving my result-only analyzer undercounted.

## 2. Tool design (recommendation)

### 2.1 The two-operation split

- **Safe trim (continuous, no gating).** Apply Lever B — `shape`/`omit` — only to
  **deleted**, **consumed-stable loader**, and **settled-interior** operators, plus
  drop **settled-op code bodies**. This is provably safe at any step (the mining
  showed Lever B = 3–6% is safe any time; astronomy confirmed) and banks ~10%
  continuously. It can even run without the tool, as a selector default.
- **Event-log fold (gated tool call).** The 70–95% lever — freeze events into a
  deck — is the risky one and is what `compactContext` triggers.

### 2.2 `compactContext` tool surface (v1)

```jsonc
{
  "keepLastSteps": "auto",   // default auto (system covers the active loop); [0,5] override
  "reason": "thrash re-deriving a settled fact"  // logged + deck header + training signal
}
```

Kept minimal on purpose — the **intelligence lives in the system**, not in caller
params, because the live learned-selector run already showed models misjudge render
knobs. On call the system:
1. Runs a **loop-type classifier** on the span being folded (below).
2. Auto-sets `keepLastSteps` to cover any active error/retry loop.
3. Renders the frozen deck = current-state LATEST (idempotent, so a later bulk
   delete leaves no stale ops) + safe-trim applied + **a compact negative-results
   note** of ruled-out strategies from the folded thrash span.
4. Appends the raw suffix; deck is byte-frozen for prompt-cache stability.

Per-operator flags (`statsOn`/`fullSampleRecords`/`codeOn`…) are **v2** and, when
added, resolved by **operator class**, not one global setting (§4).

### 2.3 Loop-type classifier (the core new mechanism)

Distinguish, for the span under consideration:
- **redundant re-derivation of an already-settled fact** → fold aggressively, small
  `keepLastSteps`. Signals: same conclusion restated ≥3 steps, **no new operator
  added**, **no error being actively repaired**.
- **active error-retry on an unsettled op** → **defer**, or fold only with a
  `keepLastSteps` window covering the whole loop. Signals: latest result
  `isError`/empty AND op modified within last ~3 steps.

### 2.4 Guardrails (system-enforced, never caller-overridable)

- Always keep the **LATEST per-op result deck** (current DAG, each op's latest
  result incl. live errors), re-derived from current state.
- Never trim/fold the **unread answer rows** of a terminal op (protect the
  answer-holder regardless of params).
- Preserve the **failed-attempt *sequence*** of any actively-erroring op (via
  `keepLastSteps`) — the current error alone is not enough; the trail of prior fix
  attempts is the working memory.
- Keep **raw rows of a value-quirk source** until its quirk-handling consumer
  (parser/join/column-map) is authored and settled.
- Keep **decision-relevant column stats/ranges** (nulls, min/max, ID ranges,
  group-by keys) — cheap and often the actual working memory.
- Non-destructive: dossier/snapshots keep everything; `inspectResult` pulls folded
  material back. Existing token-budget auto-compaction stays as the hard backstop.

## 3. When-to-trigger rules (system prompt + tool description)

Ranked (from the synthesis; evidence in the trace corpus):

**High priority**
1. **Trigger on fold-pressure**, not on a boundary: fire when the re-rendered event
   log exceeds ~75–80% of step context, weighted by foldable-mass × remaining
   steps. Treat sources-consumed as a lower bound, never the trigger.
2. **Never fold while an operator is in an active error/retry loop** (latest result
   is error/empty AND modified within ~3 steps). Defer until it produces a healthy,
   consumed result — or fold only with `keepLastSteps` covering the whole loop.
3. **DO fold aggressively on thrash that merely re-derives a settled conclusion**
   (same fact ≥3 steps, no new ops, no error being repaired). The conclusion
   persists in the DAG deck. *(wildfire-hard-17: the biggest safe saver — 388k.)*
4. **Compact at a teardown / branch-abandonment boundary** — next action is (or was)
   a bulk `deleteOperator`, or the agent pivots from editing op A to a fresh op B
   for the same subgoal. Ground-truth proof the span is dead; safest, highest-yield.
   *(legal-easy-19: fold right before a 12-op mass-delete — 184k.)*

**Medium**
5. When the DAG is structurally frozen and only the terminal/sink op is being
   polished, fold everything upstream of it. *(legal-hard-30: 9 ops frozen, only
   `verifyResult` re-edited 7×.)*
6. Count a source "consumed" only when its consumer's latest result is **non-error
   and non-empty** (a *healthy* consumer), not merely any downstream edge.
7. Defer while the current subgoal is scanning raw rows to identify a
   column/parser/join-key and that mapping is unresolved — raw rows are working
   memory. If you must fold, force `fullSampleRecords + statsOn`.

**Low**
8. Fallback trigger independent of any boundary: force-consider compaction every
   ~10 action steps or above ~15k accumulated delta tokens.
9. Skip short traces (≤3–4 action steps) — every boundary is pre-consumption
   (risky, tiny) or terminal (zero cumulative benefit).

## 4. How compaction params affect accuracy

| param | guidance |
|---|---|
| **keepLastSteps** | The dominant safety knob (it governs how much of the 70–95% fold is retained). Auto-set to cover the entire active error/retry loop (~3–5 steps) in debug traces; 0–1 on settled/DAG-frozen/post-teardown traces. Folded steps are near-identical restatements, so keeping the last 3–5 still banks most savings. Too small mid-loop drops live failed-attempt memory; too large forfeits redundant-tail savings. |
| **fullSampleRecords** | The trim-settled lever *and* the highest accuracy risk. OFF (schema/shape) is safe for settled/consumed loaders whose values are no longer read; **HIGH risk** for value-quirk loads under row inspection, any join/lookup/parser-authoring step, and the answer-holder. Keep ON until the quirk-handling consumer is authored, then OFF. *(biomedical-hard-3: trimming loader bodies would destroy the exact `S019`/`C3L-00006` strings the next join reads.)* |
| **statsOn** | Cheap, low-risk; keep ON by default for settled sources (null/min/max preserve decision facts at a fraction of full-row cost). Does NOT substitute for `fullSampleRecords` on row-level lookups/joins. |
| **codeOn** | Per-operator, never global. Drop code for settled/consumed ops — a large safe saving where duplicate loader bodies pile up (legal 13–17×). Keep ON for the actively-edited/erroring op (its tried-and-failed configs are the working memory) and for the LATEST op (answer verification). |
| **cardinalityOn** | Like `statsOn` — keep ON cheaply; useful for join-key/group-by fan-out planning; insufficient alone to replace raw rows for value-quirk parsing. |

## 5. Representative cases

**Safe high-yield (fold here):**
- `wildfire-hard-17` @step23 (~388k): ~20-step thrash re-deriving one settled fact
  ("station IDs 20–45k ≠ RAWS 16–19M"); event log 88% of the step. Fold it — just
  preserve the enumerated ruled-out join strategies (negative-results note).
- `legal-easy-19` @step21 (~184k): optimal fold sits one step before a self-initiated
  12-op mass-delete — proof the 13 throwaway parser ops are abandoned. Event log 83%.
- `legal-hard-30` @step9 (~49k): DAG frozen at 9 ops, only `verifyResult` re-edited
  7×; both loaders consumed, 5 interior ops settled — fold upstream of terminal, zero risk.
- `wildfire-hard-21` @step15 (~155k): source `ZHVI.csv` doesn't exist, agent restates
  "file missing" ~15× — safe to fold a one-line settled negative, *if* the "use NOAA
  columns instead" pivot survives. (sources-consumed never fires here.)

**Risky (defer / wide keepLastSteps):**
- `astronomy-easy-5` @step27 (~414k, largest raw opportunity): token-optimal lands
  mid ~30-step skyfield-API thrash; folding would drop the failed-attempt reasoning
  that IS the working memory. Safe only after `calculateAltitudes` works (~step 42).
- `environment-hard-9` @step9 (~235k): re-emits the same failing 7-op fix batch with
  an unchanged diagnosis; folded span holds just-submitted still-erroring code.
  sources-consumed = none → an SC-only trigger forfeits all of it.
- `biomedical-hard-4` @step13 (~91k): SC null (heuristic never fires) yet optimal is
  mid retry-loop — loaders re-modified 12/13/14 during a cross-sheet peptide search;
  folding drops which sheets/params already failed empty.
- `wildfire-hard-7` @step15 (~82k): both CSV loaders still erroring, every step a
  distinct delimiter/header hypothesis; pure token-math over-triggers. The *later*
  sources-consumed point (step 24, after files load) is the safer trigger.

## 5b. POC results (built + tested)

A minimal POC is implemented and merged: the `compactContext` marker tool
(read-only), the DELTA-assembler fold reusing `renderCompressed` at the agent's
mark (static params from settings — the model chooses only WHEN), and the context
meter (`> Context budget: ~Nk / target 4k`). What we learned:

- **Mechanism works.** Deterministic: injecting a mark at step 20/35 of
  legal-easy-19 folds 31,155 → 18,745 tok (−39.8%), deck + suffix intact, byte-deck
  identical to the shipped rolling compressor. Live: on environment-hard-15 the
  context grew 4.7k→10.3k, the agent compacted at step 14, and step 15 dropped to
  9.8k (growth reversed).
- **Without a signal, the agent does not self-compact: 0/3** tasks called it
  (gpt-5.2, DELTA, tool + description only) — the predicted 6%-delete-rate
  behaviour. The tool being available was verified (settings echo).
- **With the meter, it fires — and correctly: 1/3.** environment-hard-15 called it
  once at step 14 with a textbook reason ("sources loaded + consumed; ranking
  computed; no active debugging") — exactly the intended trigger — and still passed
  (1.0). The two non-firing tasks were short (8, 13 steps), where compaction is
  genuinely unneeded (tail mechanism). (legal-easy-19 failed that run with 0
  compact calls — trajectory variance, not compaction-caused.)

**Verdict:** the agent *can* call compaction properly when given an observable
signal, the fold executes live without hurting accuracy, and short tasks correctly
abstain. The meter is necessary (0→1 firing). Live savings were modest here (~5%)
because gpt-5.2 runs short/clean; the large wins are in the thrash tail (§1:
70% event-log, ~43k tok/trace) — the next test is a genuinely long trajectory
(or a lower meter target) + the smoke-then-grid below.

## 6. Implementation phases

- **Phase A — fold-mark plumbing (2–3d):** mark = a `compactContext` call in the
  visible path; assembler renders `[frozen deck @ boundary] + [raw suffix]`, reusing
  the compress-deck renderer + the static fold rule; golden byte-equality vs the
  current window-compress deck.
- **Phase B — loop-type classifier + safe-trim (2d):** the §2.3 classifier over the
  dossier (new-op-added? error-being-repaired? conclusion-restated?); the continuous
  Lever-B safe trim as a selector default; auto-`keepLastSteps`; negative-results
  note generator.
- **Phase C — the tool + prompt + meter (1–2d):** `compactContext` (minimal
  surface), read-only, one-line observation; conditional system-prompt section with
  §3 rules; **context meter** in the trajectory header (the observable signal
  without which size-based rules are undecidable — the 6%-delete precedent).
- **Phase D — backstop composition (0.5d):** auto-fold wins past the mark at the
  hard ceiling.
- **Phase E — smoke then grid (1–2d + compute):** *smoke first* (does it fire, and
  does firing correlate with §3 conditions? auto-classify each firing) — gate all
  spend on this. Then the A/B grid (DELTA unbounded / DELTA+auto-compress /
  DELTA+tool / tool-minus-rules / LATEST), ≥3 reps on the decisive pair, metrics
  incl. `usage.cachedInputTokens`.

## 7. Where this differs from `AGENT_TRIGGERED_COMPACTION_PLAN.md`

- **Simpler v1 tool, smarter system.** Prior plan leads with a per-op flag array
  (the ~10% lever); lead instead with the near-parameterless event-log fold + a
  system-side loop-type classifier. Per-op flags → v2.
- **Trigger is fold-pressure + loop-type, not sources-consumed.** The measured
  boundary is a lower bound; it's unreliable exactly on the costly thrash tail.
- **Decoupled safe-trim vs gated-fold** — bank the safe ~10% continuously; gate the
  risky 70–95%.
- **Kept from the prior plan:** guardrails, non-destructive fold, backstop, the
  "publishable even if it never fires" smoke design, the context meter.
