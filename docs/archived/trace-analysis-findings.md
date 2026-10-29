# Trace × solution analysis — findings (Idea 1)

> ⚠️ **Status note (see `STATUS-context-optimization.md` §5).** The **failure split
> headline** (55/60 correct; 1 context-fixable, 4 task-intrinsic; accuracy ≈ cost
> lever) is deterministic and still trustworthy. The **cost-lever mechanisms** below
> were derived from traces captured under an **older renderer** (no 50-col cap, hard
> row cap); some pathologies they cite are already mitigated. Re-measure cost claims
> on the current renderer (this is what the proposed offline cost-replay harness is for).

Oracle-grounded, per-step analysis of all **60 KramaBench traces** against the gold
`.py` solutions and the real source data (8 parallel sub-agents, 3 disciplines:
ground in data-dependencies not step-count; classify failures context-fixable vs
task-intrinsic honestly; structured labels). Raw labels:
`benchmark/llm-training-data-generation/output/trace-analysis/*.json`
(+ `AGGREGATE.json`). **153 per-step labels; deterministic, noise-free** — the
thing every prior end-to-end A/B lacked.

## Headline

- **55 / 60 correct, 5 failed.**
- **Failure split — the accuracy question:** **1 context-fixable, 4 task-intrinsic.**
  - context-fixable: **wildfire-hard-17** — the one place context could flip fail→pass.
  - task-intrinsic (no render change helps): wildfire-hard-14 (definition mismatch),
    wildfire-hard-21 (empty `ZHVI.csv`, data absent), astronomy-hard-10 (fabricated
    time axis → wrong correlation), environment-hard-9 (aggregation error; the needed
    column was visible three ways).
- **125 of 153 labels are cost-trim; the dominant transition is `full-table → shape` (36×).**
- **1 accuracy-critical label** (wildfire-hard-17).

This confirms, with evidence rather than a noisy average, the earlier read: on
KramaBench context tuning is **overwhelmingly a COST lever, not an accuracy lever**
— the accuracy ceiling is ~1/60 tasks. But that one case, plus the "latent"
near-misses below, is real and instructive.

## The one accuracy win (wildfire-hard-17) — and why it matters

The agent needed to join NOAA fire records to RAWS stations. The correct key is
RAWS `NWS ID` (range 1196–661001, overlaps the NOAA key 20107–482106). But the
34-column RAWS table renders as a **truncated wide sample** — only ~1 data row
fits, and in it `NWS ID` happened to be `NaN` while the *wrong* columns (`WX ID`,
`Station ID`, 16–19M) showed populated values. Reasoning purely by ID range, the
agent concluded "no match," fell back to the **mean elevation of all 2965 stations**
(3317.4), and failed (gold 4830.9). **A `sample+stats` render — per-column non-null
count + min/max on the ID-candidate columns — would have surfaced that `NWS ID`
overlaps the key.** So the accuracy lever is not *more rows*, it's the *right stat*
on the deciding columns. (Marked medium-confidence: the `NWS ID` header was visible
every step, so a sharper agent might have caught it regardless.)

**Latent near-misses (correct only by luck; stats would harden them):**
`environment-hard-15` hardcoded `Violation=='Yes'` but 2021 uses `'YES'` (1167 rows
silently zeroed) — a value_counts/`sample+stats` on that categorical would have
surfaced the mixed casing. Same value-set-visibility principle.

## The cost levers, categorized (the training signal)

**A. Drop consumed/superseded sources — the dominant, safe win (`full-table → shape`, 36×).**
Under `latest`, every operator's full result re-renders every step. Once a source
is consumed by a healthy downstream, its rows are dead weight; keep the schema
(`shape`), drop the rows. Present in nearly every task; biggest sinks are the
multi-source/wide tasks (environment-hard-14: 3 water + 4 precip loads full-width
across ~20 steps; biomedical: 179-col clinical re-rendered ~18×).

**B. Omit truly unconsumed operators.** Loaded-but-never-linked files
(wildfire-hard-10 `loadFiresAcres`; environment-hard-9's 8 dead loaders) and
superseded inspection ops → `omit`.

**C. Keep `sample` at the LOAD/DISCOVERY step for value-quirk files — do NOT over-trim.**
Trimming these to `shape` blinds the agent and *causes* extra work:
- `legal-hard-6/7`: **swapped column labels** detectable only from values → trimming
  to shape forced a redundant inspect op + 4 wasted steps.
- `archeology-easy-3`: the `"4 or 5"` rank value must be seen to write the parser.
- multi-header beach datasheets (environment-hard-11/12/13): variable width + merged
  headers only diagnosable from raw bytes (and `print()` is dropped by the harness,
  so the load render is the *only* structural signal).

**D. Freeze unchanged upstream during retry/verify loops.** `legal-hard-30` re-rendered
its frozen 7-operator DAG on every iteration of an 8-step `verifyResult` loop → 602K
tokens on a boolean. Collapse unchanged upstream to `shape` during no-op retries.

**E. Surface swallowed errors — UNDER-render also causes thrash (a cost *increase* from too little).**
`astronomy-easy-5` (445K tokens): ~12 attempts silently returned `(0,0)` with the
exception swallowed → the agent rebuilt the API blind ~10×. `wildfire-hard-20`:
the data-dictionary render ellipsis-hid the definition row → ~15 ops to surface it.
`legal-easy-19/25`: head/tail `...` hid the answer-bearing middle block → 13–16
reload attempts. Fix here is *more* detail once (full/error), not less.

**F. Special renderers.** Geopandas `.gpkg` dumps raw WKT geometry (a single render
was ~22KB of polygon coords, wildfire-easy-2/3) → needs a geometry-aware summary
(geom-type + bbox), never raw WKT.

## Implication for the selector/tuner

This is the **oracle training set** the tuner always lacked. The policy it teaches is
sharper than "trim aggressively":
- Default consumed/interior/wide sources → `shape`; omit dead ops. (A, B)
- BUT keep `sample` at the load step for value-quirk/dirty/multi-header files, and
  render small dictionaries / errors in FULL. (C, E)
- Add `sample+stats` on decision-critical columns (join keys, filter categoricals) —
  the one accuracy lever. (wildfire-hard-17, environment-hard-15)
- Freeze unchanged upstream during verify loops. (D)

Every one of these is a per-step, feature-derivable rule — exactly the selector's
action space. The labels can be used directly (imitation) or as the reward oracle.

## Adjudication of Idea 2 (agent self-tunes context as a tool)

The trace evidence answers the question I flagged — *does the agent know enough at
the deciding step to self-tune?* — and the answer is **asymmetric**:

- **The safe cost trims (drop a consumed source) — YES, the agent knows.** It just
  wrote the downstream that consumed it, so a lightweight "done with X" self-signal
  could drive lever A. Low-value but real.
- **The high-value moves — NO, the agent is blind exactly where it matters.** Every
  case that actually cost accuracy or caused thrash is one where the agent *did not
  know* it needed more: it reasoned by range and concluded "no join" (wildfire-hard-17
  — it wouldn't have pulled stats, it was confidently wrong); it didn't know the
  answer rows were ellipsis-hidden (legal-easy-25); it didn't know the columns were
  swapped (legal-hard-7); it swallowed its own error (astronomy-easy-5). A self-tuner
  can't request the detail that would reveal a mistake it doesn't know it's making.

**Conclusion:** a self-trim tool is viable only for the low-value safe direction and
is useless (by construction) for the high-value accuracy/anti-thrash direction. The
valuable moves require an EXTERNAL view — the oracle-trained selector / teacher, or
a rule that *pre-emptively* renders stats on decision-critical columns and errors in
full. This vindicates the asymmetric design we already have: **lean default + the
read-only `inspectResult` pull tool** (agent escalates when it *realizes* it's stuck),
with the push side owned by the selector, not the agent. I would NOT build a
self-trim tool.
